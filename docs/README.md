# pi-translator — Language Tail for pi

**Status: v1 reference implementation VERIFIED END-TO-END (2026-10-10).**
Concept: the agent always **works in the machine's language** (English by
default — its strongest token region). When the user writes in another
language, the final answer is rewritten by a **separate, context-free
translation call** on the delivery path. The model itself never generates
the target language, so long-context language corruption can never surface.

**This is not a German patch. German was just the symptom that proved the
mechanism. The design target is: any target language, pluggable.**

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
| `02-architecture.md` | Chosen mechanism + exact pi extension API ground truth (verified signatures, test log) |
| `03-design-language-tail.md` | **The implementation spec**: generic multi-language design, language profiles, validation, config, test plan, open questions |
| `04-training-track.md` | Optional downstream track: harvesting the tail's own pairs to train a dedicated translator (DPO/GRPO on H200/SLURM) |
| `reference/german-tail-v1.ts` | The verified working v1 (German-specific) — the thing to generalize |

## Quickstart (verified commands)

```
/data/user/pi-translator/
├─ docs/            ← this documentation set
└─ reference/german-tail-v1.ts   ← verified v1 code (German-specific)
```

```bash
cd /data/user/pi-translator

# load smoke test
pi --extension ./reference/german-tail-v1.ts --model the local dense model \
   --print "Reply with exactly: extension-load-ok"

# full round-trip: German question → English working draft → German delivery
GERMAN_TAIL=1 pi --extension ./reference/german-tail-v1.ts --model the local dense model \
   --print "Was ist ein Port-Konflikt? Antworte in genau zwei Sätzen."
```

Env knobs (v1): `GERMAN_TAIL=1` (enable at boot), `GERMAN_TAIL_MODEL=provider/id`
(default `the local dense model`). Per-session toggle: `/gtranslate [on|off]`.

## Reference implementation layout

| File | Content |
|---|---|
| `reference/german-tail-v1.ts` | The verified working v1 (German-specific) — the thing to generalize; implemented from 03 spec |

## Ground rules for implementation

1. **Never translate from the model's context** — the translation call is
   context-free by design (only: tiny system prompt + user question for
   disambiguation + the draft answer).
2. **Every translation is validated** (script guard, non-empty, stopReason)
   and on failure falls back to the working-language original, never to a
   silent empty bubble.
3. **Every round-trip is harvested** as a training pair (see 04) — the
   product doubles as its own dataset.
4. Do NOT auto-install into a shared instance's extension path without
   operator sign-off (sessiond loads extensions at boot for ALL users).
