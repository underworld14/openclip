/**
 * src/renderer/src/stores/projectStore/index.ts — the slice COMBINER (TRUNK,
 * frozen seam — plan E.4).
 *
 * The store is split into one-writer slice files (transcript/clips/export/
 * timeline) plus a small "core" slice for the project document itself. The
 * trunk authors this combiner once; each fan-out track fills only its own
 * slice. Thin actions call `window.openclip` directly so backend tracks never
 * import a store (plan E.4).
 *
 * Store shape mirrors the PRD `Project` model + the plan's `projectStore`
 * description (currentProject + recentProjects + setSource/.../load/save).
 */

import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { Project, SourceVideo, ProjectSettings } from '@shared/schema'

import { createTranscriptSlice, type TranscriptSlice } from './transcriptSlice'
import { createClipsSlice, type ClipsSlice } from './clipsSlice'
import { createExportSlice, type ExportSlice } from './exportSlice'
import { createTimelineSlice, type TimelineSlice } from './timelineSlice'

// ============================================================================
// Core slice — the project document + recents + load/save (TRUNK seam; the
// persistence wiring body is filled by T-Persist, E.3).
// ============================================================================

export interface ProjectMeta {
  id: string
  name: string
  updatedAt: number
  path: string
}

export interface CoreSlice {
  currentProject: Project | null
  recentProjects: ProjectMeta[]
  setCurrentProject: (project: Project | null) => void
  setSource: (sourceVideo: SourceVideo) => void
  setProjectSettings: (settings: Partial<ProjectSettings>) => void
  setRecentProjects: (recents: ProjectMeta[]) => void
  /** Load a project by id via the bridge (body owned by T-Persist). */
  load: (id: string) => Promise<void>
  /** Save the current project via the bridge (body owned by T-Persist). */
  save: () => Promise<void>
}

const createCoreSlice: StateCreator<ProjectStore, [], [], CoreSlice> = (set, get) => ({
  currentProject: null,
  recentProjects: [],
  setCurrentProject: (currentProject) => set({ currentProject }),
  setSource: (sourceVideo) =>
    set((s) => (s.currentProject ? { currentProject: { ...s.currentProject, sourceVideo } } : {})),
  setProjectSettings: (settings) =>
    set((s) =>
      s.currentProject
        ? {
            currentProject: {
              ...s.currentProject,
              settings: { ...s.currentProject.settings, ...settings }
            }
          }
        : {}
    ),
  setRecentProjects: (recentProjects) => set({ recentProjects }),
  load: async (id) => {
    // Thin action: T-Persist fills the body to `window.openclip.project.load`.
    void id
    void get
  },
  save: async () => {
    // Thin action: T-Persist fills the body to `window.openclip.project.save`.
    void get
  }
})

// ============================================================================
// Combined store type + instance (plan E.4: combined once here)
// ============================================================================

export type ProjectStore = CoreSlice & TranscriptSlice & ClipsSlice & ExportSlice & TimelineSlice

export const useProjectStore = create<ProjectStore>()((...a) => ({
  ...createCoreSlice(...a),
  ...createTranscriptSlice(...a),
  ...createClipsSlice(...a),
  ...createExportSlice(...a),
  ...createTimelineSlice(...a)
}))
