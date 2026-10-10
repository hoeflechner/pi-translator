# pi-translator — Language Tail for pi

**Status: mechanism VERIFIED end-to-end (2026-10-10). The generic
implementation per `03-design-language-tail.md` is the next step.**
Concept: the agent always **works in the machine's language** (English by
default — its strongest token region). When the user writes in another
language, the final answer is rewritten by a **separate, context-free
translation call on the delivery path**, using a **language-neutral
prompt**: the translator is simply told which language to produce. The
model itself never generates the target language, so long-context
language corruption can never surface.

**This is not a German patch. German was just the symptom that proved the
mechanism. The design target is: any target language, zero language-
specific code or prompts.** Style rules a human wants (e.g. the German
informal „du“) are user-supplied text appended to the generic translator
prompt (`promptAppend`) — never shipped built-in per language.

## Why this exists (short version — full evidence in 01-findings.md)

`the local MoE model` (~180B MoE, 6B active/token, served locally via
the serving router→vLLM) progressively corrupts **German generation** in long chats:
Chinese morphemes fused into German words (`contra⟨CJK⟩`, `zwei⟨CJK⟩liche`),
invented compounds and verbs (⟨calque⟩, ⟨calque⟩), wrong
calques (⟨calque⟩ for CPU flag). Measured dose–response over one 30-day
session transcript: artifact rate **10% at 35–60k context tokens → 24% at
154–234k**. The same model is **clean in English** (12/12 artifact-magnet
probes). Its dense sibling (the local dense model) is clean in German (0/64).
→ Keep the fast model in English, translate the output with a clean model
in a fresh context. That removes the entire failure regime.

## Document map

| File | Content |
|---|---|
| `01-findings.md` | All measured evidence: session analysis, model facts, dose-response, probes, root causes, known upstream issues, empty-bubble bug |
| `02-architecture.md` | Chosen mechanism + exact pi extension API ground truth (verified signatures, v1 test log) |
| `03-design-language-tail.md` | **The implementation spec**: language-agnostic translator prompt, per-language detector/validation tables, config, test plan, open questions |

## Archived v1 (German-specific)

The verified German-specific v1 extension and the optional training track
were removed on 2026-10-10 (operator decision: no harvesting, no
German-specific artifacts). Both are preserved in git snapshot `<initial-commit>`:

```bash
git show <initial-commit>:reference/german-tail-v1.ts   # the verified v1 code
git show <initial-commit>:docs/04-training-track.md     # the parked training track
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
