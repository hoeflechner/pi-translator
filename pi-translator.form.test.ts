/**
 * pi-translator.form.test.ts — async integration test of the ask_user form
 * path against the REAL extension factory: message_end (user → prompt call →
 * gate), message_end (assistant + ask_user → batch form call → translated
 * args + toolArgs metadata), context handler restore. Only the model itself
 * is stubbed. Run: node --experimental-strip-types pi-translator.form.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";

process.env.PI_TRANSLATOR = "1"; // enable without settings files (cwd has none)
process.env.PI_TRANSLATOR_CWD_HACK = "1"; // silence linters about ordering
const { default: factory } = await import("./pi-translator.ts");

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
	try {
		await fn();
	} catch (e) {
		console.error(`FAILED: ${name}\n${(e as Error).message}`);
		process.exit(1);
	}
	n++;
};

const UI_ARGS = {
	questions: [
		{
			id: "dividends",
			question: "Should the depot app book dividends in the future?",
			detail: "This decides whether dividend bookings become part of the depot system scope.",
			options: [
				{ value: "yes", label: "Yes, book dividends", detail: "recorded as cash ledger entries" },
				{ value: "no", label: "No, that is enough" },
			],
		},
	],
};
const DE_BATCH = [
	"Soll die Depot-App künftig Dividenden verbuchen?",
	"Das entscheidet, ob Dividendenbuchungen Teil des Depot-Systems werden.",
	"Ja, Dividenden buchen",
	"als Buchungen im Cash-Ledger erfassen",
	"Nein, das reicht so",
];

const USER_TEXT = "Soll das Depot Dividenden buchen? Bring es als Formular.";

async function main() {
	const handlers: Record<string, (e: any, c: any) => Promise<any>> = {};
	const pi: any = { on: (ev: string, fn: any) => (handlers[ev] = fn), registerCommand: () => {} };
	factory(pi);

	const calls: string[] = [];
	const counts = { detect: 0, prompt: 0, reply: 0, form: 0 };
	const DE_REPLY = { stopReason: "stop", content: [{ type: "text", text: "Kurz gesagt: Das Depot soll Dividenden verbuchen." }] };
	let reply: any = DE_REPLY; // DRAFT-branch answer, per test
	const EN_PROMPT = { stopReason: "stop", content: [{ type: "text", text: "Should the depot app book dividends in the future? Ask via form." }] };
	let DETECT_ANSWER = "German"; // detector answer, per test
	const ctx: any = {
		cwd: "/tmp/pt-formtest", // no settings file → block-free, quiet
		hasUI: false,
		isProjectTrusted: () => false,
		signal: undefined,
		model: { provider: "stub", id: "m" },
		modelRegistry: {
			find: () => null,
			streamSimple: (_m: any, req: any) => ({
				result: async () => {
					const payload = req.messages[0].content as string;
					// F3: detection is its own tiny call, recognised by its system prompt.
					if (String(req.systemPrompt).includes("Which language is the USER REQUEST")) { counts.detect++; return { stopReason: "stop", content: [{ type: "text", text: DETECT_ANSWER }] }; }
					calls.push(payload.slice(0, 30));
					if (payload.startsWith("USER REQUEST:")) { counts.prompt++; return EN_PROMPT; }
					if (payload.includes("SEGMENTS:")) { counts.form++; return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(DE_BATCH) }] }; }
					if (payload.includes("\nDRAFT:")) { counts.reply++; return reply; }
					return { stopReason: "error", content: [] };
				},
			}),
		},
	};

	const sections: Record<string, string> = {};
	await t("user message reaches the model as written, language stored", async () => {
		await handlers.before_agent_start({ prompt: "Soll das Depot Dividenden buchen? Bring es als Formular.", systemPromptOptions: { sections } }, ctx);
		assert.ok(sections.pi_translator?.includes("English"), "guideline section injected");
		const m = await handlers.message_end({ message: { role: "user", content: USER_TEXT } }, ctx);
		assert.equal(counts.detect, 1, "exactly one detect call, no prompt translation");
		assert.equal(counts.prompt, 0, "F3: the request is never translated");
		assert.equal(m?.message?.piTranslator?.userLang, "German", "the delivery language is stored on the message");
		assert.equal(m?.message?.content, USER_TEXT, "the user's own wording is untouched");
		assert.equal(m?.message?.piTranslator?.modelText, undefined, "no working-language override is smuggled in");
	});

	await t("sticky rule judges prose words, not code volume", async () => {
		const before = DETECT_ANSWER;
		DETECT_ANSWER = "English"; // detector says English: only real prose may flip the session
		const codeHeavy = "Kurz gesagt, mach das.\n```bash\n" + Array.from({ length: 30 }, (_, i) => `echo step${i} && run --flag ${i}`).join("\n") + "\n```";
		const m = await handlers.message_end({ message: { role: "user", content: codeHeavy } }, ctx);
		assert.equal(m?.message?.piTranslator?.userLang, "German", "30 lines of English code must not flip a German session");
		DETECT_ANSWER = before;
	});

	await t("a skipped delivery still writes an audit row (docs/06 R4)", async () => {
		const log = `/tmp/pt-skip-${process.pid}.jsonl`;
		try { unlinkSync(log); } catch { /* fresh */ }
		process.env.PI_TRANSLATOR_LOG = log;
		try {
			// gate closed: the question is in the working language and nothing is forced
			const savedLang = DETECT_ANSWER;
			DETECT_ANSWER = "NONE";
			const saved = await handlers.message_end({ message: { role: "user", content: "Just a plain English question here, ten words or so." } }, ctx);
			assert.equal(saved?.message?.piTranslator?.userLang, "English", "a long working-language turn does switch");
			DETECT_ANSWER = savedLang;
			const r = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "A working-language answer that needs no translation at all." }] } }, ctx);
			assert.equal(r, undefined, "no delivery call when the question is in the working language");
			const rows = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
			const skip = rows.find((x) => x.dir === "reply" && x.verdict === "skip");
			assert.ok(skip, "the skip must be visible in the audit log, not only in the debug stream");
			assert.equal(skip.reason, "question-in-working-language", "and say why it skipped");
		} finally {
			delete process.env.PI_TRANSLATOR_LOG;
			// leave the shared instance in the German state the rest of the file expects
			DETECT_ANSWER = "German";
			await handlers.message_end({ message: { role: "user", content: USER_TEXT + " Bitte gründlich, mit Begründung und Beispielen." } }, ctx);
		}
	});

	let translatedForm: any;
	await t("ask_user form translated, machine fields and meta intact", async () => {
		const msg = { role: "assistant", content: [{ type: "toolCall", name: "ask_user", arguments: UI_ARGS }] };
		translatedForm = await handlers.message_end({ message: msg }, ctx);
		assert.ok(translatedForm?.message, "form message replaced");
		const args = translatedForm.message.content[0].arguments;
		assert.equal(args.questions[0].question, DE_BATCH[0], "question translated");
		assert.equal(args.questions[0].options[0].label, DE_BATCH[2], "label translated");
		assert.equal(args.questions[0].id, "dividends", "id untouched");
		assert.equal(args.questions[0].options[0].value, "yes", "value untouched");
		assert.equal(args.questions[0].options[1].detail, undefined, "absent field stays absent");
		const ta = translatedForm.message.piTranslator.toolArgs;
		assert.equal(ta["0"].questions[0].question, UI_ARGS.questions[0].question, "English original kept as metadata");
	});

	await t("context handler restores English tool args for the model", async () => {
		const userMsg = { role: "user", content: USER_TEXT, piTranslator: { userLang: "German" } };
		const r = await handlers.context({ messages: [userMsg, translatedForm.message] }, ctx);
		assert.ok(r?.messages, "context rewritten");
		assert.equal(r.messages[1].content[0].arguments.questions[0].question, UI_ARGS.questions[0].question, "model sees English args");
		assert.equal(r.messages[0].content, USER_TEXT, "F3: the user message is handed over as written — state, not content");
		assert.equal(translatedForm.message.content[0].arguments.questions[0].question, DE_BATCH[0], "session object NOT mutated (transcript keeps German)");
	});

	await t("second form call in same turn works (state independent)", async () => {
		const msg = { role: "assistant", content: [{ type: "text", text: "Ich frage kurz:" }, { type: "toolCall", name: "ask_user", arguments: UI_ARGS }] };
		const r = await handlers.message_end({ message: msg }, ctx);
		assert.equal(r.message.content[1].arguments.questions[0].question, DE_BATCH[0], "block index handled correctly with leading text block");
		assert.equal(r.message.content[0].text, "Ich frage kurz:", "leading narration passes through untouched");
	});

	await t("QUESTION carrying paths/URLs does not break form translation", async () => {
		// Review MAJOR: masking the whole payload minted ⟦n⟧ placeholders from
		// the question's code/paths that the translator must never echo →
		// unmaskProtected failed by construction. Only SEGMENTS may be masked.
		await handlers.before_agent_start({ prompt: "Fixe das Deployment in /srv/app/v2 (Log: https://grafana.example.com/d/abc) und frage mich per Formular.", systemPromptOptions: { sections } }, ctx);
		const msg = { role: "assistant", content: [{ type: "toolCall", name: "ask_user", arguments: UI_ARGS }] };
		const r = await handlers.message_end({ message: msg }, ctx);
		assert.equal(r?.message?.content?.[0]?.arguments?.questions?.[0]?.question, DE_BATCH[0], "form still translates");
		assert.ok(r.message.piTranslator.toolArgs["0"], "original still preserved");
	});

	await t("assistant message with BOTH translated draft and tool args restores both", async () => {
		// MEDIUM hardening: original + toolArgs must restore sequentially, not
		// via if/else (else the model silently reads translated tool args).
		const dual = {
			role: "assistant",
			content: [
				{ type: "text", text: "Ich frage kurz:" },
				{ type: "toolCall", name: "ask_user", arguments: { questions: [{ id: "x", question: "Deutsche Frage?" }] } },
			],
			piTranslator: { original: "Let me ask:", toolArgs: { "1": { questions: [{ id: "x", question: "English question?" }] } } },
		};
		const r = await handlers.context({ messages: [dual] }, ctx);
		assert.equal(r.messages[0].content[0].text, "Let me ask:", "text original restored");
		assert.equal(r.messages[0].content[1].arguments.questions[0].question, "English question?", "tool args original restored too");
	});

	await t("injected custom-message run (no event.prompt) keeps the delivery language", async () => {
		// Regression 2026-10-14: a delegation_result wakes the session through
		// _startRun({ messageType: "custom" }), so before_agent_start carried no
		// prompt; lastUserPrompt was cleared and every later answer shipped in the
		// working language — silently (measured: 3 of 4 broken answers in one session).
		await handlers.before_agent_start({ prompt: "Soll das Depot Dividenden buchen?", systemPromptOptions: { sections } }, ctx);
		await handlers.message_end({ message: { role: "user", content: "Soll das Depot Dividenden buchen?" } }, ctx);
		await handlers.before_agent_start({ messageType: "custom", systemPromptOptions: { sections } }, ctx);
		const msg = { role: "assistant", content: [{ type: "text", text: "Restating: the depot should book dividends." }] };
		const r = await handlers.message_end({ message: msg }, ctx);
		assert.equal(r?.message?.content?.[0]?.text, "Kurz gesagt: Das Depot soll Dividenden verbuchen.", "answer after an injection is delivered translated");
		assert.equal(r?.message?.piTranslator?.original, "Restating: the depot should book dividends.", "English draft kept as metadata");
	});

	await t("guard rejection is not retried; a transport error is retried once", async () => {
		// Retrying a deterministic guard rejection with a byte-identical request can
		// only reproduce it — it just doubles cost and latency on every turn.
		const draft = "Restating: the depot should book dividends and record them as cash ledger entries.";
		const msg = { role: "assistant", content: [{ type: "text", text: draft }] };
		reply = { stopReason: "stop", content: [{ type: "text", text: draft }] }; // verbatim echo → overlap guard
		const before = counts.reply;
		const r = await handlers.message_end({ message: msg }, ctx);
		assert.equal(counts.reply - before, 1, "one translator call, no identical retry");
		assert.equal(r, undefined, "original answer delivered");
		reply = { stopReason: "error", content: [] }; // the fluke class IS retried
		const before2 = counts.reply;
		await handlers.message_end({ message: msg }, ctx);
		// 3, not 2: the first attempt is itself two calls (reasoning "minimal" rejected
		// with empty content → probe marks the model, one call without the option).
		assert.equal(counts.reply - before2, 3, "transport error gets its one retry (plus the reasoning probe)");
		reply = DE_REPLY;
	});

	await t("compaction summary reaches the model in the working language", async () => {
		// pi builds the summary from the STORED (user-language) deliveries and never
		// runs the summarizer through transformContext — without this the model
		// context grows target-language text exactly in the long-session regime.
		const summary = { role: "compactionSummary", summary: "Der Nutzer wollte eine Depot-App, die Dividenden verbucht.", tokensBefore: 1234, timestamp: 1 };
		const r = await handlers.context({ messages: [summary] }, ctx);
		assert.ok(r?.messages, "summary rewritten for the model");
		assert.equal(r.messages[0].summary, EN_PROMPT.content[0].text, "model sees the working-language summary");
		assert.equal(summary.summary, "Der Nutzer wollte eine Depot-App, die Dividenden verbucht.", "session object NOT mutated (transcript keeps the user's language)");
		const before = counts.prompt;
		await handlers.context({ messages: [{ ...summary }] }, ctx); // pi hands a fresh clone every request
		assert.equal(counts.prompt, before, "cached by text digest — not re-translated per request");
	});

	console.log(`pi-translator.form.test.ts: ${n} tests passed`);
}
main();
