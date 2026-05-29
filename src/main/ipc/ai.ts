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
import type { GenerateClipsRequest } from '@shared/channels'
import type { AIProvider } from '@shared/schema'
import {
  createTransport,
  generateClips as runGenerate,
  type RawTransport
} from '@main/services/ai-client'
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
}
