/**
 * src/preload/api/_invoke.ts — shared invoke/namespace plumbing for the
 * per-domain preload api modules (TRUNK, frozen seam — plan E.4).
 *
 * The bridge is assembled from per-domain `preload/api/*` namespace builders
 * (E.4). They all share this one helper so the runtime method-name derivation
 * (`toMethodName`) and the generic `invoke` wrapper live in exactly one place —
 * keeping the runtime in lockstep with the TYPE-level `MethodName` mapped type
 * in `../index.ts` (asserted by `preload-parity.spec.ts`, plan E.7).
 */

import { ipcRenderer } from 'electron'
import { IPCChannels } from '@shared/channels'
import type { ChannelMap, ChannelReq } from '@shared/channels'

/** A control-plane channel rendered as `(req) => Promise<res>` at runtime. */
export type AnyInvokeMethod = (req?: unknown) => Promise<unknown>

/** Generic invoke wrapper; the matching main handler is registered by a track. */
export function invoke<C extends keyof ChannelMap>(channel: C): AnyInvokeMethod {
  return ((req?: ChannelReq<C>) => ipcRenderer.invoke(channel as string, req)) as AnyInvokeMethod
}

/**
 * Runtime mirror of the type-level `MethodName`: strip the `<prefix>:` segment,
 * then camelCase across remaining `:` and `-` separators.
 *   "video:import"            -> "import"
 *   "video:import:url"        -> "importUrl"
 *   "ai:generate-clips"       -> "generateClips"
 *   "settings:api-key-status" -> "apiKeyStatus"
 */
export function toMethodName(channelValue: string, prefix: string): string {
  const rest = channelValue.slice(prefix.length + 1)
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
 * Build a namespace object by pairing every channel value under `prefix` with
 * its derived method name. `job:*` channels are excluded (handled by the jobs
 * API, not the invoke namespaces).
 */
export function buildNamespace(prefix: string): Record<string, AnyInvokeMethod> {
  const out: Record<string, AnyInvokeMethod> = {}
  for (const value of Object.values(IPCChannels)) {
    if (typeof value !== 'string') continue
    if (!value.startsWith(`${prefix}:`)) continue
    if (value === IPCChannels.JOB_START || value === IPCChannels.JOB_CANCEL) continue
    out[toMethodName(value, prefix)] = invoke(value as keyof ChannelMap)
  }
  return out
}
