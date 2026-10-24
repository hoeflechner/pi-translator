/**
 * pi-translator.test.ts — spec §6.1 + §6.7. Pure helpers only, no LLM, no pi
 * runtime. Run: node --experimental-strip-types pi-translator.test.ts
 */
import assert from "node:assert/strict";
import { proseOnly, scriptsOf, scriptGuardOk, lengthOk, renderAppend, buildPromptTranslatePrompt, workingGuideline, maskProtected, unmaskProtected, differsFromSource, replaceText, collectUiStrings, applyUiStrings, parseBatchReply, buildBatchTranslatePrompt, buildFormulatePrompt, parseLanguageName, canonicalLangName, splitLanguageHeader, normText, ratioOf, callCeilingMs } from "./pi-translator.ts";

let n = 0;
const t = (name: string, fn: () => void) => {
	try {
		fn();
	} catch (e) {
		console.error(`FAILED: ${name}\n${(e as Error).message}`);
		process.exit(1);
	}
	n++;
};

/* proseOnly: code stripped, prose kept (§4 scope) */
t("prose strips fenced + inline code", () => {
	const p = proseOnly("intro\n```bash\nls\n```\n中文 outro `命令`");
	assert.equal(p.includes("ls"), false, "fenced content removed");
	assert.equal(p.includes("命令"), false, "inline code removed");
	assert.ok(p.includes("intro") && p.includes("中文 outro"), "surrounding prose kept");
});

/* scriptsOf (§4.2 evidence sets) */
t("scriptsOf detects distinct scripts", () => {
	assert.ok(scriptsOf("Hallo").has("Latin"));
	assert.ok(scriptsOf("contra端口").has("Han"));
	assert.ok(scriptsOf("привет").has("Cyrillic"));
	assert.ok(scriptsOf("こんにちは").has("Hiragana"));
});

/* §6.7 script-guard: Latin question + English draft REJECTS CJK leak */
t("script-guard rejects CJK leak into German answer", () => {
	const q = "Was ist ein Port-Konflikt?";
	const draft = "A port conflict is when two apps want the same port.";
	const leaked = "Ein Port-Konflikt contra端口 wenn zwei Apps denselben Port wollen.";
	assert.equal(scriptGuardOk(leaked, q, draft), false);
});

t("script-guard passes clean German answer", () => {
	const q = "Was ist ein Port-Konflikt?";
	const draft = "A port conflict is when two apps want the same port.";
	const clean = "Ein Port-Konflikt liegt vor, wenn zwei Apps denselben Port belegen wollen.";
	assert.equal(scriptGuardOk(clean, q, draft), true);
});

t("script-guard passes code-block CJK (§4.1: outside fences only)", () => {
	const q = "Was ist ein Port-Konflikt?";
	const draft = "Run `netstat` to check.\n```sh\n# 端口 means port\nnetstat\n```";
	const clean = "Führe `netstat` aus.\n```sh\n# 端口 means port\nnetstat\n```";
	assert.equal(scriptGuardOk(clean, q, draft), true);
});

t("script-guard licenses CJK for a CJK question (table-free §4.2)", () => {
	const q = "ポートの競合とは何ですか？";
	const draft = "A port conflict is when two apps want the same port.";
	const translated = "ポートの競合とは、二つのアプリが同じポートを要求することです。";
	assert.equal(scriptGuardOk(translated, q, draft), true);
});

t("script-guard rejects Cyrillic leak into Latin-target answer", () => {
	const q = "Was ist ein Port-Konflikt?";
	const draft = "A port conflict is when two apps want the same port.";
	const leak = "Ein Port-Konflikt liegt перед, wenn zwei Apps denselben Port wollen.";
	assert.ok(scriptsOf(leak).has("Cyrillic"), "leak must contain a Cyrillic word");
	// Cyrillic is absent from QUESTION∪DRAFT (both Latin) → must fail the guard.
	assert.equal(scriptGuardOk(leak, q, draft), false);
});

/* length sanity (§4.4) */
t("lengthOk passes proportional, fails truncation/expansion", () => {
	const draft = "x".repeat(100);
	assert.equal(lengthOk("y".repeat(100), draft), true);
	assert.equal(lengthOk("y".repeat(60), draft), true); // 0.6×
	assert.equal(lengthOk("y".repeat(30), draft), false); // 0.3× truncated
	assert.equal(lengthOk("y".repeat(300), draft), false); // 3× expanded
});

/* renderAppend (§3 {append}) */
t("renderAppend: general always, per-language labeled, empties skipped", () => {
	const s = renderAppend({ "*": "Be concise.", de: "Use du.", fr: "  ", es: "  x  " });
	assert.ok(s.includes("Be concise."));
	assert.ok(s.includes("[de] Use du."));
	assert.ok(s.includes("[es] x"));
	assert.ok(!s.includes("[fr]"), "blank value skipped");
	// general before labeled
	assert.ok(s.indexOf("Be concise.") < s.indexOf("[de]"));
});

t("renderAppend empty → empty string (no dangling header)", () => {
	assert.equal(renderAppend(undefined), "");
	assert.equal(renderAppend({}), "");
	assert.equal(renderAppend({ de: "  " }), "");
});

/* F4 (docs/06): one always-on formulation call replaces detect + translate + gate */
t("formulate prompt: infer target from the QUESTION, or take an explicit one", () => {
	const auto = buildFormulatePrompt("", null);
	assert.ok(/language the QUESTION is written in/i.test(auto), "auto mode infers the target");
	const fixed = buildFormulatePrompt("", "Deutsch");
	assert.ok(/Write the final answer in Deutsch\./.test(fixed), "an explicit target (forced or remembered) is stated, not inferred");
	assert.ok(!/language the QUESTION is written in/i.test(fixed), "and the inference line is gone, not both");
});

t("formulate prompt: re-derive, invent nothing, header, no monologue", () => {
	const p = buildFormulatePrompt("", null);
	assert.ok(/Re-derive/i.test(p) && /keep every fact/i.test(p), "re-derivation is asked for; forbidding verbatim sentences was measured (61% vs 31%) and rejected by the owner: copying a sentence is not a defect");
	assert.ok(/Never describe the DRAFT/i.test(p), "field report: the model wrote 'Der vorliegende Entwurf behandelt keinen…' — meta commentary about the draft, which differsFromSource cannot catch (skipped in formulate mode, R6)");
	assert.ok(!/written by the agent in English/i.test(p), "the DRAFT shows the model what language it is in; naming it wastes a line (owner)");
	assert.ok(!/drifted/i.test(p), "same reason");
	assert.ok(/Add nothing that is not in the DRAFT/i.test(p), "the only defence against manufactured filler (docs/06 R6)");
	assert.ok(/First line: the name of the language/i.test(p), "must ask for the header line");
	assert.ok(/no comments about translating/i.test(p), "must close the Latin↔Latin meta-commentary hole the differsFromSource skip opens");
	assert.ok(/byte-identical/i.test(p) && /\[n\]|placeholder/i.test(p), "masking contract still stated");
});

t("promptAppend reaches the shipped formulate prompt", () => {
	const p = buildFormulatePrompt("\nStyle rules from the user:\nUse du.", null);
	assert.ok(p.includes("Use du."), "user style rules are appended verbatim");
	assert.ok(p.indexOf("Style rules") > p.indexOf("First line"), "appended after the contract, not replacing it");
});

/* worker-side system-prompt guideline (thinking + drafting language) */
t("workingGuideline forces working language for reasoning AND drafts", () => {
	const s = workingGuideline("English");
	assert.ok(/reasoning|thinking/i.test(s), "must cover internal reasoning");
	assert.ok(s.includes("in English only"), "must name the working language");
	assert.ok(/even when project instructions|injected memories/i.test(s), "must override AGENTS.md/memory pull");
	assert.ok(!/\bdu\b/.test(s) && !s.includes("„du"), "language-agnostic: no per-language text shipped");
});

/* F3 mask/restore (§05 placeholder protection) */
t("mask/unmask round-trips protected spans verbatim", () => {
	const src = "Öffne ```bash\nss -tlnp | grep 80\n``` und `netstat`, siehe https://example.com/a?x=1 und /home/demo/file.ts";
	const { masked, spans } = maskProtected(src);
	assert.ok(!masked.includes("ss -tlnp"), "fence body hidden");
	assert.ok(!masked.includes("netstat"), "inline code hidden");
	assert.ok(!masked.includes("example.com"), "URL hidden");
	assert.ok(!masked.includes("/home/demo"), "path hidden");
	assert.ok(masked.includes("Öffne"), "prose stays");
	const back = unmaskProtected(masked, spans);
	assert.ok(back.ok, "identity restore is complete");
	assert.equal(back.text, src, "restored byte-identical");
});

t("unmask fails closed when the translator drops or duplicates a placeholder", () => {
	const { masked, spans } = maskProtected("run `ls` now");
	assert.equal(spans.length, 1);
	assert.equal(unmaskProtected("mach ⟦0⟧ jetzt", spans).ok, true);
	assert.equal(unmaskProtected("mach es jetzt", spans).ok, false, "dropped placeholder → fail");
	assert.equal(unmaskProtected("⟦0⟧ ⟦0⟧", spans).ok, false, "duplicated → fail");
	assert.equal(unmaskProtected("mach es", spans).ok, false, "placeholder vanished from text entirely");
});

/* F2 prompt-translation template (§05) */
t("prompt-translate template: NONE contract, no style appends, technical fidelity", () => {
	const s = buildPromptTranslatePrompt("English");
	assert.ok(s.includes("reply with exactly: NONE"));
	assert.ok(s.includes("Never answer the request"));
	assert.ok(s.includes("⟦0⟧"), "placeholder rule present");
	assert.ok(!/\bdu\b/.test(s) && !s.includes("„du"), "no per-language style text in the shipped prompt");
});

t("script-guard extraAllowed licenses the working language for a script-pure question", () => {
	const kana = "ポート競合とは？";
	const en = "What is a port conflict?";
	assert.equal(scriptGuardOk(en, kana, kana), false, "without sample: Latin not in Kana-only evidence");
	assert.equal(scriptGuardOk(en, kana, kana, "a b c d e f g"), true, "working-language sample licenses Latin");
});

/* Latin↔Latin untranslated-output guard */
t("differsFromSource rejects echoed/meta English output, accepts real translations", () => {
	const draft =
		"Kill or reconfigure one of the two processes: find the current holder with ss -tlnp and either stop it or point the new service at a free port.";
	const echo =
		"Kill or reconfigure one of the two processes: find the current holder with ss -tlnp and either stop it or point the new service at a free port. We need translate DRAFT into German because QUESTION is German.";
	assert.equal(differsFromSource(echo, draft), false, "echo+meta shares nearly all words → fail");
	const de =
		"Beende oder konfiguriere einen der beiden Prozesse: Ermittle den aktuellen Inhaber mit ss -tlnp und stoppe ihn oder weise dem neuen Dienst einen freien Port zu.";
	assert.equal(differsFromSource(de, draft), true, "real German translation passes");
	assert.equal(differsFromSource("Yes it is.", "short draft."), true, "tiny source → no signal, pass");
	// regression 2026-10-14: code-dominant draft — tiny prose, a fence full of tokens
	// that are identical by contract, must not be read as "untranslated".
	const fenceDraft = "Use:\n```bash\ncd /srv/app\nsystemctl restart sitop-mcp\njournalctl -u sitop-mcp -f\n```\nThat is all.";
	const fenceDe = "Verwende:\n```bash\ncd /srv/app\nsystemctl restart sitop-mcp\njournalctl -u sitop-mcp -f\n```\nDas war's.";
	assert.equal(differsFromSource(fenceDe, fenceDraft), true, "correct output of a code-dominant draft passes");
	// known limit of the prose comparison: that draft has 4 prose words, below the
	// 8-word signal floor, so a verbatim echo of it is not judgeable here.
});

// Regression (review finding #2): multimodal block ORDER must survive the
// text swap — "image, question, image" must not become "question, images".
t("replaceText keeps multimodal block order", () => {
	const blocks = [
		{ type: "image", data: "a" },
		{ type: "text", text: "original question" },
		{ type: "image", data: "b" },
		{ type: "text", text: "second text block (merged away)" },
	];
	const out = replaceText(blocks, "übersetzt");
	assert.deepEqual(
		out.map((b: any) => [b.type, b.type === "text" ? b.text : b.data]),
		[["image", "a"], ["text", "übersetzt"], ["image", "b"]],
		"first text block replaced in place, extras dropped, image positions kept",
	);
	const noText = replaceText([{ type: "image", data: "a" }], "x");
	assert.equal(noText.length, 2, "content without text block → text appended");
});

const UI_ARGS = {
	questions: [
		{
			id: "fix_scope",
			question: "Which fixes should I apply now?",
			detail: "MAJOR = cloned repos can steer the plugin.",
			options: [
				{ value: "all", label: "All", detail: "full remediation run" },
				{ value: "none", label: "Nothing yet" },
			],
		},
		{ id: "second", question: "Second question?" },
	],
};

t("collectUiStrings covers human fields only, in stable order", () => {
	assert.deepEqual(collectUiStrings(UI_ARGS), [
		"Which fixes should I apply now?",
		"MAJOR = cloned repos can steer the plugin.",
		"All",
		"full remediation run",
		"Nothing yet",
		"Second question?",
	]);
	assert.deepEqual(collectUiStrings({ questions: "not-an-array" }), [], "broken shape → nothing, never guess");
	assert.deepEqual(collectUiStrings(undefined), [], "no args → nothing");
});

t("applyUiStrings round-trips with machine fields untouched", () => {
	const de = ["Welche Fixes jetzt?", "MAJOR = geklonte Repos steuern das Plugin.", "Alle", "kompletter Durchgang", "Noch nichts", "Zweite Frage?"];
	const out = applyUiStrings(UI_ARGS, de);
	assert.ok(out, "round-trip succeeds");
	assert.equal(out.questions[0].id, "fix_scope", "id untouched");
	assert.equal(out.questions[0].options[0].value, "all", "value untouched");
	assert.equal(out.questions[0].options[0].label, "Alle", "label translated");
	assert.equal(out.questions[0].options[1].detail, undefined, "absent detail stays absent");
	assert.equal(out.questions[1].question, "Zweite Frage?");
	assert.equal(applyUiStrings(UI_ARGS, de.slice(0, 4)), null, "missing segments → refuse");
	assert.equal(applyUiStrings(UI_ARGS, [...de, "extra"]), null, "invented segment → refuse");
});

t("parseBatchReply is strict about the JSON-array contract", () => {
	assert.deepEqual(parseBatchReply('["a", "b"]', 2), ["a", "b"]);
	assert.deepEqual(parseBatchReply("```json\n[\"a\", \"b\"]\n```", 2), ["a", "b"], "fence tolerated");
	assert.equal(parseBatchReply('["a"]', 2), null, "count drift");
	assert.equal(parseBatchReply('"just a string"', 1), null, "not an array");
	assert.equal(parseBatchReply('["a", "  "]', 2), null, "empty segment");
	assert.equal(parseBatchReply("Sure! [\"a\", \"b\"]", 2), null, "prose chatter is not tolerated");
});

t("batch prompt carries count, JSON contract and placeholders", () => {
	const s = buildBatchTranslatePrompt("English", "", null, 7);
	assert.ok(s.includes("array of 7") && s.includes("exactly 7"), "count named twice");
	assert.ok(s.includes("NONE"), "same-language passthrough");
	assert.ok(s.includes("⟦") || s.includes("PLACEHOLDER") || s.includes("placeholder"), "placeholder rule present");
	const f = buildBatchTranslatePrompt("English", "", "Japanese", 3);
	assert.ok(f.includes("Always translate into Japanese") && !f.includes("NONE"), "forced: no passthrough branch");
});

t("collect→apply round-trips on randomized schema shapes", () => {
	// Mirror-by-duplication defense: collectUiStrings and applyUiStrings agree
	// only by repeating the same predicates — random shapes with absent/empty/
	// non-string fields must still round-trip with machine fields intact.
	let seed = 42;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
	const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const machine = (a: any) =>
		JSON.stringify(
			(a?.questions ?? []).map((x: any) => ({
				id: x.id,
				m: x.multiple,
				o: (x.options ?? []).map((y: any) => y.value),
			})),
		);
	for (let iter = 0; iter < 60; iter++) {
		const args = {
			questions: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_q, qi) => ({
				id: `q${qi}`,
				multiple: rnd() > 0.5,
				question: pick([`Question ${iter}?`, "", "   ", undefined]),
				detail: pick(["Detail text", "", undefined]),
				options: Array.from({ length: Math.floor(rnd() * 3) }, (_o, oi) => ({
					value: `v${oi}`,
					label: pick(["Label", "", undefined, "Second label"]),
					detail: pick(["Option detail", "", undefined]),
				})),
			})),
		};
		const strs: string[] = collectUiStrings(args);
		const tr = strs.map((s, k) => `Ü${k} ${s}`);
		const out = applyUiStrings(args, tr);
		assert.ok(out, `iter ${iter}: round-trip succeeds`);
		assert.equal(machine(out), machine(args), `iter ${iter}: machine fields byte-equal`);
		let k = 0;
		for (const q of out.questions) {
			for (const f of ["question", "detail"]) if (typeof q[f] === "string" && (q[f] as string).startsWith("Ü")) assert.equal(q[f], tr[k++], `iter ${iter}: field ${f} in order`);
			for (const o of q.options ?? []) for (const f of ["label", "detail"]) if (typeof o[f] === "string" && (o[f] as string).startsWith("Ü")) assert.equal(o[f], tr[k++], `iter ${iter}: option field ${f} in order`);
		}
		assert.equal(k, tr.length, `iter ${iter}: every translation consumed in collect order`);
	}
});

/* ---------- F4 (docs/06): always-on formulation, header carries the language ---------- */

t("workingGuideline no longer promises a translated input", () => {
	const g = workingGuideline("English");
	assert.ok(!/translated into English before you read/i.test(g), "prompt translation is gone — the guideline must not lie about it");
	assert.ok(/untranslated/i.test(g), "must state the user text arrives as written");
	assert.ok(/translation layer on delivery/i.test(g), "delivery formulation stays");
});

t("parseLanguageName accepts only a name", () => {
	assert.deepEqual(parseLanguageName("NONE", "English"), { kind: "working" });
	assert.deepEqual(parseLanguageName("German", "English"), { kind: "lang", name: "German" });
	assert.deepEqual(parseLanguageName("german.", "English"), { kind: "lang", name: "German" }, "case + trailing dot");
	assert.deepEqual(parseLanguageName("de", "English"), { kind: "lang", name: "German" }, "operator code table shared");
	assert.deepEqual(parseLanguageName("German", "german"), { kind: "working" }, "naming the working language is working");
	assert.deepEqual(parseLanguageName("This is German, obviously", "English"), { kind: "fail" }, "a chatty answer is not a name");
	assert.deepEqual(parseLanguageName("", "English"), { kind: "fail" });
});

t("splitLanguageHeader never loses the answer", () => {
	assert.deepEqual(splitLanguageHeader("German\nHallo zusammen."), { lang: "German", text: "Hallo zusammen." });
	const noHeader = splitLanguageHeader("Hallo zusammen, hier die Antwort.");
	assert.equal(noHeader.lang, null);
	assert.equal(noHeader.text, "Hallo zusammen, hier die Antwort.", "a model that skipped the header keeps its answer");
	const headerIsText = splitLanguageHeader("Here is the translation:\nHallo.");
	assert.equal(headerIsText.lang, null);
	assert.equal(headerIsText.text, "Here is the translation:\nHallo.", "an unparseable first line is treated as content, not swallowed (R2)");
	assert.deepEqual(splitLanguageHeader("German"), { lang: null, text: "German" }, "a bare name with no body is content, and the caller rejects empty");
});

t("the header line never survives into the delivered text", () => {
	const { lang, text } = splitLanguageHeader("German\nDas Depot ist sauber.");
	assert.equal(lang, "German");
	assert.ok(!/\bGerman\b/.test(text), "no language-name line in what the user reads");
});

t("noop detection is normalised equality, not a similarity threshold", () => {
	assert.equal(normText("  Das\nist\tgut. "), normText("Das ist gut."));
	assert.notEqual(normText("Das ist gut."), normText("Das ist gut!"), "one edit is not a noop — a % threshold would reject light reformulation");
});

t("the 5-minute ceiling belongs to formulate mode only", () => {
	const saved = process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS;
	delete process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS;
	try {
		assert.equal(callCeilingMs(true), 300_000, "formulate: five minutes — the model retypes the whole answer");
		assert.equal(callCeilingMs(false), 25_000, "forms and summaries keep 25 s: a short payload that hangs is a hang");
		process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS = "40";
		assert.equal(callCeilingMs(true), 40, "the test seam wins over both");
		assert.equal(callCeilingMs(false), 40);
	} finally {
		if (saved === undefined) delete process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS;
		else process.env.PI_TRANSLATOR_CALL_TIMEOUT_MS = saved;
	}
});

t("ratioOf reports prose growth for the invented-filler metric", () => {
	assert.equal(ratioOf("Der Satz ist kurz.", "Der Satz ist kurz."), 1, "unchanged prose ratios 1.0");
	assert.ok(ratioOf("Der Satz ist kurz und wird hier lang und lang.", "Der Satz ist kurz.") > 1.5, "padding shows up as growth (R7 M5)");
	assert.ok(ratioOf("", "Der Satz ist kurz.") < 0.1, "empty output ratios near zero, so the floor guard bites");
});

t("lengthOk ceiling is a parameter: formulation gets room, truncation never does", () => {
	const draft = "x".repeat(200);
	assert.ok(lengthOk("y".repeat(300), draft, 4), "a 1.5× reformulation passes in formulate mode");
	assert.ok(lengthOk("y".repeat(700), draft, 4), "up to the 4× cap");
	assert.ok(!lengthOk("y".repeat(900), draft, 4), "beyond the cap is refused — the ceiling is never deleted (R6)");
	assert.ok(!lengthOk("y".repeat(40), draft, 4), "a 0.2× truncation fails the floor in any mode");
});

console.log(`pi-translator.test.ts: ${n} tests passed`);
