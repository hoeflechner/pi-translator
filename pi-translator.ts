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
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// shortcut: names for naming the working/forced language in the prompt only;
// raw code is the fallback for anything unlisted. Not a target-language table.
const LANG_NAMES: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian" };

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
export function lengthOk(outText: string, draft: string): boolean {
	const a = proseOnly(outText).length;
	const b = Math.max(1, proseOnly(draft).length);
	return a >= 0.4 * b && a <= 2.5 * b;
}

/** Latin↔Latin blind spot of the script guard: a translator that outputs
 *  working-language text (or meta-commentary) instead of translating is
 *  invisible to script checks. A real translation shares almost no word
 *  forms with the source; an untranslated output shares nearly all of them.
 *  Failing here is safe: retry, and the fallback (the original draft) is
 *  what the bad output degenerated to anyway. Short sources carry too
 *  little signal to judge → always pass. */
export function differsFromSource(outText: string, source: string): boolean {
	const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
	const src = words(source);
	if (src.size < 8) return true;
	const out = [...words(outText)];
	if (out.length === 0) return false;
	const shared = out.filter((w) => src.has(w)).length;
	return shared / out.length < 0.6;
}

/** F3 (docs/05): mask protected spans with ⟦n⟧ placeholders before any
 *  translation call; restored verbatim afterwards. Placeholders use brackets
 *  no translator plausibly rewrites, and completeness is asserted on restore. */
const PROTECTED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|https?:\/\/\S+|(?:^|[\s(])~?\/[\w.\-\/@]{2,}(?![\w.-])/gm;

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
export function buildSystemPrompt(workingName: string, append: string, forced: string | null): string {
	const detect = forced
		? `Always translate the DRAFT into ${forced}.`
		: `Identify which language the QUESTION is written in.
- If the QUESTION is in the same language as the DRAFT, reply with exactly: NONE
- Otherwise translate the DRAFT into the language of the QUESTION.`;
	return (
		`You are a translation engine. You receive a QUESTION from a user and a DRAFT answer written in ${workingName}.
${detect}
Output only the translated text — no comments, no copy of the source, no answering the question yourself.
Preserve markdown structure exactly; code fences, inline code, paths, commands and URLs byte-identical.
${PLACEHOLDER_RULE}
The QUESTION is disambiguation context only — never translate or answer it.` + append
	);
}

/** The worker-side guideline, injected as system prompt section
 *  `pi_translator` while enabled. Without this the model drafts directly in
 *  the user's language (AGENTS.md, memories and conversation pull it that
 *  way), the reply call merely restyles, and the working-language promise
 *  for the transcript and the prompt cache silently breaks. */
export function workingGuideline(name: string): string {
	return (
		`Working-language mode is active: generate ALL text you produce — internal reasoning/thinking and answer drafts alike — in ${name} only. ` +
		`Never write user-facing text in the user's language, even when project instructions, injected memories, or conversation history appear to ask for it: ` +
		`incoming user text is translated into ${name} before you read it, and your final message is rewritten into the user's language by a translation layer on delivery. ` +
		`"Answer in the user's language" preferences are satisfied by that layer — they are not your job. ` +
		`Code, commands, paths, identifiers and quoted material are written normally. ` +
		`If you catch yourself drafting in the user's language, redraft in ${name}.`
	);
}

/** F2 (docs/05): faithful request translation into the working language.
 *  No style appends here — user-request translation must not be restyled. */
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
	/** user messages: working-language version the model should read */
	modelText?: string;
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

type Attempt = { kind: "none" } | { kind: "text"; text: string } | { kind: "fail" };

// Translator call. reasoning "minimal": translation needs no thinking, and the
// measured empty-completion class (01-findings §5) is a thinking-budget
// overflow — cap it at the lowest level here. Some models reject that thinking
// level outright (field report: one locally served MoE endpoint answers
// "error" with empty content) — one probe per model, then call without it.
// The probe Set is PER SESSION (factory scope, passed in): a module-scoped Set
// in a multi-session host process lets one session's transient network blip
// permanently flip every user's sessions on that model (review MEDIUM).
async function callTranslator(ctx: any, model: any, systemPrompt: string, payload: string, reasoningUnsupported: Set<string>): Promise<any> {
	const key = `${model.provider}/${model.id}`;
	const request = { systemPrompt, messages: [{ role: "user", timestamp: Date.now(), content: payload }] };
	const opts: any = { signal: ctx.signal };
	if (!reasoningUnsupported.has(key)) opts.reasoning = "minimal";
	const out = await ctx.modelRegistry.streamSimple(model, request, opts).result();
	const text = (out.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
	if (text || reasoningUnsupported.has(key)) return out;
	reasoningUnsupported.add(key);
	return ctx.modelRegistry.streamSimple(model, request, { signal: ctx.signal }).result();
}

async function translateOnce(
	ctx: any,
	model: any,
	systemPrompt: string,
	payload: string,
	guards: { question: string; draft: string; spans: string[]; rejectNone: boolean; extraAllowed?: string; skipDiffers?: boolean; skipScript?: boolean },
	reasoningUnsupported: Set<string>,
): Promise<Attempt> {
	try {
		const out = await callTranslator(ctx, model, systemPrompt, payload, reasoningUnsupported);
		if (out.stopReason === "error") return { kind: "fail" };
		const raw = (out.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		if (!raw) return { kind: "fail" };
		// exact match only: pseudo-NONE answers are translation attempts
		// (spec §2), never passthrough.
		if (!guards.rejectNone && raw === "NONE") return { kind: "none" };
		const restored = unmaskProtected(raw, guards.spans);
		if (!restored.ok) return { kind: "fail" }; // lost or duplicated ⟦n⟧
		// Forced target: the allowed-script set can only be derived from
		// QUESTION ∪ DRAFT, so a legitimately forced non-Latin target (e.g.
		// /translator Japanese with a Latin question) could never pass. The
		// leak-class guard is off in forced mode — deliberate, operator request.
		if (!guards.skipScript && !scriptGuardOk(restored.text, guards.question, guards.draft, guards.extraAllowed ?? "")) return { kind: "fail" };
		// Terse drafts (prose under ~80 chars) translate disproportionally
		// longer in inflecting targets; refusing correct output is worse.
		if (proseOnly(guards.draft).length >= 80 && !lengthOk(restored.text, guards.draft)) return { kind: "fail" };
		if (!guards.skipDiffers && !differsFromSource(restored.text, guards.draft)) return { kind: "fail" }; // untranslated/meta output
		return { kind: "text", text: restored.text };
	} catch {
		return { kind: "fail" };
	}
}

/* ---------- extension ---------- */

export default function (pi: ExtensionAPI) {
	let settings: TailSettings | null | undefined; // undefined = not loaded yet
	let enabled = process.env.PI_TRANSLATOR === "1";
	let forced: string | null = null;
	let targetResolved = false;
	let lastUserPrompt = "";
	let questionIsWorkingLang = true; // set by the prompt-translation verdict
	let lastOriginal = "";
	// reasoning-probe state lives HERE, per extension instance (per session):
	// in a shared host process a module-level Set would let one session's
	// transient failure degrade every other session on that model, forever.
	const reasoningUnsupported = new Set<string>();
	const chmoddedLogs = new Set<string>();

	const dbg = (msg: string) => {
		if (process.env.PI_TRANSLATOR_DEBUG === "1" || settings?.debug) console.error(`[pi-translator] ${msg}`);
	};
	const notify = (ctx: any, msg: string) => {
		if (ctx.hasUI) ctx.ui.notify(`pi-translator: ${msg}`, "warning");
		dbg(msg);
	};
	const logLine = (rec: Record<string, unknown>) => {
		const file = process.env.PI_TRANSLATOR_LOG ?? settings?.log;
		if (!file) return;
		try {
			// The record contains the FULL plaintext of one translation (in+out)
			// — a complete bilingual transcript of the session. owner-only, and
			// fix up files created by older versions or other writers.
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
			else if (target !== "auto") forced = target;
			targetResolved = true;
		}
	}

	const workingName = () => {
		const w = process.env.PI_TRANSLATOR_WORKING ?? settings?.working ?? "en";
		return LANG_NAMES[w] ?? w;
	};
	const modelOverride = () => process.env.PI_TRANSLATOR_MODEL || settings?.model || null;

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
		guards: { question: string; draft: string; spans: string[]; rejectNone: boolean; extraAllowed?: string; skipDiffers?: boolean },
		direction: "prompt" | "reply",
	): Promise<Attempt> {
		const masked = maskProtected(source);
		const payload =
			direction === "reply"
				? `QUESTION:\n${guards.question}\n\nDRAFT:\n${masked.masked}`
				: `USER REQUEST:\n${masked.masked}`;
		const t0 = Date.now();
		let attempt = await translateOnce(ctx, translator.model, systemPrompt, payload, { ...guards, spans: masked.spans }, reasoningUnsupported);
		if (attempt.kind === "fail") attempt = await translateOnce(ctx, translator.model, systemPrompt, payload, { ...guards, spans: masked.spans }, reasoningUnsupported);
		logLine({
			dir: direction,
			model: translator.label,
			ms: Date.now() - t0,
			verdict: attempt.kind,
			in: source,
			out: attempt.kind === "text" ? attempt.text : undefined,
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
				forced = raw;
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
		lastUserPrompt = event.prompt;
		ensureSettings(ctx);
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		if (enabled) sections.pi_translator = workingGuideline(workingName());
		else delete sections.pi_translator;
	});

	// F2: the model reads English. The user's original text stays in the
	// transcript and UI; the working-language version rides along as message
	// metadata and is swapped in by the `context` handler (F1).
	pi.on("message_end", async (event: any, ctx: any) => {
		const msg = event.message;

		if (msg.role === "user") {
			ensureSettings(ctx);
			questionIsWorkingLang = true; // reset each turn; the verdict below decides
			const text = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
			// Reply payload QUESTION must track the LATEST user text, not just the
			// turn opener: a mid-turn German follow-up into an English-opening
			// turn would otherwise be answered in English, silently (review MEDIUM).
			if (text.trim()) lastUserPrompt = text;
			if (!enabled || !text.trim()) return;
			const translator = resolveTranslator(ctx);
			if (!translator) {
				questionIsWorkingLang = false; // unknown is NOT "already English" — let the reply attempt surface the breakage
				return;
			}
			// Prompt translation is independent of the forced reply target: the
			// model must read the working language whatever language we deliver in.
			const attempt = await translateWithRetry(ctx, translator, buildPromptTranslatePrompt(workingName()), text, { question: text, draft: text, spans: [], rejectNone: false, extraAllowed: "a b c d e f g", skipDiffers: true }, "prompt");
			if (attempt.kind === "none") {
				questionIsWorkingLang = true;
				dbg("prompt: already working language → passthrough");
				return;
			}
			if (attempt.kind === "fail") {
				questionIsWorkingLang = false;
				notify(ctx, "request translation failed — model sees your original text");
				return;
			}
			questionIsWorkingLang = false;
			dbg(`prompt translated (${text.length} → ${attempt.text.length} chars)`);
			return { message: { ...msg, [META_KEY]: { modelText: attempt.text } satisfies TranslatorMeta } };
		}

		if (msg.role !== "assistant") return;
		ensureSettings(ctx);
		if (!enabled) return;
		// Intermediate narration carries tool calls: never the final answer.
		if (msg.content.some((b: any) => b.type === "toolCall" || b.type === "toolUse")) return;
		const textBlocks = msg.content.filter((b: any) => b.type === "text");
		if (textBlocks.length === 0) return;
		const draft = textBlocks.map((b: any) => b.text).join("\n\n").trim();
		// Empty bubbles are an upstream generation bug, not ours to mask.
		if (!draft || !lastUserPrompt) return;

		// Reply gate: the prompt-translation verdict already told us the
		// question is in the working language → nothing to translate to.
		if (!forced && questionIsWorkingLang) {
			dbg("reply: question in working language → no delivery translation");
			return;
		}

		const translator = resolveTranslator(ctx);
		if (!translator) {
			notify(ctx, modelOverride() ? `translator model ${modelOverride()} not found — keeping working language` : "no current model available — keeping working language");
			return;
		}

		const systemPrompt = buildSystemPrompt(workingName(), renderAppend(settings?.promptAppend), forced);
		const attempt = await translateWithRetry(ctx, translator, systemPrompt, draft, { question: lastUserPrompt, draft, spans: [], rejectNone: !!forced, skipScript: !!forced }, "reply");
		if (attempt.kind === "fail") {
			notify(ctx, `translation failed or violated validation (${translator.label}) — delivering original answer`);
			return;
		}
		if (attempt.kind === "none") {
			dbg("reply: same language → passthrough");
			return;
		}
		lastOriginal = draft;
		dbg(`reply translated (${forced ?? "auto-detected"} via ${translator.label}, ${draft.length} → ${attempt.text.length} chars)`);
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
	pi.on("context", async (event: any) => {
		let restored = 0;
		let out = event.messages;
		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i];
			const meta: TranslatorMeta | undefined = msg?.[META_KEY];
			if (!meta || (msg.role !== "user" && msg.role !== "assistant")) continue;
			let content: any = undefined;
			if (msg.role === "assistant" && typeof meta.original === "string" && Array.isArray(msg.content)) {
				content = replaceText(msg.content, meta.original);
			} else if (msg.role === "user" && typeof meta.modelText === "string") {
				content = typeof msg.content === "string" ? meta.modelText : replaceText(msg.content ?? [], meta.modelText);
			}
			if (content === undefined) continue;
			if (out === event.messages) out = [...event.messages]; // copy-on-write; never mutate the session objects
			out[i] = { ...msg, content };
			restored++;
		}
		if (restored > 0) dbg(`context: ${restored} message(s) restored to working language for the model`);
		if (out !== event.messages) return { messages: out };
	});
}
