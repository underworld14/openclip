/**
 * src/preload/api/types.ts — the DERIVED method-surface types shared by the
 * per-domain preload api modules and the bridge assembler (TRUNK, frozen seam).
 *
 * `OpenClipBridge` is derived from `ChannelMap` + `JobsAPI` via these mapped
 * types — never hand-duplicated (plan E.4). Kept in its own module so each
 * `preload/api/<domain>.ts` can type its builder's return value without a
 * circular import on `../index.ts`.
 */

import type { ChannelMap, ChannelReq, ChannelRes } from '@shared/channels'

/** A control-plane channel rendered as `(req) => Promise<res>`. */
export type InvokeMethod<C extends keyof ChannelMap> =
  ChannelReq<C> extends void
    ? () => Promise<ChannelRes<C>>
    : (req: ChannelReq<C>) => Promise<ChannelRes<C>>

/** Drop the leading `<namespace>:` segment of a channel string. */
type StripPrefix<S extends string> = S extends `${string}:${infer Rest}` ? Rest : S
type CamelColon<S extends string> = S extends `${infer H}:${infer T}`
  ? `${CamelHyphen<H>}${Capitalize<CamelColon<T>>}`
  : CamelHyphen<S>
type CamelHyphen<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelHyphen<T>>}`
  : S

/** Method NAME a renderer calls for a channel string (e.g. "ai:generate-clips" → "generateClips"). */
export type MethodName<S extends string> = CamelColon<StripPrefix<S>>

/**
 * The object of methods for every channel whose value starts with `${P}:`.
 * Channels are keyed in `ChannelMap` by their enum *value* (the wire string).
 */
export type NamespaceMethods<P extends string> = {
  [C in keyof ChannelMap as C extends `${P}:${string}`
    ? MethodName<C & string>
    : never]: InvokeMethod<C>
}
