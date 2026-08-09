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
import { runGenerateClips } from '@renderer/components/generate-clips-run'
import { isCancellation } from '@renderer/components/jobStatus'
import type { ProjectStore } from './index'

export interface ClipsSlice {
  clips: Clip[]
  selectedClipId: string | null
  generating: boolean
  generateError: string | null
  /** 0..100 across the transcript's chunks while a generation runs. */
  generatePct: number
  /** "chunk 2 of 6" — what the sidebar shows instead of a bare spinner. */
  generateChunk: { index: number; count: number } | null
  /** The in-flight job, so the run can be cancelled (FEAT-c0zn3j). */
  generateJobId: string | null
  /**
   * Streaming, PROVISIONAL candidates from chunks that have come back so far,
   * shown while a generation runs so the sidebar fills in rather than sitting
   * empty for minutes. Never persisted and never merged into `clips`: they are
   * not de-overlapped across chunks, ranked or clamped, and the terminal result
   * replaces them wholesale.
   */
  provisionalClips: Clip[]
  setClips: (clips: Clip[]) => void
  updateClip: (id: string, patch: Partial<Clip>) => void
  selectClip: (id: string | null) => void
  /** Approve / reject a suggested clip (PRD §6.3 clip cards). */
  approveClip: (id: string) => void
  rejectClip: (id: string) => void
  /** Mark clip(s) exported after a (batch) export completes (Part K, Step 4). */
  markExported: (ids: string | string[]) => void
  /** Run BYOK AI clip detection via the bridge and seed the clip list. */
  generateClips: (req: GenerateClipsRequest) => Promise<void>
  /** Cancel the in-flight generation. No-op when nothing is running. */
  cancelGenerate: () => Promise<void>
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
    hookType: d.virality.hook_type,
    // Carry the AI-suggested social caption + hashtags instead of discarding them
    // (audit fix openclip-5cd).
    suggestedCaption: d.suggested_caption,
    hashtags: d.hashtags
  }
}

export const createClipsSlice: StateCreator<ProjectStore, [], [], ClipsSlice> = (set, get) => ({
  clips: [],
  selectedClipId: null,
  generating: false,
  generateError: null,
  generatePct: 0,
  generateChunk: null,
  generateJobId: null,
  provisionalClips: [],
  setClips: (clips) => set({ clips }),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  approveClip: (id) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, status: 'approved' } : c)) })),
  rejectClip: (id) => set((s) => ({ clips: s.clips.filter((c) => c.id !== id) })),
  markExported: (ids) => {
    const set_ = new Set(Array.isArray(ids) ? ids : [ids])
    set((s) => ({
      clips: s.clips.map((c) => (set_.has(c.id) ? { ...c, status: 'exported' } : c))
    }))
  },
  /**
   * Runs as a STREAMING JOB, not an invoke (FEAT-c0zn3j). The old
   * `ai.generateClips(req)` had no progress, no cancel and no timeout, so a
   * slow model meant minutes of a frozen button and a wedged one meant quitting
   * the app. The job plane supplies all three.
   *
   * Partials are rendered as PROVISIONAL cards and then thrown away: per-chunk
   * candidates are not de-overlapped across chunks, ranked or clamped, so the
   * `done` result REPLACES them wholesale. Appending them as final would show
   * the user duplicates of the same moment from overlapping chunk windows.
   */
  generateClips: async (req) => {
    set({
      generating: true,
      generateError: null,
      generatePct: 0,
      generateChunk: null,
      provisionalClips: []
    })
    try {
      const result = await runGenerateClips({
        bridge: window.openclip,
        params: req,
        onStart: (jobId) => set({ generateJobId: jobId }),
        onProgress: (pct) => set({ generatePct: Math.round(pct) }),
        onPartial: ({ clips, chunkIndex, chunkCount }) =>
          set((s) => ({
            generateChunk: { index: chunkIndex, count: chunkCount },
            // Kept OUT of `clips` deliberately. `clips` is one of the four refs
            // the autosave subscriber watches, so provisional candidates landing
            // there would be written into the .ocproj — persisting unranked,
            // un-deduped guesses as if the user had accepted them.
            provisionalClips: [
              ...s.provisionalClips,
              ...clips.map((d, i) => detectedToClip(d, chunkIndex * 1000 + i))
            ]
          }))
      })
      set({
        clips: result.clips.map(detectedToClip),
        provisionalClips: [],
        generating: false,
        generatePct: 100,
        generateChunk: null,
        generateJobId: null
      })
    } catch (err) {
      set({
        generating: false,
        generateChunk: null,
        generateJobId: null,
        provisionalClips: [],
        // A cancel is the user's own doing — say nothing rather than presenting
        // their own click back to them as a failure.
        generateError: isCancellation(err) ? null : err instanceof Error ? err.message : String(err)
      })
    }
  },

  cancelGenerate: async () => {
    const jobId = get().generateJobId
    if (!jobId) return
    try {
      await window.openclip.jobs.cancel(jobId)
    } catch {
      /* best-effort — the job may have already settled */
    }
  }
})
