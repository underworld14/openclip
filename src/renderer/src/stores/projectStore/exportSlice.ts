/**
 * exportSlice — export-history/queue within projectStore (STUB; owned by the
 * export spine, E.5). Plan E.4 slice pattern. Thin actions call
 * `window.openclip` directly. The trunk ships the slice shape only.
 */

import type { StateCreator } from 'zustand'
import type { ExportRecord } from '@shared/schema'
import type { ProjectStore } from './index'

export interface ExportSlice {
  exportHistory: ExportRecord[]
  addExportRecord: (record: ExportRecord) => void
}

export const createExportSlice: StateCreator<ProjectStore, [], [], ExportSlice> = (set) => ({
  exportHistory: [],
  addExportRecord: (record) => set((s) => ({ exportHistory: [...s.exportHistory, record] }))
})
