/**
 * useImportController — the thin React wrapper around the framework-free
 * `createImportController` core (import-controller.ts). It wires the controller's
 * injected seams to the real `window.openclip` bridge + the zustand stores, and
 * mirrors the core's `getState()` into React via `useSyncExternalStore`.
 *
 * All the testable logic (consent gate, model gate, progress banding, the G.3
 * re-import flush-save) lives in the core; this file only does the wiring.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { WhisperModelSize } from '@shared/jobs'
import type { Project } from '@shared/schema'
import { createBlankProject, hydrateFromProject } from '@renderer/hooks/useProject'
import { createImportController } from '@renderer/hooks/import-controller'
import { notifyNeedModel, setNeedModelHandler } from '@renderer/hooks/importControllerHost'
import type {
  ImportController as CoreImportController,
  PendingImport
} from '@renderer/hooks/import-controller'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useJobsStore } from '@renderer/stores/jobsStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'

export interface ImportControllerOptions {
  /** Open the first-run model-download dialog when the whisper model is absent. */
  onNeedModel?: (model: WhisperModelSize) => void
}

export interface ImportController {
  busy: boolean
  pct: number
  stage: string
  error: string | null
  /** True when a URL import is blocked awaiting the one-time TOS consent. */
  needsConsent: boolean
  acceptConsent: () => void
  declineConsent: () => void
  importFile: (path: string) => Promise<void>
  importUrl: (url: string) => Promise<void>
  /** Smart entry: routes to importUrl/importFile by detecting an http(s) URL. */
  importAny: (value: string) => Promise<void>
  /** Cancel the in-flight import (download/transcribe) — openclip-2bm. */
  cancel: () => Promise<void>
  /** The import a missing whisper model turned away, if any (FEAT-kncqxf). */
  pendingImport: PendingImport | null
  /** Replay that import once the model is installed. */
  resumePending: () => Promise<void>
  /** Forget it — the user cancelled the download instead. */
  discardPending: () => void
}

/**
 * The controller is a MODULE SINGLETON, not per-component state.
 *
 * It used to be built in a `useMemo` inside this hook, which meant every caller
 * got its own instance and — worse — the instance died with the component. The
 * ImportPanel unmounts partway through a first-run import (App swaps to the
 * editor as soon as the first transcript partial lands), taking the in-flight
 * import's progress, cancel and error state with it. A single shared instance
 * lets any component observe the same import, and lets App resume the import the
 * model dialog interrupted (FEAT-kncqxf) even though ImportPanel started it.
 *
 * The seams it closes over are all module-level zustand stores and
 * `window.openclip`, so there is nothing per-component to capture.
 */
let sharedController: CoreImportController | null = null

/**
 * TEST-ONLY: drop the shared instance so each spec starts from a clean slate
 * (mirrors `__resetImportHostForTests`). Without it every spec in a file would
 * inherit the previous one's in-flight state, and the singleton would close over
 * the first test's mock bridge for the rest of the run.
 */
export function __resetImportControllerForTests(): void {
  sharedController = null
}

export function useImportController(opts: ImportControllerOptions = {}): ImportController {
  // Keep onNeedModel current without rebuilding the controller (which would drop
  // its in-flight state). Synced in an effect (refs must not be written during
  // render); the controller only invokes it asynchronously, after effects run.
  // Registered in a MODULE-level slot, not captured in the controller's closure.
  // The controller is a singleton built by whichever component's hook runs first
  // — which is always the parent, App — so a closed-over ref meant a child's
  // callback was never seen and the model dialog stopped opening entirely.
  const onNeedModelRef = useRef(opts.onNeedModel)
  useEffect(() => {
    onNeedModelRef.current = opts.onNeedModel
    setNeedModelHandler(opts.onNeedModel)
  }, [opts.onNeedModel])

  // zustand action refs are stable across renders.
  const appendPartial = useProjectStore((s) => s.appendTranscriptPartial)
  const hydrate = useProjectStore((s) => s.hydrateTranscript)
  // NOT setCurrentProject: an import must replace every slice, or the outgoing
  // project's clips/exportHistory/selection leak into the new one (BUG-2hjt1x).
  const hydrateProject = useCallback((project: Project): void => {
    hydrateFromProject(useProjectStore, project)
  }, [])
  const setView = useUiStore((s) => s.setView)
  // The app-level job registry the persistent status bar renders (EPIC-zpa1nd).
  const beginTask = useJobsStore((s) => s.beginTask)
  const updateTask = useJobsStore((s) => s.updateTask)
  const settleTask = useJobsStore((s) => s.settleTask)

  const controller = useMemo(
    () =>
      (sharedController ??= createImportController({
        bridge: window.openclip,
        createBlankProject,
        store: {
          getCurrentProject: () => useProjectStore.getState().currentProject,
          composeProject: () => useProjectStore.getState().composeProject(),
          hydrateProject,
          appendTranscriptPartial: appendPartial,
          hydrateTranscript: hydrate,
          saveProject: async (project) => {
            await window.openclip.project.save({ project })
          }
        },
        ui: {
          setView,
          beginTask: (t) => {
            beginTask({
              id: t.id,
              kind: 'import',
              label: t.label,
              stages: t.stages,
              cancel: t.cancel,
              retry: t.retry
            })
          },
          updateTask,
          settleTask
        },
        // Read the transcription language lazily at import time (Part I) so the
        // latest Settings value applies without rebuilding the controller.
        getLanguage: () => useSettingsStore.getState().settings.language,
        // Lazily read so a change in Settings applies to the next import
        // (FEAT-1k76hk) — the controller is a singleton and is never rebuilt.
        getWhisperModel: () => useSettingsStore.getState().settings.whisperModel,
        onNeedModel: (m) => notifyNeedModel(m)
      })),
    // Built once for the whole app; all referenced actions are stable zustand refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  return {
    busy: state.busy,
    pct: state.pct,
    stage: state.stage,
    error: state.error,
    needsConsent: state.needsConsent,
    acceptConsent: controller.acceptConsent,
    declineConsent: controller.declineConsent,
    importFile: controller.importFile,
    importUrl: controller.importUrl,
    importAny: controller.importAny,
    cancel: controller.cancel,
    pendingImport: state.pendingImport,
    resumePending: controller.resumePending,
    discardPending: controller.discardPending
  }
}
