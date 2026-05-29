/**
 * preload/api/media.ts — `window.openclip.media` namespace builder (Part H).
 * media:adopt-source → adoptSource. Derives the surface from the frozen
 * ChannelMap; the matching main handler lives in `ipc/media.ts`.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildMediaApi(): NamespaceMethods<'media'> {
  return buildNamespace('media') as NamespaceMethods<'media'>
}
