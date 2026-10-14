# pi-translator

A [pi](https://pi.dev) coding-agent extension that keeps your agent **working
and thinking in the machine's strongest language** while the model's context
stays **100% that language** — and you see **your own language everywhere**.
Type German, get German; the model never reads or writes a word of it.

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

The same model was **clean in English** in 12/12 artifact-magnet probes, and
its dense local sibling (~27B, dense) was clean in German (0/64). The corruption
lives in *target-language generation at long context* — asking the model to
"answer carefully in German" cannot fix what is a decoding property.

Full evidence: [`docs/01-findings.md`](docs/01-findings.md).

## The solution: the model lives in English, the transcript lives in yours

The agent is told — as a structured system-prompt section (`pi_translator`,
added via `before_agent_start` so pi diffs it as a prompt-cache delta) — to
**always think, narrate, and draft in the working language** — English by
default, the model's strongest token region. The guideline explicitly
outranks AGENTS.md, injected memories and conversation language that pull
the model toward drafting in the user's language. It never generates the
target language, so the entire corruption regime becomes architecturally
unreachable. Two **context-free LLM translation calls** wrap each turn, and a
`context` handler keeps the model's input monolingual:

```
your question (German) ──▶ [call 1: request→English] ──▶ model reads English
                                        │ your original stays in the transcript
model draft (English) ──▶ [call 2: answer→German] ──▶ transcript + UI show German
                                        │ the English draft rides along as metadata
before EVERY later LLM call:
   `context` handler swaps all originals back → the model reads pure English
```

Each call is made by a translator LLM that **identifies the language itself**:
question already in the right language → it replies exactly `NONE` →
passthrough, no rewrite (an English chat therefore costs one tiny call and
zero rewrites).

Design properties:

* **No language detection in code.** No detector, no word lists, no per-language
  prompts: the translator is shown the text and simply told to translate it, and
  `LANG_NAMES` only *spells* a language name for the prompt (and maps what you
  typed as `target`/`/translator <language>`). Adding a language means nothing;
  your keyboard decides.
* **Nothing external.** Every translation is a local LLM call — no cloud
  machine-translation endpoints, ever.
* **Deterministic safety.** Code fences, inline code, paths (POSIX and
  `C:\…`) and URLs are masked with `⟦n⟧` placeholders before translation and
  verified on restore; every output passes a Unicode-script guard (catches the
  CJK-leak class table-free), a length sanity check, and a word-overlap guard
  that refuses untranslated echoes even between same-script languages. That
  guard compares **prose**: the code it must keep byte-identical would otherwise
  score as an echo and get correct answers of code-heavy replies rejected.
  A refused or failed call delivers the original plus a warning — and only a
  *transport* failure is retried, because re-sending a byte-identical request
  after a deterministic guard rejection reproduces it and doubles the latency.
* **Style is user config, not code.** Rules like "German answers must use
  informal *du*" are `promptAppend` entries — per-language labeled lines the
  translator applies itself.
* **Question forms travel in your language too.** When the agent asks via
  `ask_user`, the human-readable fields (question, detail, option labels)
  are translated in one batched call; machine fields (`id`, `value`) are
  never touched, and the model still reads its English original through the
  `context` handler. Any structural doubt (lost or invented segment) → the
  English form is kept and you are warned — a shifted label never ships.
  *pi 1.2.0 registers no `ask_user` tool (built-ins: bash/edit/find/grep/ls/
  powershell/read/write), so on that host this path is inert and untested in
  production; it engages wherever the tool exists.*
* **Nothing is harvested or persisted** beyond the normal session transcript
  (plus your own optional debug log).

## Usage

```bash
# load explicitly
pi --extension ./pi-translator.ts

# or boot-enabled
PI_TRANSLATOR=1 pi --extension ./pi-translator.ts
```

Per session: `/translator` (status) · `/translator on|off|auto` ·
`/translator <language name>` (force a delivery language) ·
`/translator-original` (show the working-language original of the last
answer). Add `PI_TRANSLATOR_DEBUG=1` to see decisions on stderr
(`translated` / `passthrough` / `fallback`) and `PI_TRANSLATOR_LOG=<file>`
for a JSONL record of every translation call.

### Configuration (env > settings > defaults)

| Env | Settings (`pi-translator` block) | Default | Meaning |
|---|---|---|---|
| `PI_TRANSLATOR=1` | any block present | off | enable at boot |
| `PI_TRANSLATOR_WORKING` | `working` | `en` | language the agent works in |
| `PI_TRANSLATOR_TARGET` | `target` | `auto` | `auto`, `off`, or a language name to force |
| `PI_TRANSLATOR_MODEL` | `model` | **the agent's own model** | translator override (e.g. pin a clean, larger model behind a weak worker) |
| `PI_TRANSLATOR_DEBUG=1` | `debug` | off | debug lines on stderr |
| `PI_TRANSLATOR_LOG=<file>` | `log` | off | JSONL audit of every translation call |

Settings live in `<cwd>/.pi/settings.json` or `~/.pi/agent/settings.json`.
**Placement is a trust decision:** the user-global block is always read; the
project block is read *only when pi trusts the folder* (`/trust`, or approving
the first prompt) — the same gate pi applies to project settings themselves.
An untrusted clone can therefore never reroute `model`, silently enable `log`,
or inject `promptAppend` text. The user-global block is the base; a trusted
project block overrides it per key:

```json
{
  "pi-translator": {
    "promptAppend": {
      "de": "Rede die lesende Person in durchgehend informellem „du“ an, nie mit „Sie“."
    }
  }
}
```

> **`log` writes full plaintext.** Every record contains the complete input
> and output of one translation — a bilingual transcript of your session. One
> record covers up to four provider calls (guard-free retry × the reasoning
> probe) and `ms` is their sum. Permissions: the `0600` the code asks for is
> **ignored on Windows** (measured: the file lands `0666`, inheriting the
> directory's ACL) — put the path somewhere that ACL is the answer you want.
> It grows without bound and never rotates. Leave it off unless you want a
> bilingual transcript of everything you typed.

## Verified behavior

25 unit tests + 9 async integration tests over the real extension factory
with a mocked model (prompt construction, script guard, length guard,
placeholder mask/restore, echo detection, retry policy, multimodal block
order, ask_user form round-trip, compaction-summary rewrite incl. `context`
restore — no LLM involved:
`node --experimental-strip-types pi-translator.test.ts`) plus live
echo-drills: German round-trips with the model demonstrably reading English
(`context` restores logged across session resumes), English passthrough via
the exact `NONE` marker, forced target, fallback on a broken translator
model, append label discipline — and one live-caught incident (translator
answered with meta-commentary instead of translating) closed by the
word-overlap guard.

## Known limits

* Streaming shows the working-language draft, then the replacement.
* **Compaction summaries are translated, not prevented.** pi builds a summary
  from the *stored* (your-language) deliveries and never runs the summarizer
  through the `context` handler, so the model would keep reading your language
  in long sessions — the regime this extension exists for. The `context` handler
  therefore hands the model a working-language copy of every `compactionSummary`
  / `branchSummary`, translated once and cached by text digest (pi clones the
  messages per request, so identity caching would re-translate forever). Cost:
  one extra translator call for the first request after each compaction.
* One translator call gets 25 s. `ctx.signal` alone is not a deadline — it is
  pi's run-abort signal and is undefined whenever the agent is not streaming.
* Every turn pays one cheap translation call (the request `NONE`-check);
  non-English turns pay two (request + answer). An English chat is one tiny
  call and no rewrites.
* If the working model disobeys the guideline and drafts directly in the
  user's language, the answer passes through and user style rules are not
  re-applied. Prompt translation makes this disobedience rare (the model now
  reads English input); forced-target mode always re-normalizes.
* **Thinking-level probe:** translator calls request reasoning `"minimal"`,
  but models differ in support (field report: one locally served
  MoE endpoint answered `stopReason: "error"` with empty content for that level
  while accepting it never). One failed probe — per session and model, never
  process-global — flips later calls to the provider default. Without this, a
  session on such a model had a
  dead tail: prompt translation failed, the worker drafted in the user
  language itself, and reply translation failed too — visible fallback every
  turn.
* **Translator = agent model on a translator-corrupted worker** is a quality
  choice, not a correctness one (it works after the probe fix; short fresh
  translation contexts measured as the low-dose regime). The guards only
  catch loud failures (CJK leakage, echoes, truncation) — silent compounds
  can still slip through. Pin `model` to a clean model if that matters for
  the workload.
* **Forced non-Latin targets run without the script guard.** The guard derives
  its allowed-script set from question + draft; a forced target's script cannot
  be licensed by Latin-only evidence, so correct Japanese delivery would
  always be rejected. In forced mode the script guard is skipped (echo,
  length, and diff guards stay on).
* Settings are read once per session — edits to `settings.json` take effect
  in the next new session, not mid-session. Code updates additionally wait
  for a host-process restart: pi caches extension modules by path per
  process boot, so a CLI run sees fresh code but a long-lived session host
  keeps running the version it loaded.
* `ask_caller` forms are deliberately **not** translated — their consumer is
  another working-language agent, not a human. A translated `ask_user` pays
  one extra batched translator call (~1–2 s on a healthy model).
* Whether pi's compaction path passes through `context` is untested — watch
  item for very long sessions
  ([`docs/05` §deviations](docs/05-plan-v2.md)).

## Repository

* [`docs/01-findings.md`](docs/01-findings.md) — the measured evidence
* [`docs/02-architecture.md`](docs/02-architecture.md) — mechanism + pi extension API ground truth
* [`docs/03-design-language-tail.md`](docs/03-design-language-tail.md) — the v1 implementation spec
* [`docs/05-plan-v2.md`](docs/05-plan-v2.md) — **v2: bidirectional translation + 100%-English context (implemented)**, prior-art rationale, live findings
* `pi-translator.ts` + `pi-translator.test.ts` — the extension

*Not published to npm yet. A German-specific predecessor ("german-tail")
proved the mechanism first and is preserved in the git history
(`git show $(git rev-list --max-parents=0 HEAD)`).*
