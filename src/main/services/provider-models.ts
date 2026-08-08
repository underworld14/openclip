/**
 * src/main/services/provider-models.ts — live model catalogues for OpenAI,
 * Anthropic and Ollama (audit fix FEAT-6v92dk).
 *
 * WHY LIVE, NOT A TABLE. The picker previously existed only for OpenRouter, so
 * every other provider fell back to a free-text box and `DEFAULT_SETTINGS.model`
 * of `''` — a user who pasted a perfectly good API key still failed until they
 * typed an id from memory. The obvious fix is a hardcoded list per provider, and
 * that is exactly what already rotted once: the curated OpenRouter pins shipped a
 * retired model as the app's own top recommendation (BUG-2smqpv). So each
 * provider's own `/models` endpoint is the source of truth, and the only static
 * data left is a single seed id in `settingsView.DEFAULT_MODEL_BY_PROVIDER`.
 *
 * OpenRouter keeps its richer path in `openrouter-models.ts` (pricing, curated
 * ordering); this module covers the three that had nothing.
 *
 * The HTTP call is injected so no network runs in tests (PRD §18).
 */

import type { ModelInfo } from '@shared/channels'
import type { AIProvider } from '@shared/schema'

/** Injected HTTP seam: returns the parsed JSON body of the catalogue endpoint. */
export type CatalogueFetcher = (args: {
  url: string
  headers: Record<string, string>
}) => Promise<unknown>

export interface FetchProviderModelsArgs {
  provider: AIProvider
  apiKey: string | null
  fetcher?: CatalogueFetcher
  /** Ollama daemon base URL (defaults to the standard local port). */
  ollamaBaseUrl?: string
}

const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

/**
 * OpenAI's `/v1/models` returns embeddings, speech, image and moderation models
 * alongside chat ones. Offering `text-embedding-3-large` in a clip-detection
 * picker is the same dead end as an empty field, so filter to chat-capable ids.
 *
 * Matching by id prefix rather than a fixed allow-list keeps new releases
 * visible the day they ship — the whole point of fetching live.
 */
function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  const excluded = [
    'embedding',
    'whisper',
    'tts',
    'dall-e',
    'moderation',
    'audio',
    'realtime',
    'image',
    'transcribe',
    'search',
    'codex'
  ]
  if (excluded.some((frag) => lower.includes(frag))) return false
  return lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')
}

function defaultFetcher(): CatalogueFetcher {
  return async ({ url, headers }) => {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } })
    if (!res.ok) throw new Error(`model list failed: HTTP ${res.status}`)
    return res.json()
  }
}

/**
 * Fetch a provider's model catalogue, shaped for the picker.
 *
 * Unsupported providers return `[]` rather than throwing: OpenRouter has its own
 * path and Google is not wired, and neither should break a picker that is only
 * ever a convenience over the free-text field.
 */
export async function fetchProviderModels(args: FetchProviderModelsArgs): Promise<ModelInfo[]> {
  const fetcher = args.fetcher ?? defaultFetcher()

  if (args.provider === 'openai') {
    if (!args.apiKey) throw new Error('An OpenAI API key is required to list models.')
    const body = (await fetcher({
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${args.apiKey}` }
    })) as { data?: Array<{ id?: string }> }
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && isOpenAiChatModel(id))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id, name: id, supportsStructured: true, recommended: false }))
  }

  if (args.provider === 'anthropic') {
    if (!args.apiKey) throw new Error('An Anthropic API key is required to list models.')
    const body = (await fetcher({
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': args.apiKey, 'anthropic-version': '2023-06-01' }
    })) as { data?: Array<{ id?: string; display_name?: string }> }
    return (body.data ?? [])
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        // Every model in Anthropic's catalogue supports the structured output
        // clip detection relies on.
        supportsStructured: true,
        recommended: false
      }))
  }

  if (args.provider === 'ollama') {
    const base = args.ollamaBaseUrl ?? OLLAMA_DEFAULT_URL
    let body: { models?: Array<{ name?: string }> }
    try {
      body = (await fetcher({ url: `${base}/api/tags`, headers: {} })) as {
        models?: Array<{ name?: string }>
      }
    } catch {
      // The daemon being down is the overwhelmingly common case here, and the
      // raw ECONNREFUSED tells a non-technical user nothing actionable.
      throw new Error('Could not reach Ollama on this machine. Is `ollama serve` running?')
    }
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({
        id: name,
        name,
        // Ollama enforces the JSON schema via grammar-constrained decoding, so
        // any pulled model can satisfy the clip schema.
        supportsStructured: true,
        recommended: false
      }))
  }

  return []
}
