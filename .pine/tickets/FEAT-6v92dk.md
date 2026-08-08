---
id: FEAT-6v92dk
title: Default AI model is the empty string, so a user who correctly pastes a key still gets a raw provider 401/400
status: doing
priority: critical
labels:
    - ux
    - onboarding
    - ai
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T17:13:27Z"
---

## Current behavior

settingsStore.ts:19 `model: ''` and main/ipc/settings.ts:21 `model: ''`. generateClips.ts:32 forwards `settings.model` verbatim. SettingsPanel.tsx:218-234 is a free-text Input whose only help is a stale placeholder (`:222-226` — 'e.g. gpt-4o-mini, claude-sonnet-4-5, llama3.1'). A model picker exists only for OpenRouter (main/ipc/ai.ts:209-211 returns `{models: []}` for every other provider). With no key at all, ai-client.ts:690 constructs `new OpenAI({apiKey: args.apiKey ?? ''})` and the provider's raw error body lands in the clip rail as red text (ClipSidebar.tsx:31-35) with no Retry and no link to Settings.

## Desired behavior

Per-provider sensible defaults so the model field is never empty. A curated dropdown for every provider (not just OpenRouter), with the free-text field as an escape hatch. A 'Test connection' button that does one cheap real round-trip and reports success/failure at configuration time. Missing-key and missing-model must be caught before the request with human copy: 'No API key for OpenAI. Open Settings →' rather than a 401 body.

## Competitor precedent

YT-Short-Clipper: 'Load Models' hits GET /models to populate a searchable dropdown, then 'Validate' does a live request before 'Save'. SupoClip returns 'Selected LLM provider is Google, but GOOGLE_API_KEY is not set. Set GOOGLE_API_KEY or set LLM to openai:* / anthropic:* / ollama:* with the matching API key.'

## Verified

An adversarial verifier confirmed the dead end in the real app. Note the honest scoping it
produced: a user who picks "Google Gemini" gets **no signal at all** until after they have
imported a video, waited through a full whisper transcription, and clicked Auto Generate
Clips — only then does the clip sidebar show a raw throw. The cost of the dead end is paid
in minutes of wasted work, not in a fast failure.

Related stale-pin finding: `src/main/services/openrouter-models.ts:23-32` pins
`anthropic/claude-opus-4.1` in its curated "recommended" list. That model is retired, so the
app's own recommended pick can fail outright. Current Anthropic ids are the Claude 5 family
(`claude-opus-5`, `claude-sonnet-5`) plus `claude-haiku-4-5`.

## Implementation sketch

Add `DEFAULT_MODEL_BY_PROVIDER` to `src/renderer/src/components/settingsView.ts` and apply it in the provider `onChange` in SettingsPanel.tsx when `settings.model` is empty. Extend `main/ipc/ai.ts` AI_LIST_MODELS beyond the `req.provider !== 'openrouter'` early-return (:209-211) with a static curated list per provider (OpenAI/Anthropic) and a live `/api/tags` fetch for Ollama. Add an `AI_TEST_CONNECTION` channel to `src/shared/channels.ts` reusing `createTransport` with a 3-token prompt. In generateClips.ts, refuse to dispatch when key or model is missing and set a typed `generateError` the sidebar renders with an 'Open Settings' button.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
