# 06 — v3 plan: stored user language, repair-polish mode, optional prompt passthrough

**STATUS 2026-10-24: DESIGN DRAFT. Nothing implemented. Sequenced by the
owner as: this document → second review run → implement. Do not code against
this file until the review run has reported.**

Owner policy decisions (2026-10-24), binding for this plan:

- **The working-language mandate stays.** The agent keeps working in the
  machine's language; "let the agent draft in whatever language it wants"
  is rejected by the owner, not just by the review.
- **The translator stays the agent model.** Other models "may not be
  available", and the bet is that a short, clean context makes the worker
  good enough as its own translator. `PI_TRANSLATOR_MODEL` remains an
  operator override and ships unused. Counter-evidence is recorded in
  `01-findings.md` §8 (55 % unpolished answers on the weak worker, 92.8 s
  reply median on `local/smart`) and is treated as a **watch item with a
  falsification gate** (§Falsification), not as a blocker.
- **Same-language answers are re-formulated too** — "even English gets
  re-phrased". Cost is stated in §F2 and is an open question for review.

## The proposal that opened this plan (owner, 2026-10-24)

1. User prompts are no longer translated; the extension only *looks* at the
   message and *stores* the user's language.
2. The agent then works in whatever language it wants.
3. At the very end the translator gets the task of perfectly formulating the
   answer in the user's language, from a short context and one clear
   instruction — so the surface language is always perfect.

## Verdict (review run 1 + owner decisions)

| Sub-proposal | Verdict | Why |
|---|---|---|
| 1 — store the user language | **Adopt** (this plan F1) | The stored state is the real upgrade: it replaces the `questionIsWorkingLang`/`lastUserPrompt` pair that needed three fix commits (`6a325a5`, `d5f4fce`, `86077e1`), and it moves the language *out of the context*, so compaction can no longer erase it (upstream bug class: `google/adk-python#6273`, compaction loses conversation language) |
| 1 — stop translating prompts | **Defer to an opt-in flag** (F3) | The documented engine symptom is that this worker *reads a German prompt as Chinese* (`01-findings.md` §4.3) — direct reading is a bigger fidelity risk than a masked, guarded translation that preserves entities by construction. The latency argument is real but is a **model** problem, not an architecture problem (§8: the pre-start median is 4.5 s on the worker) |
| 2 — free working language for the agent | **Reject** | Deletes four protection layers (guideline, F2 prompt translation, F1 context restore, `86077e1` summary translation) and keeps one backstop that runs *after* the damage. Class-B artifacts (calques, invented compounds) survive a same-language rephrase — a context-free rephraser cannot know that `Einzeltauchraten` meant framerate — so the user gets a **fluent, perfectly written wrong answer**, which is the silent class the owner cares about most |
| 3 — always polish into the user's language | **Adopt the intent, change the mechanism** (F2) | It fixes a real documented gap (a guideline-disobedient draft passes through unpolished — today 55 % of answers on the weak worker, §8), implemented as a **repair mode inside v2**, not as a licence to draft in any language |

## F1 — stored user language

State today is *derived per turn* from two variables and dies with the
process. v3 makes it data.

- Stamp `piTranslator: { userLang: "de" }` on the **user** message when the
  language is judged. Message metadata round-trips to the session JSONL and
  survives `--session` resume — the mechanism F1/F2 already depend on
  (`05-plan-v2.md`, "Gate passed"), so this adds no new persistence bet.
- **`nextUserLang(current, verdict, wordCount, forced) → lang`** — pure,
  unit-testable in the existing style. Sticky rule: a human message below a
  word threshold (8) *inherits* the stored language, so `"ok?"` cannot reset
  a German session; a long message, or an explicit "answer in English",
  re-judges it.
- Only **human** turns may change it. The rule from `d5f4fce` (machine-
  triggered turns — delegation reports, scheduled fires, a continue run with
  no prompt — carry no language evidence) becomes an input to
  `nextUserLang`, not a separate special case.
- **Session reload**: walk the transcript back to the latest stamped user
  message; if none, `userLang = "unknown"`, which is treated as *not* the
  working language (an attempt plus a visible failure, never a silent
  English assumption — the `05-plan-v2.md` rule "Unknown ≠ English").
- `forced` (`/translator <language>`) stays session command state and is
  **not** persisted. The reasoning-probe set stays per-process.
- **Getting the name out of the translator.** Today the protocol yields only
  `NONE` or a translation, never a language name. Extend the reply protocol:
  *first line = language name, then the translation*; parse deterministically.
  Fallback is a coarse script→language map, allowed **only for state**, never
  as the translate-or-not decision — the 05 §Rejected stance against a
  deterministic detector still stands.
- **Shadow-run is mandatory before cutover.** Compute both the old verdict
  pair and `userLang`, log divergences, and move the gates over only at zero
  divergence over real sessions. Justification is this extension's own bug
  history: three fix commits are exactly silent-skip defects in this gate
  logic, and a half-migrated gate (one handler reading `userLang`, another
  reading the verdict pair) is the same defect class.

## F2 — repair-polish mode (the adopted half of proposal 3)

- **Trigger**: the reply branch detects a draft that is **not** in the
  working language — the case that today ships raw (55 % on the weak worker).
  Detection reuses the F1 language header, or a coarse script check over
  `proseOnly(draft)` for the cheap path.
- **`buildPolishPrompt(workingName, targetName, append)`**: the DRAFT was
  written by the working agent and may have drifted. Re-derive the answer in
  the target language from the DRAFT's *content* plus the QUESTION; do not
  preserve the draft's wording where it is wrong; **add no information that
  is not in the DRAFT**. The last clause is the only defence against the new
  failure mode this mode introduces — a polisher that manufactures fluent
  filler the draft never contained.
- Prompt is short, context is fresh (~1–3k tokens) — the measured clean
  regime (`01-findings.md` §6, 12/12 probes). That is precisely the owner's
  bet, and the reason it is credible.
- Every polish logs `dir:"polish"`, plus `verdict:"noop"` when the output is
  near-identical to the draft — required because F2 skips `differsFromSource`
  (below), which would otherwise make no-ops invisible in the audit log.

### Guard matrix

| Guard | translate mode | polish mode | reason |
|---|---|---|---|
| `maskProtected` / `unmaskProtected` | keep | **keep, non-negotiable** | the only byte-identical guarantee for code fences, inline code, URLs, POSIX and Windows paths |
| `scriptGuardOk` | keep | keep unchanged (script union of QUESTION ∪ draft) | catches the polisher's *new* CJK leaks; it cannot catch a CJK artifact **inherited from the draft** because the union licenses the draft's own scripts. No setting separates the two — document it: polish does not clean class-A |
| `lengthOk` floor (0.4×) | keep | keep | a truncated answer is still a truncated answer |
| `lengthOk` ceiling | 2.5× | **relax to 4×** | "perfectly formulate" legitimately lengthens, and the current ceiling would refuse correct polish. Do **not** delete it: it is the only guard against hallucinated expansion |
| `differsFromSource` | keep | **skip** | a same-language re-formulation shares far more than 60 % of word forms with its source *by construction*; keeping it rejects correct polish constantly. The hole it opens is the Latin↔Latin meta-commentary incident (`05-plan-v2.md` Deviations) — in polish mode a meta/no-op output degrades to delivering the draft, i.e. today's behaviour: cosmetic loss, no correctness loss |

## F3 — `translatePrompt: false` (the deferred half of proposal 1)

Opt-in, default `true`. When off: skip the F2 prompt call, write no
`modelText` metadata, and let the model read the user's original text.
**Everything else stays** — delivery translation, F1 restore of stored
deliveries, summary translation, polish mode, all guards. Promotion to a
default requires weeks of clean audit data plus the owner's explicit risk
acceptance, and is not part of this plan.

## Not doing

- Free working language for the agent (proposal 2) — see Verdict.
- Pinning the translator model (owner decision) — `PI_TRANSLATOR_MODEL`
  stays as an override, unused by default.
- Deleting the `lengthOk` ceiling, or going below 4×.
- A deterministic language detector as the translate-or-not decision
  (05 §Rejected stands); the coarse script map is state-only.
- Any per-language code, tables or built-in prompts (README's core rule).

## Test plan (pure-helper style, `pi-translator.test.ts`)

1. `nextUserLang`: sticky below threshold, re-judges above it, ignores
   machine turns, respects `forced`, returns `unknown` with no history.
2. `parseLanguageHeader`: name line + translation, missing header, pseudo-
   `NONE`, header that is itself a translation.
3. Prompt shape: `buildPolishPrompt` contains re-derive, QUESTION, DRAFT,
   the no-added-information clause, and the `promptAppend` rendering.
4. Guard-mode matrix: polish skips `differsFromSource`, passes a 3× output
   under the 4× ceiling, still refuses a 0.3× truncation, still refuses new
   CJK, still tolerates draft-inherited CJK (documented), logs `noop`.
5. Mask round-trip unchanged under polish (fences, paths, URLs byte-identical).
6. E2E: replay a real German draft from the audit log → polished German
   delivered, `dir:"polish"` in the log, `/translator-original` still shows
   the untouched working-language original.

## Falsification gate for the owner's model decision

The bet "the agent model translates itself well enough in a short context"
is testable and must be measured, not assumed. After F1+F2 are live, from the
audit log on **foreign-language questions**:

- share of `dir:"reply"` verdicts that are `none` (was 55 % on the weak
  worker) — F2 should absorb these as `dir:"polish"`;
- share of `fail` verdicts and of `noop` polish outputs (a polisher that
  does nothing is the weak-model signature);
- polish `ms` distribution against the §8 baselines.

If the polish layer still waves through drift at anything like that rate,
the model decision is falsified and the translator pin returns to the table
with data.

## Deploy order and live risk

The loaded copy is the **git install** under `~/.pi/agent/git/github.com/
hoeflechner/pi-translator` (`~/.pi/agent/settings.json`), not this dev repo.
Deploy = commit → **push** → `pi update --extensions` (run manually by the
owner) → sessiond restart, because a running daemon keeps the code it loaded
at boot.

1. F1 in shadow mode alone.
2. F2 polish mode.
3. Observe against the falsification gate.
4. Only then F3 as an opt-in flag.

Never ship F3 in the same restart as F1 or F2: the recurring defect class of
this extension is a half-migrated gate, and a restart boundary is what makes
"which side migrated" answerable. Existing blast-radius controls stay:
per-user `target: "off"`, trust-scoped project blocks, 0600 per-user logs,
per-instance state so `userLang` cannot leak across users.

## Open questions for review run 2

1. **"Even English is re-phrased" costs what exactly?** Today an English
   question costs one tiny `NONE` call and *zero* reply calls (log: 4
   untouched). Always-polish makes every English turn pay a full call at
   worker speed. Is there a defensible cheap bypass, or is the consistency
   worth it?
2. Is the F1 language header (name + translation in one call) sound, or does
   a separate tiny detect call cost less than it saves?
3. `scriptGuardOk` cannot clean draft-inherited CJK. Accept, or add a
   polish-mode-only strict variant that rejects *any* non-Latin script in the
   draft and falls back to delivering the draft?
4. Is the 8-word stickiness threshold sound, or should stickiness key on
   whether the *stored* language was ever judged from a long message?
5. Does `unknown` user language (fresh session, no stamped message yet,
   first turn machine-triggered) correctly attempt-and-notify, or can it
   still ship the working language silently?
6. Anything in F1 that re-opens the silent-skip class the last three commits
   closed.
