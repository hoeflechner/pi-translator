# 03 — Implementation spec: `language-tail` (generic, any target language)

Implements the mechanism verified in 02 — one context-free translator call
that **detects the target language itself**. No detector, no language
tables, no language-specific prompt text, no harvesting.

## 1. Core concepts

- **Working language** (`workingLang`, default `en`): the language the agent
  is told to think/narrate/answer in. Injected via `promptGuidelines` while
  the tail is enabled (and un-injected when disabled → agent reverts to
  native multilingual behavior).
- **Detection is done by the translator LLM itself**: every final message
  triggers one context-free call that receives the user question + the
  working-language draft. The prompt instructs it to identify the language
  of the question and translate the draft into it. There is **no
  deterministic detector and no per-language table** — nothing in the
  extension knows or cares *which* language the user speaks.
- **Passthrough marker**: if the question's language equals the draft's
  language, the translator outputs exactly `NONE` and the extension
  delivers the original draft untouched (no rewrite of same-language
  answers).
- **Tail off / forced target**: `/langtail off` skips the call entirely;
  `/langtail <language name>` forces that language and skips question
  detection (the forced name replaces the detection instruction).

## 2. The single translator call

Per final assistant message (tail enabled, message is pure text —
mixed text+toolCall blocks are skipped as in v1):

- Input: user prompt of the turn + final draft. Nothing else — the call
  stays context-free (README ground rule 1).
- The translator decides: `NONE` (same language) or the translation.
- A response of `NONE` that is not byte-exact after trim is treated as a
  translation attempt, never as passthrough.

## 3. Translator prompt (ONE generic template)

Small system prompt, always fresh, identical for every language. Shipped
text (wording tunable; any per-language additions inside it are a spec
violation):

```
You are a translation engine. You receive a QUESTION from a user and a
DRAFT answer written in {workingLangName}.
Identify which language the QUESTION is written in.
- If the QUESTION is in the same language as the DRAFT, reply with
  exactly: NONE
- Otherwise translate the DRAFT into the language of the QUESTION.
Output only the translated text — no comments, no copy of the source,
no answering the question yourself.
Preserve markdown structure; code fences, inline code, paths, commands
and URLs byte-identical.
The QUESTION is disambiguation context only — never translate or answer it.
Style additions (apply the general ones always; apply a labeled one only
when you translate into that language):
{append}
```

- `{append}` = the user's `promptAppend` entries (§5) rendered as lines:
  general entries verbatim, per-language ones prefixed with their label
  (e.g. `[de] Sprich den Leser in direkter Anrede mit „du" an…`). The
  translator itself decides which label matches its target — the
  extension never interprets them. Empty block if no append configured.
- Forced-target mode (`/langtail <name>`): the identify/NONE rules above
  are replaced by "Always translate the DRAFT into <name>" — no
  passthrough, the output is always delivered in that language.
- Message payload: `QUESTION:\n<user prompt>\n\nDRAFT:\n<draft answer>`.

## 4. Validation pipeline (per translation)

Fail → retry once → give up → deliver working-language draft + `ui.notify`.
Never deliver an empty bubble, never loop. `NONE` short-circuits steps
1–4: draft delivered as-is.

1. `out.stopReason !== "error"`; non-empty after trim.
2. **Script guard (generic, table-free)**: every Unicode script appearing
   outside code fences in the output must also appear in QUESTION ∪ DRAFT.
   This rejects exactly the measured CJK-leak class (CJK present in
   neither a Latin-script question nor the English draft) while staying
   correct for CJK targets (a Japanese question licenses CJK output).
3. Code fences/inline code byte-identical to the draft (cheap string diff
   of fenced segments — v2; v1 trusted the prompt).
4. Length sanity outside fences: translation ∈ [0.4×, 2.5×] of source
   chars (catches truncations/hallucinated expansions).

## 5. Config & commands

- Env boot defaults: `LANG_TAIL=1` enable; `LANG_TAIL_WORKING=en`;
  `LANG_TAIL_TARGET=auto|<language name>|off`; `LANG_TAIL_MODEL=provider/id`
  translator. (No per-language model overrides — the extension does not
  know the language before the call.)
- Command `/langtail [on|off|auto|<language name>]`, plus status output
  listing the translator model and configured appends.
- Settings: `{cwd}/.pi/settings.json` block:

```json
{ "language-tail": {
    "working": "en",
    "target": "auto",
    "model": "the local dense model",
    "promptAppend": {
      "*":  "optional general addition",
      "de": "Sprich den Leser in direkter Anrede mit „du" an (informell, nicht „Sie")."
    }
} }
```

  Same resolution pattern @samfp/pi-memory uses (per-user `/data/<user>/.pi/`
  works on the multi-user pi-web box without mounts). Env > settings >
  defaults. The keys of `promptAppend` are user-facing labels rendered
  into §3's block; they do not select any code path. `promptAppend`
  values are appended verbatim — the extension never interprets them.
- **No harvest.** The tail writes nothing durable beyond the normal session
  transcript (the replaced final message). No `appendEntry` pair corpus;
  the training track was dropped by operator decision (2026-10-10, see
  README — archived in git snapshot `<initial-commit>`).

## 6. Test plan (acceptance for implementation)

1. Prompt-construction unit test: `{append}` renders general + labeled
   entries correctly; forced-target variant swaps the detection block.
2. NONE drill: English question + English draft → translator answers
   `NONE` → stdout is the untouched draft (byte-identical, no rewrite).
3. E2E per language (`pi --extension … --print`, ≥5 questions in de/fr/es/
   it): assert stdout is in the target language's script — the language is
   detected, never configured per turn.
4. E2E tool-heavy turn (bash/read): intermediate narration stays working
   language; only final message translated.
5. Fallback drill: point `LANG_TAIL_MODEL` at a bogus id → notify + working
   language delivered, no crash. Also: translator answers a non-exact
   pseudo-NONE → treated as a real (failed) translation, fallback, no
   English-leak labeled as success.
6. Append drill: set `promptAppend.de` to the „du" rule → German E2E
   answer uses „du"; English and French E2E unaffected (label discipline).
   Remove the append → neutral behavior.
7. Script-guard unit tests: known-good + injected-CJK negatives (Latin
   question rejects CJK; CJK question permits CJK).

## 7. Known limits & open questions (deliberately NOT in v2)

- **Every turn pays the translator call** — English-only turns too (the
  extension cannot know without asking). Mitigation candidate if latency
  hurts: a heuristic PRE-gate that may only skip the call on confident
  same-language questions, never force a translation. Measure first.
- **Short/ambiguous replies** ("ok?", "weiter") are language-neutral: the
  translator sees them as same-language → `NONE` → working language. The
  old session-sticky target is gone because stickiness needs a language
  id the extension no longer holds. Upgrade path: have the translator
  report its detected language in a parseable header line and reuse it
  for ambiguous turns — only if this bites in practice.
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
- **Passthrough skips style** (found live 2026-10-10): when the working
  model disobeys the working-language guideline and drafts *directly* in
  the user's language, the translator sees QUESTION≈DRAFT → `NONE` → the
  original is delivered untouched, so `promptAppend` (e.g. the du rule) is
  NOT re-applied. The tail assumes guideline obedience; weak models (the
  whole reason this exists) obey it, a fluent local model like
  `the local dense model` sometimes drafts German itself. Forced-target mode has no
  passthrough, so it always re-normalizes style. Mitigation candidate: a
  same-language *style-normalize* pass instead of passthrough — parked until
  it bites in production (it would add a call to every same-language turn).
- Mixed-language questions → translator picks (LLM judgment; the old
  detector score is gone). Queued mid-turn messages keep the turn's input.
- Multi-user auto-load (operator sign-off; sessiond boots extensions for
  ALL users of the shared instance).
