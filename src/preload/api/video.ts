/**
 * preload/api/video.ts — `window.openclip.video` namespace builder (STUB body;
 * owned by spine/T tracks, E.3/E.4). video:import / video:export → import /
 * export. (URL/YouTube import is the `url-download` streaming job, not a video:*
 * channel — see G.7.) Trunk derives the surface from the frozen ChannelMap;
 * tracks wire the matching main handlers.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildVideoApi(): NamespaceMethods<'video'> {
  return buildNamespace('video') as NamespaceMethods<'video'>
}
