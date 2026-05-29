/**
 * preload/api/audio.ts — `window.openclip.audio` namespace builder (STUB body;
 * owned by T-Media, E.3/E.4). audio:extract → extract. Trunk derives the
 * surface; the track wires the matching main handler.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildAudioApi(): NamespaceMethods<'audio'> {
  return buildNamespace('audio') as NamespaceMethods<'audio'>
}
