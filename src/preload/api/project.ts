/**
 * preload/api/project.ts — `window.openclip.project` namespace builder (STUB
 * body; owned by T-Persist, E.3/E.4). project:save / load / list / delete.
 * Trunk derives the surface; the track wires the matching main handlers.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildProjectApi(): NamespaceMethods<'project'> {
  return buildNamespace('project') as NamespaceMethods<'project'>
}
