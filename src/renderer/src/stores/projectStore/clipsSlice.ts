/**
 * clipsSlice — clip suggestions/edits within projectStore (T-AI, plan E.3/E.4).
 *
 * Thin actions call `window.openclip` directly (plan E.4 — backend tracks never
 * import a store). `generateClips` calls the AI bridge, maps the LLM's
 * `DetectedClip` (snake_case, frozen ClipSchema) → the app's `Clip` (camelCase,
 * PRD §9.3), and seeds the list as `suggested` for approve/reject in the UI.
 */

import type { StateCreator } from 'zustand'
import type { Clip, DetectedClip } from '@shared/schema'
import type { GenerateClipsRequest } from '@shared/channels'
import type { ProjectStore } from './index'

export interface ClipsSlice {
  clips: Clip[]
  selectedClipId: string | null
  generating: boolean
  generateError: string | null
  setClips: (clips: Clip[]) => void
  updateClip: (id: string, patch: Partial<Clip>) => void
  selectClip: (id: string | null) => void
  /** Approve / reject a suggested clip (PRD §6.3 clip cards). */
  approveClip: (id: string) => void
  rejectClip: (id: string) => void
  /** Run BYOK AI clip detection via the bridge and seed the clip list. */
  generateClips: (req: GenerateClipsRequest) => Promise<void>
}

/** Map a frozen-schema DetectedClip (snake_case) → the app Clip (PRD §9.3). */
export function detectedToClip(d: DetectedClip, index: number): Clip {
  return {
    id: `clip-${Date.now().toString(36)}-${index}`,
    startTime: d.start_time,
    endTime: d.end_time,
    title: d.title,
    hook: d.hook,
    viralityScore: d.virality_score,
    clipType: d.clip_type,
    keywords: d.keywords,
    status: 'suggested',
    // Part I — carry the 4-D breakdown + opening-hook type for the clip card.
    virality: {
      hook: d.virality.hook_score,
      engagement: d.virality.engagement_score,
      value: d.virality.value_score,
      shareability: d.virality.shareability_score,
      total: d.virality.total_score
    },
    hookType: d.virality.hook_type
  }
}

export const createClipsSlice: StateCreator<ProjectStore, [], [], ClipsSlice> = (set) => ({
  clips: [],
  selectedClipId: null,
  generating: false,
  generateError: null,
  setClips: (clips) => set({ clips }),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  approveClip: (id) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, status: 'approved' } : c)) })),
  rejectClip: (id) => set((s) => ({ clips: s.clips.filter((c) => c.id !== id) })),
  generateClips: async (req) => {
    set({ generating: true, generateError: null })
    try {
      const result = await window.openclip.ai.generateClips(req)
      set({ clips: result.clips.map(detectedToClip), generating: false })
    } catch (err) {
      set({
        generating: false,
        generateError: err instanceof Error ? err.message : String(err)
      })
    }
  }
})
