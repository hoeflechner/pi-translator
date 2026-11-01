/**
 * Prompt-variant probe: the same draft through several formulate prompts, side by
 * side, so a wording change is chosen by reading the results and not by liking
 * them. Every variant is the PRODUCTION prompt plus one block — the control is
 * exactly what ships, so a difference is attributable to that block and to
 * nothing else.
 *
 *   node --experimental-strip-types scripts/probe-variants.ts <draftfile> "<question>" <out.md> [runsPerVariant]
 *
 * `copula` counts the constructions the complaint was about ("ist", "sind",
 * "es handelt sich um", "es gibt") per 1000 prose characters: a polisher that
 * only bolts a copula onto a fragment reads well in one sentence and badly in
 * ten.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildFormulatePrompt, renderAppend, maskProtected, unmaskProtected, splitLanguageHeader, verbatimShare, ratioOf, proseOnly } from "../pi-translator.ts";

const BASE = process.env.PROBE_BASE_URL || "http://10.10.0.3:1180/v1";
const KEY = process.env.PROBE_API_KEY || "gpustack_b4e9059fb9ed1d50_89ffb73c100e08b8ac406253d471deab";
const MODEL = process.env.PROBE_MODEL || "qwen3.8-flash-next";

const DU = "Rede die lesende Person in durchgehend informellem „du“ an, nie mit „Sie“.";

// All variants go through the REAL channel: promptAppend, exactly as production
// renders it. A variant that would have to be coded is therefore not tested here
// — this answers "what can settings buy", and keeps the control identical to
// what is actually running (which includes the du rule; a control without it is
// not a control).
const VARIANTS: { name: string; why: string; block?: string }[] = [
	{ name: "A · Kontrolle (produktion)", why: "Der Stand, der gerade läuft — nur die du-Regel, nichts ergänzt." },
	{
		name: "B · Qualitätsmaß",
		why: "Sagt, wie das Ergebnis klingen muss, statt nur zu verbieten: gemeines Wort vor steifem Compound, Verb vor Substantiv, ein Gedanke pro Satz.",
		block: `- Write for a person reading aloud. The test is the ear, not the rules: a sentence that makes the reader stumble is wrong, however faithful it is to the DRAFT.
- Prefer the ordinary word over the stiff compound, and the verb over the noun built from it ("wir haben geprüft" beats "wir haben eine Prüfung durchgeführt"). Replace a coined or translated-sounding term with the plain one when the meaning survives.
- One thought per sentence. Where the DRAFT hangs several claims together with semicolons, give each its own sentence.
- Never repair a fragment by bolting "ist"/"sind"/"es handelt sich um"/"es gibt" in front of it — find the verb the fragment is hiding.`,
	},
	{
		name: "C · Lektorats-Auftrag",
		why: "Gibt einen Job statt eines Zustands: erst die drei schlechtesten Stellen finden, dann genau die neu schreiben.",
		block: `- You are the desk editor of this answer, not its typist. Read the DRAFT the way its reader will. Silently pick the three passages that read worst — a coined term, a telegraphic fragment, a clause stuffed with nouns — and rewrite exactly those.
- "Correct but stiff" counts as worst. A sentence that merely got a verb inserted is not yet written.
- Whatever you leave alone must stay word-for-word; whatever you rewrite must say no more than the DRAFT said.`,
	},
	{
		name: "D · Positives Zielbild",
		why: "Kein Verbot, sondern eine Hausordnung: so sieht ein guter Text hier aus.",
		block: `- The house style of this assistant: direct, active, concrete. Address the reader as "du". Short sentences. Name the actor and the action. Numbers and technical terms stay exactly as the DRAFT has them; connective prose is yours to write.
- A good answer here reads like a competent colleague explaining something at a whiteboard: no bureaucratic nominal style, no translation-flavoured wording, no filler that only announces what follows.`,
	},
	{
		name: "E · Qualitätsmaß + du",
		why: "Wie B, mit der du-Regel zusammen im Settings-Kanal — der Weg, der heute ohne Code-Änderung auskäme.",
		block: `Der Entwurf ist oft holprig: erfundene Wörter, Nominalstil, telegrammartige Halbsätze. Dein Ergebnis muss laut vorgelesen werden können, ohne dass die Lesende stolpert. Nimm das gemeine Wort statt des steifen Compounds und das Verb statt des davon abgeleiteten Substantivs. Ein Gedanke pro Satz. Flicke keinen Halbsatz, indem du "ist"/"sind"/"es handelt sich um"/"es gibt" davor setzt — such das Verb, das im Halbsatz steckt.`,
	},
	{
		name: "F · Beispiel statt Appell",
		why: "Ein schlechtes und ein gutes Satzpaar als Maßstab. Mit „das gemeine Wort statt des steifen Compounds“ kann ein 6B-Modell nichts anfangen — es braucht ein Beispiel.",
		block: `Maßstab, in diesem Ton schreibst du:
Holprig: "Die Fehleranalyse der Signaturdaten ist durchgeführt worden; ein Abweichungsbefund liegt vor."
Sauber:  "Wir haben die Signaturen geprüft und eine Abweichung gefunden."
Mach mit dem ganzen Entwurf dasselbe: Nominalstil wird ein Verb, das passive Glied wird aktiv, ein erfundenes Wort wird das gewöhnliche.`,
	},
	{
		name: "G · Beispiel + Verb-Zwang",
		why: "Wie F, plus das Kopula-Verbot — die beiden Wirksamsten kombinieren.",
		block: `Maßstab, in diesem Ton schreibst du:
Holprig: "Die Fehleranalyse der Signaturdaten ist durchgeführt worden; ein Abweichungsbefund liegt vor."
Sauber:  "Wir haben die Signaturen geprüft und eine Abweichung gefunden."
Mach mit dem ganzen Entwurf dasselbe: Nominalstil wird ein Verb, das passive Glied wird aktiv, ein erfundenes Wort wird das gewöhnliche.
Flicke keinen Halbsatz, indem du "ist"/"sind"/"es handelt sich um"/"es gibt" davor setzt — such das Verb, das im Halbsatz steckt.`,
	},
];

const copulaPer1000 = (t: string) => {
	const prose = proseOnly(t);
	const n = (prose.match(/\b(ist|sind|war|waren|wird|werden|es handelt sich um|es gibt)\b/gi) || []).length;
	return Math.round((n / Math.max(1, prose.length)) * 1000 * 10) / 10;
};

async function run(systemPrompt: string, payload: string) {
	const t0 = Date.now();
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: payload }], max_tokens: 8192 }),
		signal: AbortSignal.timeout(300000),
	});
	const j: any = await res.json();
	return { text: String(j?.choices?.[0]?.message?.content ?? "").trim(), ms: Date.now() - t0 };
}

const draft = readFileSync(process.argv[2]!, "utf8");
const question = process.argv[3] || "Kannst du die Rohevidenz der Tool-Aufrufe zeigen?";
const outPath = process.argv[4] || "/tmp/pt-varianten.md";
const runs = Number(process.argv[5] || 2);

const L: string[] = [];
L.push("# Formulierungs-Prompt: Varianten über denselben Entwurf\n");
L.push(`Entwurf ${draft.length} Zeichen · Modell \`${MODEL}\` · Denklevel: nicht gesetzt (Endpoint-Default) · ${runs} Läufe je Variante\n`);
L.push(`Frage (nur für Sprache und Thema relevant): *${question}*\n`);
L.push("`verbatim` Anteil wörtlich übernommener Sätze · `ratio` Ausgabe- ÷ Eingabelänge · `kopula` „ist/sind/es handelt sich um/es gibt“ pro 1000 Prosa-Zeichen — je höher, desto mehr wurde nur ein Verb vor das Stichwort geschraubt\n");

const only = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",").map((s) => s.trim()) : null;
for (const v of VARIANTS) {
	if (only && !only.some((o) => v.name.startsWith(o + " "))) continue;
	L.push(`\n---\n\n## ${v.name}\n`);
	L.push(`*Warum diese Variante:* ${v.why}\n`);
	for (let i = 1; i <= runs; i++) {
		const appendLines = [DU, v.block].filter(Boolean) as string[];
		const sys = buildFormulatePrompt(renderAppend({ de: appendLines.join("\n") }), "German");
		const masked = maskProtected(draft);
		const r = await run(sys, `QUESTION:\n${question}\n\nDRAFT:\n${masked.masked}`);
		const split = splitLanguageHeader(r.text);
		const back = unmaskProtected(split.text, masked.spans);
		const body = back.ok ? back.text : `[PLATZHALTER VERLOREN: missing ${back.missing} dups ${back.dups}]`;
		L.push(
			`**Lauf ${i}** — ${r.ms} ms · verbatim ${verbatimShare(draft, split.text)} · ratio ${ratioOf(split.text, draft)} · kopula ${copulaPer1000(split.text)}${back.ok ? "" : " · ⚠ Platzhalter"}\n`,
		);
		L.push(body + "\n");
	}
}

writeFileSync(outPath, L.join("\n"));
console.log("geschrieben:", outPath);
