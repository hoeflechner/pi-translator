# 03 — Implementation spec: `language-tail` (generic, any target language)

Implements the mechanism verified in 02 — configuration + detector/validation
tables + a language-NEUTRAL translator prompt. No language-specific prompt
text, no harvesting, no per-language style policy shipped in code.

## 1. Core concepts

- **Working language** (`workingLang`, default `en`): the language the agent
  is told to think/narrate/answer in. Injected via `promptGuidelines` while
  the tail is enabled (and un-injected when disabled → agent reverts to
  native multilingual behavior).
- **Target language** per turn: `auto` = detect from the user prompt; or
  forced via command/config. If target == working → no tail.
- **Language table** = everything per-language that is *mechanism*, not
  style — one row per language:

```ts
interface LangRow {
  code: string;                    // "de", "fr", "es", ...
  name: string;                    // "German" — interpolated into the prompt
  detect: { words: string[]; script: RegExp };   // function-word set + native-script evidence
  allowedScript: RegExp;           // chars legal OUTSIDE code fences (validation only)
  model?: string;                  // "provider/id" override; else default translator model
}
```

There is deliberately **no `systemPrompt` field**: the translator prompt is
one generic template (§3) into which only the language *name* is
interpolated. Per-language style wishes enter solely through user config
(`promptAppend`, §5). Initial table rows: `de`, `fr`, `es`, `it`
(detector word lists + script ranges). Extend later (ja/ru/tr…). Adding a
language = adding one table row, zero mechanism changes, zero prompt text.

## 2. Detection

- Deterministic function-word density + script-character evidence (as v1).
- **Unit-test corpus mandatory** (v1 lesson, 02 §test-log): ~30 short
  sentences per language + ~30 English/false-positive strings, run as a
  plain assertion script, no LLM involved. The first German set missed a
  real query until the guard order was fixed.
- Per-turn detection source = the prompting user message. Mid-turn queued
  messages keep the turn's decision (v1 behavior; document, don't fix).
- Session-sticky default: remember the last confident non-working target;
  under-confidence short inputs ("ok?", "weiter") reuse it; absent both,
  no tail.
- Mixed-language prompt → pick row with the higher detector score.
  (Upgrade path: fastText `lid.176.ftz` behind the same interface if
  heuristics prove too weak — do not start with it.)

## 3. Translator prompt (ONE generic template)

Small system prompt, always fresh, identical for every language except the
interpolated name. Shipped text (final wording may be tuned, but any
per-language additions inside it are a spec violation):

```
You are a translation engine. Translate the DRAFT into {LanguageName}.
Output only the translated text — no comments, no copy of the source,
no answering the question yourself.
Preserve markdown structure; code fences, inline code, paths, commands
and URLs byte-identical.
The QUESTION block is disambiguation context only — never translate or
answer it.
{append}
```

- `{append}` = the user's `promptAppend` text for this target language
  (§5), empty string if none. This is the ONLY style input that exists.
  Example: the German informal-„du“ preference lives in the user's
  `promptAppend.de`, not in any shipped prompt.
- Message payload: `QUESTION:\n<user prompt>\n\nDRAFT:\n<draft answer>`.

## 4. Validation pipeline (per translation)

Fail → retry once → give up → deliver working-language draft + `ui.notify`.
Never deliver an empty bubble, never loop.

1. `out.stopReason !== "error"`; non-empty after trim.
2. **Script guard**: characters outside code fences must match
   `row.allowedScript` ranges (for Latin targets this rejects exactly the
   CJK-leak class measured in 01-findings; for `ja` the ranges invert —
   hence per-row, not one global CJK regex).
3. Code fences/inline code byte-identical to the draft (cheap string diff
   of fenced segments — v2; v1 trusted the prompt).
4. Length sanity outside fences: translation ∈ [0.4×, 2.5×] of source
   chars (catches truncations/hallucinated expansions).

## 5. Config & commands

- Env boot defaults: `LANG_TAIL=1` enable; `LANG_TAIL_WORKING=en`;
  `LANG_TAIL_TARGET=auto|<code>|off`; `LANG_TAIL_MODEL=provider/id` default
  translator; `LANG_TAIL_MODEL_DE=provider/id` per-language override.
- Command `/langtail [on|off|auto|<code>]` (replaces v1's `/gtranslate`),
  plus status output listing loaded languages and models.
- Settings: `{cwd}/.pi/settings.json` block:

```json
{ "language-tail": {
    "working": "en",
    "target": "auto",
    "model": "the local dense model",
    "models": { "de": "provider/id" },
    "promptAppend": {
      "*":  "optional global addition",
      "de": "Sprich den Leser in direkter Anrede mit „du“ an (informell, nicht „Sie“)."
    }
} }
```

  Same resolution pattern @samfp/pi-memory uses (per-user `/data/<user>/.pi/`
  works on the multi-user pi-web box without mounts). Env > settings >
  defaults. `promptAppend` values are appended verbatim to the generic
  prompt (§3 `{append}`); the extension never interprets or ships them.
- **No harvest.** The tail writes nothing durable beyond the normal session
  transcript (the replaced final message). No `appendEntry` pair corpus;
  the training track was dropped by operator decision (2026-10-10, see
  README — archived in git snapshot `<initial-commit>`).

## 6. Test plan (acceptance for implementation)

1. Detector corpus (§2) green.
2. Script-guard unit tests: known-good + injected-CJK negatives per row.
3. E2E headless per language (`pi --extension … --print`): ≥5 questions —
   assert stdout is in the target script.
4. E2E English prompt → passthrough (no rewrite, no tail activity).
5. E2E tool-heavy turn (bash/read): intermediate narration stays working
   language; only final message translated.
6. Fallback drill: point `LANG_TAIL_MODEL` at a bogus id → notify + working
   language delivered, no crash.
7. Append drill: set `promptAppend.de` to the „du“ rule → a German E2E
   answer addresses the reader with „du“, not „Sie“ (proves `{append}`
   reaches the translator and bites). Remove the append → neutral behavior.

## 7. Known limits & open questions (deliberately NOT in v2)

- **Transcript carries the translation** (message_end replacement): the
  agent's own history becomes target-language text; the working-language
  guideline still governs generation, and measured corruption requires
  target-language *generation*, so risk is low — but watch
  **compaction**: summaries of translated transcripts may summarize *in*
  the target language, re-injecting it into context. Mitigation candidate:
  compaction instructions forcing working-language summaries. Flag during
  the first long real session.
- Display-only variant (transcript keeps working language, UI shows
  translation): pi has a `MarkdownTransformer` display hook but it is
  synchronous and message-identity-less → needs async-cache plumbing.
  Park until the transcript-carries-translation effect is actually
  observed.
- Streaming UX: user sees working-language draft stream, then replacement
  (v1 behavior, acceptable).
- Queued mid-turn messages (see §2), images in prompts (passthrough),
  multi-user auto-load (operator sign-off; sessiond boots extensions for
  ALL users of the shared instance).
