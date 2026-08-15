/**
 * tests/unit/ai-ipc.spec.ts — the AI + settings IPC handlers (T-AI, plan E.3).
 *
 * Critical invariant (PRD §12.2 / plan Part B): the raw API key NEVER crosses
 * IPC. ipc/settings.ts owns set-api-key + api-key-status and returns ONLY
 * {provider, hasKey, last4}. We assert no key material appears in any
 * renderer-facing response.
 *
 * Handlers register against a FAKE ipcMain (records handlers by channel) and a
 * FAKE IpcContext (real KeyVault with a fake safeStorage). The AI generate
 * handler is wired with an INJECTED transport factory so no provider is hit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcContext } from '@main/ipc/index'
import { registerSettingsHandlers } from '@main/ipc/settings'
import {
  registerAiHandlers,
  __setTransportFactoryForTests,
  __setModelsFetcherForTests,
  __setProviderCatalogueFetcherForTests
} from '@main/ipc/ai'
import { KeyVault, type SafeStorageLike, type SecretStoreBackend } from '@main/utils/security'
import { IPCChannels } from '@shared/channels'
import type { ChannelMap, ChannelReq, ChannelRes } from '@shared/channels'
import type { RawTransport } from '@main/services/ai-client'
import type { Settings } from '@shared/schema'
import { clipSchemaFixture, settingsFixture, transcriptSegmentsFixture } from '../fixtures/contract'
import { RECOMMENDED_OPENROUTER_MODELS } from '@main/services/openrouter-models'

/** The first curated OpenRouter pin, read from the source of truth. */
const CURATED_TOP = RECOMMENDED_OPENROUTER_MODELS[0]

// ── Fakes ─────────────────────────────────────────────────────────────────────
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (cipher) => cipher.toString().replace(/^enc:/, '')
  }
}
function memBackend(): SecretStoreBackend {
  let store: Record<string, string> = {}
  return { read: () => ({ ...store }), write: (m) => void (store = { ...m }) }
}

type Handler = (event: unknown, req: unknown) => Promise<unknown>

function makeCtx(settingsPatch: Partial<Settings> = {}): {
  ctx: IpcContext
  handlers: Map<string, Handler>
  vault: KeyVault
  settings: Settings
} {
  const handlers = new Map<string, Handler>()
  const vault = new KeyVault(fakeSafe(), memBackend())
  // The ENDPOINT is resolved main-side from Settings, exactly as the key is
  // resolved from the vault (FEAT-bysdwg) — so the fake ctx has to supply one.
  const settings: Settings = { ...settingsFixture, ...settingsPatch }
  const ctx = {
    ipcMain: {
      handle: (channel: string, h: Handler) => handlers.set(channel, h)
    },
    getMainWindow: () => null,
    sidecar: {} as never,
    keyVault: vault,
    getSettings: () => settings
  } as unknown as IpcContext
  return { ctx, handlers, vault, settings }
}

async function call<C extends keyof ChannelMap>(
  handlers: Map<string, Handler>,
  channel: C,
  req: ChannelReq<C>
): Promise<ChannelRes<C>> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler for ${channel}`)
  return (await h({}, req)) as ChannelRes<C>
}

describe('settings handlers: key never crosses IPC (PRD §12.2)', () => {
  it('SET_API_KEY persists and returns ONLY {provider,hasKey,last4}', async () => {
    const { ctx, handlers, vault } = makeCtx()
    registerSettingsHandlers(ctx)

    const res = await call(handlers, IPCChannels.SET_API_KEY, {
      provider: 'openai',
      key: 'sk-secret-ABCD1234'
    })
    expect(res).toEqual({ provider: 'openai', hasKey: true, last4: '1234' })
    // No raw key in the renderer-facing response.
    expect(JSON.stringify(res)).not.toContain('sk-secret')
    // But the vault DID store it (main-side decrypt works).
    expect(vault.getKey('openai')).toBe('sk-secret-ABCD1234')
  })

  it('GET_API_KEY_STATUS returns status with no key material', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('anthropic', 'my-anthropic-key-WXYZ')
    registerSettingsHandlers(ctx)

    const res = await call(handlers, IPCChannels.GET_API_KEY_STATUS, { provider: 'anthropic' })
    expect(res.hasKey).toBe(true)
    expect(res.last4).toBe('WXYZ')
    expect(JSON.stringify(res)).not.toContain('my-anthropic-key')
  })

  it('reports hasKey:false for an unset provider', async () => {
    const { ctx, handlers } = makeCtx()
    registerSettingsHandlers(ctx)
    const res = await call(handlers, IPCChannels.GET_API_KEY_STATUS, { provider: 'google' })
    expect(res).toEqual({ provider: 'google', hasKey: false })
  })
})

describe('ai handler: GENERATE_CLIPS (transport injected — no network)', () => {
  it('decrypts the key main-side, generates, and returns a valid ClipSchema', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'sk-live-9999')

    // Inject a transport factory that records the key it received and returns
    // a canned valid ClipSchema. This proves the key is used MAIN-SIDE only.
    let keyGivenToTransport: string | null = null
    const factory = vi.fn(
      (args: { provider: string; model: string; apiKey: string | null }): RawTransport => {
        keyGivenToTransport = args.apiKey
        return async () => ({ rawText: JSON.stringify(clipSchemaFixture) })
      }
    )
    __setTransportFactoryForTests(factory)
    registerAiHandlers(ctx)

    const res = await call(handlers, IPCChannels.GENERATE_CLIPS, {
      projectId: 'p1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      segments: transcriptSegmentsFixture,
      videoTitle: 'Demo',
      durationSeconds: 240,
      clipStyle: 'all',
      numClips: 5,
      targetPlatform: 'tiktok'
    })

    expect(res.clips.length).toBeGreaterThan(0)
    expect(res.analysis.overall_virality_potential).toBe('high')
    // The transport got the decrypted key main-side.
    expect(keyGivenToTransport).toBe('sk-live-9999')
    // The renderer response carries no key material.
    expect(JSON.stringify(res)).not.toContain('sk-live')

    __setTransportFactoryForTests(null)
  })

  it('clamps an out-of-range numClips to 1..50 at the boundary (audit fix openclip-9hc)', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'sk-live-9999')
    let promptSeen = ''
    const factory = vi.fn(
      (): RawTransport => async (p) => {
        promptSeen = p.user
        return { rawText: JSON.stringify(clipSchemaFixture) }
      }
    )
    __setTransportFactoryForTests(factory)
    registerAiHandlers(ctx)

    await call(handlers, IPCChannels.GENERATE_CLIPS, {
      projectId: 'p1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      segments: transcriptSegmentsFixture,
      videoTitle: 'Demo',
      durationSeconds: 240,
      clipStyle: 'all',
      numClips: 10000, // absurd → must be clamped to 50
      targetPlatform: 'tiktok'
    })
    // The prompt the model sees reflects the clamped count, not 10000.
    expect(promptSeen).toContain('NUMBER OF CLIPS REQUESTED: 50')
    expect(promptSeen).not.toContain('10000')
    __setTransportFactoryForTests(null)
  })

  it('honours project min/maxDuration in the prompt when supplied (audit fix openclip-t0v)', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'sk-live-9999')
    let promptSeen = ''
    const factory = vi.fn(
      (): RawTransport => async (p) => {
        promptSeen = p.user
        return { rawText: JSON.stringify(clipSchemaFixture) }
      }
    )
    __setTransportFactoryForTests(factory)
    registerAiHandlers(ctx)

    await call(handlers, IPCChannels.GENERATE_CLIPS, {
      projectId: 'p1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      segments: transcriptSegmentsFixture,
      videoTitle: 'Demo',
      durationSeconds: 240,
      clipStyle: 'all',
      numClips: 5,
      targetPlatform: 'tiktok',
      minDuration: 30,
      maxDuration: 120
    })
    expect(promptSeen).toContain('between 30 and 120 seconds') // not the old 15/90
    __setTransportFactoryForTests(null)
  })

  it('throws a typed error when the provider returns unrepairable JSON', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('ollama', 'unused')
    __setTransportFactoryForTests(() => async () => ({ rawText: 'not json' }))
    registerAiHandlers(ctx)

    await expect(
      call(handlers, IPCChannels.GENERATE_CLIPS, {
        projectId: 'p1',
        provider: 'ollama',
        model: 'llama3.1',
        segments: transcriptSegmentsFixture,
        videoTitle: 'Demo',
        durationSeconds: 240,
        clipStyle: 'all',
        numClips: 5,
        targetPlatform: 'tiktok'
      })
    ).rejects.toThrow(/INPUT_INVALID/)

    __setTransportFactoryForTests(null)
  })
})

describe('ai handler: ENHANCE_CAPTIONS emoji map (Part K — transport injected)', () => {
  it('mode:"emoji" decrypts the emoji-provider key main-side and returns a normalized map', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('ollama', 'emoji-key-7777')
    let keyGivenToTransport: string | null = null
    __setTransportFactoryForTests((args) => {
      keyGivenToTransport = args.apiKey
      return async () => ({ rawText: '{"Money":"💰","fire":"🔥"}' })
    })
    registerAiHandlers(ctx)

    const res = await call(handlers, IPCChannels.ENHANCE_CAPTIONS, {
      provider: 'ollama',
      model: 'llama3.2',
      transcript: '',
      mode: 'emoji',
      words: ['money', 'fire', 'the']
    })
    expect(res.emoji_map).toEqual({ money: '💰', fire: '🔥' })
    expect(res.enhanced_captions).toEqual([])
    expect(keyGivenToTransport).toBe('emoji-key-7777')
    expect(JSON.stringify(res)).not.toContain('emoji-key')

    __setTransportFactoryForTests(null)
  })

  it('a non-emoji request rejects as unimplemented and never builds a transport', async () => {
    // Was `{enhanced_captions: []}` — a successful empty payload a caller cannot
    // distinguish from "no captions needed". Now a typed rejection (FEAT-et1gxc).
    const { ctx, handlers } = makeCtx()
    const factory = vi.fn(() => async () => ({ rawText: '{}' }))
    __setTransportFactoryForTests(factory)
    registerAiHandlers(ctx)

    await expect(
      call(handlers, IPCChannels.ENHANCE_CAPTIONS, {
        provider: 'openai',
        model: 'gpt-4o-mini',
        transcript: 'hello world'
      })
    ).rejects.toThrow(/NOT_IMPLEMENTED/)
    expect(factory).not.toHaveBeenCalled()

    __setTransportFactoryForTests(null)
  })

  it('degrades to an empty map when the transport throws (never blocks export)', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'k')
    __setTransportFactoryForTests(() => async () => {
      throw new Error('provider down')
    })
    registerAiHandlers(ctx)

    const res = await call(handlers, IPCChannels.ENHANCE_CAPTIONS, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      transcript: '',
      mode: 'emoji',
      words: ['money']
    })
    expect(res).toEqual({ enhanced_captions: [], emoji_map: {} })

    __setTransportFactoryForTests(null)
  })
})

describe('ai handler: AI_LIST_MODELS (Part H — fetcher injected, no network)', () => {
  afterEach(() => __setModelsFetcherForTests(null))

  it('returns recommended-first models for openrouter using the decrypted key, no key in the response', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openrouter', 'sk-or-SECRET99')
    let keyGivenToFetcher: string | null = null
    __setModelsFetcherForTests(async ({ apiKey }) => {
      keyGivenToFetcher = apiKey
      return [
        { id: 'b/other', name: 'Other', supported_parameters: ['structured_outputs'] },
        // Read the curated id from the source of truth rather than hardcoding one:
        // this spec is about the handler's ordering + key handling, and pinning a
        // specific model here made it fail the moment the shortlist was refreshed
        // (BUG-2smqpv), for a reason that had nothing to do with what it tests.
        {
          id: CURATED_TOP,
          name: 'Curated Top',
          supported_parameters: ['structured_outputs']
        },
        { id: 'tools/only', name: 'ToolsOnly', supported_parameters: ['tools'] } // dropped
      ]
    })
    registerAiHandlers(ctx)

    const res = await call(handlers, IPCChannels.AI_LIST_MODELS, {
      provider: 'openrouter',
      refresh: true
    })
    expect(res.provider).toBe('openrouter')
    // Curated pin first; non-structured dropped.
    expect(res.models[0].id).toBe(CURATED_TOP)
    expect(res.models[0].recommended).toBe(true)
    expect(res.models.some((m) => m.id === 'tools/only')).toBe(false)
    // Key was used main-side; never in the response.
    expect(keyGivenToFetcher).toBe('sk-or-SECRET99')
    expect(JSON.stringify(res)).not.toContain('sk-or-SECRET')
  })

  it('serves the second call from cache (no second fetch) unless refresh is set', async () => {
    const { ctx, handlers } = makeCtx()
    const fetcher = vi.fn(async () => [
      { id: 'a/b', name: 'A', supported_parameters: ['structured_outputs'] }
    ])
    __setModelsFetcherForTests(fetcher)
    registerAiHandlers(ctx)

    const first = await call(handlers, IPCChannels.AI_LIST_MODELS, {
      provider: 'openrouter',
      refresh: true
    })
    expect(first.fromCache).toBe(false)
    const second = await call(handlers, IPCChannels.AI_LIST_MODELS, { provider: 'openrouter' })
    expect(second.fromCache).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const third = await call(handlers, IPCChannels.AI_LIST_MODELS, {
      provider: 'openrouter',
      refresh: true
    })
    expect(third.fromCache).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not use the OpenRouter fetcher for other providers', async () => {
    // Was "returns an empty list for non-openrouter providers". Those providers
    // now get their own catalogue (FEAT-6v92dk); what still holds is that the
    // OpenRouter-specific fetcher is not reused for them. Without a key the
    // OpenAI path refuses before any HTTP, which is the behaviour we want.
    const { ctx, handlers } = makeCtx()
    const fetcher = vi.fn(async () => [])
    __setModelsFetcherForTests(fetcher)
    registerAiHandlers(ctx)
    await expect(
      call(handlers, IPCChannels.AI_LIST_MODELS, { provider: 'openai' })
    ).rejects.toThrow(/api key/i)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

// ── FEAT-6v92dk / FEAT-et1gxc: fail at configuration time, not mid-flow ──────
describe('AI_TEST_CONNECTION (FEAT-6v92dk)', () => {
  afterEach(() => __setTransportFactoryForTests(null))

  it('refuses before any network call when the provider has no key', async () => {
    const { ctx, handlers } = makeCtx()
    let built = false
    __setTransportFactoryForTests(() => {
      built = true
      return async () => ({ rawText: '{}' })
    })
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'openai',
      model: 'gpt-5'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/api key/i)
    expect(built).toBe(false) // no transport, no request, no spend
  })

  it('refuses when no model id is configured', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('ollama', 'x')
    registerAiHandlers(ctx)
    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'ollama',
      model: '   '
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/model/i)
  })

  it('reports success on a live round-trip', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'sk-test')
    __setTransportFactoryForTests(() => async () => ({ rawText: 'pong' }))
    registerAiHandlers(ctx)
    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'openai',
      model: 'gpt-5'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>
    expect(res.ok).toBe(true)
    expect(typeof res.latencyMs).toBe('number')
  })

  it('maps a provider failure to human copy instead of leaking the raw body', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('openai', 'sk-bad')
    __setTransportFactoryForTests(() => async () => {
      throw new Error('401 {"error":{"message":"Incorrect API key provided: sk-bad"}}')
    })
    registerAiHandlers(ctx)
    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'openai',
      model: 'gpt-5'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/key.*(rejected|invalid)/i)
    expect(res.message).not.toContain('sk-bad')
  })
})

// ── FEAT-bysdwg: the custom OpenAI-compatible endpoint ───────────────────────
describe('custom endpoint: resolution, key binding and gates', () => {
  const CUSTOM = { aiProvider: 'custom' as const, baseUrl: 'http://localhost:1234/v1' }
  afterEach(() => {
    __setTransportFactoryForTests(null)
    __setProviderCatalogueFetcherForTests(null)
  })

  it('tests a KEYLESS endpoint — local servers need no key', async () => {
    const { ctx, handlers } = makeCtx(CUSTOM)
    let built = false
    __setTransportFactoryForTests(() => {
      built = true
      return async () => ({ rawText: 'pong' })
    })
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>

    expect(res.ok).toBe(true)
    expect(built).toBe(true) // the inverse of the OpenAI no-key case above
  })

  it('asks for a Base URL rather than a key when the endpoint is unset', async () => {
    const { ctx, handlers } = makeCtx({ aiProvider: 'custom', baseUrl: undefined })
    let built = false
    __setTransportFactoryForTests(() => {
      built = true
      return async () => ({ rawText: 'pong' })
    })
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/base url/i)
    expect(built).toBe(false)
  })

  it('takes the endpoint from SETTINGS, never from the request payload', async () => {
    // The renderer must not be able to name the destination the decrypted key is
    // attached to (PRD §12.2) — so there is no baseUrl on the IPC contract, and
    // the transport factory gets the one main-side value.
    const { ctx, handlers, vault } = makeCtx({
      ...CUSTOM,
      customKeyEndpoint: 'http://localhost:1234'
    })
    vault.setKey('custom', 'sk-local-abc')
    const seen: Array<{ baseUrl?: string; apiKey: string | null }> = []
    __setTransportFactoryForTests((args) => {
      seen.push({ baseUrl: args.baseUrl, apiKey: args.apiKey })
      return async () => ({ rawText: 'pong' })
    })
    registerAiHandlers(ctx)

    await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model',
      // A hostile renderer trying to redirect the key:
      baseUrl: 'https://attacker.example/v1'
    })

    expect(seen[0].baseUrl).toBe('http://localhost:1234/v1')
  })

  it('refuses to send a key that was saved for a DIFFERENT endpoint', async () => {
    // secrets.json is keyed by provider id alone, so without the binding the key
    // for one server is handed to the next URL the user types.
    const { ctx, handlers, vault } = makeCtx({
      ...CUSTOM,
      customKeyEndpoint: 'https://gateway.corp'
    })
    vault.setKey('custom', 'sk-corp-secret')
    const seen: Array<string | null> = []
    __setTransportFactoryForTests((args) => {
      seen.push(args.apiKey)
      return async () => ({ rawText: 'pong' })
    })
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/different endpoint/i)
    expect(res.message).not.toContain('sk-corp-secret')
    expect(seen).toEqual([]) // never built a transport with the wrong-endpoint key
  })

  it('uses the key once it is bound to the configured endpoint', async () => {
    const { ctx, handlers, vault } = makeCtx({
      ...CUSTOM,
      // Bound on ORIGIN, so the /v1 path suffix does not break the match.
      customKeyEndpoint: 'http://localhost:1234'
    })
    vault.setKey('custom', 'sk-local-abc')
    const seen: Array<string | null> = []
    __setTransportFactoryForTests((args) => {
      seen.push(args.apiKey)
      return async () => ({ rawText: 'pong' })
    })
    registerAiHandlers(ctx)

    await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model'
    })

    expect(seen).toEqual(['sk-local-abc'])
  })

  it('names the host when the server is unreachable, and never echoes the key', async () => {
    const { ctx, handlers } = makeCtx(CUSTOM)
    __setTransportFactoryForTests(() => async () => {
      throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:1234')
    })
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_TEST_CONNECTION)!(null, {
      provider: 'custom',
      model: 'local-model'
    })) as ChannelRes<typeof IPCChannels.AI_TEST_CONNECTION>

    expect(res.ok).toBe(false)
    expect(res.message).toContain('localhost:1234')
    expect(res.message).not.toMatch(/internet connection/i)
  })

  it('lists models from the configured endpoint, not the OpenRouter path', async () => {
    const { ctx, handlers } = makeCtx(CUSTOM)
    let openRouterCalls = 0
    __setModelsFetcherForTests(async () => {
      openRouterCalls += 1
      return []
    })
    __setProviderCatalogueFetcherForTests(async ({ url }) => ({
      data: [{ id: url.includes('localhost:1234') ? 'local-model' : 'wrong-endpoint' }]
    }))
    registerAiHandlers(ctx)

    const res = (await handlers.get(IPCChannels.AI_LIST_MODELS)!(null, {
      provider: 'custom'
    })) as ChannelRes<typeof IPCChannels.AI_LIST_MODELS>

    expect(res.models.map((m) => m.id)).toEqual(['local-model'])
    expect(res.fromCache).toBe(false) // the single global cache slot is OpenRouter's
    expect(openRouterCalls).toBe(0)
    __setModelsFetcherForTests(null)
  })
})

describe('stub AI channels answer honestly (FEAT-et1gxc)', () => {
  it('GENERATE_TITLES rejects as unimplemented rather than returning an empty success', async () => {
    const { ctx, handlers } = makeCtx()
    registerAiHandlers(ctx)
    await expect(handlers.get(IPCChannels.GENERATE_TITLES)!(null, {})).rejects.toThrow(
      /NOT_IMPLEMENTED/
    )
  })

  it('ENHANCE_CAPTIONS rewrite mode rejects rather than returning an empty success', async () => {
    const { ctx, handlers } = makeCtx()
    registerAiHandlers(ctx)
    await expect(
      handlers.get(IPCChannels.ENHANCE_CAPTIONS)!(null, {
        mode: 'rewrite',
        provider: 'openai',
        model: 'gpt-5'
      })
    ).rejects.toThrow(/NOT_IMPLEMENTED/)
  })
})

describe('AI_LIST_MODELS covers every offered provider (FEAT-6v92dk)', () => {
  afterEach(() => __setProviderCatalogueFetcherForTests(null))

  it('returns a real catalogue for anthropic instead of short-circuiting to []', async () => {
    const { ctx, handlers, vault } = makeCtx()
    vault.setKey('anthropic', 'sk-ant-test')
    __setProviderCatalogueFetcherForTests(async () => ({
      data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }]
    }))
    registerAiHandlers(ctx)
    const res = (await handlers.get(IPCChannels.AI_LIST_MODELS)!(null, {
      provider: 'anthropic'
    })) as ChannelRes<typeof IPCChannels.AI_LIST_MODELS>
    expect(res.provider).toBe('anthropic')
    expect(res.models.map((m) => m.id)).toEqual(['claude-opus-5'])
  })

  it('returns a real catalogue for ollama, which needs no key', async () => {
    const { ctx, handlers } = makeCtx()
    __setProviderCatalogueFetcherForTests(async () => ({ models: [{ name: 'llama3.1:8b' }] }))
    registerAiHandlers(ctx)
    const res = (await handlers.get(IPCChannels.AI_LIST_MODELS)!(null, {
      provider: 'ollama'
    })) as ChannelRes<typeof IPCChannels.AI_LIST_MODELS>
    expect(res.models.map((m) => m.id)).toEqual(['llama3.1:8b'])
  })
})
