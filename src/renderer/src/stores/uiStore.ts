/**
 * src/renderer/src/stores/uiStore.ts — global UI state (TRUNK).
 *
 * Plan `uiStore`: `view`, `selectedClipId`, `playhead`, `isPlaying`, `zoom`,
 * and a `tasks: Record<jobId,{kind,progress,status}>` map FED BY JOB PORTS via
 * the `useJob` hook's `onTask` callback. The `upsertTask` action is the seam
 * `useJob` calls; components read the map for queue/progress UI.
 */

import { create } from 'zustand'
import type { JobKind } from '@shared/jobs'
import type { JobStatus } from '@renderer/hooks/useJob'

export type AppView = 'dashboard' | 'editor' | 'settings'

export interface TaskState {
  jobId: string
  kind: JobKind
  progress: number
  status: JobStatus
}

export interface UiStore {
  view: AppView
  selectedClipId: string | null
  playhead: number
  isPlaying: boolean
  zoom: number
  /** Live jobs keyed by jobId, fed by `useJob` (plan: tasks map from ports). */
  tasks: Record<string, TaskState>

  setView: (view: AppView) => void
  selectClip: (id: string | null) => void
  setPlayhead: (t: number) => void
  setPlaying: (playing: boolean) => void
  setZoom: (zoom: number) => void
  /** Insert/update a task entry from a streamed job event. */
  upsertTask: (task: TaskState) => void
  /** Remove a finished/cancelled task. */
  clearTask: (jobId: string) => void
}

export const useUiStore = create<UiStore>()((set) => ({
  view: 'dashboard',
  selectedClipId: null,
  playhead: 0,
  isPlaying: false,
  zoom: 1,
  tasks: {},

  setView: (view) => set({ view }),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom }),
  upsertTask: (task) => set((s) => ({ tasks: { ...s.tasks, [task.jobId]: task } })),
  clearTask: (jobId) =>
    set((s) => {
      const next = { ...s.tasks }
      delete next[jobId]
      return { tasks: next }
    })
}))
