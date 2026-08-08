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
  state.setClips(project.clips)
  state.setExportHistory(project.exportHistory)
  // The selection is a singleton too: without this it keeps pointing at a clip id
  // from the OUTGOING project, which no longer exists in `clips` (audit fix
  // BUG-2hjt1x). Every slice this function touches must be replaced, not merged.
  state.selectClip(null)
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
      await refreshRecents()
      return res
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
