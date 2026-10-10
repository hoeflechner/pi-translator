# pi-translator

A [pi](https://pi.dev) coding-agent extension that keeps your agent **working
in the machine's strongest language** and **delivers every answer in yours**.

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

## The solution: translate on the delivery path, never generate the target language

The agent is told (via a prompt guideline) to **always think, narrate, and
draft in the working language** — English by default, the model's strongest
token region. It never generates the target language, so the entire corruption
regime becomes architecturally unreachable.

Delivery happens in one **context-free translation call** at `message_end`:

```
QUESTION (original user prompt) + DRAFT (working-language answer)
        │  fresh call, nothing of the session context leaks in
        ▼
translator LLM identifies the question's language itself
  ├─ same language as DRAFT  → replies "NONE" → draft passed through untouched
  └─ otherwise               → translates the DRAFT into the question's language
        ▼
validated (stopReason, non-empty, Unicode-script guard, length sanity)
  ├─ pass  → final message in the transcript is replaced by the translation
  └─ fail  → retry once, then deliver the original draft + warning — never an empty bubble
```

Design properties:

* **Zero language-specific code.** No detector, no word lists, no language
  tables, no per-language prompts. The translator is shown the question and
  simply told to translate the answer into its language. Adding a language
  means nothing; the user's keyboard decides.
* **Style is user config, not code.** Rules like "German answers must use
  informal *du*" are `promptAppend` entries — per-language labeled lines
  appended to the generic translator prompt; the translator applies the ones
  matching its target.
* **Nothing is harvested or persisted** beyond the normal session transcript.

## Usage

```bash
# load explicitly
pi --extension ./pi-translator.ts

# or boot-enabled
PI_TRANSLATOR=1 pi --extension ./pi-translator.ts
```

Per session: `/translator` (status) · `/translator on|off|auto` ·
`/translator <language name>` (force a delivery language).
Add `PI_TRANSLATOR_DEBUG=1` to see decisions on stderr
(`translated` / `passthrough` / `fallback`).

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

13 unit tests (prompt construction, script guard, length guard, append
rendering — no LLM involved: `node --experimental-strip-types
pi-translator.test.ts`) plus live end-to-end drills: German round-trip,
English passthrough via the exact `NONE` marker, forced target (French output
from a German question), fallback on a bogus translator model (original
delivered, no crash, no empty bubble), and append label discipline (the `[de]`
rule never leaks into French).

## Known limits

* Streaming shows the working-language draft, then the replacement (v1-era
  behavior, accepted).
* Every turn pays one extra model call — same-language turns too (the
  extension cannot know otherwise); the call answers `NONE` and is cheap.
* If the working model *disobeys* the guideline and drafts directly in the
  user's language, the turn passes through untranslated — and user style rules
  are then not re-applied. Forced mode always re-normalizes.
* Watch compaction in very long non-English sessions
  ([`docs/03` §7](docs/03-design-language-tail.md)).

## Repository

* [`docs/01-findings.md`](docs/01-findings.md) — the measured evidence
* [`docs/02-architecture.md`](docs/02-architecture.md) — mechanism + pi extension API ground truth
* [`docs/03-design-language-tail.md`](docs/03-design-language-tail.md) — the implementation spec this code implements 1:1
* `pi-translator.ts` + `pi-translator.test.ts` — the extension

*Not published to npm yet. A German-specific predecessor ("german-tail")
proved the mechanism first and is preserved in the git history
(`git show <initial-commit>`).*
