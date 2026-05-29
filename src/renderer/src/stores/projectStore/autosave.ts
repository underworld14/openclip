/**
 * src/renderer/src/stores/projectStore/autosave.ts — autosave SUBSCRIBER
 * (Wave-1 integration cross-wiring).
 *
 * T-Persist shipped the debounced `createAutosave` helper but left it with NO
 * subscriber (plan E.3 P5: "debounced autosave in projectStore"). This wires it
 * to the store: whenever `currentProject` changes to a non-null, DIFFERENT value
 * the edit is scheduled for a debounced save through the `window.openclip`
 * bridge (`project.save`). Rapid edits coalesce into one write (PRD §5 / §19 P5
 * "autosave"; §12.3 local `.ocproj` persistence).
 *
 * Design mirrors the rest of the renderer: a FRAMEWORK-FREE core
 * (`startAutosave`) that takes the store + a `save` callback (so it is unit-
 * testable against a real `useProjectStore` + a spy), plus `installAutosave()`
 * which wires the singleton store to the real bridge save and is invoked once at
 * app start.
 */

import { createAutosave } from '@shared/autosave'
import type { Project } from '@shared/schema'
import { useProjectStore, type ProjectStore } from './index'

/** The minimal zustand store surface the autosave subscriber needs. */
export interface AutosaveStoreApi {
  getState: () => Pick<ProjectStore, 'currentProject'>
  subscribe: (listener: (state: ProjectStore, prev: ProjectStore) => void) => () => void
}

/** Stop an active autosave subscription and flush/cancel any pending write. */
export type StopAutosave = () => void

/**
 * Subscribe `save` (debounced) to `currentProject` changes on `store`.
 *
 * Fires only when `currentProject` transitions to a non-null project whose
 * reference differs from the previous one — i.e. on real edits (slice setters
 * return new project objects), never on unrelated slice updates or on a clear
 * to `null` (closing a project). Returns a teardown that flushes the pending
 * write (so an in-flight edit is not lost) and unsubscribes.
 */
export function startAutosave(
  store: AutosaveStoreApi,
  save: (project: Project) => Promise<void> | void,
  delayMs?: number
): StopAutosave {
  const autosave = createAutosave<Project>(save, delayMs)

  const unsubscribe = store.subscribe((state, prev) => {
    const next = state.currentProject
    if (next && next !== prev.currentProject) {
      autosave(next)
    }
  })

  return () => {
    unsubscribe()
    void autosave.flush()
  }
}

/**
 * Wire autosave for the singleton project store to the real bridge save. Called
 * once at app start (see `App.tsx`). Returns a teardown for symmetry/tests.
 */
export function installAutosave(delayMs?: number): StopAutosave {
  return startAutosave(
    useProjectStore,
    async (project) => {
      await window.openclip.project.save({ project })
    },
    delayMs
  )
}
