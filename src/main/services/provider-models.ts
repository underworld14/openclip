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
import { normalizeBaseUrl, safeHost } from '@shared/endpoint-url'

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
  /**
   * The `custom` provider's OpenAI-compatible root (FEAT-bysdwg). Resolved
   * main-side from Settings — the SAME normalized string the transport uses, so
   * discovery and chat completions can never disagree about where the server is.
   */
  baseUrl?: string
}

const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

/**
 * OpenAI's `/v1/models` returns embeddings, speech, image and moderation models
 * alongside chat ones. Offering `text-embedding-3-large` in a clip-detection
 * picker is the same dead end as an empty field, so filter those out.
 *
 * EXCLUSION-only, deliberately. An earlier revision allow-listed
 * `startsWith('gpt'|'o1'|'o3')`, which silently hid `o4-mini` and
 * `chatgpt-4o-latest` and would hide every future family — a static table
 * wearing a different hat, and the exact rot this module exists to avoid. A
 * wrongly-included id is visible and recoverable (the user picks another, or
 * presses Test); a wrongly-excluded one is invisible.
 */
const NON_CHAT_FRAGMENTS = [
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
  'codex',
  'instruct'
]

function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  return !NON_CHAT_FRAGMENTS.some((frag) => lower.includes(frag))
}

/** A wedged server must not hang the handler (and the spinner) forever. */
const CATALOGUE_TIMEOUT_MS = 10_000

/**
 * A model list is a few KB. Anything near this is a wrong endpoint or a hostile
 * one. NOTE what this does and does not bound: a declared `Content-Length` is
 * rejected before the body is read, but a CHUNKED response is still buffered by
 * `res.text()` first — for that case the 10 s timeout above is the real bound.
 */
const CATALOGUE_MAX_BYTES = 2 * 1024 * 1024

function defaultFetcher(): CatalogueFetcher {
  return async ({ url, headers }) => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      // The base URL is user-supplied (FEAT-bysdwg): a redirect would re-issue
      // this request somewhere they never named, and a same-origin one keeps the
      // Authorization header. Refuse rather than follow.
      redirect: 'error',
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`model list failed: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > CATALOGUE_MAX_BYTES) {
      throw new Error(`model list failed: response too large (${declared} bytes)`)
    }
    const text = await res.text()
    if (text.length > CATALOGUE_MAX_BYTES) {
      throw new Error('model list failed: response too large')
    }
    return JSON.parse(text)
  }
}

/** HTTP status out of `defaultFetcher`'s flattened message, when there is one. */
function statusFrom(err: unknown): number | undefined {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /HTTP (\d{3})/.exec(raw)
  return match ? Number(match[1]) : undefined
}

/**
 * Turn a failed custom-endpoint catalogue fetch into advice.
 *
 * The 404 case is the one that matters: `/v1` is the single most common thing
 * missing from a pasted base URL. We SUGGEST it rather than retrying it, because
 * a silent retry would leave discovery working against one URL while chat
 * completions posted to another.
 */
export function customCatalogueError(err: unknown, base: string): string {
  const status = statusFrom(err)
  const host = safeHost(base) || base
  if (status === 404) {
    return base.endsWith('/v1')
      ? `No model list at ${base}/models (HTTP 404). This server may not support model discovery — type a model id above instead.`
      : `No model list at ${base}/models (HTTP 404). OpenAI-compatible servers usually expose /v1 — try ${base}/v1.`
  }
  if (status === 401 || status === 403) {
    return `${host} requires an API key, or rejected the one saved. Add or update it below.`
  }
  if (status !== undefined) {
    return `Model list failed: HTTP ${status}. You can still type a model id above.`
  }
  return `Could not reach ${host}. Is the server running, and is the Base URL right?`
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

  if (args.provider === 'custom') {
    const base = normalizeBaseUrl(args.baseUrl)
    if (!base) {
      throw new Error('Set a Base URL for your custom endpoint first, then press Load models.')
    }
    // `unknown`, not a hopeful shape: the response is whatever a user-supplied
    // URL returned, and typing it as the shape we want is what turns a wrong URL
    // into a TypeError instead of an empty list.
    let body: { data?: unknown; models?: unknown } | null
    try {
      body = (await fetcher({
        url: `${base}/models`,
        // Omit the header entirely when there is no key: LM Studio and vLLM
        // commonly run open, and an empty Bearer is a 401 on some of them.
        headers: args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}
      })) as typeof body
    } catch (e) {
      throw new Error(customCatalogueError(e, base))
    }
    // `data[]` is the OpenAI shape; a few gateways answer `models[]` instead.
    //
    // Every access is guarded because this body is whatever a user-supplied URL
    // returned: a 200 from a reverse proxy, a health endpoint or a captive portal
    // is one typo away, and `null`, `{data:{}}` or `{models:'nope'}` would each
    // throw a raw TypeError that the renderer then shows as the model-list error.
    // An unrecognised 200 is "no models", not a failure.
    const rows: unknown[] = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : []
    return rows
      .map((row) => {
        // Per-ENTRY guard, not just per-array: a `null` element is enough to
        // throw, and one bad row must not cost the user the whole list.
        const m = (row ?? {}) as { id?: unknown; name?: unknown }
        return typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : undefined
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        id,
        name: id,
        // Deliberately NOT filtered through `isOpenAiChatModel`: its exclusion
        // list contains 'instruct', which would hide qwen2.5-coder-32b-instruct,
        // mistral-7b-instruct — essentially the whole local-model naming
        // convention. That filter exists for OpenAI's 100-entry catalogue of
        // embeddings and TTS; a self-hosted server serves a handful of models and
        // showing all of them is strictly better.
        //
        // `supportsStructured: false` because we genuinely do not know — the
        // transport's downgrade ladder finds out, and Test connection reports it.
        supportsStructured: false,
        recommended: false
      }))
  }

  return []
}
