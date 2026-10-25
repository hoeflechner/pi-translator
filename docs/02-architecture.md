# 02 — Architecture & pi extension API ground truth

> The pi extension-API ground truth below is still accurate and load-bearing.
> The "mechanism verified" description is v1 history — current design:
> `06-plan-v3.md`.

## Mechanism (verified end-to-end 2026-10-10)

```
user (any language)
   │  before_agent_start: push guideline  ── "always think/narrate/final
   ▼                                        answer in WORKING language
agent loop (working language = English)    (never target language yourself)"
   │  tool calls, drafts, intermediate narration: all working language
   ▼
message_end (final assistant message)
   │  translateOnce( model, fresh Context{ generic prompt template
   │     ("identify QUESTION language; if same as DRAFT output exactly
   │      NONE, else translate DRAFT into the QUESTION's language"
   │      + user promptAppend),
   │     [ "QUESTION: <user prompt>\n\nDRAFT: <draft>" ] } )
   │     out === "NONE" → deliver draft untouched
   │     validate (non-empty, stopReason≠error, generic script-guard)  ── fail → retry once → FALLBACK to working-language draft + notify
   └─▶ return { message: {...msg, content:[...nonTextBlocks, text:translation]} }
```

Key decisions and why:

1. **Guideline via `systemPromptOptions.promptGuidelines`** (append in
   `before_agent_start`) — pi renders this as a structured transcript delta
   and preserves the prompt cache. **Never** return `systemPrompt` from the
   event (full replacement → forced transcript checkpoint → cache kill).
2. **Rewrite at `message_end`** — documented capability: "replace a finalized
   message while preserving its role". Result type
   `MessageEndEventResult = { message?: AgentMessage }`. No tool-in-the-loop
   "call the translator" design: the agent must not have to remember it, and
   a translated text must not pass back *through* the weak model's decoder.
3. **Translation call is provider-neutral and context-free**:
   `ctx.modelRegistry.streamSimple(model, context, {signal})`. The
   `Context` here is a raw literal (`{systemPrompt?, messages}`) — NOT the
   session's context; nothing leaks in.
4. **Fallback never produces an empty bubble** — returning nothing keeps the
   working-language draft visible (see the empty-completion bug class in
   01-findings §5).

## pi extension API — verified signatures (from pi-coding-agent dist .d.ts, 2026-10-10)

Extension = TS module, jiti-loaded, default-export factory receiving
`ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) { /* register here */ }
```

Load paths: auto-load from `~/.pi/agent/extensions/` (⚠ shared instance —
sessiond loads at boot for ALL users; operator sign-off required) or
explicit `pi --extension ./file.ts`. Development: any path.

Events used (types in `dist/core/extensions/types.d.ts`):

```ts
// BeforeAgentStartEvent { prompt: string; systemPrompt: string;
//   systemPromptOptions: NormalizedBuildSystemPromptOptions }
pi.on("before_agent_start", (event) => {
  event.systemPromptOptions.promptGuidelines.push(GUIDELINE);  // mutable, cache-friendly
  // result { systemPrompt?: string } = full replacement — avoid (cache-killer)
});

// MessageEndEvent { message: AgentMessage }
pi.on("message_end", (event, ctx) => {
  // AgentMessage (assistant): { role:"assistant",
  //   content: (TextContent|ThinkingContent|ToolCall)[], api, provider,
  //   model, usage: Usage, stopReason: StopReason, ... }
  // TextContent: { type:"text", text, textSignature? }
  return { message: {...} };  // must keep role "assistant"
});

pi.registerCommand("translator", { description, handler: async (args, ctx) => {...} });
pi.appendEntry(customType: string, data?: unknown);  // durable, EXCLUDED from model context

// ModelRegistry (ctx.modelRegistry):
find(provider: string, modelId: string): Model<Api> | undefined;
streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions)
    : AssistantMessageEventStream;   // extends EventStream → await .result()
// pi-ai Context: { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
// UserMessage: { role:"user", content: string|(...)[], timestamp: number }
// StreamOptions carries signal?: AbortSignal (verified in pi-ai types)
```

UI guardrails for multi-mode safety (extensions load in tui/rpc/json/print):
`if (ctx.hasUI) ctx.ui.notify(msg, "info"|"warning")`. No terminal-only
components needed here.

## v1 reference implementation — test log (all PASSED 2026-10-10)

The v1 file (removed from the tree 2026-10-10; recover via
`git show $(git rev-list --max-parents=0 HEAD):reference/german-tail-v1.ts`) passed:

1. Load smoke: `pi --extension ... --model <clean-model> --print
   "Reply with exactly: extension-load-ok"` → `extension-load-ok`.
2. Guideline effect: German question to the clean local model with `GERMAN_TAIL=1`
   → agent produced an **English** draft despite German input (proves the
   working-language guideline beats conversational-language pull).
3. Round-trip: stdout = fluent German; session transcript contains the
   replaced assistant message AND an appended entry:
   `{"customType":"german-tail","data":{question, english, german, model}}`.
4. Bug caught during testing (lesson for the generic design): the v1
   function-word heuristic initially MISS-detected
   „Was ist ein Port-Konflikt? Antworte in genau zwei Sätzen." (guard order:
   minimum-hit threshold placed before the umlaut check). Fixed by
   `hits >= 2 || (hits >= 1 && /[äöüß]/)`. → Heuristic text detectors are
   brittle (any corpus will miss real phrasing). This is a direct reason
   the generic design (03 §1–2) dropped deterministic detection entirely
   and let the translator LLM identify the target language.

## What v1 intentionally does NOT do (all live in the 03 spec)

- German hardcoded (detector, prompt, trigger) → replaced by a single
  generic translator call that detects the language itself (03).
- Language detection only from the prompting message (queued mid-turn
  messages don't re-trigger).
- Translates code fences by asking politely (prompt instruction) instead of
  masking them out deterministically.
- No per-language script validation (only a CJK-block regex).
- Intermediate tool-narration messages pass through untranslated by design
  (mixed text+toolCall blocks are skipped) — keep this, it is correct.
- Replacement writes the translation INTO the transcript (agent's future
  context sees target-language text). Acceptable (working-language
  guideline still governs generation), but see 03 §7 for the display-only
  variant.
