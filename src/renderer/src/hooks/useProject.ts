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
 * INTEGRATION TODO (post-I1): on `open()`, the loaded `Project` also carries
 * `transcript` and `clips` — those belong to slices OWNED BY OTHER TRACKS
 * (T-Media's `transcriptSlice`, T-AI's `clipsSlice`) which are built
 * concurrently. We hydrate ONLY the core slice here. When the slices land at
 * integration, extend `hydrateFromProject` to also call
 * `store.getState().setTranscript(project.transcript)` and `setClips(...)`.
 * Those setters are intentionally NOT touched now (one-writer-per-file, E.4).
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

/** The zustand store API subset `projectActions` reads/writes. */
export interface CoreStoreApi {
  getState: () => Pick<ProjectStore, 'currentProject' | 'setCurrentProject' | 'setRecentProjects'>
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
 * Hydrate the projectStore CORE slice from a loaded Project. Only the core slice
 * (currentProject) is this track's to write. See the INTEGRATION TODO at the top
 * of the file for the transcript/clips slices owned by other tracks.
 */
export function hydrateCoreFromProject(store: CoreStoreApi, project: Project): void {
  store.getState().setCurrentProject(project)
}

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
      hydrateCoreFromProject(store, project)
      return project
    },

    save: async (): Promise<{ path: string } | null> => {
      const current = store.getState().currentProject
      if (!current) return null
      const res = await bridge.project.save({ project: current })
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
      hydrateCoreFromProject(store, project)
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
