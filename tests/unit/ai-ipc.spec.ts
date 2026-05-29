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

import { describe, expect, it, vi } from 'vitest'
import type { IpcContext } from '@main/ipc/index'
import { registerSettingsHandlers } from '@main/ipc/settings'
import { registerAiHandlers, __setTransportFactoryForTests } from '@main/ipc/ai'
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
