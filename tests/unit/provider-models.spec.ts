/**
 * tests/unit/provider-models.spec.ts — live model catalogues for the providers
 * that previously returned an empty list (FEAT-6v92dk).
 *
 * The picker existed only for OpenRouter, so a user on OpenAI/Anthropic/Ollama
 * had to type a model id from memory into a free-text box. Fetching each
 * provider's own `/models` endpoint is also what keeps the app from shipping a
 * hardcoded catalogue that rots (BUG-2smqpv). The HTTP call is injected, so no
 * network runs here.
 */

import { describe, expect, it } from 'vitest'
import { fetchProviderModels } from '@main/services/provider-models'

describe('fetchProviderModels: OpenAI', () => {
  it('maps /v1/models into ModelInfo and drops non-chat entries', async () => {
    const fetcher = async (): Promise<unknown> => ({
      data: [
        { id: 'gpt-5', object: 'model' },
        { id: 'text-embedding-3-large', object: 'model' },
        { id: 'whisper-1', object: 'model' },
        { id: 'dall-e-3', object: 'model' },
        { id: 'gpt-5-mini', object: 'model' }
      ]
    })
    const models = await fetchProviderModels({ provider: 'openai', apiKey: 'k', fetcher })
    const ids = models.map((m) => m.id)
    expect(ids).toContain('gpt-5')
    expect(ids).toContain('gpt-5-mini')
    // Embedding / audio / image models cannot do clip detection — offering them
    // in the picker is the same dead end as an empty box.
    expect(ids).not.toContain('text-embedding-3-large')
    expect(ids).not.toContain('whisper-1')
    expect(ids).not.toContain('dall-e-3')
  })

  it('does not drop new model families the way a prefix allow-list would', async () => {
    // `startsWith('gpt'|'o1'|'o3')` silently hid o4-mini and chatgpt-4o-latest,
    // and would hide every future family — the same rot the hardcoded catalogue
    // had. Exclude what is definitely not a chat model instead.
    const fetcher = async (): Promise<unknown> => ({
      data: [
        { id: 'o4-mini' },
        { id: 'chatgpt-4o-latest' },
        { id: 'gpt-6-turbo' },
        { id: 'text-embedding-4' },
        { id: 'tts-2' }
      ]
    })
    const ids = (await fetchProviderModels({ provider: 'openai', apiKey: 'k', fetcher })).map(
      (m) => m.id
    )
    expect(ids).toEqual(expect.arrayContaining(['o4-mini', 'chatgpt-4o-latest', 'gpt-6-turbo']))
    expect(ids).not.toContain('text-embedding-4')
    expect(ids).not.toContain('tts-2')
  })

  it('requires a key and says so rather than calling with none', async () => {
    let called = false
    const fetcher = async (): Promise<unknown> => {
      called = true
      return { data: [] }
    }
    await expect(
      fetchProviderModels({ provider: 'openai', apiKey: null, fetcher })
    ).rejects.toThrow(/api key/i)
    expect(called).toBe(false)
  })
})

describe('fetchProviderModels: Anthropic', () => {
  it('maps /v1/models, preserving display names', async () => {
    const fetcher = async (): Promise<unknown> => ({
      data: [
        { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }
      ]
    })
    const models = await fetchProviderModels({ provider: 'anthropic', apiKey: 'k', fetcher })
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
    expect(models[0].name).toBe('Claude Opus 5')
    // Every Claude model in the catalogue can do structured output, which is
    // what clip detection needs.
    expect(models.every((m) => m.supportsStructured)).toBe(true)
  })
})

describe('fetchProviderModels: Ollama', () => {
  it('maps /api/tags and needs no key (it is a local daemon)', async () => {
    const fetcher = async (): Promise<unknown> => ({
      models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:14b' }]
    })
    const models = await fetchProviderModels({ provider: 'ollama', apiKey: null, fetcher })
    expect(models.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5:14b'])
  })

  it('surfaces a daemon-not-running failure as human copy', async () => {
    const fetcher = async (): Promise<unknown> => {
      throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434')
    }
    await expect(
      fetchProviderModels({ provider: 'ollama', apiKey: null, fetcher })
    ).rejects.toThrow(/ollama serve/i)
  })
})

describe('fetchProviderModels: unsupported provider', () => {
  it('returns an empty catalogue rather than throwing', async () => {
    // OpenRouter has its own richer path (pricing, curated pins); google is not
    // wired at all. Neither should break the picker.
    const models = await fetchProviderModels({
      provider: 'google',
      apiKey: 'k',
      fetcher: async () => ({})
    })
    expect(models).toEqual([])
  })
})

// ── The custom OpenAI-compatible endpoint (FEAT-bysdwg) ──────────────────────

describe('fetchProviderModels: custom endpoint', () => {
  const catalogue = async (): Promise<unknown> => ({
    data: [
      { id: 'qwen2.5-coder-32b-instruct' },
      { id: 'llama-3.3-70b' },
      { id: 'mistral-7b-instruct' }
    ]
  })

  it('lists what the server offers, in id order', async () => {
    const models = await fetchProviderModels({
      provider: 'custom',
      apiKey: null,
      baseUrl: 'http://localhost:1234/v1',
      fetcher: catalogue
    })
    expect(models.map((m) => m.id)).toEqual([
      'llama-3.3-70b',
      'mistral-7b-instruct',
      'qwen2.5-coder-32b-instruct'
    ])
  })

  it('does NOT apply the OpenAI non-chat filter', async () => {
    // `NON_CHAT_FRAGMENTS` contains 'instruct', which is most of the local-model
    // naming convention. Copy-pasting the OpenAI branch here would hide almost
    // everything an LM Studio user has downloaded.
    const models = await fetchProviderModels({
      provider: 'custom',
      apiKey: null,
      baseUrl: 'http://localhost:1234/v1',
      fetcher: catalogue
    })
    expect(models.map((m) => m.id)).toContain('mistral-7b-instruct')
    expect(models.map((m) => m.id)).toContain('qwen2.5-coder-32b-instruct')
  })

  it('joins the URL off the normalized base and omits auth when there is no key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    await fetchProviderModels({
      provider: 'custom',
      apiKey: null,
      baseUrl: 'http://localhost:1234/v1/',
      fetcher: async (args) => {
        seen.push(args)
        return { data: [] }
      }
    })
    expect(seen[0].url).toBe('http://localhost:1234/v1/models')
    // An empty Bearer is a 401 on several local servers — send no header at all.
    expect(seen[0].headers).toEqual({})
  })

  it('sends a Bearer token when a key is saved', async () => {
    const seen: Array<{ headers: Record<string, string> }> = []
    await fetchProviderModels({
      provider: 'custom',
      apiKey: 'sk-local-abc',
      baseUrl: 'http://localhost:1234/v1',
      fetcher: async (args) => {
        seen.push(args)
        return { data: [] }
      }
    })
    expect(seen[0].headers.Authorization).toBe('Bearer sk-local-abc')
  })

  it('accepts the `models[]` shape some gateways answer with', async () => {
    const models = await fetchProviderModels({
      provider: 'custom',
      apiKey: null,
      baseUrl: 'http://localhost:1234/v1',
      fetcher: async () => ({ models: [{ id: 'gemma-3-27b' }] })
    })
    expect(models.map((m) => m.id)).toEqual(['gemma-3-27b'])
  })

  it('returns [] rather than throwing when the body is a 200 of the wrong shape', async () => {
    // Discovery is a convenience over the free-text field; an unexpected but
    // successful body must not read as an error.
    const models = await fetchProviderModels({
      provider: 'custom',
      apiKey: null,
      baseUrl: 'http://localhost:1234/v1',
      fetcher: async () => ({ object: 'list' })
    })
    expect(models).toEqual([])
  })

  it('asks for a Base URL instead of guessing one', async () => {
    await expect(
      fetchProviderModels({ provider: 'custom', apiKey: null, fetcher: async () => ({}) })
    ).rejects.toThrow(/Base URL/i)
  })

  it('suggests /v1 on a 404 when the base does not already end in it', async () => {
    const fetcher = async (): Promise<unknown> => {
      throw new Error('model list failed: HTTP 404')
    }
    await expect(
      fetchProviderModels({
        provider: 'custom',
        apiKey: null,
        baseUrl: 'http://localhost:1234',
        fetcher
      })
    ).rejects.toThrow(/try http:\/\/localhost:1234\/v1/i)
  })

  it('tells the user to type an id when /v1/models itself 404s', async () => {
    const fetcher = async (): Promise<unknown> => {
      throw new Error('model list failed: HTTP 404')
    }
    await expect(
      fetchProviderModels({
        provider: 'custom',
        apiKey: null,
        baseUrl: 'http://localhost:1234/v1',
        fetcher
      })
    ).rejects.toThrow(/type a model id/i)
  })

  it('names the host — not "check your internet" — when the server is down', async () => {
    const fetcher = async (): Promise<unknown> => {
      throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:1234')
    }
    await expect(
      fetchProviderModels({
        provider: 'custom',
        apiKey: null,
        baseUrl: 'http://localhost:1234/v1',
        fetcher
      })
    ).rejects.toThrow(/localhost:1234/)
  })
})
