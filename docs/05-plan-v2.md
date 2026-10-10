# 05 — v2 plan: 100%-English context, prompt translation, adopted UX

Operator policy decisions (2026-10-10):
- **No external machine translation.** Google/mymemory/libretranslate backends
  are a no-go (privacy + unofficial endpoint). The translator is always a
  local LLM call — this stays the only mechanism.
- **Adopt pi-translate's context-restoration architecture** and extend it to
  the input side: after v2 the model sees **zero target-language tokens**.

Prior-art basis: pi-translate 1.0.3 source read directly (`input`/
`message_end`/`context` handlers, `piTranslate` message metadata, ⟦n⟧
protection); Salesforce Agentforce article (deterministic detection at scale —
rejected for us, see §Rejected).

## API ground truth (verified in this pi's types, 2026-10-10)

- `ContextEvent { type:"context"; messages: AgentMessage[] }` →
  `ContextEventResult { messages? }` — fires **before every LLM call**; the
  handler owns the message list (can rewrite content).
- `InputEvent { text, images?, source, streamingBehavior? }` — user input
  before it enters the agent.
- Message-metadata embedding: pi-translate persists a custom field
  (`piTranslate`) inside transcript messages — **must be verified on this pi
  version** (transcript round-trip test) before depending on it; fallback is
  an extension-local map keyed by message id (lost across restarts — test
  first, decide later).

## F1 — Context stays 100% English (the core)

Current state: translated final messages accumulate in the transcript, so the
model *reads* target-language text (spec §7's RISK-2 axis). v2 removes the
axis entirely:

1. `message_end` no longer overwrites the draft invisibly: it stores the
   working-language draft as metadata on the replaced message
   (`piTranslator: { original }`) and delivers the translation (unchanged
   UX otherwise).
2. A `context` handler rewrites every such message back to its English
   original before each LLM call. Prompt-cache note: the provider keeps
   seeing the same English prefix → cache stays intact.

Side effects (all good): compaction summarizes English context (the §7
compaction worry evaporates); reading-side contamination (01-findings: model
*reads* German as Chinese) is cut off on the output side too.

## F2 — Translate the user prompt (input side)

`input` handler sends `text` through the same context-free translator call
(generic prompt, `NONE` passthrough if already in the working language):
the transcript and UI keep the user's original text; the model receives the
English version (embedded via message metadata + `context` handler, same
machinery as F1).

- **Why this also helps generation:** observed live on `the local dense model` — German
  question ⇒ model sometimes drafts German despite the guideline. Handing it
  an English question removes the input-language pull; guideline obedience
  should rise for free.
- **Fidelity rule:** the input translation must preserve every technical
  detail (paths, versions, error strings) — translator prompt for this call
  says "faithfully translate the user's request; change nothing technical".
- Cost: +1 short call per non-English user message, before the run starts.
- Reply translation is unchanged: it still receives the user's ORIGINAL
  question as QUESTION.

## F3 — Placeholder protection for protected spans (both directions)

Before any translation call, mask fenced code, inline code, URLs, absolute
paths and file references with `⟦n⟧` placeholders; restore after. Replaces
"please preserve byte-identical" prompt begging with a deterministic
guarantee (pi-translate's protect.ts, 74 lines, is the pattern). The §4
fence-diff validation step becomes an assertion instead of a hope.

## F4 — "Original one keystroke away"

`/translator-original` command: re-displays the working-language original of
the last delivered answer (data source: the F1 metadata; works in every UI
mode). The native TUI overlay panel (pi-translate's Ctrl+Shift+E) is a
follow-up, parked until the command feels insufficient.

## F5 — Debug mirror: `PI_TRANSLATOR_LOG=<file>`

JSONL, off by default: one line per call — timestamp, direction
(`prompt`/`reply`), model, latency, verdict (`translated`/`none`/`fallback`),
original + result text. This is operator debugging of the local translator's
quality (still no harvest: nothing is read back, nothing is structured as a
training corpus).

## F6 — Bilingual output mode (parked, cheap)

`outputMode: "translate" | "bilingual"` — bilingual delivers the translation
with the English original appended as a quote block. For users who want to
verify phrasing inline. Parked until F1–F5 are solid.

## Rejected (explicit)

- **External MT backends** — operator policy above.
- **Deterministic language detectors** (Lingua/fastText, Salesforce-style) —
  the in-call `NONE` contract already IS the detector at this scale; their
  audited-drift argument applies to distributed fleets, not a pi session.
- **Google/GPT cloud translator defaults** — all calls stay on the local
  registry.

## Naming (verified on npm registry 2026-10-10)

`pi-translator` is **taken on npm** since 2026-06-30 (another author,
GPL-3.0, an unrelated batch CSV/JSON file-translation CLI) — and since pi.dev
packages mirror npm, `pi install npm:pi-translator` would fetch *that*.
GitHub `the owner/pi-translator` stays fine (different namespaces). Before
any publish: pick a registry name — `pi-language-tail` (internal concept name,
verified free) is the current favorite; command namespace `/translator*` is
clear of pi-translate (`/translate*`).

## Build order & acceptance

1. **Metadata round-trip test** (embed a field in a transcript message,
   restart the session, read it back) — gate for everything else.
2. F1 context-restore: E2E — German question, next turn: assert the context
   the model saw is pure working-language prose (debug dump) while the
   transcript shows the German delivery.
3. F3 protection: unit tests (mask/restore round-trip) + injected-CJK-in-prose
   still rejected, code untouched.
4. F2 prompt translation: E2E German question — transcript shows German
   original; debug dump shows English for the model; multi-paragraph
   technical question keeps every path/version.
5. F4 command, F5 log, F6 bilingual: config + smoke.
