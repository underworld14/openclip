/**
 * src/renderer/src/stores/projectStore/autosave.ts — autosave SUBSCRIBER
 * (Wave-1 integration cross-wiring; persistence-cluster fix
 * openclip-f3d/3y8/9i7/gcz).
 *
 * T-Persist shipped the debounced `createAutosave` helper but left it with NO
 * subscriber (plan E.3 P5: "debounced autosave in projectStore"). This wires it
 * to the store: whenever the project document OR any of the SIBLING slices it is
 * composed from (clips / transcript / export history) change, the edit is
 * scheduled for a debounced save through the `window.openclip` bridge
 * (`project.save`). Rapid edits coalesce into one write (PRD §5 / §19 P5
 * "autosave"; §12.3 local `.ocproj` persistence).
 *
 * THE CLUSTER FIX: autosave originally fired only on a `currentProject`
 * REFERENCE change — but clip approvals, the streamed transcript, and export
 * records live in OTHER slices, so those edits never triggered a save (and an
 * export-record save would persist a stale history). The subscriber now fires on
 * ANY of `currentProject | clips | transcript | exportHistory` changing, and
 * saves the COMPOSED project (`composeProject()` — live slices layered over the
 * document) rather than the raw `currentProject`. Transient slices (timeline
 * playhead/zoom, preview toggles, `transcriptSearch`) are NOT among the four
 * trigger refs, so they never schedule a save.
 *
 * Design mirrors the rest of the renderer: a FRAMEWORK-FREE core
 * (`startAutosave`) that takes the store + a `save` callback (so it is unit-
 * testable against a real `useProjectStore` + a spy), plus `installAutosave()`
 * which wires the singleton store to the real bridge save and is invoked once at
 * app start.
 */

import { toast } from 'sonner'
import { createAutosave } from '@shared/autosave'
import type { Project } from '@shared/schema'
import { hasActiveKind, useJobsStore } from '@renderer/stores/jobsStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useProjectStore, type ProjectStore } from './index'

/** The minimal zustand store surface the autosave subscriber needs. */
export interface AutosaveStoreApi {
  getState: () => Pick<
    ProjectStore,
    'currentProject' | 'clips' | 'transcript' | 'exportHistory' | 'composeProject'
  >
  subscribe: (listener: (state: ProjectStore, prev: ProjectStore) => void) => () => void
}

/** Stop an active autosave subscription and flush any pending write. */
export type StopAutosave = () => void

/**
 * `startAutosave`'s teardown, which ALSO carries `flush()` so a host (e.g.
 * `installAutosave`'s `pagehide` handler) can force the pending debounced save
 * WITHOUT tearing the subscription down.
 */
export interface StopAutosaveWithFlush {
  (): void
  /** Save the pending debounced project immediately (no-op when nothing pending). */
  flush: () => Promise<void>
  /**
   * Lift a suspension: if edits were swallowed while `isSuspended` was true,
   * schedule exactly one save for the latest state. No-op when nothing was
   * swallowed.
   */
  resume: () => void
}

export interface AutosaveOptions {
  /**
   * While this returns true, edits are COALESCED rather than scheduled — one
   * `resume()` later writes the final state once.
   *
   * This exists because the project is now committed at probe time
   * (FEAT-ky1jfw), so a running transcription streams partials into an OPEN
   * project. `transcript` is one of the four refs that trigger a save, and
   * whisper emits a partial every few words, so a ten-minute transcription
   * would otherwise serialize and write the whole (growing) `.ocproj` every
   * 800ms — hundreds of writes of data that is about to be replaced wholesale
   * by the terminal `hydrateTranscript`.
   */
  isSuspended?: () => boolean
}

/**
 * Subscribe `save` (debounced) to project edits on `store`.
 *
 * Fires when there is an open project AND any of the four composed-project
 * inputs changed reference: `currentProject | clips | transcript |
 * exportHistory` (slice setters return new objects on real edits). Never fires
 * on unrelated/transient slice updates, nor when `currentProject` is null
 * (closing a project). The saved payload is the COMPOSED project so sibling-slice
 * edits (clip approvals, the streamed transcript, export records) are persisted.
 *
 * `onError` (optional) receives any rejection from `save` — both the debounced
 * timer path and the teardown flush route through it, so a failed write can
 * never surface as an unhandled promise rejection. Returns a teardown that
 * flushes the pending write (so an in-flight edit is not lost) and unsubscribes.
 */
export function startAutosave(
  store: AutosaveStoreApi,
  /**
   * `opts.clipsOnly` is true when nothing outside clips/exportHistory changed
   * since the last write, so the caller can persist a delta instead of the whole
   * document (BUG-g6zq2t). Callers may ignore it and always save in full.
   */
  save: (project: Project, opts?: { clipsOnly: boolean }) => Promise<void> | void,
  delayMs?: number,
  onError?: (err: unknown) => void,
  opts: AutosaveOptions = {}
): StopAutosaveWithFlush {
  // Wrap `save` so a rejection routes to `onError` instead of bubbling as an
  // unhandled rejection (the debounce fires `void fire()` on its timer, and the
  // teardown `void flush()` is fire-and-forget — both must not throw uncaught).
  const guardedSave = async (project: Project): Promise<void> => {
    try {
      // Hand the caller the hint it needs to pick the cheap path. Read and reset
      // HERE, at the moment of the actual write, so a burst that coalesced a
      // full-document edit with clip edits still takes the full path.
      const clipsOnly = !pendingFullSave
      pendingFullSave = false
      await save(project, { clipsOnly })
    } catch (err) {
      onError?.(err)
    }
  }
  const autosave = createAutosave<Project>(guardedSave, delayMs)

  // Set when an edit arrived during a suspension, so `resume()` knows there is
  // something to write. Deliberately a bare flag, not a queued project: the
  // point is to write the LATEST state once, not to replay what was skipped.
  let dirtyWhileSuspended = false

  // STICKY: set by any edit that touches something outside clips/exportHistory,
  // cleared only when a write actually happens. It has to be sticky rather than
  // last-write-wins — a burst can coalesce a transcript change and a clip
  // approval into ONE write, and taking the delta path there would silently drop
  // the transcript change. One full-document edit in the window forces the full
  // save (BUG-g6zq2t).
  let pendingFullSave = false

  const saveLatest = (): void => {
    const composed = store.getState().composeProject()
    if (composed) autosave(composed)
  }

  const unsubscribe = store.subscribe((state, prev) => {
    // Gate on an open project — closing a project (→ null) must not save.
    if (!state.currentProject) return
    // Fire on any of the four composed-project inputs changing reference. A
    // transient slice (search / playhead / preview toggle) leaves all four
    // unchanged and so does NOT schedule a save.
    const changed =
      state.currentProject !== prev.currentProject ||
      state.clips !== prev.clips ||
      state.transcript !== prev.transcript ||
      state.exportHistory !== prev.exportHistory
    if (!changed) return
    if (opts.isSuspended?.()) {
      dirtyWhileSuspended = true
      // Force the FULL path for the write that `resume()` will do. The
      // suspension exists precisely because an import is streaming transcript
      // partials, so the deferred write is the one that must carry the
      // transcript — taking the delta path there would drop it (BUG-g6zq2t).
      pendingFullSave = true
      return
    }
    // Did anything OUTSIDE clips/exportHistory move? If not, the transcript is
    // dead weight: shipping it costs a ~1.85 MB structured clone across the
    // contextBridge and a full-document rewrite to persist a few hundred bytes
    // of clip state (BUG-g6zq2t). Approve, reject and a settled trim drag all
    // land here, which is nearly every edit a user makes.
    const clipsOnly =
      state.transcript === prev.transcript && state.currentProject === prev.currentProject
    if (!clipsOnly) pendingFullSave = true
    saveLatest()
  })

  const stop = (() => {
    unsubscribe()
    void autosave.flush()
  }) as StopAutosaveWithFlush
  // Expose the debounce flush so a host can persist a pending edit on quit
  // without tearing down the subscription (used by installAutosave's pagehide).
  stop.flush = () => autosave.flush()
  stop.resume = () => {
    if (!dirtyWhileSuspended) return
    dirtyWhileSuspended = false
    saveLatest()
  }
  return stop
}

/**
 * Wire autosave for the singleton project store to the real bridge save. Called
 * once at app start (see `App.tsx`). A failed write surfaces as a `sonner` toast
 * (default `onError`). Also flushes the pending debounce on `pagehide`
 * (Cmd-Q / window close) so an in-flight edit is persisted before teardown, and
 * removes that listener in the returned teardown. Returns a teardown for
 * symmetry/tests.
 */
export function installAutosave(delayMs?: number, onError?: (err: unknown) => void): StopAutosave {
  const handleError =
    onError ??
    ((err: unknown): void => {
      useUiStore.getState().setSaveState('error')
      toast.error('Autosave failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    })

  const stop = startAutosave(
    useProjectStore,
    async (project, opts) => {
      // Persistence was entirely silent on success (FEAT-51hnwx) — the title bar
      // now shows it, so a user can see their trims and approvals are safe
      // instead of having to trust that they are.
      useUiStore.getState().setSaveState('saving')
      if (opts?.clipsOnly) {
        // The patch path reads the on-disk document to merge into. If this
        // project has never been written (no `.ocproj` yet) that read fails, so
        // fall back to the full save rather than losing the edit. Belt and
        // braces: a project always reaches the store via setCurrentProject /
        // hydrateProject first, which forces a full save.
        try {
          // The common case: approve/reject/trim. Ships clips + export history and
          // NOT the transcript, whose word array dominates the document.
          await window.openclip.project.savePatch({
            id: project.id,
            clips: project.clips,
            exportHistory: project.exportHistory,
            settings: project.settings,
            name: project.name
          })
          useUiStore.getState().setSaveState('saved')
          return
        } catch {
          await window.openclip.project.save({ project })
          useUiStore.getState().setSaveState('saved')
          return
        }
      }
      await window.openclip.project.save({ project })
      useUiStore.getState().setSaveState('saved')
    },
    delayMs,
    handleError,
    // Hold off while an import is streaming transcript partials into the open
    // project (see AutosaveOptions.isSuspended).
    { isSuspended: () => hasActiveKind('import') }
  )

  // …and write once when it lets go. Without this the terminal
  // `hydrateTranscript` — the one write that actually matters — would be
  // swallowed by the suspension and the finished transcript never persisted.
  let importWasActive = hasActiveKind('import')
  const unsubscribeJobs = useJobsStore.subscribe(() => {
    const active = hasActiveKind('import')
    if (importWasActive && !active) stop.resume()
    importWasActive = active
  })

  // Flush the pending debounced save on Cmd-Q / window close so an in-flight edit
  // is persisted before teardown (the guarded save routes any failure to
  // `handleError`). `stop.flush()` drives the real debounce, not a parallel save.
  const onPageHide = (): void => {
    void stop.flush()
  }
  window.addEventListener('pagehide', onPageHide)

  // Quit-time flush (audit fix openclip-49y): on Cmd-Q the main process HOLDS the quit and
  // sends FLUSH_BEFORE_QUIT, which the preload re-posts as this window message (matching
  // the preload's QUIT_FLUSH_MESSAGE constant). Flush the pending debounced save, then ACK
  // via `system.autosaveFlushed()` so main quits the instant the write lands — closing the
  // gap where pagehide's async flush races renderer teardown.
  const QUIT_FLUSH_MESSAGE = 'openclip:flush-before-quit'
  const onQuitFlush = (event: MessageEvent): void => {
    if ((event.data as { __openclip?: unknown })?.__openclip !== QUIT_FLUSH_MESSAGE) return
    void stop.flush().finally(() => {
      void window.openclip.system.autosaveFlushed()
    })
  }
  window.addEventListener('message', onQuitFlush)

  return () => {
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('message', onQuitFlush)
    unsubscribeJobs()
    stop()
  }
}
