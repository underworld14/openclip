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
import { notImplemented } from '@shared/ipc-errors'
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
  clearStructuredModeMemo,
  clipsMemoKey,
  createTransport,
  extractJsonCandidate,
  generateClips as runGenerate,
  resolvedStructuredMode,
  type RawTransport
} from '@main/services/ai-client'
import {
  customKeyMatchesEndpoint,
  providerDisplay,
  providerNeedsBaseUrl,
  providerRequiresKey
} from '@shared/ai-providers'
import { normalizeBaseUrl, safeHost } from '@shared/endpoint-url'
import { humanTransportError } from '@main/services/ai-errors'
import { suggestEmoji } from '@main/services/ai-emoji'
import { createGenerateClipsRunner } from '@main/services/jobs/generate-clips-runner'
import { registerRunner, hasRunner } from '@main/services/sidecar-manager'
import { fetchProviderModels } from '@main/services/provider-models'
import type { CatalogueFetcher } from '@main/services/provider-models'
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

// Test seam for the per-provider catalogue fetch (FEAT-6v92dk). Null = real HTTP.
let providerCatalogueFetcherOverride: CatalogueFetcher | null = null

/** TEST-ONLY: override (or clear with null) the provider catalogue fetcher. */
export function __setProviderCatalogueFetcherForTests(f: CatalogueFetcher | null): void {
  providerCatalogueFetcherOverride = f
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

/**
 * The endpoint a provider talks to, resolved MAIN-SIDE (FEAT-bysdwg).
 *
 * Only `custom` has one; everything else uses its SDK default. Read fresh per
 * call so an edit in Settings takes effect immediately, and never taken from the
 * request payload — see the note on `IpcContext.getSettings`.
 */
function endpointFor(provider: AIProvider, ctx: IpcContext): string | undefined {
  if (!providerNeedsBaseUrl(provider)) return undefined
  return normalizeBaseUrl(ctx.getSettings().baseUrl)
}

/**
 * The decrypted key for a provider (MAIN-SIDE only), honouring the custom
 * key↔endpoint binding: a key entered for one endpoint is never sent to another.
 */
function keyFor(provider: AIProvider, ctx: IpcContext): string | null {
  if (provider === 'custom' && !customKeyMatchesEndpoint(ctx.getSettings())) return null
  return ctx.keyVault.getKey(provider)
}

export function registerAiHandlers(ctx: IpcContext): void {
  // Clip detection ALSO runs as a streaming job (EPIC-zpa1nd / FEAT-c0zn3j),
  // which is how the app itself now calls it: the job plane gives it progress,
  // cancel and the done-xor-error invariant that the invoke below cannot have.
  // Both entry points delegate to the same `runGenerate` core and share
  // `clipCache`, so there is one implementation and no second code path.
  //
  // Registered HERE rather than at module scope because the runner needs
  // `ctx.keyVault` — the key is decrypted main-side and never crosses IPC. The
  // `hasRunner` guard matches ipc/video.ts:35 and ipc/model.ts:29: registrars
  // run once per app, but repeatedly across specs, and re-registering throws.
  if (!hasRunner('generate-clips')) {
    registerRunner(
      'generate-clips',
      createGenerateClipsRunner({
        getKey: (provider) => keyFor(provider, ctx),
        getBaseUrl: (provider) => endpointFor(provider, ctx),
        createTransport: (args) =>
          (
            transportFactoryOverride ??
            (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeTransport : createTransport)
          )(args),
        cache: clipCache
      })
    )
  }

  ctx.ipcMain.handle(IPCChannels.GENERATE_CLIPS, async (_e, req: GenerateClipsRequest) => {
    // Decrypt the BYOK key MAIN-SIDE only (never returned to the renderer).
    const apiKey = keyFor(req.provider, ctx)
    // The endpoint comes from settings, not from `req` — see `endpointFor`.
    const baseUrl = endpointFor(req.provider, ctx)

    const factory =
      transportFactoryOverride ??
      (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeTransport : createTransport)
    const transport = await factory({
      provider: req.provider,
      model: req.model,
      apiKey,
      baseUrl
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
      // Endpoint identity, so two servers offering the same model id don't share
      // a cache entry (FEAT-bysdwg).
      provider: req.provider,
      baseUrl,
      cache: clipCache
    })

    if (!result.ok) {
      // Surface the typed error code so the renderer can branch on it.
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }
    // Carry any non-fatal warnings (e.g. a chunk that failed while others
    // succeeded) alongside the clips, so a partial run stops looking like a
    // complete one (BUG-yq6qbw).
    return result.warnings?.length ? { ...result.value, warnings: result.warnings } : result.value
  })

  // GENERATE_TITLES is PRD §7.4 (v1.0 polish) and is NOT built yet. It answers
  // with a typed rejection rather than `{options: []}` — a successful empty
  // payload is indistinguishable from "the model had no suggestions", so a caller
  // cannot branch on it and a UI built against it would silently render nothing
  // forever (audit fix FEAT-et1gxc).
  ctx.ipcMain.handle(IPCChannels.GENERATE_TITLES, async () => {
    // Built through `notImplemented()` so the prefix lives in ONE place and
    // callers branch with `isNotImplemented(err)` rather than string-matching
    // (FEAT-azqfsv). `ipcMain.handle` flattens a rejection to its message, so a
    // typed error class cannot survive the control plane — the code has to
    // travel in the text, and the convention is what makes that safe.
    throw notImplemented(
      'AI title generation (PRD §7.4) is not built yet. ' +
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
        throw notImplemented(
          'caption rewrite (PRD §7.5) is not built yet; only mode:"emoji" is wired.'
        )
      }
      const apiKey = keyFor(req.provider, ctx)
      const factory =
        transportFactoryOverride ??
        (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeEmojiTransport : createTransport)
      const transport = await factory({
        provider: req.provider,
        model: req.model,
        apiKey,
        baseUrl: endpointFor(req.provider, ctx)
      })
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
      const settings = ctx.getSettings()
      const apiKey = keyFor(req.provider, ctx)
      const baseUrl = endpointFor(req.provider, ctx)
      // Ollama and a custom endpoint may both be local and keyless; everything
      // else needs a key. Check BEFORE building a transport so a keyless test
      // costs nothing and cannot 401.
      if (providerRequiresKey(req.provider) && !apiKey) {
        return {
          ok: false,
          message: `No API key saved for ${providerDisplay(req.provider)}. Paste one above, then test again.`
        }
      }
      // For a custom endpoint the missing prerequisite is the URL, not the key.
      if (providerNeedsBaseUrl(req.provider) && !baseUrl) {
        return {
          ok: false,
          message:
            'No Base URL set. Add your server’s OpenAI-compatible URL above, then test again.'
        }
      }
      // A key bound to a DIFFERENT endpoint is treated as absent (FEAT-bysdwg) —
      // say so, rather than silently testing unauthenticated.
      if (
        req.provider === 'custom' &&
        !apiKey &&
        ctx.keyVault.status('custom').hasKey &&
        !customKeyMatchesEndpoint(settings)
      ) {
        return {
          ok: false,
          message: `The saved key was entered for a different endpoint. Re-enter it for ${safeHost(baseUrl)}, or clear it to connect without a key.`
        }
      }
      if (!model) {
        return { ok: false, message: 'No model id set. Pick one from the list, then test again.' }
      }
      const factory =
        transportFactoryOverride ??
        (process.env.OPENCLIP_FAKE_TRANSCRIBE ? () => fakeTransport : createTransport)
      // Test is the user's explicit "check again", so it must not report a verdict
      // remembered from an earlier transient failure (FEAT-bysdwg).
      if (providerNeedsBaseUrl(req.provider)) clearStructuredModeMemo(clipsMemoKey(baseUrl, model))
      const started = Date.now()
      try {
        const transport = await factory({ provider: req.provider, model, apiKey, baseUrl })
        // This DOES exercise structured output: `createTransport` always attaches
        // the strict ClipSchema response_format, so a model that cannot produce
        // it fails here — which is the more useful probe, since that is exactly
        // what clip detection needs. It is not the cheapest possible request.
        const probe = await transport({
          system: 'You are a connectivity probe. Answer with exactly one word.',
          user: 'Reply with the single word: pong'
        })
        // A non-throwing call is NOT proof of a working endpoint. An empty
        // completion is how a refusal, a content filter or a truncation arrives,
        // and clip detection would fail on it every time.
        if (!probe.rawText.trim()) {
          return {
            ok: false,
            message: `${providerDisplay(req.provider, baseUrl)} accepted the request but returned an empty response for "${model}". Try another model.`
          }
        }
        return {
          ok: true,
          message: `Connected to ${model}.${structuredModeNote(req.provider, baseUrl, model, probe.rawText)}`,
          latencyMs: Date.now() - started
        }
      } catch (err) {
        return {
          ok: false,
          message: humanTransportError(err, req.provider, model, baseUrl, apiKey)
        }
      }
    }
  )

  // List a provider's models for the picker (Part H — OpenRouter only for now).
  // The key (if any) is decrypted MAIN-SIDE and only used to authorize the fetch;
  // it never crosses IPC. Cached in-memory with a short TTL; `refresh` bypasses.
  ctx.ipcMain.handle(
    IPCChannels.AI_LIST_MODELS,
    async (_e, req: ListModelsRequest): Promise<ListModelsResult> => {
      // Every provider we OFFER gets a real catalogue. Returning [] here is what
      // left OpenAI/Anthropic/Ollama users typing a model id from memory into a
      // free-text box (audit fix FEAT-6v92dk). The OpenRouter path below stays
      // separate because it carries pricing + curated ordering.
      if (req.provider !== 'openrouter') {
        const models = await fetchProviderModels({
          provider: req.provider,
          apiKey: keyFor(req.provider, ctx),
          baseUrl: endpointFor(req.provider, ctx),
          fetcher: providerCatalogueFetcherOverride ?? undefined
        })
        return { provider: req.provider, models, fetchedAt: Date.now(), fromCache: false }
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
 * What Test connection must say about a custom endpoint's structured output.
 *
 * The probe used to be trustworthy because the strict `response_format` was
 * always attached: a model that could not do it failed the test. A custom
 * endpoint may DOWNGRADE instead of failing, so a bare "Connected" would now
 * hide the difference between "will produce exact JSON" and "we will be repairing
 * prose". Report the rung the endpoint settled on (FEAT-bysdwg).
 */
function structuredModeNote(
  provider: AIProvider,
  baseUrl: string | undefined,
  model: string,
  rawText: string
): string {
  if (provider !== 'custom') return ''
  const mode = resolvedStructuredMode(clipsMemoKey(baseUrl, model))
  // Unknown = nothing was memoized (a fake transport, or an E2E run). Saying
  // nothing is the honest answer; claiming strict support here would be a guess.
  if (mode === undefined) return ''
  if (mode === 'none') {
    return ' No structured-output support — clip detection may need retries and can be unreliable.'
  }
  // The server ACCEPTED a structured-output request. Whether it HONOURED it is a
  // different question, and the one that decides whether clip detection works:
  // several self-hosted builds ignore an unrecognised `response_format` and
  // answer prose with a 200, which no error-driven ladder can see. The probe's
  // own reply settles it, since both live modes force a JSON object.
  if (!looksLikeJson(rawText)) {
    return ' The server ignored the structured-output request — clip detection will rely on repairing plain text, and may be unreliable.'
  }
  if (mode === 'json_object') return ' JSON mode — output will be repaired if needed.'
  return ' Strict JSON schema supported.'
}

/** Did the endpoint answer with a JSON object, as both live modes require? */
function looksLikeJson(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(extractJsonCandidate(rawText))
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}
