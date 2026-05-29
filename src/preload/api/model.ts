/**
 * preload/api/model.ts — `window.openclip.model` namespace builder (STUB body;
 * owned by T-Media, E.3/E.4). model:status / download. Trunk derives the
 * surface; the track wires the matching main handlers.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildModelApi(): NamespaceMethods<'model'> {
  return buildNamespace('model') as NamespaceMethods<'model'>
}
