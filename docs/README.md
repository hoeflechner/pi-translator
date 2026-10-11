# pi-translator — Language Tail for pi

**Status: v2 IMPLEMENTED AND DRILLED (2026-10-10) — bidirectional context-
free translation, model context 100% working language, all drills passed.
v1 spec: `03-design-language-tail.md`; v2: `05-plan-v2.md`.**
Concept: the agent always **works in the machine's language** (English by
default — its strongest token region). Both directions of a turn are wrapped
by **context-free LLM translation calls** (question → working language for
the model; answer → the user's language for delivery), and a `context`
handler hands the model back its working-language originals on every later
call — the model context stays 100% working language, the transcript stays
the user's language.

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
| `03-design-language-tail.md` | **The implementation spec**: single context-free translator call doing detection + translation, generic validation, config, test plan, open questions |
| `05-plan-v2.md` | **v2 plan**: 100%-English model context (context-restore), prompt translation, placeholder protection, adopted UX from prior art, rejected options, naming situation |

## Quickstart (verified commands, 2026-10-10)

The implementation lives at the repo root: `pi-translator.ts` (+ unit test
`pi-translator.test.ts`). The user-facing README is one level up.

```bash
cd pi-translator

# unit tests (no LLM, no pi runtime): spec §6.1 + §6.7
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON pi-translator.test.ts

# load smoke
pi --extension ./pi-translator.ts --model <provider>/<clean-model> \
   --print "Reply with exactly: extension-load-ok"

# full round-trip: German question → English working draft → German delivery
PI_TRANSLATOR=1 pi --extension ./pi-translator.ts --model <provider>/<clean-model> \
   --print "Was ist ein Port-Konflikt? Antworte in genau zwei Sätzen."
```

Add `PI_TRANSLATOR_DEBUG=1` to any run to see the tail's decisions on stderr
(`translated` / `passthrough` / `fallback`). Config precedence is
env > settings > defaults; the `pi-translator` settings block lives in
`{cwd}/.pi/settings.json` (a working `du`-rule example is committed there)
or `~/.pi/agent/settings.json`. A configured block enables the tail even
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
