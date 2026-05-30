/**
 * App.tsx — the native-macOS hybrid shell (Part F): a draggable hidden-inset
 * title bar, vibrancy sidebars, and a dark editor canvas. First run shows the
 * focused <Welcome> import screen; once a project has content (source / transcript
 * / clips) it swaps to the 3-pane editor. Export / Settings / subsequent Import
 * open as native dialogs rather than inline drawers.
 *
 * The editor is shown whenever there is content so the headless E2E (which
 * hydrates the stores via window.__openclipTest) still renders TranscriptPanel /
 * ClipSidebar / Timeline.
 */

import { useEffect, useState } from 'react'
import { APP_NAME } from '@shared'
import type { WhisperModelSize } from '@shared/jobs'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  Clapperboard,
  Download,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Sun
} from 'lucide-react'

import { Welcome } from '@renderer/components/Welcome'
import { Dashboard } from '@renderer/components/Dashboard'
import { ImportPanel } from '@renderer/components/ImportPanel'
import { TranscriptPanel } from '@renderer/components/TranscriptPanel'
import { ClipSidebar } from '@renderer/components/ClipSidebar'
import { PreviewPlayer } from '@renderer/components/PreviewPlayer'
import { Timeline } from '@renderer/components/Timeline'
import { ExportPanel } from '@renderer/components/ExportPanel'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { ModelDownloadDialog } from '@renderer/components/ModelDownloadDialog'
import { Toaster } from '@renderer/components/ui/sonner'
import { createGenerateClipsHandler } from '@renderer/components/generateClips'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { installAutosave } from '@renderer/stores/projectStore/autosave'

type Modal = 'none' | 'import' | 'export' | 'settings'

function App(): React.JSX.Element {
  const [modal, setModal] = useState<Modal>('none')
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [neededModel, setNeededModel] = useState<WhisperModelSize | undefined>(undefined)
  const [dark, setDark] = useState(true)

  const hasSource = useProjectStore((s) => !!s.currentProject?.sourceVideo)
  const hasTranscript = useProjectStore((s) => (s.transcript?.segments.length ?? 0) > 0)
  const hasClips = useProjectStore((s) => (s.clips?.length ?? 0) > 0)
  const showEditor = hasSource || hasTranscript || hasClips

  const generating = useProjectStore((s) => s.generating)

  // The "Auto Generate Clips" header action: build the request from the open
  // project + app settings (segments only — words stay local) and dispatch the
  // clipsSlice action. The ClipSidebar already surfaces generating/generateError.
  const handleGenerateClips = createGenerateClipsHandler({
    // composeProject() so the request's segments come from the LIVE transcript
    // slice (the same source `hasTranscript` gates on), not a possibly-stale
    // currentProject.transcript.
    getProject: () => useProjectStore.getState().composeProject(),
    getSettings: () => useSettingsStore.getState().settings,
    generateClips: (req) => useProjectStore.getState().generateClips(req)
  })

  // Wire the debounced autosave subscriber (Wave-1 integration) once for the app
  // lifetime; tears down on unmount.
  useEffect(() => installAutosave(), [])
  // Default to the dark editor aesthetic; the header toggle flips chrome theme.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  const handleNeedModel = (model: WhisperModelSize): void => {
    setNeededModel(model)
    setModelDialogOpen(true)
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-transparent text-foreground">
      {/* ── Native hidden-inset title bar (draggable). Left padding clears the
          macOS traffic lights; interactive controls carry .app-no-drag. ── */}
      <header className="app-drag flex h-[52px] shrink-0 items-center justify-between border-b border-border/60 pl-20 pr-3">
        <div className="flex items-center gap-2">
          <Clapperboard className="size-4 text-primary" />
          <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
        </div>
        <div className="app-no-drag flex items-center gap-1">
          {showEditor && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setModal('import')}
            >
              <Plus className="size-4" /> Import
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => setDark((d) => !d)}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => setModal('settings')}
          >
            <SettingsIcon className="size-4" />
          </Button>
        </div>
      </header>

      {/* ── Body: welcome (first-run) or the 3-pane editor. ── */}
      {!showEditor ? (
        <Welcome onNeedModel={handleNeedModel} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* LEFT — translucent projects sidebar (vibrancy). */}
          <aside className="vibrant-sidebar flex w-60 shrink-0 flex-col border-r border-border/60">
            <ScrollArea className="flex-1">
              <Dashboard />
            </ScrollArea>
            <div className="p-2">
              <Button className="w-full gap-1.5" size="sm" onClick={() => setModal('import')}>
                <Plus className="size-4" /> New / Import
              </Button>
            </div>
          </aside>

          {/* CENTER — solid dark editor canvas. */}
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Editor
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  disabled={!hasTranscript || generating}
                  onClick={handleGenerateClips}
                >
                  <Sparkles className="size-4" /> Auto Generate Clips
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setModal('export')}
                >
                  <Download className="size-4" /> Export All
                </Button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
              <PreviewPlayer />
              <Timeline />
              {hasTranscript && <TranscriptPanel />}
            </div>
          </main>

          {/* RIGHT — translucent clip sidebar (vibrancy). */}
          <aside className="vibrant-sidebar w-72 shrink-0 border-l border-border/60">
            <ScrollArea className="h-full">
              <ClipSidebar />
            </ScrollArea>
          </aside>
        </div>
      )}

      {/* ── Dialogs ── */}
      <Dialog open={modal === 'import'} onOpenChange={(o) => !o && setModal('none')}>
        <DialogContent className="app-no-drag">
          <DialogHeader>
            <DialogTitle>Import a video</DialogTitle>
          </DialogHeader>
          <ImportPanel onNeedModel={handleNeedModel} />
        </DialogContent>
      </Dialog>

      <Dialog open={modal === 'export'} onOpenChange={(o) => !o && setModal('none')}>
        <DialogContent className="app-no-drag sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export clips</DialogTitle>
          </DialogHeader>
          <ExportPanel />
        </DialogContent>
      </Dialog>

      <Dialog open={modal === 'settings'} onOpenChange={(o) => !o && setModal('none')}>
        <DialogContent className="app-no-drag">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <SettingsPanel />
        </DialogContent>
      </Dialog>

      <ModelDownloadDialog
        open={modelDialogOpen}
        initialModel={neededModel}
        onDownloaded={() => setModelDialogOpen(false)}
      />

      {/* App-wide toasts (autosave failures, etc.). Mounted once. */}
      <Toaster />
    </div>
  )
}

export default App
