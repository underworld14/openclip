---
id: FEAT-bysdwg
title: 'Custom OpenAI-compatible endpoint: base URL, model id, and model discovery'
status: doing
priority: medium
created: "2026-08-15T08:10:14Z"
updated: "2026-08-15T08:10:14Z"
---

# Description

`AIProvider` is a closed enum and every endpoint URL is a literal, so OpenClip cannot talk to
LM Studio / vLLM / LiteLLM / Groq / Together / DeepSeek / a corporate gateway. `Settings.baseUrl`
and `TransportFactoryArgs.baseUrl` both already exist but are **dead end-to-end** — no UI renders
the field, no handler reads it, and none of the four `createTransport` call sites passes it.

Add a 5th provider `custom` (Custom (OpenAI-compatible)) with its own base URL, its own OPTIONAL
key slot (local servers need none), a free-text model id, and model discovery via
`GET {baseUrl}/models`. Endpoints that reject strict `json_schema` still work through a runtime
downgrade ladder.

# Acceptance Criteria
- [ ] `custom` selectable in Settings with a Base URL field (validated, blur-committed)
- [ ] A keyless local endpoint works — no `Authorization` header sent, no `Missing credentials` throw
- [ ] Model discovery hits `{baseUrl}/models`; failure degrades to free text, never blocks generate
- [ ] Structured output auto-downgrades json_schema -> json_object -> none, memoized per endpoint+model
- [ ] `baseUrl` never crosses IPC — resolved main-side from settings, like the API key
- [ ] A key saved for one endpoint is not sent to a different endpoint
- [ ] Provider error text is redacted/capped on the GENERATE path, not just Test connection
- [ ] Per-request (not per-run) provider deadline
- [ ] `clipCacheKey` includes endpoint identity
- [ ] Readiness understands "needs a base URL, not a key"

# Implementation Plan

Seven commits, each green on its own:
1. Shared foundation — `src/shared/ai-providers.ts`, `src/shared/endpoint-url.ts`
2. Enum + validation — `AIProvider += 'custom'`, `baseUrl` refine, de-duplicate
   `job-start-validation.AI_PROVIDERS`
3. Transport ladder — `buildOpenAITransport` modes/memo, classifier, `<think>` strip,
   `createTransport case 'custom'`
4. Main-side resolution — `IpcContext.getSettings`, 4 call sites, key/endpoint binding,
   error redaction, per-request deadline, cache key
5. Discovery — `provider-models.ts` custom branch + fetch hardening
6. Test connection reports the resolved structured-output mode
7. UI — Settings panel, store, readiness, PRD row

Full plan: `~/.claude/plans/please-plan-to-support-drifting-blanket.md`

# Notes

Verified against the installed OpenAI SDK (`node_modules/openai/client.js`):
- `:142` — `apiKey: ''` throws `Missing credentials` before any request
- `:73` — omitting `apiKey` falls back to `process.env.OPENAI_API_KEY` (would leak the user's real
  key to the custom endpoint)
- `:213-218` + `internal/headers.js:59-63` — `defaultHeaders: { Authorization: null }` is the
  supported "send no auth" mechanism
- `:159` — `maxRetries` defaults to 2; `:600` spreads `fetchOptions` into `fetch` (so
  `redirect: 'error'` works)

Deliberately out of scope (separate tickets): AI emoji is broken on OpenAI/OpenRouter because
`buildOpenAITransport` hardcodes the ClipSchema `response_format` for every prompt; `settings.json`
is written 0644 while `secrets.json` is 0600.

# Related Files

# Attachments
