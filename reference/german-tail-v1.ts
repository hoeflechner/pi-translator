/**
 * german-tail — agent works in English; the final answer is translated to
 * German by a fresh, context-free model call when the user asked in German.
 *
 * Why: the local MoE model corrupts German morphology (CJK morpheme fusion,
 * invented compounds) in long contexts (measured: ~10% artifact rate < 60k
 * tokens → ~24% at 154–234k) while it stays clean in English. Translation
 * happens in a fresh short context = the measured-clean regime, on a clean
 * model (default: the local dense model, the local dense model, 0/64 artifacts in the misc
 * transcript analysis).
 *
 * Toggle per session: /gtranslate [on|off]. Boot-time default via
 * GERMAN_TAIL=1. Translator model via GERMAN_TAIL_MODEL=provider/id.
 *
 * Every translated answer is appended as session entry `german-tail`
 * ({question, english, german}) — this doubles as the harvest corpus for the
 * future DPO/GRPO work on the translator.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const GUIDELINE =
	"Working language: always think, narrate tool use, and produce final answers in English, regardless of the language the user writes in. Never answer in German yourself — a downstream translation stage handles German delivery.";

const TRANSLATOR_SYSTEM = [
	"Du bist ein präziter Übersetzer. Übersetze die vorgegebene englische Antwort in natürliches, fehlerfreies Deutsch.",
	"Regeln: informelles „Du“; gehobener, aber natürlichen Stil; keine erfundenen deutschen Komposita; etablierte englische Fachbegriffe (z. B. Endpoint, Cache, Framerate, Bug) bleiben unverändert; Markdown-Struktur, Codeblöcke, Pfade, Befehle und URLs exakt unverändert lassen.",
	"Gib ausschließlich die deutsche Übersetzung aus, ohne Vor- oder Nachbemerkungen.",
].join("\n");

/**
 * Deterministic v1 heuristic (no deps): German function-word density + umlaut
 * evidence. shortcut: tuned for chat-length inputs; upgrade to a classifier
 * if misroutes appear.
 */
function isGerman(text: string): boolean {
	const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
	if (words.length < 2) return false;
	const de = new Set([
		"der", "die", "das", "und", "ist", "nicht", "mit", "auf", "für", "von", "auch", "wie",
		"aber", "oder", "ich", "du", "wir", "mein", "meine", "deine", "bitte", "danke", "kann",
		"können", "muss", "soll", "schon", "noch", "mal", "hallo", "warum", "wann", "wo", "im",
		"dem", "den", "des", "über", "nach", "bei", "um", "hat", "haben", "bist", "bin", "sind",
		"war", "wäre", "würde", "damit", "denn", "sondern", "ja", "nein", "keine", "genau", "zwei",
		"guck", "schau", "los", "mach", "machst", "macht", "sag", "sage", "gerne", "eigentlich",
	]);
	let hits = 0;
	for (const w of words) if (de.has(w)) hits++;
	return hits >= 2 || (hits >= 1 && /[äöüß]/.test(text));
}

export default function (pi: ExtensionAPI) {
	let enabled = process.env.GERMAN_TAIL === "1";
	// shortcut: detected from the prompting message only; mid-turn queued
	// messages do not re-trigger language detection.
	let lastUserPrompt = "";

	pi.registerCommand("gtranslate", {
		description: "Toggle German translation tail (agent stays English, delivery translated)",
		handler: async (args, ctx) => {
			const a = args.trim();
			enabled = a === "on" ? true : a === "off" ? false : !enabled;
			if (ctx.hasUI) ctx.ui.notify(`german-tail: ${enabled ? "ON" : "OFF"}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		lastUserPrompt = event.prompt;
		if (!enabled) return;
		const g = event.systemPromptOptions.promptGuidelines;
		if (!g.includes(GUIDELINE)) g.push(GUIDELINE);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		const msg = event.message as any;
		if (msg.role !== "assistant" || !isGerman(lastUserPrompt)) return;
		const textBlocks = msg.content.filter((b: any) => b.type === "text");
		if (textBlocks.length === 0) return;
		// Mixed with tool-call blocks (intermediate narration): leave as-is.
		if (msg.content.some((b: any) => b.type === "toolCall" || b.type === "toolUse")) return;
		const draft = textBlocks.map((b: any) => b.text).join("\n\n").trim();
		// Empty bubbles are an upstream generation bug, not ours to mask here.
		if (!draft || isGerman(draft)) return;

		const spec = process.env.GERMAN_TAIL_MODEL ?? "the local dense model";
		const [provider, ...modelRest] = spec.split("/");
		const model = ctx.modelRegistry.find(provider, modelRest.join("/"));
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`german-tail: translator model ${spec} not found — keeping English`, "warning");
			return;
		}

		const german =
			(await translateOnce(ctx, model, lastUserPrompt, draft)) ??
			(await translateOnce(ctx, model, lastUserPrompt, draft));
		if (!german) {
			if (ctx.hasUI) ctx.ui.notify("german-tail: translation failed or leaked CJK — keeping English", "warning");
			return;
		}
		pi.appendEntry("german-tail", { question: lastUserPrompt, english: draft, german, model: spec });
		const nonText = msg.content.filter((b: any) => b.type !== "text");
		return { message: { ...msg, content: [...nonText, { type: "text", text: german }] } };
	});
}

async function translateOnce(ctx: any, model: any, question: string, text: string): Promise<string | undefined> {
	try {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt: TRANSLATOR_SYSTEM,
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content:
							"Kontext — Frage des Nutzers (nur zum Verständnis, nicht mitübersetzen):\n" +
							question +
							"\n\nZu übersetzende Antwort:\n" +
							text,
					},
				],
			},
			{ signal: ctx.signal },
		);
		const out = await stream.result();
		if (out.stopReason === "error") return undefined;
		const german = (out.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim();
		return german && !CJK.test(german) ? german : undefined;
	} catch {
		return undefined;
	}
}
