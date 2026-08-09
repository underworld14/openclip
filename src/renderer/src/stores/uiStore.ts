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

export interface UiStore {
  view: AppView
  selectedClipId: string | null
  playhead: number
  isPlaying: boolean
  zoom: number

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

  setView: (view) => set({ view }),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom })
}))
