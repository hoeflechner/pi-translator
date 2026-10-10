# 04 — Training track (optional, downstream): from harvested pairs to a trained translator

The language tail (03) makes the models' weaknesses irrelevant *today*.
This track is about removing them: it uses the tail's own harvest
(`pi.appendEntry("language-tail", …)`) as the data engine. Two separate
targets — do not conflate them:

## Track A (primary): a small purpose-trained translator

Replace the general-purpose translator model in the tail's API call with a
cheap, fast, quality-trained small multilingual model (4–8B LoRA =
home-scale hardware, no cluster needed).

- **Data**: the harvest. Chosen = accepted translations; rejected =
  validation-failed outputs + fallback events; plus SFT positives from the
  clean regime (27B the dense model-quality translations are already the default
  producer). Grow the set by replaying real questions offline against
  candidate checkpoints.
- **Method**: SFT first (style contract + preservation rules from 03 §3
  baked in); DPO afterwards using validation negatives if SFT alone leaves
  the quiet error classes (calques, register drift) — the *loud* class
  (CJK leaks) is already caught by the script guard, so don't spend
  preference data on it.
- **Eval before any claim**: fixed probe suite per language (the §6-test
  corpus of 03 grows into the eval corpus), deterministic scorer =
  script-guard + preservation diff + LLM-judge for register/morphology,
  fixed seed/temperature. Baseline numbers recorded before training.

## Track B (opportunistic): hardening the local MoE model itself

Feasible since 2026-10-10: access to **several H200 (141 GB) on a SLURM
cluster** — above the documented smallest measured rig for this model.

- **Path**: ms-swift **Megatron** backend (the HF-transformers LoRA path is
  broken for this arch — QSA indexer cannot train, transformers#48826).
  Official best-practice doc: `<vendor-docs>`;
  exact-model examples in `modelscope/ms-swift` under
  `<vendor-examples>/`. Model3.5/3.6/3.8 share identical structure →
  their memory/parallelism recipes transfer (measured: full-model-class
  LoRA 8×70GB TP2/EP4/PP2 with the ~95 GiB n-gram table CPU-offloaded via
  `PLE_CPU_OFFLOAD`; MoE-LoRA sibling 35B-A3B ran on 4×40 GiB, rank 8).
- **Method preference**: **GRPO with the detector itself as reward**
  (plugin reward = script guard + preservation diff + judge): negatives
  self-generate at the real distribution — this replaces hand-curated
  "bad translation" pairs. DPO alternative (negatives: replay contaminated
  prompts on base the MoE model via vLLM on the cluster; positives: 27B rewrites)
  — **but samples must carry long contaminated contexts** (failure is at
  131k median context; 24% artifact rate at 154–234k) or you train the
  easy regime only.
- **Serving the result**: vLLM runtime LoRA (`--lora-modules`); the serving router
  adapter support unverified → fall back to small direct vLLM deployment.
- **Out of scope for weights** (keep as serving flags regardless):
  prefix-cache/KV-quant corruption class (mlx-serve#706, sglang#31720),
  `preserve_thinking` (Model3.8 preserves historical thinking **by
  default** — set false), empty-bubble reasoning-budget overflow
  (01-findings §5), presence_penalty hygiene (model card: language-mixing
  knob).
- **No precedent exists** for LoRA/GRPO fixing language artifacts in this
  family — Track B is an experiment, Track A is production value. Run the
  eval harness before spending GPU-hours, and expect the tail (03) to have
  made the production problem moot long before B finishes.

## Upstream opportunity

The measurement package (dose–response table + probe suite + transcripts)
is publishable to `the vendor tracker` as the first **German** corruption report
for the MoE model-next (none existed as of 2026-10-10; family precedent: #238
Tamil, mlx-serve#706 German-read-as-Chinese). Filing it also pressures the
benchmark gap (no official German eval exists; EuroEval German merely
requested #2158).

## Harvest → dataset pipeline (when to build)

Not before the tail runs for a while. Then: export `language-tail` entries
from session JSONLs → dedupe → validation-failures become negatives →
`{prompt, chosen, rejected}` jsonl for ms-swift. Existing seed data:
the misc transcript's 23 artifact messages (context snapshots included) +
this box's 27B re-translation capability.
