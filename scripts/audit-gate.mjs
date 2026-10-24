#!/usr/bin/env node
/**
 * Falsification gate for the owner's bet "the agent's own model is a good enough
 * polisher" (docs/06 R7). Reads the audit log, prints M1-M5 per worker label,
 * exits 1 when any metric is FALSIFIED.
 *
 *   node scripts/audit-gate.mjs [/data/bernhard/.pi/pi-translator.jsonl] [--since 2026-10-24]
 *
 * R7 defined these over the F2 `dir:"polish"` population. F4 has one call per
 * answer, so the population is `dir:"reply"` rows with `mode:"formulate"`,
 * minus `verdict:"skip"` (no call happened, so it is not evidence about the
 * model). Everything else is R7 as written.
 */
import { readFileSync } from "node:fs";

const THRESH = {
	classA: { watch: 0.02, fail: 0.05 }, // >5%: no better than the worker's own German (01 §4: 10-24% corrupted)
	noop: { fail: 0.3 }, // >30%: the polisher is doing nothing — the weak-model signature
	failed: { fail: 0.15 }, // >15%: the guards are fighting the model
	p90ms: { fail: 60_000 }, // the reply p90 it replaces was 72.1s (01 §8) — the bet must be cheaper
	ratio: { watch: 1.5 }, // median prose growth: manufactured filler creeping in
};
const MIN_CALLS = 100; // R7: below this the shares are noise, not a verdict
const CLASS_A = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A class-A character in a legitimately CJK answer is not a defect.
const CJK_LANG = /chinese|cantonese|japanese|korean|mandarin/i;

export function gate(rows) {
	const byModel = new Map();
	for (const r of rows) {
		if (r.dir !== "reply" || r.mode !== "formulate" || r.verdict === "skip") continue;
		if (!byModel.has(r.model ?? "unknown")) byModel.set(r.model ?? "unknown", []);
		byModel.get(r.model ?? "unknown").push(r);
	}
	const out = [];
	for (const [model, rs] of byModel) {
		const delivered = rs.filter((r) => r.verdict === "text");
		const latin = delivered.filter((r) => !r.inherited_cjk && !CJK_LANG.test(r.lang ?? ""));
		const p90 = percentile(rs.map((r) => r.ms).filter((m) => typeof m === "number"), 0.9);
		const ratios = delivered.filter((r) => typeof r.ratio === "number").map((r) => r.ratio).sort((a, b) => a - b);
		const m = {
			model,
			calls: rs.length,
			M1: latin.length ? latin.filter((r) => CLASS_A.test(r.out ?? "")).length / latin.length : null,
			M2: rs.length ? rs.filter((r) => r.verdict === "noop").length / rs.length : null,
			M3: rs.length ? rs.filter((r) => r.verdict === "reject" || r.verdict === "error" || r.verdict === "none").length / rs.length : null,
			M4: p90,
			M5: ratios.length ? median(ratios) : null,
			// Delivered rows whose target language never got parsed — M1 and M2
			// silently shrink without this being visible.
			langNull: delivered.filter((r) => !r.lang).length,
		};
		const thin = rs.length < MIN_CALLS;
		m.status = {
			M1: share(m.M1, THRESH.classA, thin),
			M2: share(m.M2, THRESH.noop, thin),
			M3: share(m.M3, THRESH.failed, thin),
			M4: m.M4 === null ? "n/a" : m.M4 > THRESH.p90ms.fail ? "FALSIFIED" : "ok",
			M5: m.M5 === null ? "n/a" : m.M5 > THRESH.ratio.watch ? "watch" : "ok",
		};
		m.falsified = Object.values(m.status).includes("FALSIFIED");
		out.push(m);
	}
	return out;
}

const share = (v, t, thin) => (v === null ? "n/a" : thin ? "thin" : v > t.fail ? "FALSIFIED" : t.watch !== undefined && v > t.watch ? "watch" : "ok");
const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
function percentile(a, p) {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const since = args.includes("--since") ? Date.parse(args[args.indexOf("--since") + 1]) : 0;
	const file = args.find((a) => !a.startsWith("--") && a !== args[args.indexOf("--since") + 1]) ?? "/data/bernhard/.pi/pi-translator.jsonl";
	const rows = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((r) => r && (!since || Date.parse(r.ts) >= since));
	const res = gate(rows);
	if (!res.length) {
		console.log(`no formulate-mode reply rows in ${file} — nothing measured (pre-F4 log, or the host was never restarted)`);
		process.exit(0);
	}
	const pct = (v) => (v === null ? "  —  " : `${(v * 100).toFixed(1)}%`);
	for (const m of res) {
		console.log(`\n${m.model}  (${m.calls} calls, ${m.langNull} delivered without a parsed language)`);
		console.log(`  M1 class-A introduced  ${pct(m.M1).padStart(6)}  ${m.status.M1}   (fail >${THRESH.classA.fail * 100}%, watch >${THRESH.classA.watch * 100}%)`);
		console.log(`  M2 noop (did nothing)  ${pct(m.M2).padStart(6)}  ${m.status.M2}   (fail >${THRESH.noop.fail * 100}%)`);
		console.log(`  M3 reject/error/none   ${pct(m.M3).padStart(6)}  ${m.status.M3}   (fail >${THRESH.failed.fail * 100}%)`);
		console.log(`  M4 latency p90         ${m.M4 === null ? "  —  " : `${(m.M4 / 1000).toFixed(1)}s`}  ${m.status.M4}   (fail >${THRESH.p90ms.fail / 1000}s)`);
		console.log(`  M5 median ratio        ${m.M5 === null ? "  —  " : m.M5.toFixed(2)}   ${m.status.M5}   (watch >${THRESH.ratio.watch})`);
		if (m.calls < MIN_CALLS) console.log(`  ⚠ under ${MIN_CALLS} calls — shares are reported but not verdicts ("thin")`);
	}
	const bad = res.filter((m) => m.falsified);
	console.log(bad.length ? `\nFALSIFIED on: ${bad.map((m) => m.model).join(", ")} — the polisher model decision is open again (docs/06)` : "\nGate holds on the measured population.");
	process.exit(bad.length ? 1 : 0);
}
