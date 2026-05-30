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
  __setModelsFetcherForTests
} from '@main/ipc/ai'
import { KeyVault, type SafeStorageLike, type SecretStoreBackend } from '@main/utils/security'
import { IPCChannels } from '@shared/channels'
import type { ChannelMap, ChannelReq, ChannelRes } from '@shared/channels'
import type { RawTransport } from '@main/services/ai-client'
import { clipSchemaFixture, transcriptSegmentsFixture } from '../fixtures/contract'

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

function makeCtx(): { ctx: IpcContext; handlers: Map<string, Handler>; vault: KeyVault } {
  const handlers = new Map<string, Handler>()
  const vault = new KeyVault(fakeSafe(), memBackend())
  const ctx = {
    ipcMain: {
      handle: (channel: string, h: Handler) => handlers.set(channel, h)
    },
    getMainWindow: () => null,
    sidecar: {} as never,
    keyVault: vault
  } as unknown as IpcContext
  return { ctx, handlers, vault }
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

  it('a non-emoji request stays the stub and never builds a transport', async () => {
    const { ctx, handlers } = makeCtx()
    const factory = vi.fn(() => async () => ({ rawText: '{}' }))
    __setTransportFactoryForTests(factory)
    registerAiHandlers(ctx)

    const res = await call(handlers, IPCChannels.ENHANCE_CAPTIONS, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      transcript: 'hello world'
    })
    expect(res).toEqual({ enhanced_captions: [] })
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
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude',
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
    expect(res.models[0].id).toBe('anthropic/claude-sonnet-4.5')
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

  it('returns an empty list for non-openrouter providers (no fetch)', async () => {
    const { ctx, handlers } = makeCtx()
    const fetcher = vi.fn(async () => [])
    __setModelsFetcherForTests(fetcher)
    registerAiHandlers(ctx)
    const res = await call(handlers, IPCChannels.AI_LIST_MODELS, { provider: 'openai' })
    expect(res.models).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
