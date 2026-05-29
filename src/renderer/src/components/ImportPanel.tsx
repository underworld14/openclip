/**
 * ImportPanel — drag/drop + URL import + the I1 vertical slice (T-Media, E.3).
 * PRD §6.1 / §11.2. Picks a video, then runs import → audio extract → transcribe
 * (via `runImportPipeline`), streaming progress + live partials into the
 * projectStore and hydrating the final transcript. If the chosen whisper model
 * isn't installed it asks App to open the first-run ModelDownloadDialog (PRD §13).
 *
 * The orchestration is the pure `runImportPipeline` (import-pipeline.ts), so the
 * whole slice is unit-testable headlessly; this component is the thin UI shell.
 */

import { useCallback, useState } from 'react'
import type { WhisperModelSize } from '@shared/jobs'
import { runImportPipeline } from '@renderer/components/import-pipeline'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'

export interface ImportPanelProps {
  /** Open the first-run model-download dialog (wired by App). */
  onNeedModel?: (model: WhisperModelSize) => void
}

export function ImportPanel({ onNeedModel }: ImportPanelProps = {}): React.JSX.Element {
  const [filePath, setFilePath] = useState('')
  const [pct, setPct] = useState(0)
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const appendPartial = useProjectStore((s) => s.appendTranscriptPartial)
  const hydrate = useProjectStore((s) => s.hydrateTranscript)
  const setSource = useProjectStore((s) => s.setSource)
  const upsertTask = useUiStore((s) => s.upsertTask)

  const runImport = useCallback(
    async (path: string): Promise<void> => {
      if (!path) return
      setBusy(true)
      setErr(null)
      setPct(0)
      const model: WhisperModelSize = 'base'
      try {
        // First-transcribe model gate (PRD §13): if absent, open the dialog.
        const statuses = await window.openclip.model.status({ model })
        if (!statuses.some((s) => s.model === model && s.installed)) {
          onNeedModel?.(model)
          setBusy(false)
          return
        }
        const result = await runImportPipeline({
          bridge: window.openclip,
          filePath: path,
          projectId: 'p1',
          model,
          onProgress: (p, s) => {
            setPct(p)
            setStage(s)
            upsertTask({
              jobId: 'transcribe-import',
              kind: 'transcribe',
              progress: p,
              status: 'running'
            })
          },
          onPartial: (partial) => appendPartial(partial),
          onTranscript: (t) => hydrate(t)
        })
        setSource(result.sourceVideo)
        setStage('done')
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [appendPartial, hydrate, setSource, upsertTask, onNeedModel]
  )

  return (
    <div data-testid="import-panel" className="flex flex-col gap-2 p-3">
      <p className="text-xs text-muted-foreground">Import a video to transcribe (PRD §6.1).</p>
      <input
        data-testid="import-file-input"
        aria-label="Video file path"
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        placeholder="/path/to/video.mp4"
        value={filePath}
        onChange={(e) => setFilePath(e.target.value)}
      />
      <Button
        size="sm"
        data-testid="import-start"
        disabled={busy || !filePath}
        onClick={() => void runImport(filePath)}
      >
        {busy ? 'Transcribing…' : 'Import & Transcribe'}
      </Button>
      {busy && (
        <div className="flex flex-col gap-1">
          <Progress value={pct} data-testid="import-progress" />
          <span className="text-xs text-muted-foreground" data-testid="import-stage">
            {stage} · {pct}%
          </span>
        </div>
      )}
      {err && (
        <span className="text-xs text-destructive" data-testid="import-error">
          {err}
        </span>
      )}
      {/* The live transcript renders in the App center pane's TranscriptPanel,
          which reads the same transcriptSlice this import hydrates (Wave-1
          dedupe — the inline workaround was removed; the transcript renders once). */}
    </div>
  )
}

export default ImportPanel
