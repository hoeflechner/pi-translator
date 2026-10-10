/**
 * pi-translator.test.ts — spec §6.1 + §6.7. Pure helpers only, no LLM, no pi
 * runtime. Run: node --experimental-strip-types pi-translator.test.ts
 */
import assert from "node:assert/strict";
import { proseOnly, scriptsOf, scriptGuardOk, lengthOk, renderAppend, buildSystemPrompt, buildPromptTranslatePrompt, workingGuideline, maskProtected, unmaskProtected, differsFromSource } from "./pi-translator.ts";

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
	assert.ok(scriptsOf("contra设计").has("Han"));
	assert.ok(scriptsOf("привет").has("Cyrillic"));
	assert.ok(scriptsOf("こんにちは").has("Hiragana"));
});

/* §6.7 script-guard: Latin question + English draft REJECTS CJK leak */
t("script-guard rejects CJK leak into German answer", () => {
	const q = "Was ist ein Port-Konflikt?";
	const draft = "A port conflict is when two apps want the same port.";
	const leaked = "Ein Port-Konflikt contra设计 wenn zwei Apps denselben Port wollen.";
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

/* buildSystemPrompt (§3 template + forced swap) */
t("auto template contains the NONE contract", () => {
	const s = buildSystemPrompt("English", "", null);
	assert.ok(s.includes("reply with exactly: NONE"));
	assert.ok(s.includes("into the language of the QUESTION"));
	assert.ok(!s.includes("Always translate"), "auto mode must not force a target");
});

t("forced template swaps detection for a fixed target, drops NONE", () => {
	const s = buildSystemPrompt("English", "", "German");
	assert.ok(s.includes("Always translate the DRAFT into German."));
	assert.ok(!s.includes("NONE"), "forced mode has no passthrough (§3)");
});

t("append is appended to the shipped prompt", () => {
	const s = buildSystemPrompt("English", renderAppend({ de: "Use du." }), null);
	assert.ok(s.trimEnd().endsWith("[de] Use du."));
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
	const src = "Öffne ```bash\nss -tlnp | grep 80\n``` und `netstat`, siehe https://example.com/a?x=1 und /data/user/file.ts";
	const { masked, spans } = maskProtected(src);
	assert.ok(!masked.includes("ss -tlnp"), "fence body hidden");
	assert.ok(!masked.includes("netstat"), "inline code hidden");
	assert.ok(!masked.includes("example.com"), "URL hidden");
	assert.ok(!masked.includes("/data/user"), "path hidden");
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
});

console.log(`pi-translator.test.ts: ${n} tests passed`);
