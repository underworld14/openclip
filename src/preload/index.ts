/**
 * src/preload/index.ts — the typed contextBridge that exposes `window.openclip`.
 *
 * FROZEN as part of the OUTER contract (plan E.2 / E.4, tag `contracts-outer`).
 *
 * The public type `OpenClipBridge` is DERIVED from `ChannelMap` + `JobsAPI`
 * via mapped types (below) — it is NOT hand-duplicated. Each control-plane
 * channel becomes a `(req) => Promise<res>` method, grouped into the
 * per-domain namespaces required by plan E.4: video, audio, ai, project,
 * settings, model, jobs.
 *
 * Stage 2 wires only the TYPE surface. The runtime bodies are real for the
 * generic invoke/jobs plumbing but every concrete method currently throws
 * 'not wired' via `notWired()` until the fan-out tracks (E.3) fill their IPC
 * handlers — the contract (shapes + namespaces) is what is frozen here.
 *
 * The fan-out tracks own `preload/api/*` stubs (E.4) that this module would
 * assemble; in the scaffold trunk we expose the complete derived surface
 * directly so `preload-parity.spec.ts` (E.7) and downstream type-checks pass.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPCChannels } from '@shared/channels'
import type { ChannelMap, ChannelReq, ChannelRes } from '@shared/channels'
import type { JobKind, JobParams, JobsAPI } from '@shared/jobs'

// ============================================================================
// Derivation helpers — turn a ChannelMap entry into a method signature
// ============================================================================

/** A control-plane channel rendered as `(req) => Promise<res>`. */
type InvokeMethod<C extends keyof ChannelMap> =
  ChannelReq<C> extends void
    ? () => Promise<ChannelRes<C>>
    : (req: ChannelReq<C>) => Promise<ChannelRes<C>>

/**
 * Map a channel's *string value* (e.g. "video:import", "ai:generate-clips",
 * "settings:api-key-status") to the method NAME the renderer calls
 * (e.g. "import", "generateClips", "apiKeyStatus"). Drops the leading
 * `<namespace>:` segment, then camelCases across BOTH the remaining `:` and
 * `-` separators. Must stay in lockstep with the runtime `toMethodName` below
 * (asserted by `preload-parity.spec.ts`, plan E.7).
 */
type StripPrefix<S extends string> = S extends `${string}:${infer Rest}` ? Rest : S
type CamelColon<S extends string> = S extends `${infer H}:${infer T}`
  ? `${CamelHyphen<H>}${Capitalize<CamelColon<T>>}`
  : CamelHyphen<S>
type CamelHyphen<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelHyphen<T>>}`
  : S
type MethodName<S extends string> = CamelColon<StripPrefix<S>>

/**
 * Given a namespace prefix `P`, build the object of methods for every channel
 * whose value starts with `${P}:`. Channels are keyed in `ChannelMap` by their
 * enum *value* (the wire string), so we filter on that string.
 */
type NamespaceMethods<P extends string> = {
  [C in keyof ChannelMap as C extends `${P}:${string}`
    ? MethodName<C & string>
    : never]: InvokeMethod<C>
}

// ============================================================================
// OpenClipBridge — the public, derived `window.openclip` type (E.4 namespaces)
// ============================================================================

export interface OpenClipBridge {
  /** video:import, video:import:url, video:export → import, importUrl, export */
  video: NamespaceMethods<'video'>
  /** audio:extract → extract */
  audio: NamespaceMethods<'audio'>
  /** ai:generate-clips, ai:generate-titles, ai:enhance-captions */
  ai: NamespaceMethods<'ai'>
  /** project:save|load|list|delete */
  project: NamespaceMethods<'project'>
  /** settings:get|set|api-key-status|set-api-key */
  settings: NamespaceMethods<'settings'>
  /** model:status|download */
  model: NamespaceMethods<'model'>
  /** streaming jobs — modeled by JobsAPI (returns a MessagePort), not invoke */
  jobs: JobsAPI
}

// ============================================================================
// Runtime construction (stubbed — type surface is the frozen deliverable)
// ============================================================================

function notWired(channel: string): never {
  throw new Error(`openclip: IPC channel "${channel}" is not wired yet (Stage 2 trunk stub)`)
}

/** Generic invoke wrapper; real once the matching main handler is registered. */
function invoke<C extends keyof ChannelMap>(channel: C): InvokeMethod<C> {
  // Cast through unknown: the variadic arg is shaped by `InvokeMethod<C>`.
  return ((req?: ChannelReq<C>) => {
    // The handler is registered by the owning fan-out track (E.3); until then
    // the main side responds with a "not wired" rejection. We still route via
    // the real ipcRenderer.invoke so wiring a handler "just works" later.
    return ipcRenderer.invoke(channel as string, req)
  }) as InvokeMethod<C>
}

/**
 * Runtime mirror of the type-level `MethodName`: strip the `<prefix>:` segment,
 * then camelCase across remaining `:` and `-` separators.
 *   "video:import"            -> "import"
 *   "video:import:url"        -> "importUrl"
 *   "ai:generate-clips"       -> "generateClips"
 *   "settings:api-key-status" -> "apiKeyStatus"
 */
function toMethodName(channelValue: string, prefix: string): string {
  const rest = channelValue.slice(prefix.length + 1) // strip "<prefix>:"
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  const camelHyphen = (s: string): string =>
    s
      .split('-')
      .map((part, i) => (i === 0 ? part : cap(part)))
      .join('')
  return rest
    .split(':')
    .map((seg, i) => (i === 0 ? camelHyphen(seg) : cap(camelHyphen(seg))))
    .join('')
}

/**
 * Build a namespace object by pairing each channel value under `prefix` with
 * its derived method name. The runtime KEYS (via `toMethodName`) stay in
 * lockstep with the mapped TYPE above (parity-checked, plan E.7).
 */
function buildNamespace<P extends string>(prefix: P): NamespaceMethods<P> {
  const out: Record<string, unknown> = {}
  for (const value of Object.values(IPCChannels)) {
    if (typeof value !== 'string') continue
    if (!value.startsWith(`${prefix}:`)) continue
    // job:* channels are not part of the invoke namespaces (handled by jobs API)
    if (value === IPCChannels.JOB_START || value === IPCChannels.JOB_CANCEL) continue
    out[toMethodName(value, prefix)] = invoke(value as keyof ChannelMap)
  }
  return out as NamespaceMethods<P>
}

const jobs: JobsAPI = {
  async start<K extends JobKind>(
    kind: K,
    _params: JobParams[K]
  ): Promise<{ jobId: string; port: MessagePort }> {
    // Real impl: open a MessageChannel, postMessage one port to main, await
    // the jobId, hand the other port to the renderer. Stubbed until T-Media
    // wires the sidecar job router.
    void kind
    void _params
    return notWired(IPCChannels.JOB_START)
  },
  async cancel(jobId: string): Promise<void> {
    void jobId
    return notWired(IPCChannels.JOB_CANCEL)
  }
}

const openclip: OpenClipBridge = {
  video: buildNamespace('video'),
  audio: buildNamespace('audio'),
  ai: buildNamespace('ai'),
  project: buildNamespace('project'),
  settings: buildNamespace('settings'),
  model: buildNamespace('model'),
  jobs
}

// ============================================================================
// Expose to the renderer (contextIsolation on by default)
// ============================================================================

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('openclip', openclip)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (defined in index.d.ts)
  window.openclip = openclip
}
