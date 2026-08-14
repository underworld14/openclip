/**
 * src/renderer/src/stores/uiStore.ts — global UI state (TRUNK).
 *
 * Plan `uiStore`: `view`, `selectedClipId`, `playhead`, `isPlaying`, `zoom`.
 *
 * The `tasks: Record<jobId,{kind,progress,status}>` map that used to live here
 * is GONE (EPIC-zpa1nd). It was written by the import controller and read by no
 * component, and the `useJob` hook built to feed it had no call sites — a
 * progress model with no surface. Live work now lives in `stores/jobsStore.ts`,
 * which models user-visible ACTIVITIES rather than raw jobs and is rendered by
 * `JobStatusBar`.
 */

import { create } from 'zustand'

export type AppView = 'dashboard' | 'editor' | 'settings'

/**
 * Whether the user's work is on disk (FEAT-51hnwx).
 *
 * The only user-visible signal in the entire persistence path was
 * `toast.error('Autosave failed')`. Success produced nothing at all: no
 * indicator, no last-saved time, no manual save. Users have been trained by
 * every cloud editor to distrust local work they cannot see being saved, and
 * this app's trims and approvals genuinely were being persisted — silently.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface UiStore {
  view: AppView
  selectedClipId: string | null
  playhead: number
  isPlaying: boolean
  zoom: number
  /** Persistence state, rendered in the title bar. */
  saveState: SaveState
  /** `Date.now()` of the last successful write, for the "Saved · 2s ago" label. */
  lastSavedAt: number | null

  setSaveState: (state: SaveState, at?: number) => void
  setView: (view: AppView) => void
  selectClip: (id: string | null) => void
  setPlayhead: (t: number) => void
  setPlaying: (playing: boolean) => void
  setZoom: (zoom: number) => void
}

export const useUiStore = create<UiStore>()((set) => ({
  view: 'dashboard',
  selectedClipId: null,
  playhead: 0,
  isPlaying: false,
  zoom: 1,

  saveState: 'idle',
  lastSavedAt: null,
  setSaveState: (saveState, at) =>
    set(saveState === 'saved' ? { saveState, lastSavedAt: at ?? Date.now() } : { saveState }),
  setView: (view) => set({ view }),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom })
}))
