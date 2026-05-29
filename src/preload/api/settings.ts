/**
 * preload/api/settings.ts — `window.openclip.settings` namespace builder (STUB
 * body; owned by T-AI, E.3/E.4). settings:get / set / api-key-status /
 * set-api-key. The raw API key never crosses IPC — set-api-key returns only
 * `{provider,hasKey,last4}` (PRD §12.2). Trunk derives the surface.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildSettingsApi(): NamespaceMethods<'settings'> {
  return buildNamespace('settings') as NamespaceMethods<'settings'>
}
