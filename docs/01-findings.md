# 01 — Findings: the evidence behind the Language Tail

All findings from 2026-10-10 (analysis session, analysis container).
Primary artifact: 30-day pi-web transcript `<session-transcript>.jsonl` ("misc", 2026-09-10 → 10-10, 124 user / 484 assistant messages, models `the local dense model` + `provider-a/the local MoE model`, 5 compactions, 8 model switches). Deep-dive research file: `<research-note>`. Running log: `<journal>`.

## 1. The failure (what degradation looks like)

Two artifact classes in **final assistant texts**, Model-only:

**A) CJK morpheme fusion** (model-intrinsic tokenization/alignment leak, loud):
`contra⟨CJK⟩`, `Beim Start⟨CJK⟩t`, `⟨CJK⟩är`, `zwei⟨CJK⟩liche Punkte`,
`offene⟨CJK⟩kette`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`, `⟨CJK⟩`.
13+ occurrences, **zero in any the dense model (27B) message**, from Model's very
first day to the final message of the session.

**B) Calques / invented morphology** (quiet — reads fluent, is wrong):
⟨calque⟩ ×10 (for CPU "flag"), ⟨calque⟩ ("Windows Store"),
⟨calque⟩ ("frame rate"), ⟨calque⟩ (invented verb), ⟨calque⟩,
⟨calque⟩, ⟨calque⟩, ⟨calque⟩, ⟨calque⟩, ⟨calque⟩.
Cluster after 2026-10-06 when AGENTS.md gained an explicit *no-anglicisms*
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
inverted). the dense model (27B): 0/64 artifacts in every quartile.
**Practical number: keep a Model-the MoE model chat under ~90k tokens or the
artifact rate ~2.5×'s; the tail removes the exposure entirely.**

## 3. Model facts (official sources, verified 2026-10-10)

- Model3.8-Flash-Next (released 2026-08-26): multimodal **ultra-sparse MoE**,
  125B main params + 51B n-gram embedding table + 4B MTP ≈ **~180B total,
  6B ACTIVE per token**; 48 layers, 512 experts (10 routed + 1 shared);
  hybrid Gated DeltaNet (3/4 layers) + Model Sparse Attention; 262K native
  context (1M via YaRN); Model-community-1.0 license; Model4 architecture
  preview. Positioned "ultimate cost efficiency".
- **Not** a weaker tier per benchmarks: ≥ 27B on most official suites
  (DeepSWE 58.7 vs 42.2 etc.). **No official German/general-multilingual
  benchmark exists** (EuroEval German only requested, the vendor tracker#2158;
  community blind bench with German prose running, crow-nest#152).
- Served locally: the serving router (<internal-host>) → vLLM backend. the dense model =
  the local dense model dense on <inference-host> behind an LLM proxy (<internal-host>),
  thinking enabled. Both registered in `~/.pi/agent/models.json`
  (providers `provider-a`, `local`).

## 4. Family-level language-corruption reports (evidence-ranked)

1. Official model card Best Practices: higher `presence_penalty` "may
   occasionally result in **language mixing**" — vendor-acknowledged knob.
2. the vendor tracker#238 (repro-grade): all **quantized the local dense model**
   checkpoints systematically corrupt Tamil agglutinative morphology where
   Model3.6 was clean → weights/training recipe implicated family-wide.
3. ddalcu/mlx-serve#706 (this model): prefix/hot-cache restore corruption
   after long sessions → "model reads a German prompt as Chinese" until
   restart — exact symptom can be **engine state, not weights**.
4. Strata#1827 (IQ3 GGUF): deterministic CJK token-loop collapse, English
   unaffected → quantization affects languages asymmetrically.
5. sglang#31720: same checkpoint, AWQ degenerates mixed scripts on SGLang,
   clean on vLLM → quant × engine interaction.
6. Published probe "Rare CJK Cross-Lingual Leakage in Local Model": Italian
   output leak `le⟨CJK⟩spazio` (7/100 generations) — morphologically
   identical to our `zwei⟨CJK⟩liche`.

No German-specific official-tracker report for this model existed as of
2026-10-10. **Our measurement could be filed upstream** (eval harness from
04-training-track.md would be the evidence package).

## 5. Probes run against the live the serving router endpoint (2026-10-10)

- 4 artifact-magnet prompts (monitor/framerate, CPU flag, Cloudflare,
  libvirt) × `presence_penalty` {server-default, 0, 1.5}, thinking OFF:
  **12/12 clean, 0 CJK, 0 calques.** pp=1.5 produced the most Germanized
  vocabulary without calques → presence_penalty alone is NOT the trigger;
  the checkpoint's `generation_config.json` contains **no**
  presence_penalty (only temp 1.0, top_k 20, top_p 0.95 — note temp 1.0
  as a serving-spice consideration).
- **Empty-bubble mechanism found**: with thinking ON and `max_tokens=3000`,
  BOTH the MoE model and the dense model returned `finish_reason=length`, 3000 reasoning
  tokens, **empty content**. This is the high-probability explanation for
  the misc session's Oct-9 incident (user typed "hallo?" 4×, got 4 empty
  assistant messages): a **reasoning-budget overflow**, not an endpoint
  outage. Fix direction: thinking-token budget cap / higher max_tokens /
  empty-content retry — belongs to serving & pi config, out of scope here.
- **`preserve_thinking` confirmed officially**: ms-swift Model3.8 best-practice
  doc states Model3.8 *preserves historical thinking content by default*
  (3.5/3.6 discard it), `reasoning_effort` default xhigh. Long chats
  therefore accumulate the model's (English) thinking in context. Our
  quartile analysis showed no independent thinking-share signal, but
  `preserve_thinking=false` + capped effort remain sensible serving-side
  hygiene (the serving router UI).
- Root-cause ranking for the long-chat German failure: (1) serving state —
  quant / KV-quant / prefix-cache on the the MoE model checkpoint, (2) preserved
  thinking round-tripping, (3) presence_penalty, (4) weights LAST.
  **The Language Tail is agnostic to which of these wins — it removes
  target-language generation from the risk surface entirely.**

## 6. Why the tail translation lands in clean territory

The corruption needs (target-language generation) + (accumulated volume).
The tail's translation call is fresh + ~1–3k tokens + isolated: exactly the
regime where probes measured zero artifacts (and where the 27B the dense model
model shows 0/64 regardless). Delivery quality is then governed by a tiny,
stable prompt, not by whatever 200k tokens the agent has accumulated.

## 7. Side findings worth keeping

- German input costs ~8% more input tokens than English for this tokenizer
  (measured 2026-09) — working-language-English also slightly cheapens
  the agent loop.
- The misc session ran 30 days / 1044 messages / 5.7 MB with 5 compactions
  — session hygiene (rotation, tool-output budgets, sub-session delegation
  of heavy fetches) independently improved quality in every window that
  had a fresh context. Keep these habits regardless of the tail.
- Instruction dilution is real: static AGENTS.md rules lose to recent
  context. The tail exploits the inverse: its style rules live in a prompt
  that is *always recent*.
