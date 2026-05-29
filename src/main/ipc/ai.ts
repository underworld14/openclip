/**
 * src/main/ipc/ai.ts — AI (BYOK) control-plane handlers (T-AI, plan E.3).
 *
 * Wires GENERATE_CLIPS (and stubs GENERATE_TITLES / ENHANCE_CAPTIONS for the
 * frozen registry) via `ai-client.ts` (structured output + Zod repair ladder +
 * map-reduce). The provider API key is decrypted from `ctx.keyVault` MAIN-SIDE
 * ONLY and handed to the provider transport; it NEVER crosses IPC (PRD §12.2).
 *
 * A repaired/clamped/validated `ClipSchema` is returned as the channel response
 * (the renderer maps DetectedClip → Clip in its store). An unrepairable LLM
 * response throws a typed error string carrying the `INPUT_INVALID` code so the
 * renderer can surface it (PRD §16).
 */

import { IPCChannels } from '@shared/channels'
import type { GenerateClipsRequest, ListModelsRequest, ListModelsResult } from '@shared/channels'
import type { AIProvider } from '@shared/schema'
import {
  createTransport,
  generateClips as runGenerate,
  type RawTransport
} from '@main/services/ai-client'
import {
  fetchOpenRouterModels,
  ModelListCache,
  RECOMMENDED_OPENROUTER_MODELS,
  type ModelsFetcher
} from '@main/services/openrouter-models'
import type { IpcContext } from './index'

// ============================================================================
// Test seam: inject a transport factory so unit tests never construct a real
// SDK / hit the network. Null → use the real `createTransport`.
// ============================================================================

type TransportFactory = (args: {
  provider: AIProvider
  model: string
  apiKey: string | null
  baseUrl?: string
}) => RawTransport | Promise<RawTransport>

let transportFactoryOverride: TransportFactory | null = null

/** TEST-ONLY: override (or clear with null) the provider transport factory. */
export function __setTransportFactoryForTests(factory: TransportFactory | null): void {
  transportFactoryOverride = factory
}

// Test seam + cache for the OpenRouter model list (Part H).
let modelsFetcherOverride: ModelsFetcher | null = null
const modelListCache = new ModelListCache()

/** TEST-ONLY: override (or clear with null) the OpenRouter models fetcher. */
export function __setModelsFetcherForTests(fetcher: ModelsFetcher | null): void {
  modelsFetcherOverride = fetcher
}

/**
 * E2E fake-provider mode (plan E.10): when OPENCLIP_FAKE_TRANSCRIBE is set, the
 * launched app uses a deterministic transport that emits a FIXED, schema-valid
 * ClipSchema — so the integration Wave-1 E2E can drive `ai:generate-clips` over
 * the real main process with NO API key and NO network. Two clips well inside
 * the default [15,90]s bounds and the source duration so the clamp keeps both.
 */
const FAKE_CLIPS_JSON = JSON.stringify({
  clips: [
    {
      start_time: 12,
      end_time: 42,
      title: 'The hook that stops the scroll',
      hook: 'A bold opening claim that demands attention.',
      virality_score: 9,
      virality: {
        hook_score: 24,
        engagement_score: 22,
        value_score: 22,
        shareability_score: 22,
        total_score: 90,
        hook_type: 'statement'
      },
      clip_type: 'hook',
      keywords: ['hook', 'opening'],
      suggested_caption: 'You won’t believe this opener',
      hashtags: ['#viral', '#hook']
    },
    {
      start_time: 60,
      end_time: 95,
      title: 'The aha moment',
      hook: 'A counter-intuitive insight that reframes everything.',
      virality_score: 7,
      virality: {
        hook_score: 18,
        engagement_score: 18,
        value_score: 17,
        shareability_score: 17,
        total_score: 70,
        hook_type: 'contrast'
      },
      clip_type: 'aha',
      keywords: ['insight', 'aha'],
      suggested_caption: 'This changed how I think',
      hashtags: ['#insight']
    }
  ],
  // The repair ladder validates each chunk's raw output against the FULL
  // ClipSchema (clips + analysis), so the fake transport must emit `analysis`.
  // mapReduceGenerate recomputes the run-level analysis after reduce anyway.
  analysis: {
    total_duration: 240,
    clips_found: 2,
    best_clip_index: 0,
    overall_virality_potential: 'high'
  }
})

const fakeTransport: RawTransport = async () => ({ rawText: FAKE_CLIPS_JSON })

/** Per-process result cache (PRD §16): (transcriptHash, promptVersion, model, style). */
const clipCache = new Map<string, unknown>()

export function registerAiHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(IPCChannels.GENERATE_CLIPS, async (_e, req: GenerateClipsRequest) => {
    // Decrypt the BYOK key MAIN-SIDE only (never returned to the renderer).
    const apiKey = ctx.keyVault.getKey(req.provider)

    const factory =
      transportFactoryOverride ??
      (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeTransport : createTransport)
    const transport = await factory({
      provider: req.provider,
      model: req.model,
      apiKey
    })

    const result = await runGenerate({
      transport,
      segments: req.segments,
      videoTitle: req.videoTitle,
      durationSeconds: req.durationSeconds,
      clipStyle: req.clipStyle,
      numClips: req.numClips,
      targetPlatform: req.targetPlatform,
      // PRD §9.3 defaults; the renderer passes project-level overrides via settings.
      minDuration: 15,
      maxDuration: 90,
      model: req.model,
      cache: clipCache
    })

    if (!result.ok) {
      // Surface the typed error code so the renderer can branch on it.
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    return result.value
  })

  // GENERATE_TITLES / ENHANCE_CAPTIONS are PRD §7.4/§7.5 (v1.0 polish). The
  // channels are frozen; wire minimal pass-throughs so the registry is complete
  // and the bridge surface is callable. Full prompts land with the title/hook
  // generator milestone.
  ctx.ipcMain.handle(IPCChannels.GENERATE_TITLES, async () => {
    return { options: [] }
  })
  ctx.ipcMain.handle(IPCChannels.ENHANCE_CAPTIONS, async () => {
    return { enhanced_captions: [] }
  })

  // List a provider's models for the picker (Part H — OpenRouter only for now).
  // The key (if any) is decrypted MAIN-SIDE and only used to authorize the fetch;
  // it never crosses IPC. Cached in-memory with a short TTL; `refresh` bypasses.
  ctx.ipcMain.handle(
    IPCChannels.AI_LIST_MODELS,
    async (_e, req: ListModelsRequest): Promise<ListModelsResult> => {
      if (req.provider !== 'openrouter') {
        return { provider: req.provider, models: [], fetchedAt: Date.now(), fromCache: false }
      }
      if (!req.refresh) {
        const cached = modelListCache.get()
        if (cached) {
          return {
            provider: req.provider,
            models: cached.models,
            fetchedAt: cached.fetchedAt,
            fromCache: true
          }
        }
      }
      const apiKey = ctx.keyVault.getKey(req.provider)
      const fetcher = modelsFetcherOverride ?? undefined
      const models = await fetchOpenRouterModels({
        apiKey,
        fetcher,
        recommended: RECOMMENDED_OPENROUTER_MODELS
      })
      const entry = modelListCache.set(models)
      return {
        provider: req.provider,
        models: entry.models,
        fetchedAt: entry.fetchedAt,
        fromCache: false
      }
    }
  )
}
