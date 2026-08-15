/**
 * src/shared/ai-providers.ts — per-provider facts that BOTH processes need
 * (FEAT-bysdwg).
 *
 * WHY THIS EXISTS. Two rules about providers were hand-copied across the app:
 * "does it need a BYOK key" lived as `provider !== 'ollama'` in THREE places
 * (`ipc/ai.ts` key gate, `readinessView.needsKey`, `SettingsPanel`'s catalogue
 * auto-fetch), and the display name lived only in the renderer while `ipc/ai.ts`
 * interpolated the raw enum id into user-facing error copy. Adding a fifth
 * provider meant editing three copies of one rule and shipping the sentence
 * "custom rejected the test request".
 *
 * `PROVIDER_LABELS` is a TOTAL Record on purpose: a new enum member must not
 * compile until it has a name.
 */

import type { AIProvider, Settings } from './schema'
import { endpointFingerprint, safeHost } from './endpoint-url'

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama (local)',
  openrouter: 'OpenRouter',
  custom: 'Custom (OpenAI-compatible)'
}

export function providerLabel(provider: AIProvider): string {
  return PROVIDER_LABELS[provider]
}

/**
 * How to NAME the provider inside an error sentence.
 *
 * For the four fixed providers this is just the brand. For `custom` the brand
 * tells the user nothing — they may have several servers — so name the host they
 * configured. HOST ONLY: these strings are rendered in the UI, and a full URL can
 * carry a path or query the user would not expect to see quoted back.
 */
export function providerDisplay(provider: AIProvider, baseUrl?: string): string {
  if (provider !== 'custom') return PROVIDER_LABELS[provider]
  const host = safeHost(baseUrl)
  return host ? `your endpoint at ${host}` : 'your custom endpoint'
}

/**
 * Does this provider REQUIRE a BYOK key before we should attempt a call?
 *
 * Ollama runs on this machine. A custom endpoint may equally be LM Studio on
 * localhost — a key is optional there, and demanding one made the Generate
 * button unreachable for exactly the users this provider is for.
 */
export function providerRequiresKey(provider: AIProvider): boolean {
  return provider !== 'ollama' && provider !== 'custom'
}

/** Does the user have to supply the endpoint, because we have no default for it? */
export function providerNeedsBaseUrl(provider: AIProvider): boolean {
  return provider === 'custom'
}

/**
 * Is the stored `custom` key still the one the user entered FOR the endpoint now
 * configured? (FEAT-bysdwg)
 *
 * The key vault is keyed by provider id alone, so without this a key pasted for a
 * corporate gateway would be sent as a Bearer token to whatever base URL is typed
 * next. Fail-closed (treat the key as absent) rather than destructive (delete
 * it): someone fixing a typo in the URL must not lose the key they just pasted.
 * Compared on ORIGIN, so adding or removing `/v1` keeps the binding.
 */
export function customKeyMatchesEndpoint(settings: Settings): boolean {
  return endpointFingerprint(settings.baseUrl) === (settings.customKeyEndpoint ?? '')
}
