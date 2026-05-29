/**
 * previewSlice — transient WYSIWYG-preview / compose selection (Part K, Step 3).
 *
 * One-writer slice (plan E.4) holding the choices the PreviewPlayer and the
 * ExportPanel SHARE so the live preview matches what export will produce:
 *   - `aspectOverride` — preview/compose aspect; null ⇒ follow `settings.aspectRatio`.
 *   - `reframeMode`    — Part J reframe shown in the preview + used by export.
 *   - `captionsPreviewEnabled` — overlay burned-style captions in the preview.
 *
 * The selected caption TEMPLATE is NOT here — it is persisted on
 * `ProjectSettings.captionTemplateId` (Step 2). This slice is transient (not
 * written to `.ocproj`).
 */

import type { StateCreator } from 'zustand'
import type { AspectRatio } from '@shared/schema'
import type { ReframeMode } from '@shared/reframe-plan'
import type { ProjectStore } from './index'

export interface PreviewSlice {
  aspectOverride: AspectRatio | null
  reframeMode: ReframeMode
  captionsPreviewEnabled: boolean
  setAspectOverride: (a: AspectRatio | null) => void
  setReframeMode: (m: ReframeMode) => void
  setCaptionsPreviewEnabled: (on: boolean) => void
}

export const createPreviewSlice: StateCreator<ProjectStore, [], [], PreviewSlice> = (set) => ({
  aspectOverride: null,
  reframeMode: 'off',
  captionsPreviewEnabled: true,
  setAspectOverride: (aspectOverride) => set({ aspectOverride }),
  setReframeMode: (reframeMode) => set({ reframeMode }),
  setCaptionsPreviewEnabled: (captionsPreviewEnabled) => set({ captionsPreviewEnabled })
})
