/**
 * src/renderer/src/App.tsx — the full PRD §11.1 main layout (TRUNK, frozen).
 *
 * Per plan E.4: the JSX tree is authored ONCE here importing per-component
 * STUBS; each fan-out track replaces only its own component body, never this
 * layout. The frozen regions are the structural shell:
 *   ┌ top bar (title + 🔍 ⚙️ 👤) ───────────────────────────────────────┐
 *   ├ PROJECT PANEL │   PREVIEW PLAYER + TIMELINE   │  CLIP SIDEBAR      ┤
 *   ├ bottom action bar [Import][Auto Generate][Export All][Settings] ──┘
 *
 * The Import / Transcript / Export / Settings panels and the first-run model
 * dialog mount inside the shell; this file imports every §11.2 stub so the
 * import graph (and thus the type surface each track fills) is fixed up front.
 */

import { useEffect, useState } from 'react'
import { APP_NAME } from '@shared'
import type { WhisperModelSize } from '@shared/jobs'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Search, Settings as SettingsIcon, User } from 'lucide-react'

import { Dashboard } from '@renderer/components/Dashboard'
import { ImportPanel } from '@renderer/components/ImportPanel'
import { TranscriptPanel } from '@renderer/components/TranscriptPanel'
import { ClipSidebar } from '@renderer/components/ClipSidebar'
import { PreviewPlayer } from '@renderer/components/PreviewPlayer'
import { Timeline } from '@renderer/components/Timeline'
import { ExportPanel } from '@renderer/components/ExportPanel'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { ModelDownloadDialog } from '@renderer/components/ModelDownloadDialog'
import { useProjectStore } from '@renderer/stores/projectStore'
import { installAutosave } from '@renderer/stores/projectStore/autosave'

type Drawer = 'none' | 'import' | 'transcript' | 'export' | 'settings'

function App(): React.JSX.Element {
  const [drawer, setDrawer] = useState<Drawer>('none')
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [neededModel, setNeededModel] = useState<WhisperModelSize | undefined>(undefined)

  // The single canonical transcript view lives in the center pane (Wave-1
  // dedupe — the ImportPanel inline workaround was removed). Show it once a
  // transcript exists, or when the user explicitly opens the transcript drawer.
  const hasTranscript = useProjectStore((s) => (s.transcript?.segments.length ?? 0) > 0)
  const showTranscript = drawer === 'transcript' || hasTranscript

  // Wave-1 integration: wire the debounced autosave subscriber to the store
  // (T-Persist shipped createAutosave with no subscriber). One install for the
  // app lifetime; tears down on unmount.
  useEffect(() => installAutosave(), [])

  // ImportPanel's first-transcribe model gate (PRD §13): open the download
  // dialog for the requested model.
  const handleNeedModel = (model: WhisperModelSize): void => {
    setNeededModel(model)
    setModelDialogOpen(true)
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ── Top bar (PRD §11.1): title + search / settings / profile ── */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Search">
            <Search className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => setDrawer('settings')}
          >
            <SettingsIcon className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Profile">
            <User className="size-4" />
          </Button>
        </div>
      </header>

      {/* ── Three-column body: project panel │ preview+timeline │ clip sidebar ── */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT — project panel (Dashboard). */}
        <aside className="flex w-60 shrink-0 flex-col border-r">
          <ScrollArea className="flex-1">
            <Dashboard />
            {drawer === 'import' && <ImportPanel onNeedModel={handleNeedModel} />}
          </ScrollArea>
          <Separator />
          <div className="p-2">
            <Button className="w-full" size="sm" onClick={() => setDrawer('import')}>
              + New
            </Button>
          </div>
        </aside>

        {/* CENTER — preview player above the (minimal) timeline. The single
            canonical TranscriptPanel lives here (PRD §11.1 center pane). */}
        <main className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          <PreviewPlayer />
          <Timeline />
          {showTranscript && <TranscriptPanel />}
          {drawer === 'export' && <ExportPanel />}
          {drawer === 'settings' && <SettingsPanel />}
        </main>

        {/* RIGHT — clip sidebar (cards + scores). */}
        <aside className="w-72 shrink-0 border-l">
          <ScrollArea className="h-full">
            <ClipSidebar />
          </ScrollArea>
        </aside>
      </div>

      {/* ── Bottom action bar (PRD §11.1). ── */}
      <footer className="flex h-14 shrink-0 items-center gap-2 border-t px-3">
        <Button variant="secondary" size="sm" onClick={() => setDrawer('import')}>
          Import Video
        </Button>
        <Button variant="secondary" size="sm">
          Auto Generate Clips
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setDrawer('export')}>
          Export All
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDrawer('settings')}>
          Settings
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setModelDialogOpen(true)}
          >
            Models
          </button>
        </span>
      </footer>

      {/* First-run model download dialog (PRD §13). Opened either via the
          "Models" affordance or by ImportPanel's first-transcribe model gate
          (onNeedModel → handleNeedModel), pre-selecting the needed model. */}
      <ModelDownloadDialog
        open={modelDialogOpen}
        initialModel={neededModel}
        onDownloaded={() => setModelDialogOpen(false)}
      />
    </div>
  )
}

export default App
