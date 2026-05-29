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

/** Per-process result cache (PRD §16): (transcriptHash, promptVersion, model, style). */
const clipCache = new Map<string, unknown>()

export function registerAiHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(IPCChannels.GENERATE_CLIPS, async (_e, req: GenerateClipsRequest) => {
    // Decrypt the BYOK key MAIN-SIDE only (never returned to the renderer).
    const apiKey = ctx.keyVault.getKey(req.provider)

    const factory = transportFactoryOverride ?? createTransport
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
