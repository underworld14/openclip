---
topic: byok-endpoints
updated: 2026-08-15T08:36:40Z
---

# byok-endpoints

- 2026-08-15: BYOK destination is a security boundary, not just config. When a provider endpoint becomes user-supplied, resolve it MAIN-side from Settings (IpcContext.getSettings) exactly as the key is resolved from the vault. A baseUrl on the IPC/job contract would let a compromised renderer name the host the decrypted key is attached to (PRD 12.2) — and keeping it off the contract also means channels.ts/jobs.ts/preload never change, so preload-parity and the mock bridge stay untouched. Corollary: the key vault is keyed by provider id alone, so a key saved for one custom endpoint would otherwise be sent to the next URL typed — bind it to the endpoint ORIGIN (Settings.customKeyEndpoint) and treat a mismatch as no key, fail-closed and never destructive.
- 2026-08-15: The OpenAI SDK constructor has two traps for a custom baseURL (verified in node_modules/openai/client.js): apiKey:'' THROWS 'Missing credentials' (:142), and OMITTING apiKey falls back to process.env.OPENAI_API_KEY (:73) — which would send the user's real OpenAI key to whatever host they typed. Pass a placeholder key plus defaultHeaders:{Authorization:null} (the supported omit-auth path, :213-218), and set maxRetries:0 + fetchOptions:{redirect:'error'} (spread into fetch at :600). Same file: OPENAI_BASE_URL env silently redirects any client built without an explicit baseURL.
- 2026-08-15: Provider errors reach the UI on the GENERATE path, not just Test connection: transport throw -> generate-clips-runner -> sidecar-manager emit.error -> useJob -> clipsSlice.generateError -> rendered. The OpenAI SDK builds that message from the response body VERBATIM, so a provider 401 echoing the key was already reachable on screen and no test covered it. Redact + cap where errors LEAVE main (services/ai-errors.ts), not only in the one handler that happened to call the mapper.
