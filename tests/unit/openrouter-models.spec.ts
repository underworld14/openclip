/**
 * tests/unit/openrouter-models.spec.ts — the OpenRouter model service (Part H):
 * structured-output detection, raw→ModelInfo mapping, recommended-first ordering
 * (curated pins → remaining structured, name-sorted; non-structured dropped), the
 * TTL cache, and the default fetcher's URL + auth header. No network (fetch + the
 * fetcher seam are injected/mocked).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  supportsStructured,
  mapRawToModelInfo,
  orderForPicker,
  fetchOpenRouterModels,
  ModelListCache,
  createDefaultFetcher,
  type OpenRouterRawModel
} from '@main/services/openrouter-models'

const raw = (over: Partial<OpenRouterRawModel> & { id: string }): OpenRouterRawModel => ({
  supported_parameters: ['structured_outputs'],
  ...over
})

describe('supportsStructured', () => {
  it('is true for structured_outputs or response_format, false otherwise', () => {
    expect(supportsStructured(raw({ id: 'a', supported_parameters: ['structured_outputs'] }))).toBe(
      true
    )
    expect(supportsStructured(raw({ id: 'b', supported_parameters: ['response_format'] }))).toBe(
      true
    )
    expect(supportsStructured(raw({ id: 'c', supported_parameters: ['tools'] }))).toBe(false)
    expect(supportsStructured(raw({ id: 'd', supported_parameters: [] }))).toBe(false)
  })
})

describe('mapRawToModelInfo', () => {
  it('maps fields + parses per-token pricing → USD per 1M', () => {
    const m = mapRawToModelInfo(
      raw({
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        description: 'desc'
      })
    )
    expect(m).toMatchObject({
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      contextLength: 200000,
      supportsStructured: true,
      recommended: false,
      description: 'desc'
    })
    expect(m.pricePerMTokIn).toBeCloseTo(3)
    expect(m.pricePerMTokOut).toBeCloseTo(15)
  })
  it('falls back name=id; free (0) → 0, empty/unknown → undefined', () => {
    const m = mapRawToModelInfo(raw({ id: 'x/y', pricing: { prompt: '0', completion: '' } }))
    expect(m.name).toBe('x/y')
    expect(m.pricePerMTokIn).toBe(0) // free passes through as 0 → renders "Free"
    expect(m.pricePerMTokOut).toBeUndefined() // empty/unknown
  })
})

describe('orderForPicker', () => {
  const list: OpenRouterRawModel[] = [
    raw({ id: 'z/plain-structured', name: 'Zeta' }),
    raw({ id: 'tools-only', name: 'Tools Only', supported_parameters: ['tools'] }),
    raw({ id: 'openai/gpt-5', name: 'GPT-5' }),
    raw({ id: 'a/another-structured', name: 'Alpha' }),
    raw({ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' })
  ]

  it('filters to structured-only, pins the curated shortlist in order, sorts the rest by name', () => {
    const out = orderForPicker(list, [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5',
      'missing/model'
    ])
    // tools-only (non-structured) is dropped entirely.
    expect(out.find((m) => m.id === 'tools-only')).toBeUndefined()
    // Curated pins first, in declared order, flagged recommended; missing slug skipped.
    expect(out.slice(0, 2).map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5'
    ])
    expect(out[0].recommended).toBe(true)
    expect(out[1].recommended).toBe(true)
    // Remaining structured models sorted by name (Alpha < Zeta), not recommended.
    expect(out.slice(2).map((m) => m.name)).toEqual(['Alpha', 'Zeta'])
    expect(out.slice(2).every((m) => !m.recommended)).toBe(true)
  })
})

describe('fetchOpenRouterModels', () => {
  it('uses the injected fetcher and returns recommended-first ModelInfo[]', async () => {
    const fetcher = vi.fn(async () => [
      raw({ id: 'openai/gpt-5', name: 'GPT-5' }),
      raw({ id: 'b/other', name: 'Other' })
    ])
    const out = await fetchOpenRouterModels({ apiKey: 'k', fetcher, recommended: ['openai/gpt-5'] })
    expect(fetcher).toHaveBeenCalledWith({ apiKey: 'k' })
    expect(out[0].id).toBe('openai/gpt-5')
    expect(out[0].recommended).toBe(true)
  })
})

describe('ModelListCache', () => {
  it('returns a fresh entry within TTL and null once expired', () => {
    let now = 1000
    const cache = new ModelListCache(500, () => now)
    expect(cache.get()).toBeNull()
    cache.set([])
    expect(cache.get()).not.toBeNull()
    now = 1499
    expect(cache.get()).not.toBeNull()
    now = 1501
    expect(cache.get()).toBeNull()
  })
})

describe('createDefaultFetcher', () => {
  afterEach(() => vi.unstubAllGlobals())

  type FetchArgs = [string, { headers?: Record<string, string> }?]

  it('GETs the OpenRouter /models URL with a Bearer header when a key is present', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [raw({ id: 'a' })] })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await createDefaultFetcher()({ apiKey: 'secret-key' })
    expect(data).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as FetchArgs
    expect(url).toBe('https://openrouter.ai/api/v1/models')
    expect(init?.headers?.Authorization).toBe('Bearer secret-key')
  })

  it('omits the Authorization header when no key (public list)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await createDefaultFetcher()({ apiKey: null })
    const [, init] = fetchMock.mock.calls[0] as unknown as FetchArgs
    expect(init?.headers?.Authorization).toBeUndefined()
  })

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }))
    )
    await expect(createDefaultFetcher()({ apiKey: null })).rejects.toThrow(/HTTP 429/)
  })
})
