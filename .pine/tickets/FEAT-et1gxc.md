---
id: FEAT-et1gxc
title: Google/Gemini is selectable in the provider dropdown but hard-throws, and two AI channels return silent empty successes
status: todo
priority: medium
labels:
    - ux
    - ai
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

settingsView.ts:31 `PROVIDERS = ['openai','anthropic','google','ollama','openrouter']` with the label 'Google Gemini' (settingsView.ts:16), but ai-client.ts:716-717 does `case 'google': throw new Error('Google provider is not wired in the MVP (PRD §4.3)')`. A user can select it, save a key, and hit a hard crash three clicks later. Additionally `GENERATE_TITLES` returns `{options: []}` unconditionally (main/ipc/ai.ts:175-178) and `ENHANCE_CAPTIONS` rewrite mode returns `{enhanced_captions: []}` (main/ipc/ai.ts:188) — both are live IPC channels exposed on the preload bridge that answer *successfully* with nothing, which is worse than erroring.

## Desired behavior

Either wire Google (the SDK shape is close to the existing OpenAI transport) or remove it from PROVIDERS and add a 'Coming soon' disabled option. Stub channels should either be implemented or return a typed `NOT_IMPLEMENTED` error so callers can branch, not a successful empty payload.

## Competitor precedent

SupoClip's `_get_missing_llm_key_error()` names the exact env var and lists working alternatives instead of throwing. LokaClip publishes an honest '/features' page with a 'not yet available' roadmap section — under-promising in public reads as competence.

## Implementation sketch

Fastest safe fix: remove `'google'` from `PROVIDERS` in settingsView.ts:31 (or render it `disabled` with a 'coming soon' suffix). Real fix: add a `case 'google'` transport in ai-client.ts:716 using `@google/genai` with `responseSchema` from the existing `clipJsonSchema()` — the `RawTransport` seam means it's one function plus a spec in tests/unit/ai-providers.spec.ts. For the stubs, change main/ipc/ai.ts:175-178 and :188 to `throw new JobError('NOT_IMPLEMENTED', …)` and hide the corresponding UI entry points until built.

## Sizing

Impact: **medium** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
