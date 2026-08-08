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
import type {
  EnhanceCaptionsRequest,
  EnhanceCaptionsResult,
  GenerateClipsRequest,
  ListModelsRequest,
  ListModelsResult,
  TestConnectionRequest,
  TestConnectionResult
} from '@shared/channels'
import type { AIProvider } from '@shared/schema'
import {
  createTransport,
  generateClips as runGenerate,
  type RawTransport
} from '@main/services/ai-client'
import { suggestEmoji } from '@main/services/ai-emoji'
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

/** E2E fake-provider emoji map (mode:'emoji') — deterministic, schema-valid. */
const fakeEmojiTransport: RawTransport = async () => ({
  rawText: JSON.stringify({ money: '💰', fire: '🔥', idea: '💡' })
})

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
      // Clamp numClips to a sane 1..50 at the trust boundary (audit fix openclip-9hc):
      // an unbounded value (e.g. 10000) would inflate the prompt + BYOK token cost and
      // risk output truncation, and a non-positive value yields an always-empty result.
      numClips: Math.max(1, Math.min(50, Math.floor(req.numClips) || 1)),
      targetPlatform: req.targetPlatform,
      // Honour the user's project-level clip-length bounds when supplied; PRD §9.3
      // defaults otherwise (audit fix openclip-t0v — previously hard-coded 15/90).
      minDuration: req.minDuration ?? 15,
      maxDuration: req.maxDuration ?? 90,
      model: req.model,
      cache: clipCache
    })

    if (!result.ok) {
      // Surface the typed error code so the renderer can branch on it.
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    return result.value
  })

  // GENERATE_TITLES is PRD §7.4 (v1.0 polish) and is NOT built yet. It answers
  // with a typed rejection rather than `{options: []}` — a successful empty
  // payload is indistinguishable from "the model had no suggestions", so a caller
  // cannot branch on it and a UI built against it would silently render nothing
  // forever (audit fix FEAT-et1gxc).
  ctx.ipcMain.handle(IPCChannels.GENERATE_TITLES, async () => {
    throw new Error(
      'NOT_IMPLEMENTED: AI title generation (PRD §7.4) is not built yet. ' +
        'Titles currently come from the clip-detection pass.'
    )
  })

  // ENHANCE_CAPTIONS (PRD §7.5). Part K (emoji): mode:'emoji' returns a per-word
  // `emoji_map` via the BYOK transport (own provider/model/key — the renderer
  // resolves emojiProvider/emojiModel before calling). The legacy rewrite path
  // stays a stub until the caption-rewrite milestone. Emoji is cosmetic: any
  // transport failure degrades to an empty map (never blocks the export).
  ctx.ipcMain.handle(
    IPCChannels.ENHANCE_CAPTIONS,
    async (_e, req: EnhanceCaptionsRequest): Promise<EnhanceCaptionsResult> => {
      // Rewrite mode (PRD §7.5) is not built. Reject rather than answering with an
      // empty success (audit fix FEAT-et1gxc) — emoji mode below is the real path.
      if (req.mode !== 'emoji') {
        throw new Error(
          'NOT_IMPLEMENTED: caption rewrite (PRD §7.5) is not built yet; only mode:"emoji" is wired.'
        )
      }
      const apiKey = ctx.keyVault.getKey(req.provider)
      const factory =
        transportFactoryOverride ??
        (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeEmojiTransport : createTransport)
      const transport = await factory({ provider: req.provider, model: req.model, apiKey })
      try {
        const emoji_map = await suggestEmoji(transport, req.words ?? [])
        return { enhanced_captions: [], emoji_map }
      } catch {
        return { enhanced_captions: [], emoji_map: {} }
      }
    }
  )

  // AI_TEST_CONNECTION — one cheap real round-trip so a misconfiguration is caught
  // HERE, in Settings, instead of after the user has imported a video and sat
  // through a full whisper transcription (audit fix FEAT-6v92dk). Never throws:
  // the renderer renders `message` verbatim, so every failure mode has to already
  // be human-readable.
  ctx.ipcMain.handle(
    IPCChannels.AI_TEST_CONNECTION,
    async (_e, req: TestConnectionRequest): Promise<TestConnectionResult> => {
      const model = (req.model ?? '').trim()
      const apiKey = ctx.keyVault.getKey(req.provider)
      // Ollama runs locally and needs no key; everything else does. Check BEFORE
      // building a transport so a keyless test costs nothing and cannot 401.
      if (req.provider !== 'ollama' && !apiKey) {
        return {
          ok: false,
          message: `No API key saved for ${req.provider}. Paste one above, then test again.`
        }
      }
      if (!model) {
        return { ok: false, message: 'No model id set. Pick one from the list, then test again.' }
      }
      const factory =
        transportFactoryOverride ??
        (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeTransport : createTransport)
      const started = Date.now()
      try {
        const transport = await factory({ provider: req.provider, model, apiKey })
        // Deliberately tiny: this proves auth + model id + reachability, and is the
        // cheapest request the provider will accept. It is NOT a schema check.
        await transport({
          system: 'You are a connectivity probe. Answer with exactly one word.',
          user: 'Reply with the single word: pong'
        })
        return { ok: true, message: `Connected to ${model}.`, latencyMs: Date.now() - started }
      } catch (err) {
        return { ok: false, message: humanTransportError(err, req.provider, model) }
      }
    }
  )

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

/**
 * Map a provider SDK failure to something a non-technical user can act on.
 *
 * Provider error bodies routinely echo the submitted API key back (OpenAI's 401
 * says "Incorrect API key provided: sk-…"), so the raw message must NEVER be
 * forwarded verbatim to the renderer — this function is also the redaction seam.
 */
function humanTransportError(err: unknown, provider: AIProvider, model: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/\b401\b|unauthor|invalid[_ -]?api[_ -]?key|incorrect api key/i.test(raw)) {
    return `The ${provider} key was rejected. Check that it is correct and still active.`
  }
  if (/\b403\b|permission|forbidden/i.test(raw)) {
    return `That key is valid but not allowed to use "${model}". Try a different model or plan.`
  }
  if (/\b404\b|model[_ ]?not[_ ]?found|does not exist|unknown model/i.test(raw)) {
    return `${provider} does not recognise the model "${model}". Pick one from the list.`
  }
  if (/\b429\b|rate[_ ]?limit|quota|insufficient[_ ]?quota|billing/i.test(raw)) {
    return `${provider} rejected the request for quota or rate-limit reasons. Check your billing.`
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|timeout|ETIMEDOUT/i.test(raw)) {
    return provider === 'ollama'
      ? 'Could not reach Ollama on this machine. Is `ollama serve` running?'
      : `Could not reach ${provider}. Check your internet connection.`
  }
  // Unknown shape: say so plainly and keep it short rather than dumping a body
  // that may contain the key.
  return `${provider} rejected the test request. Double-check the provider, model id and key.`
}
