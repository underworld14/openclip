/**
 * useImportController — the shared smart-import state machine (F.2/F.4) used by
 * both the Welcome screen and the ImportPanel. Handles: the first-transcribe
 * whisper-model gate (PRD §13), a one-time yt-dlp/TOS consent for URL imports
 * (PRD §20.4), the file vs URL branch, progress/stage/error state, creating the
 * project (so the editor view appears), and hydrating the transcript slice.
 *
 * The heavy lifting is the pure `runImportPipeline` / `runUrlDownload`
 * (import-pipeline.ts); this hook is the thin React orchestration around them.
 */

import { useCallback, useState } from 'react'
import type { WhisperModelSize } from '@shared/jobs'
import type { SourceVideo } from '@shared/schema'
import type { JobResult } from '@shared/jobs'
import { runImportPipeline, runUrlDownload, isUrl } from '@renderer/components/import-pipeline'
import { createBlankProject } from '@renderer/hooks/useProject'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useUiStore } from '@renderer/stores/uiStore'

const MODEL: WhisperModelSize = 'base'
const CONSENT_KEY = 'openclip:url-consent'

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
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}
function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useImportController(opts: ImportControllerOptions = {}): ImportController {
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [stage, setStage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [needsConsent, setNeedsConsent] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  const appendPartial = useProjectStore((s) => s.appendTranscriptPartial)
  const hydrate = useProjectStore((s) => s.hydrateTranscript)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const setView = useUiStore((s) => s.setView)
  const upsertTask = useUiStore((s) => s.upsertTask)
  const { onNeedModel } = opts

  const ensureModel = useCallback(async (): Promise<boolean> => {
    const statuses = await window.openclip.model.status({ model: MODEL })
    if (!statuses.some((s) => s.model === MODEL && s.installed)) {
      onNeedModel?.(MODEL)
      return false
    }
    return true
  }, [onNeedModel])

  // Run probe → extract → transcribe, scaling progress into [base, base+span],
  // then create the project doc so the editor view appears. The transcript slice
  // is already hydrated via onTranscript; setCurrentProject only sets the core
  // slice (it composes into the saved .ocproj).
  const runPipeline = useCallback(
    async (filePath: string, name: string, base: number, span: number): Promise<void> => {
      const result = await runImportPipeline({
        bridge: window.openclip,
        filePath,
        projectId: 'p1',
        model: MODEL,
        onProgress: (p, s) => {
          const scaled = base + Math.round((p / 100) * span)
          setPct(scaled)
          setStage(s)
          upsertTask({ jobId: 'import', kind: 'transcribe', progress: scaled, status: 'running' })
        },
        onPartial: (partial) => appendPartial(partial),
        onTranscript: (t: JobResult['transcribe']) => hydrate(t)
      })
      const sourceVideo: SourceVideo = result.sourceVideo
      setCurrentProject({ ...createBlankProject(name, sourceVideo), transcript: result.transcript })
      setView('editor')
    },
    [appendPartial, hydrate, setCurrentProject, setView, upsertTask]
  )

  const importFile = useCallback(
    async (path: string): Promise<void> => {
      if (!path) return
      setBusy(true)
      setError(null)
      setPct(0)
      try {
        if (!(await ensureModel())) {
          setBusy(false)
          return
        }
        await runPipeline(path, basename(path), 0, 100)
        setStage('done')
      } catch (e) {
        setError(asMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [ensureModel, runPipeline]
  )

  const importUrl = useCallback(
    async (url: string): Promise<void> => {
      const u = url.trim()
      if (!u) return
      // One-time yt-dlp / TOS consent (PRD §20.4) before the first URL download.
      if (typeof localStorage !== 'undefined' && localStorage.getItem(CONSENT_KEY) !== '1') {
        setPendingUrl(u)
        setNeedsConsent(true)
        return
      }
      setBusy(true)
      setError(null)
      setPct(0)
      setStage('downloading')
      try {
        if (!(await ensureModel())) {
          setBusy(false)
          return
        }
        const dl = await runUrlDownload({
          bridge: window.openclip,
          url: u,
          onProgress: (p, s) => {
            setPct(Math.round(p * 0.2)) // download occupies the 0..20% band
            setStage(s)
          }
        })
        await runPipeline(dl.filePath, dl.title ?? 'Imported video', 20, 80)
        setStage('done')
      } catch (e) {
        setError(asMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [ensureModel, runPipeline]
  )

  const acceptConsent = useCallback(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CONSENT_KEY, '1')
    setNeedsConsent(false)
    const u = pendingUrl
    setPendingUrl(null)
    if (u) void importUrl(u)
  }, [pendingUrl, importUrl])

  const declineConsent = useCallback(() => {
    setNeedsConsent(false)
    setPendingUrl(null)
  }, [])

  const importAny = useCallback(
    (value: string): Promise<void> => (isUrl(value) ? importUrl(value) : importFile(value)),
    [importUrl, importFile]
  )

  return {
    busy,
    pct,
    stage,
    error,
    needsConsent,
    acceptConsent,
    declineConsent,
    importFile,
    importUrl,
    importAny
  }
}
