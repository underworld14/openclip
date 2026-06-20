/**
 * useImportController — the thin React wrapper around the framework-free
 * `createImportController` core (import-controller.ts). It wires the controller's
 * injected seams to the real `window.openclip` bridge + the zustand stores, and
 * mirrors the core's `getState()` into React via `useSyncExternalStore`.
 *
 * All the testable logic (consent gate, model gate, progress banding, the G.3
 * re-import flush-save) lives in the core; this file only does the wiring.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { WhisperModelSize } from '@shared/jobs'
import { createBlankProject } from '@renderer/hooks/useProject'
import { createImportController } from '@renderer/hooks/import-controller'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useUiStore } from '@renderer/stores/uiStore'
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
}

export function useImportController(opts: ImportControllerOptions = {}): ImportController {
  // Keep onNeedModel current without rebuilding the controller (which would drop
  // its in-flight state). Synced in an effect (refs must not be written during
  // render); the controller only invokes it asynchronously, after effects run.
  const onNeedModelRef = useRef(opts.onNeedModel)
  useEffect(() => {
    onNeedModelRef.current = opts.onNeedModel
  }, [opts.onNeedModel])

  // zustand action refs are stable across renders.
  const appendPartial = useProjectStore((s) => s.appendTranscriptPartial)
  const hydrate = useProjectStore((s) => s.hydrateTranscript)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const setView = useUiStore((s) => s.setView)
  const upsertTask = useUiStore((s) => s.upsertTask)
  const clearTask = useUiStore((s) => s.clearTask)

  const controller = useMemo(
    () =>
      createImportController({
        bridge: window.openclip,
        createBlankProject,
        store: {
          getCurrentProject: () => useProjectStore.getState().currentProject,
          composeProject: () => useProjectStore.getState().composeProject(),
          setCurrentProject,
          appendTranscriptPartial: appendPartial,
          hydrateTranscript: hydrate,
          saveProject: async (project) => {
            await window.openclip.project.save({ project })
          }
        },
        ui: {
          setView,
          upsertTask: (t) =>
            upsertTask({
              jobId: t.jobId,
              kind: 'transcribe',
              progress: t.progress,
              status: t.status
            }),
          clearTask
        },
        // Read the transcription language lazily at import time (Part I) so the
        // latest Settings value applies without rebuilding the controller.
        getLanguage: () => useSettingsStore.getState().settings.language,
        onNeedModel: (m) => onNeedModelRef.current?.(m)
      }),
    // Built once; all referenced actions are stable zustand refs.
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
    cancel: controller.cancel
  }
}
