---
id: FEAT-bysdwg
title: 'Custom OpenAI-compatible endpoint: base URL, model id, and model discovery'
status: done
priority: medium
created: "2026-08-15T08:10:14Z"
updated: "2026-08-15T08:36:03Z"
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
- [x] `custom` selectable in Settings with a Base URL field (validated, blur-committed)
- [x] A keyless local endpoint works — no `Authorization` header sent, no `Missing credentials` throw
- [x] Model discovery hits `{baseUrl}/models`; failure degrades to free text, never blocks generate
- [x] Structured output auto-downgrades json_schema -> json_object -> none, memoized per endpoint+model
- [x] `baseUrl` never crosses IPC — resolved main-side from settings, like the API key
- [x] A key saved for one endpoint is not sent to a different endpoint
- [x] Provider error text is redacted/capped on the GENERATE path, not just Test connection
- [x] Per-request (not per-run) provider deadline
- [x] `clipCacheKey` includes endpoint identity
- [x] Readiness understands "needs a base URL, not a key"

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

# Verification

- `npm run typecheck` / `npm run lint` clean; `npm test` 1413 passed, `npm run test:e2e` 12 passed.
- 45 new/updated assertions across `custom-endpoint.spec.ts`, `endpoint-url.spec.ts`,
  `settings-panel-custom-endpoint.spec.tsx`, plus additions to `provider-models`,
  `ai-ipc`, `generate-clips-runner`, `ai-mapreduce`, `readiness-view`,
  `job-start-validation` and `ai-components`.
- Driven over REAL HTTP against a throwaway OpenAI-compatible server that 400s
  `json_schema`: keyless `/models` discovery sent no Authorization header, the
  transport downgraded to `json_object` on the wire, the `<think>` preamble was
  stripped, and `generateClips` returned a valid ClipSchema.

# Follow-ups filed

- BUG-vh7vwp — AI emoji is broken on OpenAI/OpenRouter (pre-existing; the seam to
  fix it was added here)
- BUG-4tscfq — settings.json is 0644 while secrets.json is 0600
- BUG-v4phgj — OPENAI_BASE_URL env silently redirects the built-in openai provider

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

## Work Evidence

Closed by `pine close --evidence` on 2026-08-15.

- Base: `c6771af9` (last commit at or before ticket created 2026-08-15)
- Commits (3):
  - `58534d6a` — fix(settings): re-read key status when the custom endpoint changes (FEAT-bysdwg)
  - `0a183cd8` — feat(settings): Base URL field, keyless copy and endpoint-aware readiness (FEAT-bysdwg)
  - `4e9fb64d` — feat(ai): a custom OpenAI-compatible endpoint — base URL, keyless auth, discovery (FEAT-bysdwg)
- Files changed (base → working tree):

```
 .pine/tickets/FEAT-bysdwg.md                       |  86 ++++++
 docs/prd.md                                        |   3 +
 src/main/index.ts                                  |   4 +-
 src/main/ipc/ai.ts                                 | 149 +++++++---
 src/main/ipc/index.ts                              |  14 +
 src/main/ipc/job-start-validation.ts               |   7 +-
 src/main/ipc/settings.ts                           |  36 ++-
 src/main/services/ai-client.ts                     | 296 ++++++++++++++++++--
 src/main/services/ai-errors.ts                     | 129 +++++++++
 src/main/services/jobs/generate-clips-runner.ts    |  67 ++++-
 src/main/services/provider-models.ts               | 109 +++++++-
 src/renderer/src/components/SettingsPanel.tsx      |  96 ++++++-
 src/renderer/src/components/readinessView.ts       |  36 ++-
 src/renderer/src/components/settingsView.ts        |  25 +-
 src/renderer/src/hooks/useReadiness.ts             |   1 +
 src/renderer/src/stores/settingsStore.ts           |  28 +-
 src/shared/ai-providers.ts                         |  75 +++++
 src/shared/endpoint-url.ts                         | 132 +++++++++
 src/shared/schema.ts                               |  43 ++-
 tests/unit/ai-components.spec.ts                   |   8 +-
 tests/unit/ai-ipc.spec.ts                          | 177 +++++++++++-
 tests/unit/ai-mapreduce.spec.ts                    |  23 ++
 tests/unit/custom-endpoint.spec.ts                 | 308 +++++++++++++++++++++
 tests/unit/endpoint-url.spec.ts                    | 112 ++++++++
 tests/unit/generate-clips-runner.spec.ts           |  74 ++++-
 tests/unit/job-start-validation.spec.ts            |  37 +++
 tests/unit/provider-models.spec.ts                 | 140 ++++++++++
 tests/unit/readiness-view.spec.ts                  |  30 ++
 tests/unit/settings-panel-custom-endpoint.spec.tsx | 185 +++++++++++++
 29 files changed, 2302 insertions(+), 128 deletions(-)
```
