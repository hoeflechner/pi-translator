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
	const seenOpts: any[] = [];
	const counts = { formulate: 0, prompt: 0, reply: 0, form: 0 };
	// Formulate mode answers "<language>\n<text>" — the header must never reach the user.
	const DE_REPLY = { stopReason: "stop", content: [{ type: "text", text: "German\nKurz gesagt: Das Depot soll Dividenden verbuchen." }] };
	let reply: any = DE_REPLY; // formulate-branch answer, per test
	const EN_PROMPT = { stopReason: "stop", content: [{ type: "text", text: "Should the depot app book dividends in the future? Ask via form." }] };
	const ctx: any = {
		cwd: "/tmp/pt-formtest", // no settings file → block-free, quiet
		hasUI: false,
		isProjectTrusted: () => false,
		signal: undefined,
		model: { provider: "stub", id: "m" },
		modelRegistry: {
			find: () => null,
			streamSimple: (_m: any, req: any, opts?: any) => ({
				result: async () => {
					const payload = req.messages[0].content as string;
					if (String(req.systemPrompt).includes("final formulation layer")) { counts.formulate++; seenOpts.push(opts); return reply; }
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
	await t("a human turn runs no translator call at all (F4)", async () => {
		await handlers.before_agent_start({ prompt: USER_TEXT, systemPromptOptions: { sections } }, ctx);
		assert.ok(sections.pi_translator?.includes("English"), "guideline section injected");
		const m = await handlers.message_end({ message: { role: "user", content: USER_TEXT } }, ctx);
		assert.equal(m, undefined, "the user message is not replaced — nothing is translated before the agent starts");
		assert.equal(counts.prompt, 0, "no prompt translation");
		assert.equal(counts.formulate, 0, "no pre-start formulation either");
	});

	await t("the answer is formulated and the header never reaches the reader", async () => {
		const r = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "In short: the depot should book dividends." }] } }, ctx);
		assert.equal(counts.formulate, 1, "every answer is formulated, same-language ones included");
		const delivered = r?.message?.content?.[0]?.text;
		assert.equal(delivered, "Kurz gesagt: Das Depot soll Dividenden verbuchen.", "the language-name line is stripped");
		assert.ok(!/^German\b/m.test(delivered), "no header line in what the user reads");
		assert.equal(r.message.piTranslator.original, "In short: the depot should book dividends.", "the draft stays reachable for the model (F1)");
		// "minimal" is not a thinking level this class of endpoint serves — asking
		// for it cost a rejected request plus a probe retry onto xhigh (12,788
		// completion tokens for 6,700 chars). Ask for a level that exists.
		assert.equal(seenOpts.at(-1)?.reasoning, "medium", "formulate asks for a supported thinking level");
	});

	await t("a formulation that changed nothing is a logged noop, not a silent pass", async () => {
		const log = `/tmp/pt-noop-${process.pid}.jsonl`;
		try { unlinkSync(log); } catch { /* fresh */ }
		const savedReply = reply;
		process.env.PI_TRANSLATOR_LOG = log;
		try {
			reply = { stopReason: "stop", content: [{ type: "text", text: "English\nThe exact same words as the draft." }] };
			const r = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "The exact same words as the draft." }] } }, ctx);
			assert.equal(r, undefined, "the draft is delivered as written when the polisher did nothing");
			const rows = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
			const noop = rows.find((x) => x.verdict === "noop");
			assert.ok(noop, "and the audit log says so (R6/R7 M2 — this is the weak-model signature)");
			assert.equal(noop.mode, "formulate");
			assert.equal(noop.lang, "English", "the header is parsed even on a noop");
		} finally {
			reply = savedReply;
			delete process.env.PI_TRANSLATOR_LOG;
		}
	});

	await t("a question-less machine turn skips visibly, never guessing a language", async () => {
		const log = `/tmp/pt-skip-${process.pid}.jsonl`;
		try { unlinkSync(log); } catch { /* fresh */ }
		const pi2: any = { on: (ev: string, fn: any) => (fresh[ev] = fn), registerCommand: () => {} };
			const fresh: Record<string, (e: any, c: any) => Promise<any>> = {};
		factory(pi2); // new instance: no question, no remembered language
		process.env.PI_TRANSLATOR_LOG = log;
		try {
			await fresh.before_agent_start({ prompt: "", systemPromptOptions: { sections: {} } }, ctx);
			const r = await fresh.message_end({ message: { role: "assistant", content: [{ type: "text", text: "A delegation result arrived with no question to answer." }] } }, ctx);
			assert.equal(r, undefined, "delivered as written rather than guessed into a language");
			const rows = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
			const skip = rows.find((x) => x.verdict === "skip");
			assert.ok(skip, "the skip is visible in the audit log (R4)");
			assert.equal(skip.reason, "no-language-evidence");
		} finally {
			delete process.env.PI_TRANSLATOR_LOG;
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
		reply = { stopReason: "stop", content: [{ type: "text", text: "German\n" + draft }] }; // verbatim echo → noop, not a retry
		const before = counts.formulate;
		const r = await handlers.message_end({ message: msg }, ctx);
		assert.equal(counts.formulate - before, 1, "one call, no identical retry");
		assert.equal(r, undefined, "original answer delivered");
		reply = { stopReason: "error", content: [] }; // the fluke class IS retried
		const before2 = counts.formulate;
		await handlers.message_end({ message: msg }, ctx);
		// 3, not 2: the first attempt is itself two calls (reasoning "minimal" rejected
		// with empty content → probe marks the model, one call without the option).
		assert.equal(counts.formulate - before2, 3, "transport error gets its one retry (plus the reasoning probe)");
		reply = DE_REPLY;
	});

	await t("a lost placeholder gets one repair attempt that says what was lost", async () => {
		// The draft contains one protected span (inline code) → masked to ⟦0⟧.
		// The polisher's first answer drops it. Retrying byte-identical would
		// reproduce the loss; retrying with the diagnosis is a different request.
		const draft = "Start the daemon first: `pi-web-sessiond` owns the socket.";
		const log = `/tmp/pt-repair-${process.pid}.jsonl`;
		try {
			unlinkSync(log);
		} catch {
			/* fresh */
		}
		const saved = reply;
		const seen: string[] = [];
		process.env.PI_TRANSLATOR_LOG = log;
		try {
			reply = {
				stopReason: "stop",
				content: [{ type: "text", text: "German\nDer Daemon besitzt den Socket — zuerst starten." }], // ⟦0⟧ gone
			};
			const orig = ctx.modelRegistry.streamSimple;
			ctx.modelRegistry.streamSimple = (m: any, req: any, opts?: any) => {
				const payload = String(req.messages[0].content);
				seen.push(payload);
				const fixed = payload.includes("ATTENTION:")
					? { stopReason: "stop", content: [{ type: "text", text: "German\nDer Daemon besitzt den Socket — zuerst `⟦0⟧` starten." }] }
					: reply;
				return { result: async () => fixed };
			};
			const r = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: draft }] } }, ctx);
			ctx.modelRegistry.streamSimple = orig;
			assert.equal(seen.length, 2, "one repair attempt, no loop");
			assert.match(seen[1], /ATTENTION:/, "the retry says what went wrong");
			assert.match(seen[1], /Missing from your answer: ⟦0⟧/, "and names the lost placeholder");
			assert.doesNotMatch(seen[0], /ATTENTION:/, "the first request was clean");
			const delivered = r?.message?.content?.[0]?.text ?? "";
			assert.match(delivered, /`pi-web-sessiond`/, "the protected span is back — the repair shipped, not the raw draft");
			const rows = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
			assert.ok(rows.some((x) => x.placeholder_repair === true), "the audit row says a repair was attempted");
			// And when even the repair fails, the operator must be able to see WHY
			// from the log — "rejected by the placeholders guard" alone is no clue.
			reply = { stopReason: "stop", content: [{ type: "text", text: "German\nDer Daemon besitzt den Socket — zuerst starten." }] };
			const stubborn = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: draft }] } }, ctx);
			assert.equal(stubborn, undefined, "the raw draft ships after the repair failed too");
			const dead = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.verdict === "reject").pop();
			assert.deepEqual(dead.placeholders_missing, [0], "the row names the marker that was lost");
			assert.deepEqual(dead.placeholders_dups, []);
			assert.equal(dead.placeholder_repair, true, "and that a repair was attempted before giving up");
			reply = saved;
		} finally {
			reply = saved;
			delete process.env.PI_TRANSLATOR_LOG;
		}
	});

	await t("a timed-out call is not retried (the double-stall class)", async () => {
		// The ceiling aborts the request; the endpoint then answers stopReason
		// "error" (or "stop" with empty content). Labelled "transport" that was a
		// fluke, so the retry paid the ceiling a SECOND time: the user watched 50 s
		// of nothing for a call that had already failed at 25 (field report 20:19).
		const draft = "A long enough draft that the ceiling is what ends this call at all.";
		const saved = reply;
		const savedEnv = process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS;
		process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS = "40";
		const hang = ctx.modelRegistry.streamSimple;
		ctx.modelRegistry.streamSimple = () => ({
			result: async () => {
				counts.formulate++;
				await new Promise((r) => setTimeout(r, 400));
				return { stopReason: "error", content: [] };
			},
		});
		try {
			const before = counts.formulate;
			const r = await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: draft }] } }, ctx);
			assert.equal(r, undefined, "the draft is delivered rather than withheld");
			assert.equal(counts.formulate - before, 1, "one call — a slow model retried is a double stall");
		} finally {
			ctx.modelRegistry.streamSimple = hang;
			reply = saved;
			if (savedEnv === undefined) delete process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS;
			else process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS = savedEnv;
		}
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
