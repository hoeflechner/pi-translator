/**
 * A/B probe for the formulate prompt — same drafts through the OLD and the NEW
 * prompt builder, side by side, so a prompt change is judged on evidence and
 * not on how it reads.
 *
 *   node --experimental-strip-types scripts/probe-prompt.ts cases.json out.md
 *
 * Cases: [{ "label": string, "question": string, "draft": string }]
 * The prompt under test is imported from the real module — this script never
 * carries its own copy of the prompt, so it cannot drift from what ships.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildFormulatePrompt as buildNew, maskProtected, unmaskProtected, splitLanguageHeader, verbatimShare, ratioOf, proseOnly } from "../pi-translator.ts";
import { buildFormulatePrompt as buildOld } from "/tmp/old-pt.ts";

const BASE = process.env.PROBE_BASE_URL || "http://10.10.0.3:1180/v1";
const KEY = process.env.PROBE_API_KEY || "gpustack_b4e9059fb9ed1d50_89ffb73c100e08b8ac406253d471deab";
const MODEL = process.env.PROBE_MODEL || "qwen3.8-flash-next";
const REASONING = process.env.PROBE_REASONING || "medium";
const APPEND = process.env.PROBE_APPEND || "";

async function run(systemPrompt: string, payload: string): Promise<{ text: string; ms: number; err?: string }> {
	const t0 = Date.now();
	try {
		const res = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "system", content: systemPrompt }, { role: "user", content: payload }],
				reasoning_effort: REASONING,
				max_tokens: 4096,
			}),
			signal: AbortSignal.timeout(300000),
		});
		const j: any = await res.json();
		const text = j?.choices?.[0]?.message?.content ?? "";
		return { text: String(text).trim(), ms: Date.now() - t0, err: text ? undefined : `empty: ${JSON.stringify(j).slice(0, 200)}` };
	} catch (e: any) {
		return { text: "", ms: Date.now() - t0, err: String(e?.message || e) };
	}
}

const cases: any[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const outPath = process.argv[3] || "/tmp/probe-out.md";
const variants = [
	{ name: "ALT", build: buildOld },
	{ name: "NEU", build: buildNew },
];

const L: string[] = [];
L.push("# A/B: telegrammartige Entwürfe durch den Formulierungs-Prompt\n");
L.push(`Modell \`${MODEL}\` · Denkstufe \`${REASONING}\` · ${cases.length} Entwürfe · je Variante ein Aufruf\n`);
L.push("`verbatim` = Anteil der Sätze aus dem Entwurf, die wörtlich wiederkehren · `ratio` = Ausgabe- ÷ Eingabelänge (Prosa, Code aus) · beide aus den echten Helferfunktionen des Moduls.\n");

for (const c of cases) {
	L.push(`\n---\n\n## ${c.label}\n`);
	L.push(`*Frage:* ${String(c.question).replace(/\n/g, " ").slice(0, 160)}\n`);
	L.push("**ENTWURF**\n");
	L.push(c.draft + "\n");
	for (const v of variants) {
		const masked = maskProtected(c.draft);
		const payload = `QUESTION:\n${c.question}\n\nDRAFT:\n${masked.masked}`;
		const r = await run(v.build(APPEND, null), payload);
		const split = splitLanguageHeader(r.text);
		const restored = unmaskProtected(split.text, masked.spans);
		const out = restored.ok ? restored.text : `[PLATZHALTER VERLOREN: missing ${restored.missing} dups ${restored.dups}]\n\n${split.text}`;
		L.push(`**${v.name}** — ${r.ms} ms · verbatim ${r.text ? verbatimShare(c.draft, split.text) : "-"} · ratio ${r.text ? ratioOf(split.text, c.draft) : "-"}${r.err ? ` · FEHLER: ${r.err}` : ""}\n`);
		L.push((out || "_(leer)_") + "\n");
	}
	void proseOnly;
}

writeFileSync(outPath, L.join("\n"));
console.log("geschrieben:", outPath);
