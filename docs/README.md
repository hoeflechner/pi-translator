# pi-translator — Language Tail for pi

**Status: v3 F3+F4 IMPLEMENTED (2026-10-24) — no pre-start call, no delivery
gate: the user's text reaches the model as written and every answer is
formulated by one context-free call. Current design: `06-plan-v3.md`;
measurements: `01-findings.md` §8. `03-design-language-tail.md` (v1) and
`05-plan-v2.md` (v2) are **history** — they describe prompt translation and the
`NONE` passthrough, both of which no longer exist.**
Concept: the agent always **works in the machine's language** (English by
default — its strongest token region). Since **F4** the user's own text is
**not** translated before the model sees it: the 100%-working-language
invariant was unachievable anyway, because injected memories, tool results and
file content carry the user's language regardless. What remains is one
**context-free formulation call** per answer, which produces the final text in
the reader's language — same-language answers included — plus a `context`
handler that hands the model back **its own** working-language drafts and tool
arguments on every later call. The transcript stays the user's language; the
model's own words stay the working language.

**This is not a German patch. German was just the symptom that proved the
mechanism. The design target is: any target language, zero language-
specific code, tables or prompts.** Style rules a human wants (e.g. the
German informal „du“) are user-supplied text appended to the generic
translator prompt (`promptAppend`) — never shipped built-in per language.

## Why this exists (short version — full evidence in 01-findings.md)

The locally served **ultra-sparse MoE model** of this instance (~180B total,
~6B active/token, self-hosted serving stack) progressively corrupts **German
generation** in long chats: Chinese morphemes fused into German words,
invented compounds and verbs, wrong calques of English technical terms
(exact samples withheld — transcript-derived personal data). Measured
dose–response over one 30-day session transcript: artifact rate **10% at
35–60k context tokens → 24% at 154–234k**. The same model is **clean in
English** (12/12 artifact-magnet probes). Its dense local sibling (~27B)
is clean in German (0/64).
→ Keep the fast model in English, translate the output with a clean model
in a fresh context. That removes the entire failure regime.

## Document map

| File | Content |
|---|---|
| `01-findings.md` | All measured evidence: session analysis, model facts, dose-response, probes, root causes, known upstream issues, empty-bubble bug |
| `02-architecture.md` | Chosen mechanism + exact pi extension API ground truth (verified signatures, v1 test log) |
| `03-design-language-tail.md` | **History (v1)**: the original single context-free call doing detection + translation, validation, config, test plan. Its `NONE` passthrough and detection instruction **no longer exist** |
| `05-plan-v2.md` | **History (v2)**: 100%-English model context (context-restore), prompt translation, placeholder protection, adopted UX, rejected options. Prompt translation and the 100%-English invariant were **deleted by v3** — kept because the decisions below are argued against its measurements |
| `06-plan-v3.md` | **Current design (2026-10-24)**: F3 + F4 shipped — prompt translation and the detect call both deleted, one always-on formulation call per answer with a parsed language header, the guard matrix, the owner decisions (always reformulate; agent model as polisher), the falsification gate and its M1–M6 thresholds, what each earlier review finding became, deploy order |

## Quickstart (verified commands)

The implementation lives at the repo root: `pi-translator.ts`,
`pi-translator.test.ts` (34 unit), `pi-translator.form.test.ts` (14 async
integration over the real factory with a mocked model), and
`scripts/audit-gate.mjs` (the falsification gate).

```bash
cd pi-translator

# unit + integration tests (no LLM, no pi runtime)
node --experimental-strip-types pi-translator.test.ts
node --experimental-strip-types pi-translator.form.test.ts
node scripts/audit-gate.test.mjs

# load smoke
pi --extension ./pi-translator.ts --model <provider>/<model> \
   --print "Reply with exactly: extension-load-ok"

# round-trip: German question, draft in any language, formulated German delivery
PI_TRANSLATOR=1 PI_TRANSLATOR_LOG=/tmp/pt.jsonl pi --extension ./pi-translator.ts \
   --model <provider>/<model> \
   --print "Was ist ein Port-Konflikt? Antworte in genau zwei Sätzen."
node scripts/audit-gate.mjs /tmp/pt.jsonl      # verdict per model label
```

Add `PI_TRANSLATOR_DEBUG=1` to any run to see the tail's decisions on stderr
(e.g. `reply formulated (German via …)`, `formulation changed nothing`, `delivering as written`). Config precedence
is env > settings > defaults; the `pi-translator` settings block lives in
`{cwd}/.pi/settings.json` (a working `du`-rule example is committed there) or
`~/.pi/agent/settings.json`. A configured block enables the tail even
without `PI_TRANSLATOR=1`.

## Archived v1 (German-specific)

The verified German-specific v1 extension and the optional training track
were removed on 2026-10-10 (operator decision: no harvesting, no
German-specific artifacts). Both are preserved in the first git snapshot
(`INIT=$(git rev-list --max-parents=0 HEAD)`):

```bash
git show $INIT:reference/german-tail-v1.ts   # the verified v1 code
git show $INIT:docs/04-training-track.md     # the parked training track
```

The v1 test log (02 §test-log) records the end-to-end verification of the
mechanism: load smoke, working-language guideline overriding German input,
German round-trip delivery, and a detector miss caught by unit testing.

## Ground rules for implementation

1. **Never translate from the model's context** — the translation call is
   context-free by design (only: tiny generic system prompt + user question
   for disambiguation + the draft answer).
2. **Every translation is validated** (script guard, non-empty, stopReason)
   and on failure falls back to the working-language original, never to a
   silent empty bubble.
3. **The translator prompt is language-neutral.** No per-language style
   hints ship with the tail. The one user-facing knob for style is
   `promptAppend` (settings, per language + global) — e.g. German
   informal-du is expressed there, by the user, not in code.
4. **Nothing is harvested** — the tail persists no extra records; only the
   normal session transcript exists.
5. Do NOT auto-install into a shared instance's extension path without
   operator sign-off (sessiond loads extensions at boot for ALL users).
