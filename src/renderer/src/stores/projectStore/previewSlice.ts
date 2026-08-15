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
import type { ReframeMode, ReframePlan } from '@shared/reframe-plan'
import type { ProjectStore } from './index'

export interface PreviewSlice {
  aspectOverride: AspectRatio | null
  reframeMode: ReframeMode
  captionsPreviewEnabled: boolean
  /**
   * The auto-reframe plan for the selected clip, so the PREVIEW can show it
   * (FEAT-kzej8t).
   *
   * Auto-reframe was an invisible switch: the preview showed an unchanged centre
   * crop with a badge reading "Auto-reframe on export". The user could not see
   * the face-follow, could not tell it had locked onto the wrong speaker, and
   * found out only after exporting.
   */
  reframePlan: ReframePlan | null
  /** Which clip + mode `reframePlan` was computed for, so a stale plan is never shown. */
  reframePlanFor: string | null
  reframePlanLoading: boolean
  /**
   * Why there is no plan. `detect-failed` is NOT the same as `no-face` and used
   * to be indistinguishable — both silently became a centre crop.
   */
  reframePlanError: { reason: 'no-face' | 'detect-failed'; message?: string } | null
  setAspectOverride: (a: AspectRatio | null) => void
  setReframeMode: (m: ReframeMode) => void
  /** Fetch (or read from cache) the plan for a clip; no-ops when reframe is off. */
  loadReframePlan: (args: {
    projectId: string
    clipId: string
    sourcePath: string
    startTime: number
    endTime: number
    sourceResolution: { width: number; height: number }
    aspectRatio: AspectRatio
  }) => Promise<void>
  setCaptionsPreviewEnabled: (on: boolean) => void
}

export const createPreviewSlice: StateCreator<ProjectStore, [], [], PreviewSlice> = (set, get) => ({
  aspectOverride: null,
  reframeMode: 'off',
  captionsPreviewEnabled: true,
  reframePlan: null,
  reframePlanFor: null,
  reframePlanLoading: false,
  reframePlanError: null,
  setAspectOverride: (aspectOverride) => set({ aspectOverride }),
  // Deliberately transient-only, same as this slice's other fields: it just
  // mirrors the LIVE mode into the store. Persistence (EPIC-k83ghw /
  // BUG-8kgcxs) is the CALLER's job — the explicit user-action call site
  // (ExportPanel's framing control) also writes `project.settings.reframeMode`
  // in the same breath `fitMode` already does, and `hydrateFromProject`
  // restores this from that same field on load. Persisting HERE unconditionally
  // would also fire on hydration itself (this setter runs there too), stamping
  // an explicit 'off' onto every legacy project that never had the field.
  setReframeMode: (reframeMode) =>
    // Changing the mode invalidates the plan: `auto` and `split` produce
    // structurally different plans from the same faces, and showing the old one
    // would preview a crop the export is not going to make.
    set({ reframeMode, reframePlan: null, reframePlanFor: null, reframePlanError: null }),

  loadReframePlan: async (args) => {
    const mode = get().reframeMode
    if (mode === 'off') {
      set({ reframePlan: null, reframePlanFor: null, reframePlanError: null })
      return
    }
    // Keyed on everything that changes the plan, so a trim or a mode switch
    // refetches and a re-render does not.
    const key = [args.clipId, args.startTime, args.endTime, args.aspectRatio, mode].join('|')
    if (get().reframePlanFor === key || get().reframePlanLoading) return
    set({ reframePlanLoading: true })
    try {
      const res = await window.openclip.video.planReframe({
        projectId: args.projectId,
        clipId: args.clipId,
        sourcePath: args.sourcePath,
        startTime: args.startTime,
        endTime: args.endTime,
        sourceResolution: args.sourceResolution,
        aspectRatio: args.aspectRatio,
        mode
      })
      set({
        reframePlan: res.plan,
        reframePlanFor: key,
        reframePlanError: res.reason ? { reason: res.reason, message: res.message } : null
      })
    } catch (e) {
      // The IPC itself failed — still a detection failure from the user's side,
      // and still better said than swallowed.
      set({
        reframePlan: null,
        reframePlanFor: key,
        reframePlanError: {
          reason: 'detect-failed',
          message: e instanceof Error ? e.message : String(e)
        }
      })
    } finally {
      set({ reframePlanLoading: false })
    }
  },
  setCaptionsPreviewEnabled: (captionsPreviewEnabled) => set({ captionsPreviewEnabled })
})
