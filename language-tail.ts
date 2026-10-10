/**
 * language-tail — the agent always works in the working language (English by
 * default); every final answer is delivered in the user's language by ONE
 * context-free LLM call that detects that language itself.
 *
 * Spec: docs/03-design-language-tail.md (this file implements it 1:1).
 * Evidence for why: docs/01-findings.md + docs/02-architecture.md.
 *
 * No detector, no language tables, no per-language prompt text: the
 * translator receives QUESTION + DRAFT and either replies "NONE" (same
 * language → passthrough) or translates into the question's language.
 * Style wishes are user-supplied `promptAppend` entries rendered into the
 * generic prompt; the translator applies the ones matching its target.
 *
 * Boot: LANG_TAIL=1, or a "language-tail" block in settings (see spec §5).
 * Per session: /langtail [on|off|auto|<language name>].
 * Env: LANG_TAIL_WORKING, LANG_TAIL_TARGET, LANG_TAIL_MODEL, LANG_TAIL_DEBUG=1.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// shortcut: names for naming the working/forced language in the prompt only;
// raw code is the fallback for anything unlisted. Not a target-language table.
const LANG_NAMES: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian" };

/* ---------- pure helpers (exported for language-tail.test.ts) ---------- */

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
 *  in QUESTION ∪ DRAFT. Catches the measured CJK-leak class table-free; a
 *  CJK question legitimately licenses CJK output. */
export function scriptGuardOk(outText: string, question: string, draft: string): boolean {
	const allowed = scriptsOf(`${question}\n${draft}`);
	for (const s of scriptsOf(proseOnly(outText))) if (!allowed.has(s)) return false;
	return true;
}

/** Spec §4.4: translation prose length within [0.4×, 2.5×] of draft prose. */
export function lengthOk(outText: string, draft: string): boolean {
	const a = proseOnly(outText).length;
	const b = Math.max(1, proseOnly(draft).length);
	return a >= 0.4 * b && a <= 2.5 * b;
}

/** Spec §3 {append}: general ("*") entries verbatim, per-language ones
 *  labeled — the translator itself decides which label matches its target. */
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

/** Spec §3: the ONE generic template. `forced` (from /langtail <name> or
 *  LANG_TAIL_TARGET) replaces the detect/NONE block; no passthrough then. */
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
Preserve markdown structure; code fences, inline code, paths, commands and URLs byte-identical.
The QUESTION is disambiguation context only — never translate or answer it.` + append
	);
}

/* ---------- settings (same file layout @samfp/pi-memory reads) ---------- */

interface TailSettings {
	working?: string;
	target?: string;
	model?: string;
	promptAppend?: Record<string, string>;
}

function loadSettings(cwd: string): TailSettings | null {
	// shortcut: first block wins (project overrides global); merge per-key when it ever bites.
	for (const path of [join(cwd, ".pi", "settings.json"), join(homedir(), ".pi", "agent", "settings.json")]) {
		try {
			const block = JSON.parse(readFileSync(path, "utf-8"))?.["language-tail"];
			if (block && typeof block === "object") return block as TailSettings;
		} catch {
			/* missing or invalid file = fall through to defaults */
		}
	}
	return null;
}

/* ---------- translation attempt ---------- */

type Attempt = { kind: "none" } | { kind: "text"; text: string } | { kind: "fail" };

async function translateOnce(
	ctx: any,
	model: any,
	systemPrompt: string,
	question: string,
	draft: string,
	forced: string | null,
): Promise<Attempt> {
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: `QUESTION:\n${question}\n\nDRAFT:\n${draft}`,
					},
				],
			},
			// reasoning "minimal": translation needs no thinking, and the
			// measured empty-completion class (01-findings §5) is a
			// thinking-budget overflow — cap it at the lowest level here.
			{ signal: ctx.signal, reasoning: "minimal" },
		);
		const out = await stream.result();
		if (out.stopReason === "error") return { kind: "fail" };
		const text = (out.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		if (!text) return { kind: "fail" };
		// exact match only: pseudo-NONE answers are translation attempts
		// (spec §2) and die at the length guard below, never passthrough.
		if (!forced && text === "NONE") return { kind: "none" };
		if (!scriptGuardOk(text, question, draft)) return { kind: "fail" };
		if (!lengthOk(text, draft)) return { kind: "fail" };
		return { kind: "text", text };
	} catch {
		return { kind: "fail" };
	}
}

/* ---------- extension ---------- */

export default function (pi: ExtensionAPI) {
	let settings: TailSettings | null | undefined; // undefined = not loaded yet
	let enabled = process.env.LANG_TAIL === "1";
	let forced: string | null = null;
	let targetResolved = false;
	let lastUserPrompt = "";

	const dbg = (msg: string) => {
		if (process.env.LANG_TAIL_DEBUG === "1") console.error(`[langtail] ${msg}`);
	};
	const notify = (ctx: any, msg: string) => {
		if (ctx.hasUI) ctx.ui.notify(`language-tail: ${msg}`, "warning");
		dbg(msg);
	};

	function ensureSettings(ctx: any) {
		if (settings !== undefined) return;
		settings = loadSettings(ctx.cwd);
		if (!targetResolved) {
			const s = settings ?? {};
			if (settings && (s.target ?? "auto") !== "off") enabled = true; // a configured block means intent
			const target = process.env.LANG_TAIL_TARGET ?? s.target ?? "auto";
			if (target === "off") enabled = false;
			else if (target !== "auto") forced = target;
			targetResolved = true;
		}
	}

	const workingName = () => {
		const w = process.env.LANG_TAIL_WORKING ?? settings?.working ?? "en";
		return LANG_NAMES[w] ?? w;
	};
	const modelSpec = () => process.env.LANG_TAIL_MODEL ?? settings?.model ?? "the local dense model";

	pi.registerCommand("langtail", {
		description: "Language tail: agent works in the working language, final answers delivered in the user's language. /langtail [on|off|auto|<language name>]",
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
			if (ctx.hasUI)
				ctx.ui.notify(
					`language-tail: ${enabled ? (forced ? `forced → ${forced}` : "auto") : "OFF"} | working ${workingName()} | model ${modelSpec()} | appends ${appends.length ? appends.join(",") : "-"}`,
					"info",
				);
			dbg(`command /langtail ${raw || "(status)"} → ${enabled ? (forced ? `forced ${forced}` : "auto") : "off"}`);
		},
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		lastUserPrompt = event.prompt;
		ensureSettings(ctx);
		if (!enabled) return;
		const guideline = `Working language: always think, narrate tool use, and produce final answers in ${workingName()}, regardless of the language the user writes in. Never answer in the user's language yourself — a downstream translation stage handles delivery in the user's language.`;
		const g = event.systemPromptOptions.promptGuidelines;
		if (!g.includes(guideline)) g.push(guideline);
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		ensureSettings(ctx);
		if (!enabled) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		// Intermediate narration carries tool calls: never the final answer.
		if (msg.content.some((b: any) => b.type === "toolCall" || b.type === "toolUse")) return;
		const textBlocks = msg.content.filter((b: any) => b.type === "text");
		if (textBlocks.length === 0) return;
		const draft = textBlocks.map((b: any) => b.text).join("\n\n").trim();
		// Empty bubbles are an upstream generation bug, not ours to mask.
		if (!draft || !lastUserPrompt) return;

		const [provider, ...rest] = modelSpec().split("/");
		const model = ctx.modelRegistry.find(provider, rest.join("/"));
		if (!model) {
			notify(ctx, `translator model ${modelSpec()} not found — keeping working language`);
			return;
		}

		const systemPrompt = buildSystemPrompt(workingName(), renderAppend(settings?.promptAppend), forced);
		let attempt = await translateOnce(ctx, model, systemPrompt, lastUserPrompt, draft, forced);
		if (attempt.kind === "fail") attempt = await translateOnce(ctx, model, systemPrompt, lastUserPrompt, draft, forced);
		if (attempt.kind === "fail") {
			notify(ctx, "translation failed or violated validation — delivering original answer");
			return;
		}
		if (attempt.kind === "none") {
			dbg("same language → passthrough");
			return;
		}
		dbg(`translated (${forced ?? "auto-detected"}, ${draft.length} → ${attempt.text.length} chars)`);
		const nonText = msg.content.filter((b: any) => b.type !== "text");
		return { message: { ...msg, content: [...nonText, { type: "text", text: attempt.text }] } };
	});
}
