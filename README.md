# pi-translator

A [pi](https://pi.dev) coding-agent extension that keeps your agent **working
and thinking in the machine's strongest language** while the model's context
stays **100% that language** — and you see **your own language everywhere**.
Type German, get German; the model never reads or writes a word of it.

## The problem: long-context language corruption

A local `the local MoE model` (180B MoE, 6B active) serving this instance
progressively corrupted its **German** output in long chats — measured over a
30-day session transcript:

* **CJK morphemes fused into German words** (`contra⟨CJK⟩`, `zwei⟨CJK⟩liche`,
  `Start⟨CJK⟩t`) — the model's tokenizer space leaking into generation;
* **invented compounds and verbs** (⟨calque⟩, ⟨calque⟩) and wrong
  calques (⟨calque⟩ for a CPU flag);
* a clean **dose–response**: artifact rate rose from ~10% at 35–60k context
  tokens to ~24% at 154–234k.

The same model was **clean in English** in 12/12 artifact-magnet probes, and
its dense sibling (the local dense model) was clean in German (0/64). The corruption
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

* **Zero language-specific code.** No detector, no word lists, no language
  tables, no per-language prompts. The translator is shown the text and
  simply told to translate it. Adding a language means nothing; your keyboard
  decides.
* **Nothing external.** Every translation is a local LLM call — no cloud
  machine-translation endpoints, ever.
* **Deterministic safety.** Code fences, inline code, paths and URLs are
  masked with `⟦n⟧` placeholders before translation and verified on restore;
  every output passes a Unicode-script guard (catches the CJK-leak class
  table-free), a length sanity check, and a word-overlap guard that refuses
  untranslated echoes even between same-script languages. Failure → retry
  once → deliver the original + warning. Never a silent empty bubble.
* **Style is user config, not code.** Rules like "German answers must use
  informal *du*" are `promptAppend` entries — per-language labeled lines the
  translator applies itself.
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
| `PI_TRANSLATOR_MODEL` | `model` | **the agent's own model** | translator override (e.g. pin a clean 27B behind a weak worker) |

Settings live in `<cwd>/.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "pi-translator": {
    "promptAppend": {
      "de": "Rede die lesende Person in durchgehend informellem „du“ an, nie mit „Sie“."
    }
  }
}
```

## Verified behavior

18 unit tests (prompt construction, script guard, length guard,
placeholder mask/restore, echo detection — no LLM involved:
`node --experimental-strip-types pi-translator.test.ts`) plus live
echo-drills: German round-trips with the model demonstrably reading English
(`context` restores logged across session resumes), English passthrough via
the exact `NONE` marker, forced target, fallback on a broken translator
model, append label discipline — and one live-caught incident (translator
answered with meta-commentary instead of translating) closed by the
word-overlap guard.

## Known limits

* Streaming shows the working-language draft, then the replacement.
* Every turn pays one cheap translation call (the request `NONE`-check);
  non-English turns pay two (request + answer). An English chat is one tiny
  call and no rewrites.
* If the working model disobeys the guideline and drafts directly in the
  user's language, the answer passes through and user style rules are not
  re-applied. Prompt translation makes this disobedience rare (the model now
  reads English input); forced-target mode always re-normalizes.
* **Thinking-level probe:** translator calls request reasoning `"minimal"`,
  but models differ in support (field report: the provider-a/the local MoE model
  endpoint answered `stopReason: "error"` with empty content for that level
  while accepting it never). One failed probe per model flips all later calls
  to the provider default. Without this, a session on such a model had a
  dead tail: prompt translation failed, the worker drafted in the user
  language itself, and reply translation failed too — visible fallback every
  turn.
* **Translator = agent model on a translator-corrupted worker** is a quality
  choice, not a correctness one (it works after the probe fix; short fresh
  translation contexts measured as the low-dose regime). The guards only
  catch loud failures (CJK leakage, echoes, truncation) — silent compounds
  can still slip through. Pin `model` to a clean model if that matters for
  the workload.
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
(`git show <initial-commit>`).*
