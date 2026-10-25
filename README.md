# pi-translator

A [pi](https://pi.dev) coding-agent extension that keeps your agent **working
and thinking in the machine's strongest language** while you see **your own
language everywhere**.

Since **v3 (F3/F4, 2026-10-24)** the user's own text reaches the model
**exactly as written** — prompt translation was deleted, along with the language
detector that used to gate it. What is left is one thing that matters: **one
context-free formulation call per final answer**, which produces the text you
read in your language, plus a `context` handler that stops the model from ever
reading its own output back through the target language.

## The problem: long-context language corruption

The locally served **ultra-sparse MoE model** of this instance (~180B total,
~6B active per token) progressively corrupted its **German** output in long
chats — measured over a 30-day personal session transcript:

* **CJK morphemes fused into German words** — the model's tokenizer space
  leaking into generation (13+ distinct occurrences, exact samples withheld
  as transcript-derived personal data);
* **invented compounds and verbs** and wrong calques of English technical
  terms (roughly a dozen distinct classes);
* a clean **dose–response**: artifact rate rose from ~10% at 35–60k context
  tokens to ~24% at 154–234k.

The same model was **clean in English** in 12/12 artifact-magnet probes, and its
dense local sibling (~27B, dense) was clean in German (0/64). The corruption
lives in *target-language generation at long context* — asking the model to
"answer carefully in German" cannot fix what is a decoding property.

Full evidence: [`docs/01-findings.md`](docs/01-findings.md).

## What runs per turn (v3)

```
your question (German) ───────────────────────────────▶ model reads German, as written
agent draft (any language) ──[ one formulation call ]──▶ transcript + UI in the reader's language
                                  │ the call answers with the language name on its
                                  │ first line; that header is stripped before the
                                  │ guards and before delivery (never shown, never stored)
before EVERY later LLM call:
   `context` restores the agent's OWN drafts and tool arguments (F1)
```

The guideline (`pi_translator`, injected via `before_agent_start` so pi diffs it
as a prompt-cache delta) tells the agent to think, narrate and draft in the
working language and shows it an English example — the strongest token region
for the worker, and the reason the draft is usually English even when the
question was German.

**Every answer is formulated, same-language ones included** (owner decision).
So there is no translate-or-not gate: `NONE` from the call now means *"the
polisher did nothing"*, which is a failure, not a passthrough — `rejectNone` is
on, and a normalised-equality check logs `verdict:"noop"` and ships the draft
honestly instead of pretending it was formulated.

Design properties:

* **No detection code.** No detector, no word lists, no per-language prompts.
  The formulation call reports the language it used in its header line, parsed
  by a strict one-word parser. A **one-word question does not decide the
  language**: below three prose words (`"OK"`) the target is taken from the last
  delivered answer and *stated* in the prompt (`Write the final answer in
  German.`) rather than inferred from a token the model would mirror from the
  draft.
* **Nothing external.** Every formulation is a local LLM call — no cloud
  machine-translation endpoints, ever. The translator model is **the agent's own
  model** unless `model` is set.
* **Deterministic safety.** Code fences, inline code, paths (POSIX and `C:\…`)
  and URLs are masked to `⟦n⟧` before the call and verified on restore: every
  index must appear exactly once. A loss is no longer fatal — `unmaskProtected`
  names the offenders and **one repair attempt** is made with that diagnosis
  attached (`Missing from your answer: ⟦7⟧, ⟦19⟧ …`), bounded to calls that
  finished inside 60 % of the ceiling. Outputs also pass a Unicode-script guard
  (catches the CJK-leak class table-free), a length check (floor 0.4×, ceiling
  2.5×, 4× in formulate mode because re-deriving legitimately lengthens) and
  the noop check. The word-overlap/echo guard is **off** in formulate mode —
  re-derivation rewords by definition, and it has its own protection against the
  failure that guard used to catch (the prompt forbids *describing* the draft,
  which is what the model actually did in the field).
* **Only a transport failure is retried.** A timeout is never retried — a slow
  model retried is a double stall, and that mislabelling once cost users 50 s
  per answer while blaming the network.
* **Ceilings: 25 s, and 300 s in formulate mode.** Formulation is not a
  translation, it retypes the whole answer (~11 s per 1000 output characters
  measured on the worker), so a long answer legitimately needs 30–60 s. Forms
  and summaries keep 25 s: there a slow response is a hang, and a five-minute
  freeze before an `ask_user` form ships is a worse bug than the one the ceiling
  raises.
* **Thinking level is asked for, not guessed.** Formulate mode requests
  `medium`; other directions `minimal`. Field reason: this class of endpoint
  rejects `minimal` outright (*"Supported types are xhigh (default), medium, and
  low"*), the per-session probe then retried **without** the option and landed on
  **xhigh** — 12,788 completion tokens for 6,700 characters. The probe stays for
  models that reject a level outright, per session and model, never
  process-global.
* **Style is user config, not code.** Rules like "German answers must use
  informal *du*" are `promptAppend` entries — per-language labeled lines the
  formulation call applies itself.
* **Question forms travel in your language too.** `ask_user` human fields
  (question, detail, option labels) go through one batched call; machine fields
  (`id`, `value`) are untouched. Any structural doubt → the English form is kept
  and you are warned; a shifted label never ships. `ask_caller` is deliberately
  **not** translated (its consumer is another agent).
* **Nothing is harvested or persisted** beyond the normal session transcript
  (plus your own optional audit log).

## Measured, not assumed

The owner's bet — *"the agent's own model is a good enough polisher"* — has a
falsification gate, and it runs against the audit log:

```bash
node scripts/audit-gate.mjs [logfile] [--since 2026-10-24]   # exit 1 when falsified
```

| | measure | threshold |
|---|---|---|
| M1 | class-A characters **introduced** by the polisher | >5 % fails, 2–5 % watch |
| M2 | `noop` share — the polisher did nothing | >30 % fails |
| M3 | `reject` + `error` + `none` share | >15 % fails |
| M4 | call `ms` p90 | >60 s fails |
| M5 | median `ratio` (manufactured filler) | >1.5 watch |
| M6 | `verbatim` — share of draft sentences reproduced word-for-word | reported, never judged |

Below 100 calls per model label nothing is falsified (`thin`), and metrics are
per label, never global: a strong model's numbers do not vouch for the worker's.

For context, the first day of F4 in production (34 formulate calls, worker
model): 17 delivered, 10 error, 4 guard-rejected, 3 noop; median successful call
~15 s; `ratio` ~1.0 and `verbatim` 0.5–0.67. That is a sample of one day, not a
verdict — which is exactly why the gate, and not this sentence, decides.

## Usage

```bash
pi --extension ./pi-translator.ts              # load explicitly
PI_TRANSLATOR=1 pi --extension ./pi-translator.ts   # or boot-enabled
```

Per session: `/translator` (status) · `/translator on|off|auto` ·
`/translator <language name>` (force a delivery language) ·
`/translator-original` (show the working-language original of the last answer).
`PI_TRANSLATOR_DEBUG=1` puts the tail's decisions on stderr (`reply formulated …`,
`formulation changed nothing`, `delivering as written`); `PI_TRANSLATOR_LOG=<file>`
writes the JSONL audit log.

### Configuration (env > settings > defaults)

| Env | Settings (`pi-translator` block) | Default | Meaning |
|---|---|---|---|
| `PI_TRANSLATOR=1` | any block present | off | enable at boot |
| `PI_TRANSLATOR_WORKING` | `working` | `en` | language the agent works in |
| `PI_TRANSLATOR_TARGET` | `target` | `auto` | `auto`, `off`, or a language name to force |
| `PI_TRANSLATOR_MODEL` | `model` | **the agent's own model** | polisher override (pin a different model behind a weak worker) |
| `PI_TRANSLATOR_DEBUG=1` | `debug` | off | debug lines on stderr |
| `PI_TRANSLATOR_LOG=<file>` | `log` | off | JSONL audit of every call |
| `PI_TRANSLATOR_CALL_TIMEOUT_MS` | — | 25000 / 300000 | test seam for the call ceiling (read per call) |

Settings live in `<cwd>/.pi/settings.json` or `~/.pi/agent/settings.json`.
**Placement is a trust decision:** the user-global block is always read; the
project block is read *only when pi trusts the folder* — an untrusted clone can
never reroute `model`, silently enable `log`, or inject `promptAppend` text.

```json
{ "pi-translator": { "promptAppend": { "de": "Rede die lesende Person in durchgehend informellem „du“ an, nie mit „Sie“." } } }
```

### The audit log

Every decision writes exactly one row — delivered, noop, none, skip, failed,
rejected — and every row carries **`rev`**, the short hash of the installed
package that wrote it. That field exists because answering *"is this session
running the reloaded code?"* cost hours: extension code is read when a session
runtime is created, so a running session keeps its copy until `/reload`.

Fields: `ts`, `rev`, `dir` (`reply` · `form` · `summary`), `model`, `ms`,
`verdict`, `reason`, `in`, `out`, and for formulate mode `mode`, `lang`,
`ratio`, `verbatim`, `inherited_cjk`, plus `placeholder_repair`,
`placeholders_missing`, `placeholders_dups` on placeholder rejections.

> **`log` writes full plaintext** — the complete input and output of one call,
> i.e. a bilingual transcript of your session. One row can cover up to three
> provider calls (transport retry × reasoning probe + placeholder repair) and
> `ms` is their sum. `0600` is **ignored on Windows** (measured: lands `0666`,
> inheriting the directory ACL). It never rotates.

## Verified behavior

34 unit tests + 14 async integration tests over the real extension factory with
a mocked model (`node --experimental-strip-types pi-translator.test.ts` and
`pi-translator.form.test.ts`) plus `node scripts/audit-gate.test.mjs` pinning
the gate against a fixture with hand-computed values. Covered include: header
parse/strip on every path, noop detection, one-call-only on timeout, the
placeholder repair attempt shipping the repaired text, one-word-question target
fallback, form round-trip, compaction-summary rewrite with `context` restore.

## Known limits

* **Class-A inherited from the draft passes through.** The script guard
  licenses the scripts present in question ∪ draft, so CJK that the drafting
  model already produced cannot be cleaned by the polisher — it is logged as
  `inherited_cjk` and reaches you. This is the original complaint, un-fixed.
* **Intermediate messages are not formulated.** Any assistant message carrying
  tool calls ships as drafted, and that is the largest share of what you read —
  which is where the worker's worst German shows up.
* **Streaming shows the draft, then the replacement.**
* **`/reload` is per session** and is what picks up edited code; a session you
  never reloaded keeps the version it started with, and a *spawned* session may
  inherit an older runtime than the file on disk. Verify with `rev`, don't
  assume. (Settings are read once per session too: edits land in the next
  session.)
* **Compaction summaries are translated, not prevented** — pi builds them from
  the stored deliveries and never runs the summarizer through `context`, so the
  handler hands the model a working-language copy, cached by text digest. One
  extra call after each compaction.
* **Forced non-Latin targets run without the script guard** — its allowed-script
  set derives from question + draft, so a forced Japanese answer could never
  pass. Echo, length and noop guards stay on.
* **A disobedient draft is a quality problem, not a correctness one.** If the
  model drafts in your language anyway, the formulation still runs; `verbatim`
  is how you see whether it actually reworded anything.

## Repository

* [`docs/06-plan-v3.md`](docs/06-plan-v3.md) — **current design and the owner decisions behind it** (F3/F4, what was deleted and why, the guard matrix, the falsification gate)
* [`docs/01-findings.md`](docs/01-findings.md) — the measured evidence, incl. §8 (v3 measurements)
* [`docs/02-architecture.md`](docs/02-architecture.md) — mechanism + pi extension-API ground truth
* [`docs/03-design-language-tail.md`](docs/03-design-language-tail.md) · [`docs/05-plan-v2.md`](docs/05-plan-v2.md) — **history**: the v1 and v2 designs. Both describe prompt translation and the `NONE` passthrough, which **no longer exist**; kept because they carry the measurements the v3 decisions were argued against
* `scripts/audit-gate.mjs` · `scripts/audit-gate.test.mjs` — the falsification gate
* `pi-translator.ts` + `pi-translator.test.ts` + `pi-translator.form.test.ts` — the extension

*Not published to npm yet. A German-specific predecessor ("german-tail") proved
the mechanism first and is preserved in the git history
(`git show $(git rev-list --max-parents=0 HEAD)`).*
