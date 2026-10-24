/**
 * pi-translator v2 — the agent works ONLY in the working language (English by
 * default), and the model context stays 100% working language in BOTH
 * directions, while the user sees their own language everywhere:
 *
 *   user types German  ──prompt translation──▶ model reads English draft
 *   model drafts English ──reply translation──▶ transcript + UI show German
 *   before every LLM call, `context` restores the English originals
 *   (embedded as message metadata) → the model never reads target language.
 *
 * Why: the locally served ultra-sparse MoE model corrupts German GENERATION
 * in long contexts (measured 10%→24% artifacts by context quartile) and is
 * clean in English.
 * Spec docs/03 + upgrade plan docs/05 (F1 context-restore, F2 prompt
 * translation, F3 placeholder protection, F4 original, F5 debug log).
 * No external MT. No detector: the translator LLM identifies languages
 * itself and answers "NONE" for same-language passthrough.
 *
 * Boot: PI_TRANSLATOR=1, or a "pi-translator" block in settings.
 * Per session: /translator [on|off|auto|<language name>], /translator-original.
 * Env: PI_TRANSLATOR_WORKING, PI_TRANSLATOR_TARGET, PI_TRANSLATOR_MODEL,
 *      PI_TRANSLATOR_DEBUG=1, PI_TRANSLATOR_LOG=<file.jsonl>.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// shortcut: names for naming the working/forced language in the prompt only;
// raw code is the fallback for anything unlisted. Not a target-language table.
const LANG_NAMES: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian" };
// "de", "German" and "german" all mean the same thing to an operator writing a
// settings block or typing /translator German.
const TARGET_LOOKUP: Record<string, string> = Object.fromEntries(Object.entries(LANG_NAMES).flatMap(([k, v]) => [[k, v], [v.toLowerCase(), v]]));

/* ---------- pure helpers (exported for pi-translator.test.ts) ---------- */

export function proseOnly(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.trim();
}

const SCRIPT_NAMES = [
	"Latin", "Han", "Hiragana", "Katakana", "Hangul", "Cyrillic", "Arabic",
	"Hebrew", "Greek", "Thai", "Devanagari", "Bengali", "Tamil", "Telugu",
	"Gujarati", "Kannada", "Malayalam", "Gurmukhi", "Odia", "Sinhala",
	"Myanmar", "Khmer", "Lao", "Georgian", "Armenian", "Ethiopic",
	"Cherokee", "Mongolian", "Tibetan", "Thaana", "Nko",
];
// Names are Unicode-canonical (Myanmar/Odia, not Burmese/Oriya); stale
// property names are skipped so the guard compiles on any V8/Unicode.
const SCRIPT_RES: [string, RegExp][] = SCRIPT_NAMES.flatMap((s) => {
	try {
		return [[s, new RegExp(`\\p{Script=${s}}`, "u")] as [string, RegExp]];
	} catch {
		return [];
	}
});

export function scriptsOf(text: string): Set<string> {
	const found = new Set<string>();
	for (const [name, re] of SCRIPT_RES) if (re.test(text)) found.add(name);
	return found;
}

/** Spec §4.2: every script outside code fences in `outText` must also appear
 *  in QUESTION ∪ DRAFT (∪ extraAllowed). Catches the measured CJK-leak class
 *  table-free; a CJK question legitimately licenses CJK output.
 *  extraAllowed: prompt-translation passes a working-language sample — the
 *  ORIGINAL request may contain no Latin at all (pure Kana) while the
 *  translation target is the Latin working language. */
export function scriptGuardOk(outText: string, question: string, draft: string, extraAllowed = ""): boolean {
	const allowed = scriptsOf(`${question}\n${draft}\n${extraAllowed}`);
	for (const s of scriptsOf(proseOnly(outText))) if (!allowed.has(s)) return false;
	return true;
}

/** Spec §4.4: translation prose length within [0.4×, 2.5×] of draft prose. */
export function lengthOk(outText: string, draft: string, ceiling = 2.5): boolean {
	const a = proseOnly(outText).length;
	const b = Math.max(1, proseOnly(draft).length);
	return a >= 0.4 * b && a <= ceiling * b;
}

/** Latin↔Latin blind spot of the script guard: a translator that outputs
 *  working-language text (or meta-commentary) instead of translating is
 *  invisible to script checks. A real translation shares almost no word
 *  forms with the source; an untranslated output shares nearly all of them.
 *  Failing here is safe: retry, and the fallback (the original draft) is
 *  what the bad output degenerated to anyway. Short sources carry too
 *  little signal to judge → always pass. */
export function differsFromSource(outText: string, source: string): boolean {
	// proseOnly on both sides: the answer carries every masked span (code fences,
	// inline code) byte-identically by design, so counting those tokens scores them
	// as "shared words" and rejects correct output of code-dominant answers — the
	// commonest shape a coding agent writes (measured: 0.765 shared vs the 0.6
	// ceiling on a two-command fence).
	// shortcut: prose below the 8-word signal floor stays unjudgeable (a verbatim echo
	// of it passes), and masked URLs/paths outside fences still count as shared.
	const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
	const src = words(proseOnly(source));
	if (src.size < 8) return true;
	const out = [...words(proseOnly(outText))];
	if (out.length === 0) return false;
	const shared = out.filter((w) => src.has(w)).length;
	return shared / out.length < 0.6;
}

/** F3 (docs/05): mask protected spans with ⟦n⟧ placeholders before any
 *  translation call; restored verbatim afterwards. Placeholders use brackets
 *  no translator plausibly rewrites, and completeness is asserted on restore. */
// The `C:\...` branch is not decoration: on a Windows host the absolute paths this
// agent quotes constantly matched nothing and went to the translator unprotected.
const PROTECTED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|https?:\/\/\S+|[A-Za-z]:[\\/][\w.\-\\/@]{2,}|(?:^|[\s(])~?\/[\w.\-\/@]{2,}(?![\w.-])/gm;

export function maskProtected(text: string): { masked: string; spans: string[] } {
	const spans: string[] = [];
	const masked = text.replace(PROTECTED, (span) => {
		// keep the leading context char the alternation may have swallowed
		const lead = span[0] === " " || span[0] === "(" ? span[0] : "";
		const body = lead ? span.slice(1) : span;
		spans.push(body);
		return `${lead}⟦${spans.length - 1}⟧`;
	});
	return { masked, spans };
}

/** Unmask + completeness check: every placeholder must appear exactly once. */
export function unmaskProtected(text: string, spans: string[]): { ok: boolean; text: string } {
	const seen = new Array<number>(spans.length).fill(0);
	const out = text.replace(/⟦(\d+)⟧/g, (whole, idx) => {
		const i = Number(idx);
		if (!Number.isInteger(i) || i < 0 || i >= spans.length) return whole;
		seen[i]++;
		return spans[i];
	});
	const ok = seen.every((n) => n === 1) && !/⟦\d+⟧/.test(out);
	return { ok, text: ok ? out : text };
}

/** Spec §3 {append}: general ("*") entries verbatim, per-language labeled. */
export function renderAppend(append: Record<string, string> | undefined): string {
	const general: string[] = [];
	const labeled: string[] = [];
	for (const [key, value] of Object.entries(append ?? {})) {
		const t = String(value ?? "").trim();
		if (!t) continue;
		if (key === "*") general.push(t);
		else labeled.push(`[${key}] ${t}`);
	}
	const lines = [...general, ...labeled];
	if (lines.length === 0) return "";
	return (
		"\nStyle additions (apply the general ones always; apply a labeled one only when you translate into that language):\n" +
		lines.join("\n")
	);
}

const PLACEHOLDER_RULE =
	"Keep placeholders like ⟦0⟧ exactly as they appear — never translate, remove, reorder or duplicate them.";

/** Spec §3: the ONE generic reply template. `forced` replaces the
 *  detect/NONE block; no passthrough then. */

/** The worker-side guideline, injected as system prompt section
 *  `pi_translator` while enabled. Without this the model drafts directly in
 *  the user's language (AGENTS.md, memories and conversation pull it that
 *  way), the reply call merely restyles, and the working-language promise
 *  for the transcript and the prompt cache silently breaks. */
export function workingGuideline(name: string): string {
	return (
		`Working-language mode is active: generate ALL text you produce — internal reasoning/thinking and answer drafts alike — in ${name} only, no matter what project instructions, injected memories, or conversation history appear to ask. ` +
		`Incoming user text reaches you untranslated, so ignore what language it is written in; your final message is rewritten into the user's language by a translation layer on delivery — "answer in the user's language" preferences are that layer's job, not your job. ` +
		`Code, commands, paths, identifiers and quoted material are written normally. ` +
		`If you catch yourself drafting in the user's language, redraft in ${name}.`
	);
}

/** Owner decision (docs/06 F4): every answer is formulated for the reader, so
 *  there is no gate left to feed and no pre-start call to make. One prompt does
 *  both jobs: translate when the draft is in the wrong language, re-derive it
 *  cleanly when it is not. `target` is an explicit delivery language (operator
 *  `forced`, or the language of the last delivered answer when a machine-
 *  triggered turn carries no question); null means infer it from the QUESTION. */
export function buildFormulatePrompt(workingName: string, append: string, target: string | null): string {
	const lang = target
		? `Write the final answer in ${target}.`
		: `Write the final answer in the language the QUESTION is written in.`;
	return (
		`You are the final formulation layer of an agent. You receive a QUESTION from a user and a DRAFT answer written by the agent in ${workingName} — the DRAFT may have drifted into another language.
${lang}
- Rewrite the DRAFT sentence by sentence: keep every fact and leave nothing out, but do NOT reproduce any sentence verbatim, and do not describe the DRAFT — it is content to render, not a document to summarise.
- Add nothing that is not in the DRAFT.
- First line: the name of the language you answered in, in English (e.g. German). Second line onwards: the answer.
- Nothing else: no comments about translating, no copy of the source, and never answer the QUESTION yourself.
Preserve markdown structure exactly; code fences, inline code, paths, commands and URLs byte-identical.
${PLACEHOLDER_RULE}
The QUESTION is context for language and topic only.` + append
	);
}

export type LangVerdict = { kind: "working" } | { kind: "lang"; name: string } | { kind: "fail" };

/** Operator input and model answers share one name table: "de", "German" and
 *  "german" all mean German. Unknown names pass through verbatim — the name is
 *  state and log text, never a key into a language database. */
export function canonicalLangName(raw: string): string {
	const t = String(raw ?? "").trim();
	return TARGET_LOOKUP[t.toLowerCase()] ?? t;
}

/** Parse a one-word language answer. Strict on purpose: a chatty answer ("This
 *  is German") is a model that started talking, which is a FAIL, not a name —
 *  guessing from it would silently pick a target. */
export function parseLanguageName(raw: string, workingName: string): LangVerdict {
	const t = String(raw ?? "")
		.trim()
		.replace(/^["'“”]+|["'“”].*$/g, "")
		.replace(/[.!:;]+$/, "")
		.trim();
	if (!t) return { kind: "fail" };
	if (/^none$/i.test(t)) return { kind: "working" };
	if (t.toLowerCase() === workingName.toLowerCase()) return { kind: "working" };
	if (t.split(/\s+/).length > 3 || !/^[A-Za-z][A-Za-z -]{1,29}$/.test(t)) return { kind: "fail" };
	return { kind: "lang", name: canonicalLangName(t) };
}

/** The formulate call answers "<language name>\n<text>". A model that skipped
 *  the header must not lose its answer: the whole reply is then the text, with
 *  the language unknown (docs/06 R2 — never let the name line reach the model
 *  or the transcript as answer content). */
export function splitLanguageHeader(raw: string): { lang: string | null; text: string } {
	const t = String(raw ?? "").trim();
	const i = t.indexOf("\n");
	if (i < 0) return { lang: null, text: t };
	const v = parseLanguageName(t.slice(0, i), "");
	if (v.kind !== "lang") return { lang: null, text: t };
	return { lang: v.name, text: t.slice(i + 1).trim() };
}

/** Share of the DRAFT's sentences (>=6 words) that the formulation reproduces
 *  verbatim. ratio cannot see this: a faithful re-derivation has ratio ~1.0 by
 *  design, so "did it actually reword?" needs its own number. Measured basis:
 *  0.61 with the old instruction, 0.31 with the current one (same 15 s). */
export function verbatimShare(draft: string, out: string): number {
	const norm = (x: string) => x.replace(/\s+/g, " ").trim();
	const sentences = draft.split(/(?<=[.!?])\s+/).map(norm).filter((x) => x.split(" ").length >= 6);
	if (!sentences.length) return 0;
	const o = norm(out);
	return sentences.filter((x) => o.includes(x)).length / sentences.length;
}

/** True when the DRAFT itself carries non-Latin script — the case scriptGuardOk
 *  cannot police (its union licenses the draft's own scripts), so it is logged
 *  instead: inherited class-A is a count, not a shrug (docs/06 R4/R7). */
export function foreignScriptIn(text: string): boolean {
	const scripts = scriptsOf(text);
	return ["Han", "Hiragana", "Katakana", "Hangul", "Cyrillic"].some((sc) => scripts.has(sc));
}

/** Whitespace/case-normalised text: the equality that defines a polisher that
 *  did nothing (docs/06 R6 — a percentage threshold would reject light edits). */
export function normText(s: string): string {
	return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Output ÷ draft prose length, logged with every formulation so invented
 *  filler is countable (docs/06 R4/R7 M5) instead of a prompt wish. */
export function ratioOf(outText: string, draft: string): number {
	const b = Math.max(1, proseOnly(draft).length);
	return Math.round((proseOnly(outText).length / b) * 100) / 100;
}

/** Summary direction (docs/05 F7): pi builds compaction/branch summaries from
 *  the STORED user-language deliveries, so the model would otherwise read its own
 *  work back in the user's language. Faithful translation, not restyled. */
export function buildPromptTranslatePrompt(workingName: string): string {
	return `You are a translation engine. Translate the USER REQUEST into ${workingName}.
- If the request is already in ${workingName}, reply with exactly: NONE
- Never answer the request; never comment on it; add and omit nothing.
- Keep technical content (code, paths, commands, URLs, versions, error strings) byte-identical.
${PLACEHOLDER_RULE}
Output only the ${workingName} request text.`;
}

/* ---------- settings (same file layout @samfp/pi-memory reads) ---------- */

interface TailSettings {
	working?: string;
	target?: string;
	model?: string;
	promptAppend?: Record<string, string>;
	debug?: boolean;
	log?: string;
}

function readBlock(path: string): TailSettings | null {
	try {
		const block = JSON.parse(readFileSync(path, "utf-8"))?.["pi-translator"];
		if (block && typeof block === "object") return block as TailSettings;
	} catch {
		/* missing or invalid file = no block */
	}
	return null;
}

/** Trust-scoped settings (review MAJOR): model/log/debug/promptAppend steer
 *  where plaintext goes, so the PROJECT block is read only when pi itself
 *  trusts the folder (`ctx.isProjectTrusted()`) — the same gate pi applies to
 *  project settings. An untrusted clone can no longer reroute the translator
 *  model, enable silent plaintext logging, or inject prompt text. User-global
 *  is the base; a trusted project block overrides per key. */
function loadSettings(cwd: string, projectTrusted: boolean): TailSettings | null {
	const base = readBlock(join(homedir(), ".pi", "agent", "settings.json"));
	const project = projectTrusted ? readBlock(join(cwd, ".pi", "settings.json")) : null;
	if (!base) return project;
	if (!project) return base;
	return { ...base, ...project, promptAppend: { ...base.promptAppend, ...project.promptAppend } };
}

/* ---------- message metadata ---------- */

interface TranslatorMeta {
	/** assistant messages: the working-language draft the model actually wrote */
	original?: string;
	/** user messages: the language this human turn asked to be answered in
	  (F3, docs/06). Read back on session reload to restore `userLang`. */
	userLang?: string;
	/** assistant messages with translated ask_user forms: content-block index
	  → the original working-language tool-call arguments */
	toolArgs?: Record<string, any>;
}
const META_KEY = "piTranslator";

/** Replace the FIRST text block in place, drop the others: multimodal blocks
 *  (images…) keep their original positions — "image, then question" must not
 *  become "question, then image" for the model. */
export function replaceText(content: any[], text: string): any[] {
	const idx = content.findIndex((b: any) => b.type === "text");
	if (idx < 0) return [...content, { type: "text", text }];
	const after = content.slice(idx + 1).filter((b: any) => b.type !== "text");
	return [...content.slice(0, idx), { ...content[idx], type: "text", text }, ...after];
}

/* ---------- translation attempt ---------- */

/** `error` = the call itself broke; `reject` = a guard refused the output.
 *  The split is the whole point: a guard rejection is deterministic, so the
 *  identical retry can only produce the same rejection and burn a second call
 *  (measured: it doubled cost + latency on every turn of a code-dominant answer).
 *  `why: "timeout"` is not retried either — a slow model retried is a double stall. */
/** One guard set for every outbound call; `header` marks formulate mode, where
 *  the model returns a language-name line before the answer. */
type Guards = { question: string; draft: string; spans: string[]; rejectNone: boolean; extraAllowed?: string; skipDiffers?: boolean; skipScript?: boolean; header?: boolean };

type Attempt = { kind: "none" } | { kind: "text"; text: string; lang?: string } | { kind: "error"; why: "transport" | "timeout" } | { kind: "reject"; guard: string };

/** Anything but a usable translation or an explicit NONE. */
const failed = (a: Attempt) => a.kind === "error" || a.kind === "reject";

// Hard ceiling on one translator call. ctx.signal is pi's run-abort signal and is
// undefined whenever the agent is not streaming, so without this a hanging
// endpoint stalled the turn forever with nothing said at all.
const CALL_TIMEOUT_MS = 25000;
// Formulate mode gets five minutes (owner request, 2026-10-24: "mach einfach mal
// das timeout 5min und wir sehen was rauskommt"). It is not a translation any
// more — the model retypes the whole answer, and measured worker speed is ~11 s
// per 1000 output characters, so a 3k-char answer legitimately needs 30-60 s.
// The 25 s ceiling STAYS for forms and summaries: those are short payloads where
// a hang is a hang, and a 5-minute freeze before an ask_user form ships would be
// a worse bug than the one this raises.
const FORMULATE_TIMEOUT_MS = 300000;
// Thinking level for the formulation call. "minimal" is NOT a level this class
// of endpoint serves (field: "Unexpected reasoning effort minimal. Supported
// types are xhigh (default), medium, and low") — every request was rejected and
// the probe retry landed on xhigh, i.e. 12,788 completion tokens for 6,700
// characters. Ask for a level that exists. "low"/"medium" answer in 9-15 s but
// COPY the draft (ratio 1.00, ~1,850 tok) instead of re-deriving it, so the
// level is the polish knob: measured via verdict:"noop" per label in the gate.
const FORMULATE_REASONING = "medium";
/** Read per call, not at module load: lets a test drive the timeout path
 *  without waiting for the real ceiling. */
export function callCeilingMs(formulate: boolean): number {
	return Number(process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS) || (formulate ? FORMULATE_TIMEOUT_MS : CALL_TIMEOUT_MS);
}

// Translator call. reasoning "minimal": translation needs no thinking, and the
// measured empty-completion class (01-findings §5) is a thinking-budget
// overflow — cap it at the lowest level here. Some models reject that thinking
// level outright (field report: one locally served MoE endpoint answers
// "error" with empty content) — one probe per model, then call without it.
// The probe Set is PER SESSION (factory scope, passed in): a module-scoped Set
// in a multi-session host process lets one session's transient network blip
// permanently flip every user's sessions on that model (review MEDIUM).
async function callTranslator(ctx: any, model: any, systemPrompt: string, payload: string, reasoningUnsupported: Set<string>, timedOut: { v: boolean }, ceilingMs: number, reasoning: string): Promise<any> {
	const key = `${model.provider}/${model.id}`;
	const request = { systemPrompt, messages: [{ role: "user", timestamp: Date.now(), content: payload }] };
	const ctrl = new AbortController();
	const timer = setTimeout(() => {
		timedOut.v = true;
		ctrl.abort();
	}, ceilingMs);
	const relay = () => ctrl.abort();
	ctx.signal?.addEventListener?.("abort", relay);
	const opts: any = { signal: ctrl.signal };
	if (!reasoningUnsupported.has(key)) opts.reasoning = reasoning;
	try {
		const out = await ctx.modelRegistry.streamSimple(model, request, opts).result();
		const text = (out.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
		if (text || reasoningUnsupported.has(key)) return out;
		reasoningUnsupported.add(key);
		return await ctx.modelRegistry.streamSimple(model, request, { signal: ctrl.signal }).result();
	} finally {
		clearTimeout(timer);
		ctx.signal?.removeEventListener?.("abort", relay);
	}
}

async function translateOnce(
	ctx: any,
	model: any,
	systemPrompt: string,
	payload: string,
	guards: Guards,
	reasoningUnsupported: Set<string>,
	timedOut: { v: boolean },
): Promise<Attempt> {
	try {
		const out = await callTranslator(ctx, model, systemPrompt, payload, reasoningUnsupported, timedOut, callCeilingMs(!!guards.header), guards.header ? FORMULATE_REASONING : "minimal");
		if (out.stopReason === "error") return { kind: "error", why: timedOut.v ? "timeout" : "transport" };
		const raw = (out.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		// Same class: an abort often yields stopReason "stop" with empty content.
		if (!raw) return { kind: "error", why: timedOut.v ? "timeout" : "transport" };
		// exact match only: pseudo-NONE answers are translation attempts
		// (spec §2), never passthrough.
		if (!guards.rejectNone && raw === "NONE") return { kind: "none" };
		const restored = unmaskProtected(raw, guards.spans);
		if (!restored.ok) return { kind: "reject", guard: "placeholders" }; // lost or duplicated ⟦n⟧
		// Forced target: the allowed-script set can only be derived from
		// QUESTION ∪ DRAFT, so a legitimately forced non-Latin target (e.g.
		// /translator Japanese with a Latin question) could never pass. The
		// leak-class guard is off in forced mode — deliberate, operator request.
		// Formulate mode: the answer carries a language-name line. Strip it BEFORE
		// the guards and before returning, or the name leaks into the transcript and
		// into the model's own future context (docs/06 R2).
		let text = restored.text;
		let lang: string | undefined;
		if (guards.header) {
			const h = splitLanguageHeader(text);
			text = h.text;
			lang = h.lang ?? undefined;
			if (!text) return { kind: "reject", guard: "empty" };
		}
		if (!guards.skipScript && !scriptGuardOk(text, guards.question, guards.draft, guards.extraAllowed ?? "")) return { kind: "reject", guard: "script" };
		// Terse drafts (prose under ~80 chars) translate disproportionally
		// longer in inflecting targets; refusing correct output is worse.
		// A formulation that re-derives wording legitimately lengthens; 4× still
		// caps invented paragraphs (docs/06 guard matrix — never delete the ceiling).
		if (proseOnly(guards.draft).length >= 80 && !lengthOk(text, guards.draft, guards.header ? 4 : 2.5)) return { kind: "reject", guard: "length" };
		if (!guards.skipDiffers && !differsFromSource(text, guards.draft)) return { kind: "reject", guard: "overlap" }; // untranslated/meta output
		return { kind: "text", text, lang };
	} catch {
		return timedOut.v ? { kind: "error", why: "timeout" } : { kind: "error", why: "transport" };
	}
}

/* ---------- extension ---------- */

export default function (pi: ExtensionAPI) {
	let settings: TailSettings | null | undefined; // undefined = not loaded yet
	let enabled = process.env.PI_TRANSLATOR === "1";
	let forced: string | null = null;
	let targetResolved = false;
	let lastUserPrompt = "";
	// Language of the last delivered answer. The ONLY use is a machine-triggered
	// turn (delegation report, scheduled fire) that carries no question: without
	// it there is no evidence at all, and guessing is the silent-skip class.
	let lastLang: string | null = null;
	let lastOriginal = "";
	// reasoning-probe state lives HERE, per extension instance (per session):
	// in a shared host process a module-level Set would let one session's
	// transient failure degrade every other session on that model, forever.
	const reasoningUnsupported = new Set<string>();
	const chmoddedLogs = new Set<string>();
	// working-language text of already-seen summaries, keyed by text digest
	const summaryCache = new Map<string, string | null>();

	const dbg = (msg: string) => {
		if (process.env.PI_TRANSLATOR_DEBUG === "1" || settings?.debug) console.error(`[pi-translator] ${msg}`);
	};
	const notify = (ctx: any, msg: string) => {
		// ctx.hasUI means a dialog-capable UI is available; in --print and dialog-less
		// RPC modes a warning raised there vanishes entirely, and a silent fallback to
		// the working language is exactly the failure nobody notices.
		if (ctx.hasUI) ctx.ui.notify(`pi-translator: ${msg}`, "warning");
		else console.error(`[pi-translator] WARNING: ${msg}`);
		dbg(msg);
	};
	const logLine = (rec: Record<string, unknown>) => {
		const file = process.env.PI_TRANSLATOR_LOG ?? settings?.log;
		if (!file) return;
		try {
			// The record contains the FULL plaintext of one translation (in+out)
			// — a complete bilingual transcript of the session. owner-only, and
			// fix up files created by older versions or other writers.
			// appendFileSync does not create the parent dir and the catch below would
			// swallow the ENOENT, so a deleted log dir would mean silent no-logging.
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 });
			if (!chmoddedLogs.has(file)) {
				try {
					chmodSync(file, 0o600);
				} catch {
					/* foreign-owned file: keep logging, keep trying */
				}
				chmoddedLogs.add(file);
			}
		} catch {
			/* logging must never break delivery */
		}
	};

	function ensureSettings(ctx: any) {
		if (settings !== undefined) return;
		settings = loadSettings(ctx.cwd, typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false);
		if (!targetResolved) {
			const s = settings ?? {};
			if (settings && (s.target ?? "auto") !== "off") enabled = true; // a configured block means intent
			const target = process.env.PI_TRANSLATOR_TARGET ?? s.target ?? "auto";
			if (target === "off") enabled = false;
			else if (target !== "auto") forced = targetName(target);
			if (forced && forced.toLowerCase() === workingName().toLowerCase()) forced = null; // forced→working = a paid echo of the draft
			targetResolved = true;
		}
	}

	const workingName = () => {
		const w = process.env.PI_TRANSLATOR_WORKING ?? settings?.working ?? "en";
		return LANG_NAMES[w] ?? w;
	};
	const modelOverride = () => process.env.PI_TRANSLATOR_MODEL || settings?.model || null;

	/** A delivery target is operator free text — "de", "German", "german". Name it
	 *  the way the prompt needs instead of sending "translate the DRAFT into de". */
	const targetName = (raw: string) => {
		const t = String(raw ?? "").trim();
		return TARGET_LOOKUP[t.toLowerCase()] ?? t;
	};

	// Translator defaults to the agent's own model; an env/settings override
	// pins a different one (e.g. a clean, larger model behind a weak worker).
	function resolveTranslator(ctx: any): { model: any; label: string } | null {
		const spec = modelOverride();
		if (spec) {
			const [provider, ...rest] = spec.split("/");
			const model = ctx.modelRegistry.find(provider, rest.join("/"));
			return model ? { model, label: spec } : null;
		}
		return ctx.model ? { model: ctx.model, label: `${ctx.model.provider}/${ctx.model.id}` } : null;
	}

	async function translateWithRetry(
		ctx: any,
		translator: { model: any; label: string },
		systemPrompt: string,
		source: string,
		guards: Guards,
		direction: "prompt" | "reply" | "summary",
	): Promise<Attempt> {
		const masked = maskProtected(source);
		const payload =
			direction === "reply"
				? `QUESTION:\n${guards.question}\n\nDRAFT:\n${masked.masked}`
				: `USER REQUEST:\n${masked.masked}`;
		const t0 = Date.now();
		const timedOut = { v: false };
		let attempt = await translateOnce(ctx, translator.model, systemPrompt, payload, { ...guards, spans: masked.spans }, reasoningUnsupported, timedOut);
		// retry only what could have been a fluke — see the Attempt comment
		if (attempt.kind === "error" && attempt.why === "transport") attempt = await translateOnce(ctx, translator.model, systemPrompt, payload, { ...guards, spans: masked.spans }, reasoningUnsupported, timedOut);
		logLine({
			dir: direction,
			model: translator.label,
			ms: Date.now() - t0,
			verdict: attempt.kind,
			reason: attempt.kind === "reject" ? attempt.guard : attempt.kind === "error" ? attempt.why : undefined,
			in: source,
			out: attempt.kind === "text" ? attempt.text : undefined,
			// Formulate-mode metrics the falsification gate needs and nothing else
			// writes: which language shipped, how much it grew, whether class-A came
			// in with the draft (docs/06 R4/R7).
			...(guards.header
				? {
						mode: "formulate",
						lang: attempt.kind === "text" ? attempt.lang ?? null : null,
						ratio: attempt.kind === "text" ? ratioOf(attempt.text, source) : null,
						inherited_cjk: foreignScriptIn(guards.draft),
						verbatim: attempt.kind === "text" ? Number(verbatimShare(guards.draft, attempt.text).toFixed(2)) : null,
					}
				: {}),
		});
		return attempt;
	}

	pi.registerCommand("translator", {
		description: "pi-translator: agent works in the working language, final answers delivered in the user's language. /translator [on|off|auto|<language name>]",
		handler: async (args: string, ctx: any) => {
			ensureSettings(ctx);
			const raw = args.trim();
			const a = raw.toLowerCase();
			if (a === "on") enabled = true;
			else if (a === "off") enabled = false;
			else if (a === "auto") {
				enabled = true;
				forced = null;

			} else if (a !== "status" && raw) {
				enabled = true;
				forced = targetName(raw);
				if (forced && forced.toLowerCase() === workingName().toLowerCase()) forced = null; // see ensureSettings

			}
			const appends = Object.keys(settings?.promptAppend ?? {});
			const translator = resolveTranslator(ctx);
			if (ctx.hasUI)
				ctx.ui.notify(
					`pi-translator: ${enabled ? (forced ? `forced → ${forced}` : "auto") : "OFF"} | working ${workingName()} | model ${modelOverride() ?? `agent (${translator ? translator.label : "n/a"})`} | appends ${appends.length ? appends.join(",") : "-"}`,
					"info",
				);
			dbg(`command /translator ${raw || "(status)"} → ${enabled ? (forced ? `forced ${forced}` : "auto") : "off"}`);
		},
	});

	// F4: the working-language original of the last delivered answer.
	pi.registerCommand("translator-original", {
		description: "Show the working-language original of the last translated answer",
		handler: async (_args: string, ctx: any) => {
			if (!lastOriginal) {
				if (ctx.hasUI) ctx.ui.notify("pi-translator: nothing translated yet in this session", "info");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(`pi-translator original:\n\n${lastOriginal}`, "info");
			else console.error(lastOriginal);
		},
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		// Only a real user prompt may redefine the delivery language. A run woken by
		// an injected custom message (delegation_result from the subagents extension)
		// starts with messageType "custom" and NO prompt, so assigning unconditionally
		// cleared lastUserPrompt and the reply guard below silently skipped
		// translation — the answer shipped in the working language.
		if (typeof event.prompt === "string" && event.prompt) lastUserPrompt = event.prompt;
		ensureSettings(ctx);
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		if (enabled) sections.pi_translator = workingGuideline(workingName());
		else delete sections.pi_translator;
	});

	// F2: the model reads English. The user's original text stays in the
	// transcript and UI; the working-language version rides along as message
	// metadata and is swapped in by the `context` handler (F1).
	// ask_user form translation: the tool-call ARGUMENTS are what the human
	// reads. Same gate as the reply path (English chat → nothing to deliver).
	// The English original is kept as metadata; the `context` handler restores
	// it, so tool-call history stays working-language for the model.
	async function translateUiForm(msg: any, ctx: any): Promise<any | undefined> {
		const translator = resolveTranslator(ctx);
		if (!translator) {
			notify(ctx, "no translator model — questions stay in the working language");
			return undefined;
		}
		const blocks: number[] = [];
		const perBlock: string[][] = [];
		const strings: string[] = [];
		msg.content.forEach((b: any, i: number) => {
			if ((b.type === "toolCall" || b.type === "toolUse") && b.name === "ask_user") {
				const s = collectUiStrings(b.arguments);
				if (s.length) {
					blocks.push(i);
					perBlock.push(s);
					strings.push(...s);
				}
			}
		});
		if (!strings.length) return undefined;
		const systemPrompt = buildBatchTranslatePrompt(workingName(), renderAppend(settings?.promptAppend), forced, strings.length);
		// Mask ONLY the segments: the QUESTION is context the translator must
		// not echo, so masking it would mint ⟦n⟧ placeholders the reply can
		// never contain → unmaskProtected fails by construction whenever the
		// user's prompt carries a path or URL (review MAJOR).
		const masked = maskProtected(JSON.stringify(strings));
		const payload = `QUESTION:\n${lastUserPrompt}\n\nSEGMENTS:\n${masked.masked}`;
		const guards = { question: lastUserPrompt, draft: strings.join("\n"), spans: masked.spans, rejectNone: false, extraAllowed: workingName(), skipDiffers: true, skipScript: !!forced };
		const t0 = Date.now();
		// No retry here: for forms the English fallback IS the UX, and a
		// wobbly endpoint would pay double latency on every form (review #4.3).
		const attempt = await translateOnce(ctx, translator.model, systemPrompt, payload, guards, reasoningUnsupported, { v: false });
		logLine({ dir: "form", model: translator.label, ms: Date.now() - t0, verdict: attempt.kind, in: strings.join("\n"), out: attempt.kind === "text" ? attempt.text : undefined });
		if (attempt.kind !== "text") {
			if (failed(attempt)) notify(ctx, "question-form translation failed — questions stay in the working language");
			return undefined;
		}
		const translated = parseBatchReply(attempt.text, strings.length);
		if (!translated) {
			notify(ctx, "question-form translation lost segments — questions stay in the working language");
			return undefined;
		}
		const content = [...msg.content];
		const toolArgs: Record<string, any> = {};
		let off = 0;
		for (let k = 0; k < blocks.length; k++) {
			const i = blocks[k];
			const rebuilt = applyUiStrings(msg.content[i].arguments, translated.slice(off, off + perBlock[k].length));
			off += perBlock[k].length;
			if (!rebuilt) {
				notify(ctx, "question-form structure changed during translation — questions stay in the working language");
				return undefined;
			}
			content[i] = { ...msg.content[i], arguments: rebuilt };
			toolArgs[String(i)] = msg.content[i].arguments;
		}
		dbg(`form translated (${strings.length} segments via ${translator.label})`);
		return { message: { ...msg, content, [META_KEY]: { ...(msg as any)[META_KEY], toolArgs } } };
	}

	pi.on("message_end", async (event: any, ctx: any) => {
		const msg = event.message;

		if (msg.role === "user") {
			ensureSettings(ctx);
			const text = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
			// A user message without human text (queued marker, empty steer) carries no
			// language evidence — resetting here would drop the verdict to "already
			// English" and ship the answer untranslated, the same class as the
			// before_agent_start bug fixed in 6a325a5.
			if (!text.trim()) return;
			// Reply payload QUESTION must track the LATEST user text, not just the
			// turn opener: a mid-turn German follow-up into an English-opening
			// turn would otherwise be answered in English, silently (review MEDIUM).
			lastUserPrompt = text;
			// F4 (docs/06): nothing else runs on a human turn. The request reaches the
			// model exactly as written and the delivery language is decided by the
			// formulation call itself — a pre-start call bought a gate that no longer
			// exists. Machine-triggered turns never get here: they carry no text.
			return;
		}

		if (msg.role !== "assistant") return;
		ensureSettings(ctx);
		if (!enabled) return;
		// ask_user forms: the arguments are the human-visible payload. Same call
		// regardless of language — its own NONE contract handles same-language.
		if (msg.content.some((b: any) => (b.type === "toolCall" || b.type === "toolUse") && b.name === "ask_user")) return translateUiForm(msg, ctx);
		// Intermediate narration carries tool calls: never the final answer.
		if (msg.content.some((b: any) => b.type === "toolCall" || b.type === "toolUse")) return;
		const textBlocks = msg.content.filter((b: any) => b.type === "text");
		if (textBlocks.length === 0) return;
		const draft = textBlocks.map((b: any) => b.text).join("\n\n").trim();
		// Empty bubbles are an upstream generation bug, not ours to mask.
		if (!draft) return;
		// Never silent: this skip ships the answer in the working language. It also
		// has to land in the audit log — a skip that leaves no row makes the whole
		// delivery population unreadable (docs/06 R4).
		// No question and no remembered language = no evidence for a target. Deliver
		// as written, visibly, and never guess a language (docs/05 "Unknown ≠ English").
		if (!lastUserPrompt && !forced && !lastLang) {
			logLine({ dir: "reply", model: null, ms: 0, verdict: "skip", reason: "no-language-evidence", in: draft });
			dbg("reply: no question and no remembered language → delivering as written");
			return;
		}

		const translator = resolveTranslator(ctx);
		if (!translator) {
			notify(ctx, modelOverride() ? `translator model ${modelOverride()} not found — keeping working language` : "no current model available — keeping working language");
			return;
		}

		// Owner decision: every answer is formulated, same-language ones included,
		// so NONE would mean "the polisher did nothing" — rejectNone turns it into a
		// visible failure instead of a silent raw delivery.
		const target = forced ?? lastLang;
		const systemPrompt = buildFormulatePrompt(workingName(), renderAppend(settings?.promptAppend), target);
		const attempt = await translateWithRetry(ctx, translator, systemPrompt, draft, { question: lastUserPrompt, draft, spans: [], rejectNone: true, skipScript: !!forced, skipDiffers: true, header: true }, "reply");
		if (failed(attempt)) {
			notify(ctx, `translation ${attempt.kind === "reject" ? `rejected by the ${attempt.guard} guard` : `failed (${attempt.why})`} (${translator.label}) — delivering original answer`);
			return;
		}
		if (attempt.kind === "none") {
			// Unreachable with rejectNone; kept so a future guard change cannot turn
			// "the polisher said NONE" back into a silent raw delivery.
			logLine({ dir: "reply", model: translator.label, ms: 0, verdict: "none", mode: "formulate", in: draft });
			notify(ctx, "formulation returned NONE — delivering the draft as written");
			return;
		}
		if (attempt.lang) lastLang = attempt.lang; // the fallback for question-less turns
		// A formulation identical to the draft is the weak-model signature (R7 M2).
		// Deliver the draft and log it — silently passing it off as formulated would
		// hide exactly the failure the owner's model decision has to be measured on.
		if (normText(attempt.text) === normText(draft)) {
			logLine({ dir: "reply", model: translator.label, ms: 0, verdict: "noop", mode: "formulate", lang: attempt.lang ?? null, in: draft, out: attempt.text });
			dbg("reply: formulation changed nothing (polisher did nothing)");
			return;
		}
		lastOriginal = draft;
		dbg(`reply formulated (${target ?? "inferred from question"} via ${translator.label}, ${draft.length} → ${attempt.text.length} chars)`);
		// F1: the English draft stays reachable as metadata; `context` hands it
		// back to the model on every later call.
		return {
			message: {
				...msg,
				content: replaceText(msg.content, attempt.text),
				[META_KEY]: { original: draft } satisfies TranslatorMeta,
			},
		};
	});

	// F1: before every LLM call the model gets working-language originals —
	// the transcript keeps the user-language deliveries. Runs regardless of
	// `enabled`: the invariant belongs to the data, not the toggle.
	pi.on("context", async (event: any, ctx: any) => {
		let restored = 0;
		let out = event.messages;
		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i];
			const meta: TranslatorMeta | undefined = msg?.[META_KEY];
			// Only assistant messages carry a restore today: the user side reads the
			// original since F3, and its metadata (userLang) is state, not content.
			if (!meta || msg.role !== "assistant") continue;
			let content: any = undefined;
			if (msg.role === "assistant" && Array.isArray(msg.content) && (typeof meta.original === "string" || meta.toolArgs)) {
				// Sequential, not exclusive: one message could carry BOTH a
				// translated draft and translated tool args; an if/else chain
				// would silently skip one restore and leak target-language
				// content into the model context.
				content = msg.content;
				if (typeof meta.original === "string") content = replaceText(content, meta.original);
				if (meta.toolArgs) content = content.map((b: any, j: number) => (meta.toolArgs![String(j)] === undefined ? b : { ...b, arguments: meta.toolArgs![String(j)] }));
			}
			if (content === undefined) continue;
			if (out === event.messages) out = [...event.messages]; // copy-on-write; never mutate the session objects
			out[i] = { ...msg, content };
			restored++;
		}
		// Compaction and branch summaries are the one text pi builds from the STORED
		// (user-language) deliveries: the summarizer never runs through pi's
		// transformContext, so the model's context would keep growing target-language
		// text — the exact long-context regime this extension exists to keep out. Hand
		// the model a working-language summary instead. Keyed by a text digest, not by
		// object identity: pi hands handlers a clone of the messages every request, so
		// identity would re-translate the same summary on every single call.
		for (let i = 0; i < out.length; i++) {
			const msg = out[i];
			if (msg?.role !== "compactionSummary" && msg?.role !== "branchSummary") continue;
			const src = typeof msg.summary === "string" ? msg.summary : "";
			if (!src.trim()) continue;
			const key = `${src.length}\u0000${src.slice(0, 60)}\u0000${src.slice(-40)}`;
			let working = summaryCache.get(key);
			if (working === undefined) {
				const translator = resolveTranslator(ctx);
				if (!translator) continue;
				const attempt = await translateWithRetry(ctx, translator, buildPromptTranslatePrompt(workingName()), src, { question: src, draft: src, spans: [], rejectNone: false, extraAllowed: workingName(), skipDiffers: true }, "summary");
				working = attempt.kind === "text" ? attempt.text : null;
				if (summaryCache.size > 8) summaryCache.clear();
				summaryCache.set(key, working);
				dbg(working ? `summary → ${workingName()} for the model (${src.length} → ${working.length} chars)` : `summary kept as-is (${attempt.kind})`);
			}
			if (!working) continue;
			if (out === event.messages) out = [...event.messages]; // copy-on-write; never mutate the session objects
			out[i] = { ...msg, summary: working };
			restored++;
		}
		if (restored > 0) dbg(`context: ${restored} message(s) restored to working language for the model`);
		if (out !== event.messages) return { messages: out };
	});
}

/* ---------- ask_user form translation (outbound UI) ---------- */

/** ask_user / ask_caller args are the ONLY outbound tool payloads a human
 *  reads. Translate the human fields (question/detail/option label/option
 *  detail); machine fields (id, value, multiple, count) stay byte-identical.
 *  Schema is FIXED to the ask_user contract — an unexpected shape yields an
 *  empty list (never guess), so a changed tool simply stops being translated. */
export function collectUiStrings(args: any): string[] {
	const out: string[] = [];
	for (const q of Array.isArray(args?.questions) ? args.questions : []) {
		if (typeof q?.question === "string" && q.question.trim()) out.push(q.question);
		if (typeof q?.detail === "string" && q.detail.trim()) out.push(q.detail);
		for (const o of Array.isArray(q?.options) ? q.options : []) {
			if (typeof o?.label === "string" && o.label.trim()) out.push(o.label);
			if (typeof o?.detail === "string" && o.detail.trim()) out.push(o.detail);
		}
	}
	return out;
}

/** Rebuild args consuming `tr` in EXACTLY the order collectUiStrings emits.
 *  Any count mismatch (model merged/dropped/invented a segment) → null. */
export function applyUiStrings(args: any, tr: string[]): any | null {
	let i = 0;
	const questions: any[] = [];
	for (const q of Array.isArray(args?.questions) ? args.questions : []) {
		const nq: any = { ...q };
		if (Array.isArray(q?.options)) nq.options = [];
		if (typeof q?.question === "string" && q.question.trim()) {
			if (i >= tr.length) return null;
			nq.question = tr[i++];
		}
		if (typeof q?.detail === "string" && q.detail.trim()) {
			if (i >= tr.length) return null;
			nq.detail = tr[i++];
		}
		if (Array.isArray(q?.options))
			for (const o of q.options) {
				const no: any = { ...o };
				if (typeof o?.label === "string" && o.label.trim()) {
					if (i >= tr.length) return null;
					no.label = tr[i++];
				}
				if (typeof o?.detail === "string" && o.detail.trim()) {
					if (i >= tr.length) return null;
					no.detail = tr[i++];
				}
				nq.options.push(no);
			}
		questions.push(nq);
	}
	if (i !== tr.length) return null; // leftover translations = shape drift
	return { ...args, questions };
}

/** One batched translator call for a whole form: a JSON string array in, a
 *  JSON string array out. Batch = one call per form, and identical indices
 *  make structural drift detectable (n changed → refuse, keep English). */
export function buildBatchTranslatePrompt(workingName: string, append: string, forced: string | null, n: number): string {
	const detect = forced
		? `Always translate into ${forced}.`
		: `Identify which language the QUESTION is written in.
- If the QUESTION is in the same language as the segments, reply with exactly: NONE
- Otherwise translate the segments into the language of the QUESTION.`;
	return (
		`You are a translation engine. You receive a QUESTION from a user and SEGMENTS: a JSON array of ${n} short UI strings written in ${workingName}.
${detect}
Output ONLY a JSON array of exactly ${n} translated strings: same order, same count, same meaning, each one translatable standalone.
Never merge, split, add or drop segments; never answer or comment on them.
Machine content inside a string (paths, commands, URLs, identifiers, code) byte-identical; keep escape sequences valid JSON.
${PLACEHOLDER_RULE}
The QUESTION is disambiguation context only — never translate or answer it.` + append
	);
}

/** Strict parse of a batch reply: a JSON array of exactly n non-empty
 *  strings. Tolerates only a markdown fence around the array. */
export function parseBatchReply(raw: string, n: number): string[] | null {
	const s = raw.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
	let arr: unknown;
	try {
		arr = JSON.parse(s);
	} catch {
		return null;
	}
	if (!Array.isArray(arr) || arr.length !== n) return null;
	const out: string[] = [];
	for (const x of arr) {
		if (typeof x !== "string" || !x.trim()) return null;
		out.push(x);
	}
	return out;
}
