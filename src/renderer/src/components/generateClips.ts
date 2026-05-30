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

/**
 * PURE: build the AI clip-generation request from the open project + app
 * settings. Segments only — the transcript `words` stay local (PRD §16).
 */
export function buildGenerateClipsRequest(
  project: Project,
  settings: Settings
): GenerateClipsRequest {
  return {
    projectId: project.id,
    provider: settings.aiProvider,
    model: settings.model,
    segments: project.transcript.segments,
    videoTitle: project.name,
    durationSeconds: project.sourceVideo.duration,
    clipStyle: project.settings.clipStyle,
    numClips: settings.maxClips,
    targetPlatform: project.settings.targetPlatform
  }
}

/** Seams the click handler reads/dispatches (so the core is store-agnostic). */
export interface GenerateClipsHandlerDeps {
  getProject: () => Project | null
  getSettings: () => Settings
  generateClips: (req: GenerateClipsRequest) => Promise<void>
}

/**
 * Build the "Auto Generate Clips" click handler. No-ops when no project is open
 * (a request cannot be built); otherwise composes the request and dispatches it
 * through the injected `generateClips` action.
 */
export function createGenerateClipsHandler(deps: GenerateClipsHandlerDeps): () => Promise<void> {
  return async () => {
    const project = deps.getProject()
    if (!project) return
    await deps.generateClips(buildGenerateClipsRequest(project, deps.getSettings()))
  }
}
