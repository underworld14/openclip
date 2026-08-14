/**
 * src/renderer/src/components/generateClips.ts — pure view-model for the App
 * header's "Auto Generate Clips" button (P0 dead-button fix).
 *
 * Kept in its own (non-component) module so `App.tsx` exports only the component
 * (react-refresh/only-export-components) while this mapping logic stays unit-
 * testable in the trunk's node env (no jsdom) — the same pure-core / thin-wrapper
 * split `Dashboard.view`/`import-controller` use.
 *
 * `buildGenerateClipsRequest` maps the OPEN project + app settings into the
 * FROZEN `GenerateClipsRequest` (channels.ts): the AI provider/model come from
 * the app `Settings`, the clip count from `Settings.maxClips`, and the style +
 * platform from the PROJECT's own `settings`. Only segment-level transcript text
 * is forwarded — the local word stream NEVER leaves the machine (PRD §16).
 */

import type { Project, Settings } from '@shared/schema'
import type { GenerateClipsRequest } from '@shared/channels'
import {
  defaultPreflight,
  normalizePreflight,
  sliceSegmentsToRange,
  type PreflightConfig
} from '@shared/generate-preflight'

/**
 * PURE: build the AI clip-generation request from the open project + app
 * settings, optionally overridden by the pre-flight panel (FEAT-n762y6).
 *
 * Segments only — the transcript `words` stay local (PRD §16) — and sliced to
 * the analysis window before they leave, so a user who asked about ten minutes
 * of a three-hour stream is not billed for the other two hours fifty.
 *
 * `preflight` is OPTIONAL: with it absent this reproduces the pre-panel
 * behaviour exactly (project settings + app settings), which is what keeps every
 * existing caller and its tests honest.
 */
export function buildGenerateClipsRequest(
  project: Project,
  settings: Settings,
  preflight?: PreflightConfig
): GenerateClipsRequest {
  const cfg = normalizePreflight(
    preflight ?? defaultPreflight(project, settings),
    project.sourceVideo.duration
  )
  return {
    projectId: project.id,
    provider: settings.aiProvider,
    model: settings.model,
    segments: sliceSegmentsToRange(project.transcript.segments, cfg.range),
    videoTitle: project.name,
    durationSeconds: project.sourceVideo.duration,
    clipStyle: cfg.clipStyle,
    numClips: cfg.numClips,
    targetPlatform: project.settings.targetPlatform,
    // Pass the user's clip-length bounds so the handler honours them instead of its
    // old hard-coded 15/90 (audit fix openclip-t0v).
    minDuration: cfg.minDuration,
    maxDuration: cfg.maxDuration,
    // Omitted rather than sent empty, so an untargeted run produces the same
    // request — and therefore the same cache key — it always did.
    ...(cfg.range ? { range: cfg.range } : {}),
    ...(cfg.keywords.length > 0 ? { keywords: cfg.keywords } : {}),
    ...(cfg.customPrompt ? { customPrompt: cfg.customPrompt } : {})
  }
}

/** Seams the click handler reads/dispatches (so the core is store-agnostic). */
export interface GenerateClipsHandlerDeps {
  getProject: () => Project | null
  getSettings: () => Settings
  generateClips: (req: GenerateClipsRequest) => Promise<void>
  /** The pre-flight panel's config, when the user configured the run (FEAT-n762y6). */
  getPreflight?: () => PreflightConfig | undefined
  /**
   * Surface for the "nothing to generate from" precondition. The button's enabled
   * state (`hasTranscript`) and this handler's precondition (a composable project)
   * are computed from different things and CAN disagree; when they do the click
   * must say something rather than dead-end (audit fix BUG-19bt2k).
   */
  onError?: (message: string) => void
}

/**
 * Build the "Auto Generate Clips" click handler. No-ops when no project is open
 * (a request cannot be built); otherwise composes the request and dispatches it
 * through the injected `generateClips` action.
 */
export function createGenerateClipsHandler(deps: GenerateClipsHandlerDeps): () => Promise<void> {
  return async () => {
    const project = deps.getProject()
    if (!project) {
      deps.onError?.('No project is open — import a video before generating clips.')
      return
    }
    await deps.generateClips(
      buildGenerateClipsRequest(project, deps.getSettings(), deps.getPreflight?.())
    )
  }
}
