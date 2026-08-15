/**
 * src/main/services/ai-errors.ts — the ONE place a provider failure becomes text
 * a user may see (FEAT-bysdwg).
 *
 * WHY IT MOVED HERE. `humanTransportError` lived in `ipc/ai.ts` and was called
 * from exactly one handler — `AI_TEST_CONNECTION`. The GENERATE path never went
 * through it: a transport throw travelled runner → `sidecar-manager.emit.error`
 * → `useJob` → `clipsSlice.generateError` → rendered, and the OpenAI SDK builds
 * that message as `${status} ${response body}` VERBATIM. So a provider 401 whose
 * body echoes the submitted key ("Incorrect API key provided: sk-…") was already
 * reachable on screen, and no test covered it.
 *
 * With a user-supplied endpoint the string stops being merely embarrassing: a
 * hostile or compromised server chooses it. Nothing here is rendered as HTML (the
 * app has no `dangerouslySetInnerHTML`), so this is not an XSS boundary — it is a
 * SECRET-ECHO and attacker-copy boundary. Every message that leaves main for a
 * user's eyes goes through `redactSecrets` and a length cap, and the runner maps
 * the failure onto the typed job codes that already existed but were never
 * thrown (`API_AUTH`, `API_RATE_LIMIT`).
 */

import type { AIProvider } from '@shared/schema'
import { providerDisplay } from '@shared/ai-providers'

/** Long enough to be useful, short enough that no one pastes a wall of HTML. */
export const MAX_PROVIDER_ERROR_CHARS = 300

/**
 * Key-shaped tokens across the providers we speak to (and the common
 * OpenAI-compatible gateways). Prefix-based, so it cannot match ordinary prose.
 */
const KEY_SHAPED = /\b(?:sk|sk-or|sk-ant|sk-proj|gsk|xai|api)[-_][A-Za-z0-9_-]{8,}\b/g

/**
 * Strip anything key-shaped, plus the ACTUAL key when we have it — the only
 * check that works for a gateway with a bespoke key format — then cap the length.
 */
export function redactSecrets(text: string, apiKey?: string | null): string {
  let out = text.replace(KEY_SHAPED, '[redacted]')
  // Guard the length: a 3-char "key" would blank out unrelated text.
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[redacted]')
  return out.length > MAX_PROVIDER_ERROR_CHARS ? `${out.slice(0, MAX_PROVIDER_ERROR_CHARS)}…` : out
}

/**
 * Map a provider SDK failure to something a non-technical user can act on.
 *
 * Provider error bodies routinely echo the submitted API key back, so the raw
 * message must NEVER be forwarded verbatim — this function is also the redaction
 * seam.
 */
export function humanTransportError(
  err: unknown,
  provider: AIProvider,
  model: string,
  baseUrl?: string,
  apiKey?: string | null
): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Name the endpoint, not the enum id: "custom rejected the request" tells a
  // user with several servers nothing.
  const who = providerDisplay(provider, baseUrl)
  if (/\b401\b|unauthor|invalid[_ -]?api[_ -]?key|incorrect api key/i.test(raw)) {
    return `The key for ${who} was rejected. Check that it is correct and still active.`
  }
  if (/\b403\b|permission|forbidden/i.test(raw)) {
    return `That key is valid but not allowed to use "${model}". Try a different model or plan.`
  }
  if (/\b404\b|model[_ ]?not[_ ]?found|does not exist|unknown model/i.test(raw)) {
    return provider === 'custom'
      ? `${who} returned 404 for "${model}". Check the model id — and that the Base URL is the OpenAI-compatible root, usually ending in /v1.`
      : `${who} does not recognise the model "${model}". Pick one from the list.`
  }
  if (/response_format|json_schema|structured|schema/i.test(raw)) {
    return `"${model}" cannot produce the strict JSON that clip detection needs. Pick another model.`
  }
  if (/\b429\b|rate[_ ]?limit|quota|insufficient[_ ]?quota|billing/i.test(raw)) {
    return `${who} rejected the request for quota or rate-limit reasons. Check your billing.`
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|timeout|ETIMEDOUT/i.test(raw)) {
    if (provider === 'ollama') {
      return 'Could not reach Ollama on this machine. Is `ollama serve` running?'
    }
    // "Check your internet connection" is actively wrong advice for a server on
    // localhost — the overwhelmingly common custom endpoint.
    if (provider === 'custom') {
      return `Could not reach ${who}. Is the server running and listening on that address?`
    }
    return `Could not reach ${who}. Check your internet connection.`
  }
  // Unknown shape. Quote the server, REDACTED and capped, rather than either
  // dumping a body that may contain the key or hiding the only clue a
  // self-hosted-endpoint user has. Attributed, so attacker-chosen text cannot
  // read as OpenClip speaking.
  const quoted = redactSecrets(raw.trim(), apiKey)
  return quoted
    ? `${who} rejected the request. Server said: ${quoted}`
    : `${who} rejected the request. Double-check the provider, model id and key.`
}

/** Terminal job codes a provider failure can map to (see `@shared/jobs`). */
export interface ProviderFailure {
  code: 'API_AUTH' | 'API_RATE_LIMIT' | 'SIDECAR_CRASH'
  message: string
  retriable: boolean
}

/**
 * Classify a provider failure for the JOB plane.
 *
 * `API_AUTH` / `API_RATE_LIMIT` have been in the `JobError` code union since the
 * job plane was built and were never actually thrown; a rejected key surfaced as
 * `SIDECAR_CRASH` with a raw body attached. Both are far more actionable named.
 */
export function describeProviderFailure(
  err: unknown,
  args: { provider: AIProvider; model: string; baseUrl?: string; apiKey?: string | null }
): ProviderFailure {
  const raw = err instanceof Error ? err.message : String(err)
  const message = humanTransportError(err, args.provider, args.model, args.baseUrl, args.apiKey)
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key/i.test(raw)) {
    // A rejected key will be rejected identically on retry.
    return { code: 'API_AUTH', message, retriable: false }
  }
  if (/\b429\b|rate[_ ]?limit|quota|insufficient[_ ]?quota|billing/i.test(raw)) {
    return { code: 'API_RATE_LIMIT', message, retriable: true }
  }
  return { code: 'SIDECAR_CRASH', message, retriable: true }
}
