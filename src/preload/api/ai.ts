/**
 * preload/api/ai.ts — `window.openclip.ai` namespace builder (STUB body; owned
 * by T-AI, E.3/E.4). ai:generate-clips / generate-titles / enhance-captions.
 * Trunk derives the surface; the track wires the matching main handlers.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildAiApi(): NamespaceMethods<'ai'> {
  return buildNamespace('ai') as NamespaceMethods<'ai'>
}
