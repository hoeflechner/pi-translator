# 03 — Implementation spec: `language-tail` (generic, any target language)

Generalize `reference/german-tail-v1.ts` from "German" to "profile-driven".
Keep the v1 event wiring exactly (verified in 02) — the generalization is
configuration + profiles + validation.

## 1. Core concepts

- **Working language** (`workingLang`, default `en`): the language the agent
  is told to think/narrate/answer in. Injected via `promptGuidelines` while
  the tail is enabled (and un-injected when disabled → agent reverts to
  native multilingual behavior).
- **Target language** per turn: `auto` = detect from the user prompt; or
  forced via command/config. If target == working → no tail.
- **Language profile** = everything language-specific, one table:

```ts
interface LangProfile {
  code: string;                    // "de", "fr", "es", ...
  name: string;
  detect: { words: string[]; script: RegExp };   // function-word set + native-script evidence
  systemPrompt: string;            // translator contract (see §3)
  allowedScript: RegExp;           // chars legal OUTSIDE code fences (validation)
  model?: string;                  // "provider/id" override; else default translator model
}
```

Initial profiles: `de` (port of v1, incl. its style contract), `fr`, `es`,
`it`. Extend later (ja/ru/tr…). Adding a language = adding a profile, zero
mechanism changes.

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
- Mixed-language prompt → pick profile with the higher detector score.
  (Upgrade path: fastText `lid.176.ftz` behind the same interface if
  heuristics prove too weak — do not start with it.)

## 3. Translator prompt contract (per profile)

Small system prompt, always fresh. Must contain, per profile:
1. Role + output-only-translation instruction (no comments, no doubling).
2. The **style policy of the language** — this is where AGENTS.md style
   rules now live, because this prompt is never diluted by session length
   (see 01-findings §1B). German: informal „Du“, elevated-but-natural,
   established loanwords allowed and preferred, **invented compounds
   explicitly forbidden** (the measured failure class), no anglicism
   mania. French/Spanish/Italian: analogous register rules.
3. Preservation: markdown structure, code blocks, inline code, paths,
   commands, URLs byte-identical.
4. Payload: user question as *context only* ("nicht mitübersetzen") +
   draft answer.

## 4. Validation pipeline (per translation)

Fail → retry once → give up → deliver working-language draft + `ui.notify`.
Never deliver an empty bubble, never loop.

1. `out.stopReason !== "error"`; non-empty after trim.
2. **Script guard**: characters outside code fences must match
   `profile.allowedScript` ranges (for Latin targets this rejects exactly
   the CJK-leak class measured in 01-findings; for `ja` the ranges invert —
   hence per-profile, not one global CJK regex).
3. Code fences/inline code byte-identical to the draft (cheap string diff
   of fenced segments — v2; v1 trusts the prompt).
4. Length sanity outside fences: translation ∈ [0.4×, 2.5×] of source
   chars (catches truncations/hallucinated expansions).

## 5. Config & commands

- Env boot defaults: `LANG_TAIL=1` enable; `LANG_TAIL_WORKING=en`;
  `LANG_TAIL_TARGET=auto|<code>|off`; `LANG_TAIL_MODEL=provider/id` default
  translator; `LANG_TAIL_MODEL_DE=provider/id` per-profile override.
  (v1's `GERMAN_TAIL*` names may stay as aliases during transition.)
- Command `/langtail [on|off|auto|<code>]` (replaces `/gtranslate`), plus
  status output listing loaded profiles and models.
- Settings: `{cwd}/.pi/settings.json` block `{"language-tail": {...}}` —
  same resolution pattern @samfp/pi-memory uses (per-user `/data/<user>/.pi/`
  works on the multi-user pi-web box without mounts). Env > settings >
  defaults.
- Harvest: keep `pi.appendEntry("language-tail", {turn, target, question,
  source, translation, model, validated})` — the corpus feeds
  04-training-track. Entries are excluded from model context (verified API
  property).

## 6. Test plan (acceptance for implementation)

1. Detector corpus (§2) green.
2. Script-guard unit tests: known-good + injected-CJK negatives per profile.
3. E2E headless per language (`pi --extension … --print`): ≥5 questions —
   assert stdout is in target script and transcript holds the harvest
   entry with both versions.
4. E2E English prompt → passthrough (no entry, no rewrite).
5. E2E tool-heavy turn (bash/read): intermediate narration stays working
   language; only final message translated.
6. Fallback drill: point `LANG_TAIL_MODEL` at a bogus id → notify + working
   language delivered, no crash.

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
