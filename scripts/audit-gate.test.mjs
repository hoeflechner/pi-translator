#!/usr/bin/env node
/** Hand-computed expectations for the gate (docs/06 R7: "run it on a fixture log
 *  with hand-computed expected values"). node scripts/audit-gate.test.mjs */
import assert from "node:assert/strict";
import { gate } from "./audit-gate.mjs";

const row = (o) => ({ ts: "2026-10-24T12:00:00Z", dir: "reply", mode: "formulate", model: "sharc/worker", ms: 1000, lang: "German", ...o });
const many = (n, o) => Array.from({ length: n }, () => row(o));

// 100 calls: 50 clean, 10 class-A introduced, 10 class-A inherited, 20 noop, 10 reject.
// A Japanese answer is excluded from M1 by language, and the 5 skip rows must not
// count as calls at all.
const rows = [
	...many(50, { verdict: "text", out: "Sauberes Deutsch.", ratio: 1.2, verbatim: 0.3 }),
	...many(10, { verdict: "text", out: "Deutsch mit 漢字 drin.", ratio: 1.2 }),
	...many(10, { verdict: "text", out: "日本語混じり aus dem draft.", ratio: 1.2, inherited_cjk: true }),
	...many(1, { verdict: "text", out: "日本語の答え。", ratio: 1.2, lang: "Japanese" }),
	...many(20, { verdict: "noop", out: "wie der draft", ratio: 1.0 }),
	...many(10, { verdict: "reject", guard: "length" }),
	...many(5, { verdict: "skip", reason: "no-language-evidence" }),
];

const [m] = gate(rows);
assert.equal(m.model, "sharc/worker");
assert.equal(m.calls, 101, "5 skip rows are not calls; the Japanese answer is");
assert.equal(m.M1, 10 / 60, "class-A share over delivered non-inherited Latin rows only");
assert.equal(m.M2, 20 / 101, "20 of 101 calls did nothing");
assert.equal(m.M3, 10 / 101, "10 of 101 calls were rejected");
assert.equal(m.M4, 1000, "flat ms → p90 is that value");
assert.equal(m.M5, 1.2, "median of a constant");
assert.equal(m.M6, 0.3, "30% of draft sentences copied verbatim");
assert.equal(m.M6, 0.3, "30% of draft sentences copied verbatim");
assert.equal(m.M6, 0.3, "30% of draft sentences copied verbatim");
assert.equal(m.langNull, 0);
assert.deepEqual(m.status, { M1: "FALSIFIED", M2: "ok", M3: "ok", M4: "ok", M5: "ok", M6: "ok" });
assert.equal(m.falsified, true);

// A clean population holds, and the two watch thresholds are reachable.
const clean = gate([...many(100, { verdict: "text", out: "Sauberes Deutsch.", ratio: 1.1, verbatim: 0.2 })])[0];
assert.deepEqual(clean.status, { M1: "ok", M2: "ok", M3: "ok", M4: "ok", M5: "ok", M6: "ok" });
assert.equal(clean.falsified, false);
const padded = gate([...many(100, { verdict: "text", out: "x", ratio: 1.9 })])[0];
assert.equal(padded.status.M5, "watch", "filler growth is visible before it is fatal");
const sleepy = gate([...many(100, { verdict: "text", out: "x", ms: 61_000 })])[0];
assert.equal(sleepy.status.M4, "FALSIFIED", "a polisher slower than the tail it replaces fails the bet");
const chatty = gate([...many(100, { verdict: "noop" })])[0];
assert.equal(chatty.status.M2, "FALSIFIED", "a polisher that never polishes fails the bet");
const dirty = gate([...many(100, { verdict: "text", out: "漢字" })])[0];
assert.equal(dirty.status.M1, "FALSIFIED");
const copier = gate([...many(100, { verdict: "text", out: "x", verbatim: 0.62 })])[0];
assert.equal(copier.status.M6, "FALSIFIED", "a polisher that transcribes the draft is falsified (the 0.61 baseline)");

// Under the floor the shares print but are not verdicts — thin data must never
// falsify a model on 5 turns.
const thin = gate([...many(5, { verdict: "noop" })])[0];
assert.equal(thin.calls, 5);
assert.equal(thin.status.M2, "thin", "too few calls to judge");
assert.equal(thin.falsified, false);

// Two worker labels are measured separately — the gate is per model, not global.
const both = gate([...many(100, { verdict: "text", out: "x" }), ...many(100, { verdict: "text", out: "漢字", model: "local/smart" })]);
assert.equal(both.length, 2);
assert.equal(both.find((x) => x.model === "sharc/worker").falsified, false);
assert.equal(both.find((x) => x.model === "local/smart").falsified, true);

// Rows from the pre-F4 versions (no mode field) are not evidence about this design.
assert.equal(gate([{ dir: "reply", verdict: "text", model: "m", out: "漢字" }]).length, 0, "translate-era rows ignored");
assert.equal(gate([{ dir: "prompt", mode: "formulate", verdict: "text", model: "m" }]).length, 0, "wrong direction ignored");

console.log("audit-gate.test.mjs: all assertions passed");
