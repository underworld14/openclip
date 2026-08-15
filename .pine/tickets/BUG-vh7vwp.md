---
id: BUG-vh7vwp
title: 'AI emoji is broken on OpenAI/OpenRouter: the transport forces the ClipSchema response_format on every prompt'
status: todo
priority: medium
created: "2026-08-15T08:35:22Z"
updated: "2026-08-15T08:35:22Z"
---

# Description

`buildOpenAITransport` (`src/main/services/ai-client.ts`) attaches
`response_format: {type:'json_schema', json_schema:{name:'clips', strict:true, schema}}`
to EVERY prompt it is given. `ENHANCE_CAPTIONS` (mode:'emoji') reuses that same
transport for `suggestEmoji` (`src/main/ipc/ai.ts` → `services/ai-emoji.ts`), so the
emoji request is strictly constrained to emit a ClipSchema document.
`parseEmojiMap` then rejects it (values are arrays/objects, not emoji strings) and
the handler's catch degrades to `{}` — which is indistinguishable, by design, from
"the model had no suggestions". So AI emoji has never worked on OpenAI or
OpenRouter, silently.

Anthropic (`zodOutputFormat(ClipSchema)`) and Ollama (`format: clipJsonSchema()`)
have the same shape.

Found while building FEAT-bysdwg; deliberately not folded into it.

# Acceptance Criteria
- [ ] The emoji transport is not constrained to the clip schema
- [ ] A test asserts the emoji request's response_format (or absence of one)
- [ ] AI emoji produces a non-empty map against a real provider

# Implementation Plan

FEAT-bysdwg added the seam: `buildOpenAITransport(client, model, opts)` already
takes `modes` and could take a `responseSchema`. Give the emoji path its own
schema (or `modes: ['none']` plus the schema in the prompt, as the custom
provider's non-strict rungs do), and key the structured-mode memo on the schema
name — it already is (`${baseUrl}|${model}|clips`).

# Notes

# Related Files
- src/main/services/ai-client.ts
- src/main/services/ai-emoji.ts
- src/main/ipc/ai.ts

# Attachments
