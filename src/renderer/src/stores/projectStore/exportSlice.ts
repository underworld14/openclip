/**
 * exportSlice — export composition + history within projectStore (EXPORT spine,
 * plan E.5 / E.4 slice pattern; PRD §6.9). Thin actions; the live FFmpeg
 * progress stream is driven by `runExport` in ExportPanel (a MessagePort cannot
 * live in the store), while THIS slice owns the pure, testable pieces:
 *
 *   - `composeProject()` — the INTEGRATION-GAP fix (plan Gate C / task 5): build
 *     the Project to export/persist from the LIVE slice state (clipsSlice +
 *     transcriptSlice) layered over `currentProject`, so the exported clip set
 *     reflects current edits/approvals + the streamed transcript rather than a
 *     stale `currentProject.clips`. The clipsSlice is the source of truth for
 *     clips; the transcriptSlice for the transcript.
 *   - `buildExportParams()` — map a clip + source + settings + chosen output path
 *     to `JobParams['export']`, applying the SHARED pure `resolveBounds(clip)`
 *     (critic fix M2) so the cut span honours the timeline trim.
 *   - `addExportRecord()` — append an ExportRecord to history after a `done`.
 */

import type { StateCreator } from 'zustand'
import type {
  ExportRecord,
  Project,
  Clip,
  SourceVideo,
  ProjectSettings,
  CaptionStyle,
  WordTimestamp
} from '@shared/schema'
import type { JobParams } from '@shared/jobs'
import { resolveBounds } from '@shared/clip-bounds'
import type { ProjectStore } from './index'

export interface ExportSlice {
  exportHistory: ExportRecord[]
  addExportRecord: (record: ExportRecord) => void
  /**
   * Replace the whole export-history slice. Called by `hydrateFromProject` on
   * open/new so the slice mirrors the loaded `.ocproj` (and resets to `[]` for a
   * fresh project). WITHOUT this, `composeProject()` would persist a stale `[]`
   * over an opened project's real history, and one project's records would leak
   * into the next (the slice is a singleton, never reset on switch).
   */
  setExportHistory: (history: ExportRecord[]) => void
  /**
   * Compose the Project to export/persist from LIVE slice state (integration-gap
   * fix). Returns null when there is no open project. The returned Project layers
   * the live clips + transcript over the current project document.
   */
  composeProject: () => Project | null
}

/**
 * PURE: layer the live clips + transcript + export history over a base project so
 * the composed document reflects current edits/approvals + the streamed
 * transcript + the latest export records (not the stale snapshot the project was
 * loaded with). Exported for direct unit testing without a store (plan Gate C
 * integration test). The persistence-cluster fix added `exportHistory` so an
 * export-record save persists the LIVE history rather than the stale one.
 */
export function composeLiveProject(
  base: Project,
  clips: Clip[],
  transcript: Project['transcript'] | null,
  exportHistory: ExportRecord[]
): Project {
  return {
    ...base,
    clips,
    transcript: transcript ?? base.transcript,
    exportHistory
  }
}

/**
 * PURE: build the export job params for a clip. The cut span is the SHARED
 * `resolveBounds(clip)` (editedStart/End ?? startTime/endTime — fix M2), so a
 * timeline trim is honoured here exactly as it is in the timeline. Throws on a
 * non-positive span (the caller surfaces it before starting the job).
 */
export function buildExportParams(args: {
  projectId: string
  clip: Clip
  source: SourceVideo
  settings: Pick<ProjectSettings, 'aspectRatio'> & { fitMode?: JobParams['export']['fitMode'] }
  outputPath: string
  quality?: '720p' | '1080p'
  assPath?: string
  /**
   * Burn word-level karaoke captions (PRD §6.4). When true, the project's
   * transcript words (ABSOLUTE seconds) + the chosen style are threaded into
   * `JobParams['export'].captions`; the export runner scopes+rebases them to the
   * clip's resolved bounds and burns the generated .ass in the same re-encode.
   */
  captionsEnabled?: boolean
  /** The full transcript word stream (kept local; PRD §16). Required when captionsEnabled. */
  words?: WordTimestamp[]
  /** Caption style to map to ASS (font/size/color/bg/position/animation). */
  captionStyle?: CaptionStyle
  /**
   * Part K (emoji) — BYOK-AI emoji map (normalized word → emoji) for the export's
   * captions, used when the style's `autoEmoji === 'ai'`. Absent ⇒ local dict.
   */
  aiEmojiMap?: Record<string, string>
  /** Remove long silences via jump-cuts (Part I.4, opt-in). */
  removeSilence?: JobParams['export']['removeSilence']
  /** Auto-reframe mode (Part J, opt-in): follow the speaker / split-screen. */
  reframe?: JobParams['export']['reframe']
  /** Brand-kit logo overlay (Part K, Step 5). Threaded into the export job; the
   * runner/ffmpeg render it (overlay rendering lands in the logo follow-up). */
  logoPath?: string
  logoPosition?: JobParams['export']['logoPosition']
  logoScale?: number
  logoMargin?: number
  /**
   * App Setting "force CPU" (PRD §14). Declared in the schema and honoured by
   * `codecArgs()` since day one, but with no field to carry it there the toggle
   * was inert (BUG-jt3d62). Absent ⇒ hardware encode, as before.
   */
  forceCpu?: boolean
}): JobParams['export'] {
  const { start, end } = resolveBounds(args.clip)
  if (!(end > start)) {
    throw new Error(`export: clip "${args.clip.id}" has a non-positive span (${start}..${end})`)
  }
  return {
    projectId: args.projectId,
    clipId: args.clip.id,
    sourcePath: args.source.path,
    startTime: start,
    endTime: end,
    aspectRatio: args.settings.aspectRatio,
    // How a mismatched source is fitted (FEAT-bd87vz). Absent ⇒ `fill`, the
    // historical centre-crop — which silently cut content out of an already
    // portrait or square source.
    fitMode: args.settings.fitMode,
    outputPath: args.outputPath,
    forceCpu: args.forceCpu,
    assPath: args.assPath,
    captions:
      args.captionsEnabled && args.words && args.words.length > 0
        ? // Part K: thread the clip's AI keywords so a template with keyword
          // emphasis recolors/scales them; harmless when the style has none. The
          // aiEmojiMap is used only when the style's autoEmoji === 'ai'.
          {
            words: args.words,
            style: args.captionStyle,
            keywords: args.clip.keywords,
            aiEmojiMap: args.aiEmojiMap
          }
        : undefined,
    removeSilence: args.removeSilence,
    // Auto-reframe (Part J): pass the source pixel size + fps so the runner's
    // face-detection step needn't re-ffprobe. Only meaningful when reframe != off.
    reframe: args.reframe,
    sourceResolution: {
      width: args.source.resolution.width,
      height: args.source.resolution.height
    },
    fps: args.source.fps,
    // Brand-kit logo (Part K, Step 5) — absent ⇒ no overlay (current behavior).
    logoPath: args.logoPath,
    logoPosition: args.logoPosition,
    logoScale: args.logoScale,
    logoMargin: args.logoMargin,
    quality: args.quality ?? '1080p'
  }
}

export const createExportSlice: StateCreator<ProjectStore, [], [], ExportSlice> = (set, get) => ({
  exportHistory: [],
  addExportRecord: (record) => set((s) => ({ exportHistory: [...s.exportHistory, record] })),
  setExportHistory: (exportHistory) => set({ exportHistory }),
  composeProject: () => {
    const { currentProject, clips, transcript, exportHistory } = get()
    if (!currentProject) return null
    return composeLiveProject(currentProject, clips, transcript, exportHistory)
  }
})
