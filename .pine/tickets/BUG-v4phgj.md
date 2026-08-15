---
id: BUG-v4phgj
title: OPENAI_BASE_URL in the environment silently redirects the built-in openai provider
status: todo
priority: medium
created: "2026-08-15T08:35:22Z"
updated: "2026-08-15T08:35:22Z"
---

# Description

`createTransport`'s `openai` branch passes `baseURL: args.baseUrl`, which is
always `undefined` for the built-in provider. `node_modules/openai/client.js:73`
destructures `baseURL = readEnv('OPENAI_BASE_URL')`, so an `OPENAI_BASE_URL` in
the environment silently redirects every OpenAI call — including the user's key —
to a host they never configured in OpenClip, with no indication in the UI.

Same shape as the `apiKey` env fallback that FEAT-bysdwg closed for the custom
provider (there by always passing an explicit key).

# Acceptance Criteria
- [ ] The openai branch passes an explicit baseURL
- [ ] A test asserts the ctor receives it even when OPENAI_BASE_URL is set

# Implementation Plan

Export the default (`https://api.openai.com/v1`) next to `OPENROUTER_BASE_URL`
and pass `baseURL: args.baseUrl ?? OPENAI_DEFAULT_BASE_URL`, matching what the
openrouter branch already does.

# Notes

# Related Files
- src/main/services/ai-client.ts

# Attachments
