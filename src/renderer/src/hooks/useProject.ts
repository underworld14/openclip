/**
 * src/renderer/src/hooks/useProject.ts — project persistence hook (T-Persist,
 * plan E.3 / P5). A THIN wrapper over `window.openclip.project.*` plus the
 * core-slice hydration this track owns.
 *
 * Design (mirrors `useJob` — a framework-free core + a trivial React wrapper):
 *   - `projectActions(bridge, store)` — the pure, testable core: list/load/save/
 *     delete/new, calling the bridge and hydrating the projectStore CORE slice
 *     (currentProject + recentProjects). No React; unit-tested against the mock
 *     bridge (`tests/mocks/openclip.ts`).
 *   - `useProject()` — memoizes `projectActions` over the real `window.openclip`
 *     and the singleton store; refreshes recents on mount.
 *
 * INTEGRATION (Wave-1, done): on `open()`, the loaded `Project` also carries
 * `transcript` and `clips` — those live in slices owned by OTHER tracks
 * (T-Media's `transcriptSlice`, T-AI's `clipsSlice`). Now that all three slices
 * co-exist on the combined store, `hydrateFromProject` restores ALL of them:
 * the core slice (`setCurrentProject`), the transcript slice (`setTranscript`),
 * and the clips slice (`setClips`). This is integration-owned cross-wiring
 * (the integration agent owns the trunk), not a per-track edit.
 */

import { useEffect, useMemo } from 'react'
import type { Project, SourceVideo } from '@shared/schema'
import { useProjectStore, type ProjectStore, type ProjectMeta } from '@renderer/stores/projectStore'

/**
 * The frozen `window.openclip` bridge surface. We read it off the global `Window`
 * type (declared in `src/preload/index.d.ts`) rather than importing the preload
 * module — the renderer must NOT reach into `src/preload` internals (E.4 /
 * `import/no-restricted-paths`); it consumes the typed bridge surface only.
 */
export type Bridge = Window['openclip']

// ============================================================================
// Minimal store surface the core needs (so the core is store-shape agnostic).
// ============================================================================

/**
 * The zustand store API subset `projectActions` reads/writes. Wave-1 integration
 * widens this beyond the core slice to also include the transcript/clips setters
 * (owned by T-Media / T-AI) so a loaded project restores ALL slices, not just the
 * project document. `useProjectStore` (the full combined store) satisfies this.
 */
export interface CoreStoreApi {
  getState: () => Pick<
    ProjectStore,
    | 'currentProject'
    | 'setCurrentProject'
    | 'setRecentProjects'
    | 'setTranscript'
    | 'setClips'
    | 'setExportHistory'
    | 'selectClip'
    | 'composeProject'
    | 'setReframeMode'
    // Read access for regeneratePosterFrames (BUG-08sb0x) to re-check the
    // live list before folding a regenerated path back in.
    | 'clips'
  >
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Default per-project generation/export settings for a freshly created doc. */
function defaultProjectSettings(): Project['settings'] {
  return {
    targetPlatform: 'all',
    aspectRatio: '9:16',
    clipStyle: 'all',
    maxClips: 5,
    minDuration: 15, // PRD §9.3 default
    maxDuration: 90 // PRD §9.3 default
  }
}

/**
 * Build a blank, schema-valid `Project` for a freshly imported source video
 * (PRD §9.3). Transcript starts empty; clips/exportHistory are []; ids are UUIDs.
 */
export function createBlankProject(name: string, sourceVideo: SourceVideo): Project {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    sourceVideo,
    transcript: { language: '', segments: [], words: [] },
    clips: [],
    settings: defaultProjectSettings(),
    exportHistory: []
  }
}

/**
 * Hydrate ALL projectStore slices from a loaded Project (Wave-1 integration
 * cross-wiring). Restores the core project document, the transcript slice
 * (T-Media's `transcriptSlice`), and the clips slice (T-AI's `clipsSlice`) so a
 * reopened project comes back whole (PRD §5 "Project Save/Load"; plan P5
 * done-when: "quit/reopen restores the full project — source, transcript, clips,
 * edits, settings"). The `Project` schema guarantees `transcript`, `clips`, and
 * `exportHistory` are present (each defaults to []), so no null-guards are needed.
 * `exportHistory` MUST be hydrated here: `composeProject()` reads it from the
 * slice, so without this an opened project's history would be overwritten with []
 * on the next save (and leak across project switches — the slice is a singleton).
 */
export function hydrateFromProject(store: CoreStoreApi, project: Project): void {
  const state = store.getState()
  state.setCurrentProject(project)
  state.setTranscript(project.transcript)
  // Strip `thumbnailPath` on hydrate (BUG-08sb0x): poster frames live in the
  // per-project TEMP cache (PRD §17), not the `.ocproj` — a path surviving in
  // an old document is no proof the file still exists (an OS temp sweep, or the
  // app's own project-delete cleanup for a DIFFERENT project sharing the temp
  // root, can reclaim it independently). Rendering a stale path 404s silently
  // and the clip card is permanently blank. Stripped here IN MEMORY ONLY —
  // this never touches the saved document — so no <img> ever mounts with a
  // path that might not resolve; `open()` kicks off `regeneratePosterFrames`
  // right after to fill them back in with fresh frames.
  state.setClips(project.clips.map((c) => ({ ...c, thumbnailPath: undefined })))
  state.setExportHistory(project.exportHistory)
  // The selection is a singleton too: without this it keeps pointing at a clip id
  // from the OUTGOING project, which no longer exists in `clips` (audit fix
  // BUG-2hjt1x). Every slice this function touches must be replaced, not merged.
  state.selectClip(null)
  // Restore the auto-reframe mode (EPIC-k83ghw / BUG-8kgcxs) — previewSlice
  // used to start every project on 'off' regardless of what was saved, so
  // "Follow speaker" silently reverted to plain centre-crop on every reopen.
  state.setReframeMode(project.settings.reframeMode ?? 'off')
}

/**
 * Regenerate every clip's poster frame after `hydrateFromProject` stripped it
 * (BUG-08sb0x). A single-frame ffmpeg extract is cheap — the same cost
 * `generateThumbnails` (clipsSlice) already pays right after every AI
 * generation — so redoing it unconditionally on every open is not a new
 * performance class, just a different trigger; it is what turns a permanently
 * blank clip card back into a real one without the user doing anything.
 *
 * Sequential (one ffmpeg spawn per clip against one disk) and best-effort: one
 * failed grab costs that clip its thumbnail, never the others, and never blocks
 * the open (the caller does not await this — see `open()`). Bails out if the
 * user has since navigated away from `project` (closed it or opened another)
 * so a slow regeneration for a project no longer open can't stomp on whatever
 * is open now — `clips` is a singleton slice shared by every project.
 */
export async function regeneratePosterFrames(
  bridge: Bridge,
  store: CoreStoreApi,
  project: Project
): Promise<void> {
  for (const clip of project.clips) {
    if (store.getState().currentProject?.id !== project.id) return
    try {
      const { thumbnailPath } = await bridge.video.clipThumbnail({
        projectId: project.id,
        clipId: clip.id,
        sourcePath: project.sourceVideo.path,
        atTime: clip.editedStart ?? clip.startTime,
        aspectRatio: project.settings.aspectRatio
      })
      const state = store.getState()
      if (state.currentProject?.id !== project.id) return
      state.setClips(state.clips.map((c) => (c.id === clip.id ? { ...c, thumbnailPath } : c)))
    } catch {
      /* cosmetic — a missing poster is not fatal */
    }
  }
}

/**
 * Close whatever project is open, clearing every slice `hydrateFromProject`
 * would otherwise leave behind (EPIC-k83ghw / BUG-tdgtfb).
 *
 * Used by File → New Project (Cmd+N) and by deleting the currently-open
 * project. Before this, both left the OUTGOING project's clips/transcript
 * sitting in the (singleton) slices: Cmd+N showed the previous project's
 * clips as though they belonged to the new, empty one — and approving or
 * trimming one there silently wrote it into whatever got created next; and
 * deleting the open project left it fully rendered in the editor after its
 * `.ocproj` and (for an app-owned source) its video were already gone, so the
 * very next edit re-created the document over a deleted file.
 */
export function closeProject(store: CoreStoreApi): void {
  const state = store.getState()
  state.setCurrentProject(null)
  state.setTranscript(null)
  state.setClips([])
  state.setExportHistory([])
  state.selectClip(null)
  // Otherwise a "New Project" inherited whatever reframe mode the CLOSED
  // project happened to leave behind (previewSlice is a singleton too).
  state.setReframeMode('off')
}

/**
 * @deprecated Wave-1 integration superseded core-only hydration with full
 * cross-slice hydration. Retained as an alias for callers/tests that referenced
 * the core-slice helper; it now hydrates every slice via {@link hydrateFromProject}.
 */
export const hydrateCoreFromProject = hydrateFromProject

// ============================================================================
// projectActions — the framework-free core (tested against the mock bridge)
// ============================================================================

export interface ProjectActions {
  /** project:list → write `recentProjects` (Dashboard recents — PRD §11.2). */
  refreshRecents: () => Promise<ProjectMeta[]>
  /** project:load(id) → hydrate currentProject (core slice). */
  open: (id: string) => Promise<Project>
  /** project:save the current project → returns the persisted path (or null). */
  save: () => Promise<{ path: string } | null>
  /** project:delete(id) then refresh the recents list. */
  remove: (id: string) => Promise<{ deleted: boolean }>
  /**
   * Rename a project on disk (FEAT-905vk4).
   *
   * Load → set name → save, rather than a new IPC channel: the name lives in the
   * `.ocproj` document and `project:save` already writes it, so a dedicated
   * channel would be a second way to do the same thing.
   *
   * Deliberately does NOT hydrate the store: renaming a project you are not
   * currently editing must not yank the editor onto it. The one exception is the
   * OPEN project, whose in-memory name is updated so the title bar agrees with
   * the row without a reload.
   */
  rename: (id: string, name: string) => Promise<Project>
  /**
   * Copy a project under a new id (FEAT-905vk4).
   *
   * The copy keeps the transcript and the clips — which is the point: it is how
   * you try a different set of clips without re-transcribing, or keep a version
   * before a destructive trim. Export history is NOT copied: those files belong
   * to the original run and claiming them would be a lie about what the copy has
   * produced.
   */
  duplicate: (id: string) => Promise<Project>
  /** Seed a fresh blank Project into currentProject (does not persist yet). */
  createNew: (name: string, sourceVideo: SourceVideo) => Promise<Project>
}

/**
 * Build the project actions over a bridge + store. Pure (no React) so it is
 * unit-testable with `createMockOpenclip()` + a real `useProjectStore`.
 */
export function projectActions(bridge: Bridge, store: CoreStoreApi): ProjectActions {
  const refreshRecents = async (): Promise<ProjectMeta[]> => {
    const recents = await bridge.project.list()
    store.getState().setRecentProjects(recents)
    return recents
  }

  return {
    refreshRecents,

    open: async (id: string): Promise<Project> => {
      const project = await bridge.project.load({ id })
      hydrateFromProject(store, project)
      // Fire-and-forget (BUG-08sb0x): matches clipsSlice's own post-generation
      // thumbnail pass — the project is usable immediately, posters fill in as
      // they finish.
      void regeneratePosterFrames(bridge, store, project)
      return project
    },

    save: async (): Promise<{ path: string } | null> => {
      // Persist the COMPOSED project (live clips/transcript/exportHistory layered
      // over the document), NOT the stale `currentProject` — otherwise a manual
      // save would drop sibling-slice edits (clip approvals, streamed transcript).
      const project = store.getState().composeProject()
      if (!project) return null
      const res = await bridge.project.save({ project })
      // Reflect the new save in the recents list (updatedAt changed).
      await refreshRecents()
      return res
    },

    remove: async (id: string): Promise<{ deleted: boolean }> => {
      const res = await bridge.project.delete({ id })
      // Deleting the OPEN project must close it in the editor (EPIC-k83ghw /
      // BUG-tdgtfb) — its `.ocproj` and (for an app-owned source) its video
      // are now gone, so leaving it rendered meant the next edit the user
      // made re-created the document over deleted media.
      if (store.getState().currentProject?.id === id) closeProject(store)
      await refreshRecents()
      return res
    },

    rename: async (id: string, name: string): Promise<Project> => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('A project name cannot be empty.')
      const project = await bridge.project.load({ id })
      const renamed: Project = { ...project, name: trimmed, updatedAt: Date.now() }
      await bridge.project.save({ project: renamed })
      // Keep the OPEN project's in-memory name in step, so the title bar and the
      // row cannot disagree — but only when it IS the open one (renaming another
      // project must not switch the editor to it).
      const current = store.getState().currentProject
      if (current?.id === id) store.getState().setCurrentProject(renamed)
      await refreshRecents()
      return renamed
    },

    duplicate: async (id: string): Promise<Project> => {
      const project = await bridge.project.load({ id })
      const now = Date.now()
      let sourceVideo = project.sourceVideo
      const newId = crypto.randomUUID()
      // A file-imported source lives OUTSIDE the app-owned media tree and is
      // shared safely by reference (the app never deletes it). An APP-OWNED
      // source (URL/YouTube import) lives at `media/<projectId>/…` and IS
      // deleted when its owning project is deleted — so without a real copy,
      // deleting the ORIGINAL destroyed the duplicate's video too (EPIC-k83ghw
      // / BUG-tdgtfb). Best-effort: if the copy fails, keep the duplicate
      // pointed at the original path rather than losing the whole duplicate.
      if (sourceVideo.appOwned) {
        try {
          const { path } = await bridge.media.copySource({
            projectId: newId,
            filePath: sourceVideo.path
          })
          sourceVideo = { ...sourceVideo, path }
        } catch {
          /* keep referencing the original's media; duplicate still works until it is deleted */
        }
      }
      const copy: Project = {
        ...project,
        id: newId,
        name: `${project.name} copy`,
        createdAt: now,
        updatedAt: now,
        sourceVideo,
        // The copy has exported nothing yet. Inheriting the original's history
        // would point at files this project never produced.
        exportHistory: []
      }
      await bridge.project.save({ project: copy })
      await refreshRecents()
      return copy
    },

    createNew: async (name: string, sourceVideo: SourceVideo): Promise<Project> => {
      const project = createBlankProject(name, sourceVideo)
      hydrateFromProject(store, project)
      return project
    }
  }
}

// ============================================================================
// useProject — the React hook (thin wrapper around the core)
// ============================================================================

export interface UseProjectResult extends ProjectActions {
  currentProject: Project | null
  recentProjects: ProjectMeta[]
}

/**
 * React hook exposing the project actions + the live store selections. Memoizes
 * `projectActions` over the real `window.openclip` bridge and the singleton
 * store, and refreshes the recents list once on mount.
 */
export function useProject(): UseProjectResult {
  const currentProject = useProjectStore((s) => s.currentProject)
  const recentProjects = useProjectStore((s) => s.recentProjects)

  const actions = useMemo<ProjectActions>(
    () => projectActions(window.openclip, useProjectStore),
    []
  )

  useEffect(() => {
    void actions.refreshRecents()
  }, [actions])

  return { ...actions, currentProject, recentProjects }
}
