/**
 * openrouter-models — fetch + shape OpenRouter's model catalog for the model
 * picker (Part H). Pure-ish + injectable (the network call is a `ModelsFetcher`
 * seam) so the mapping/ordering/cache logic is unit-testable with no network.
 *
 * Policy (locked):
 *   - The picker only lists STRUCTURED-OUTPUT-capable models (clip detection needs
 *     strict JSON). A user can still type any model id by hand in the UI.
 *   - Ordering is recommended-first: a curated shortlist (RECOMMENDED_*) pinned in
 *     order (only when present in the live list), then the remaining structured
 *     models sorted by name.
 */

import { OPENROUTER_BASE_URL } from './ai-client'
import type { ModelInfo } from '@shared/channels'

/**
 * Curated, recommended OpenRouter models for clip detection — the single update
 * point. All are strong + structured-output-capable. Stale slugs degrade
 * gracefully (only pinned when present in the live list). Verify/refresh against
 * https://openrouter.ai/models as the catalog evolves.
 */
export const RECOMMENDED_OPENROUTER_MODELS: readonly string[] = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.1',
  'openai/gpt-5',
  'openai/gpt-4.1',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat-v3.1',
  'meta-llama/llama-4-maverick'
] as const

/** Raw shape of an OpenRouter `/models` entry (the subset we read). */
export interface OpenRouterRawModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
}

/** Injectable network seam — returns the raw `data[]` from `/api/v1/models`. */
export type ModelsFetcher = (args: { apiKey: string | null }) => Promise<OpenRouterRawModel[]>

/**
 * True if the model can produce JSON output we can consume — either strict
 * `structured_outputs` (json_schema strict, the ideal) OR basic `response_format`
 * (JSON mode). The transport always requests strict json_schema; a
 * response_format-only model may downgrade to JSON mode, and the Zod repair
 * ladder recovers it. We include both so the picker isn't needlessly sparse;
 * clip detection still works for both via the repair ladder.
 */
export function supportsStructured(raw: OpenRouterRawModel): boolean {
  const params = raw.supported_parameters ?? []
  return params.includes('structured_outputs') || params.includes('response_format')
}

/**
 * Parse a per-token USD price string → USD per 1M tokens. `undefined` when the
 * price is unknown (missing/empty/NaN/negative); a finite 0 passes through as 0
 * so free models render as "Free" rather than blank.
 */
function pricePerMTok(perToken: string | undefined): number | undefined {
  if (!perToken) return undefined
  const n = Number(perToken)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n * 1_000_000
}

/** Map a raw OpenRouter model → the picker's `ModelInfo` (recommended set later). */
export function mapRawToModelInfo(raw: OpenRouterRawModel): ModelInfo {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    contextLength: raw.context_length,
    pricePerMTokIn: pricePerMTok(raw.pricing?.prompt),
    pricePerMTokOut: pricePerMTok(raw.pricing?.completion),
    supportsStructured: supportsStructured(raw),
    recommended: false,
    description: raw.description
  }
}

/**
 * Filter to structured-capable models, then order recommended-first: the curated
 * shortlist in its declared order (pinned, only when present), then the remaining
 * structured models sorted by display name. Stamps `recommended` on the pins.
 */
export function orderForPicker(
  raw: OpenRouterRawModel[],
  recommended: readonly string[] = RECOMMENDED_OPENROUTER_MODELS
): ModelInfo[] {
  const structured = raw.filter(supportsStructured).map(mapRawToModelInfo)
  const byId = new Map(structured.map((m) => [m.id, m]))
  const pinned: ModelInfo[] = []
  const pinnedIds = new Set<string>()
  for (const id of recommended) {
    const m = byId.get(id)
    if (m && !pinnedIds.has(id)) {
      pinned.push({ ...m, recommended: true })
      pinnedIds.add(id)
    }
  }
  const rest = structured
    .filter((m) => !pinnedIds.has(m.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...pinned, ...rest]
}

/** Default fetcher: GET OpenRouter's public `/models` (Bearer key when present). */
export function createDefaultFetcher(): ModelsFetcher {
  return async ({ apiKey }) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers })
    if (!res.ok) {
      throw new Error(`OpenRouter model list failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { data?: OpenRouterRawModel[] }
    return body.data ?? []
  }
}

/** Fetch + shape the OpenRouter model list (recommended-first, structured-only). */
export async function fetchOpenRouterModels(args: {
  apiKey: string | null
  fetcher?: ModelsFetcher
  recommended?: readonly string[]
}): Promise<ModelInfo[]> {
  const fetcher = args.fetcher ?? createDefaultFetcher()
  const raw = await fetcher({ apiKey: args.apiKey })
  return orderForPicker(raw, args.recommended ?? RECOMMENDED_OPENROUTER_MODELS)
}

/** In-memory per-provider model-list cache with a short TTL (injectable clock). */
export class ModelListCache {
  private entry: { models: ModelInfo[]; fetchedAt: number } | null = null
  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(): { models: ModelInfo[]; fetchedAt: number } | null {
    if (!this.entry) return null
    if (this.now() - this.entry.fetchedAt > this.ttlMs) return null
    return this.entry
  }

  set(models: ModelInfo[]): { models: ModelInfo[]; fetchedAt: number } {
    this.entry = { models, fetchedAt: this.now() }
    return this.entry
  }
}
