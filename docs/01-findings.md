# 01 — Findings: the evidence behind the Language Tail

All findings from a 2026-10-10 analysis session.
Primary artifact: a 30-day personal pi-web session transcript (2026-09-10 →
10-10; 124 user / 484 assistant messages; two locally served models —
referred to below as **the MoE worker** and **the dense sibling** — 5
compactions, 8 model switches). The detailed private research notes stay
out of this repo on purpose.

## 1. The failure (what degradation looks like)

Two artifact classes in **final assistant texts**, only from the MoE worker:

**A) CJK morpheme fusion** (model-intrinsic tokenization/alignment leak, loud):
13+ distinct occurrences of Chinese morphemes fused directly into German
words (script mixing inside single tokens), zero in any message of the
dense sibling, present from the MoE worker's very first day to the final
message of the session.

**B) Calques / invented morphology** (quiet — reads fluent, is wrong):
calqued meanings of English technical terms (~10 occurrences of one class),
invented verbs, invented compounds and mangled word forms — roughly a dozen
distinct examples across the transcript.
Clustered after 2026-10-06, when AGENTS.md gained an explicit *no-anglicisms*
rule: **forbidding loan words forces translation; a weak model mistranslates.**
(Class A predates that rule → A is intrinsic, B is rule-amplified. The
production response: the no-anglicisms rule was REMOVED from global
AGENTS.md 2026-10-10 — "an occasional anglicism beats an invented word."
Style policy now lives only in the translator prompt, which is fresh per
call and therefore never diluted.)

## 2. Dose–response: volume is the axis (measured, not vibes)

Per-message detector (CJK regex + calque list) against each assistant
message's **real context size** (`usage.input`), window-reset at the 5
compactions:

| context quartile (tokens) | artifact rate |
|---|---|
| 35k–60k | 10% |
| 60k–91k | 7% |
| 91k–154k | 14% |
| **154k–234k** | **24%** |

Median context at artifact messages **131k** vs 86k at clean. Tool-output
*share* of context: **flat** (12/12/17/14%) — "many tool calls make it
worse" is true but **mediated through accumulated volume**, not through
language mixing per se. Thinking-text share: no positive signal (even
inverted). The dense sibling: 0/64 artifacts in every quartile.
**Practical number: keep the MoE worker's German chats under ~90k tokens or
the artifact rate ~2.5×'s; the tail removes the exposure entirely.**

## 3. Model facts (official sources, verified 2026-10-10; identities withheld)

- **The MoE worker** (released 2026-08-26): multimodal **ultra-sparse MoE**,
  roughly ~180B total parameters with ~6B active per token; hybrid
  linear/full attention; very long native context (extended further via
  YaRN); community-tier license. Positioned by its vendor as "ultimate cost
  efficiency".
- **Not** a weaker tier per benchmarks: it scores ≥ the dense sibling on most
  official suites. **No official German/general-multilingual benchmark
  exists** for it (a German EuroEval request is open upstream; a community
  blind bench including German prose is running).
- Served locally behind a self-hosted inference stack (serving-router +
  vLLM-class backend); the dense sibling runs dense in fp16/bf16 nearby,
  thinking enabled. Both registered in the pi model registry.
- **Naming policy of this doc set:** concrete model/provider names are
  deliberately omitted. They add nothing to the mechanism (the failure is a
  *regime*, not a product review) and the transcript-level evidence is
  personal data.

## 4. Family-level language-corruption reports (evidence-ranked)

1. Official model card Best Practices: higher `presence_penalty` "may
   occasionally result in **language mixing**" — vendor-acknowledged knob.
2. Reproducible upstream report on the dense sibling: all **quantized
   checkpoints** of the current generation systematically corrupt an
   agglutinative non-European language where the previous generation was
   clean → weights/training recipe implicated family-wide.
3. Engine bug report on the MoE worker: prefix/hot-cache restore corruption
   after long sessions → "model reads a German prompt as Chinese" until
   restart — exact symptom can be **engine state, not weights**.
4. Quantization report (aggressive quant): deterministic CJK token-loop
   collapse, English unaffected → quantization affects languages
   asymmetrically.
5. Engine × quant interaction report: same checkpoint, one quantization
   degenerates mixed scripts on one serving engine, clean on another.
6. Published probe "Rare CJK Cross-Lingual Leakage in a Local MoE Family":
   Italian output with fused CJK morphemes (7/100 generations) —
   morphologically identical to our class-A artifacts.

No German-specific official-tracker report for this model existed as of
2026-10-10. **The measurement above could be filed upstream** (the eval
harness of the dropped training track — archived in the repo's first git
snapshot — would be the evidence package).

## 5. Probes run against the live endpoint (2026-10-10)

- 4 artifact-magnet prompts (monitor/framerate, CPU flag, Cloudflare,
  libvirt) × `presence_penalty` {server-default, 0, 1.5}, thinking OFF:
  **12/12 clean, 0 CJK, 0 calques.** pp=1.5 produced the most Germanized
  vocabulary without calques → presence_penalty alone is NOT the trigger;
  the checkpoint's `generation_config.json` contains **no**
  presence_penalty (only temp 1.0, top_k 20, top_p 0.95 — note temp 1.0
  as a serving-spice consideration).
- **Empty-bubble mechanism found**: with thinking ON and `max_tokens=3000`,
  BOTH models returned `finish_reason=length`, 3000 reasoning tokens,
  **empty content**. This is the high-probability explanation for the
  transcript's Oct-9 incident (user typed "hallo?" 4×, got 4 empty assistant
  messages): a **reasoning-budget overflow**, not an endpoint outage. Fix
  direction: thinking-token budget cap / higher max_tokens / empty-content
  retry — belongs to serving & pi config, out of scope here.
- **`preserve_thinking` confirmed officially**: the vendor's fine-tuning
  best-practice doc states this generation *preserves historical thinking
  content by default* (previous generations discard it), `reasoning_effort`
  default xhigh. Long chats therefore accumulate the model's (English)
  thinking in context. Our quartile analysis showed no independent
  thinking-share signal, but `preserve_thinking=false` + capped effort
  remain sensible serving-side hygiene.
- Root-cause ranking for the long-chat German failure: (1) serving state —
  quant / KV-quant / prefix-cache on the MoE checkpoint, (2) preserved
  thinking round-tripping, (3) presence_penalty, (4) weights LAST.
  **The Language Tail is agnostic to which of these wins — it removes
  target-language generation from the risk surface entirely.**

## 6. Why the tail translation lands in clean territory

The corruption needs (target-language generation) + (accumulated volume).
The tail's translation call is fresh + ~1–3k tokens + isolated: exactly the
regime where probes measured zero artifacts (and where the dense sibling
shows 0/64 regardless). Delivery quality is then governed by a tiny, stable
prompt, not by whatever 200k tokens the agent has accumulated.

## 7. Side findings worth keeping

- German input costs ~8% more input tokens than English for this tokenizer
  (measured 2026-09) — working-language-English also slightly cheapens
  the agent loop.
- The analyzed session ran 30 days / 1044 messages / 5.7 MB with 5
  compactions — session hygiene (rotation, tool-output budgets, sub-session
  delegation of heavy fetches) independently improved quality in every
  window that had a fresh context. Keep these habits regardless of the tail.
- Instruction dilution is real: static AGENTS.md rules lose to recent
  context. The tail exploits the inverse: its style rules live in a prompt
  that is *always recent*.
