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

import { useEffect, useMemo, useState } from 'react'
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
import { toast } from 'sonner'
import { createGenerateClipsHandler } from '@renderer/components/generateClips'
import { GeneratePreflightDialog } from '@renderer/components/GeneratePreflightDialog'
import {
  defaultPreflight,
  preflightToProjectSettings,
  type PreflightConfig
} from '@shared/generate-preflight'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useJobsStore } from '@renderer/stores/jobsStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { saveStatusLabel } from '@renderer/components/saveStatus'
import { activeTasks } from '@renderer/components/jobStatus'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { installAutosave } from '@renderer/stores/projectStore/autosave'
import { installJobNotifications } from '@renderer/stores/jobNotifications'
import { useImportController } from '@renderer/hooks/useImportController'
import { useReadiness } from '@renderer/hooks/useReadiness'
import { ReadinessBar } from '@renderer/components/ReadinessBar'
import { JobStatusBar } from '@renderer/components/JobStatusBar'

type Modal = 'none' | 'import' | 'export' | 'settings'

function App(): React.JSX.Element {
  const [modal, setModal] = useState<Modal>('none')
  /**
   * Is an export encode still running? Read from the app-level job registry
   * rather than ExportPanel's local state, because the panel unmounts on
   * dismissal — which is exactly the moment we need the answer (FEAT-az3sxm).
   */
  // Persistence indicator (FEAT-51hnwx). `now` ticks slowly so "Saved · 2s ago"
  // ages without a per-second re-render of the whole title bar.
  const saveState = useUiStore((s) => s.saveState)
  const lastSavedAt = useUiStore((s) => s.lastSavedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const saveLabel = saveStatusLabel(saveState, lastSavedAt, now)

  const exportTasks = useJobsStore((s) => s.tasks)
  const exportRunning = useMemo(
    // `activeTasks` is the same predicate the status bar uses (running OR queued,
    // top-level only), so the toast and the bar can never disagree about whether
    // there is something to go back to.
    () => activeTasks(exportTasks).some((t) => t.kind === 'export'),
    [exportTasks]
  )
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [neededModel, setNeededModel] = useState<WhisperModelSize | undefined>(undefined)
  const [dark, setDark] = useState(true)

  const hasSource = useProjectStore((s) => !!s.currentProject?.sourceVideo)
  const hasTranscript = useProjectStore((s) => (s.transcript?.segments.length ?? 0) > 0)
  const hasClips = useProjectStore((s) => (s.clips?.length ?? 0) > 0)
  /**
   * Deliberately NOT `hasTranscript` (FEAT-ky1jfw). Transcript segments arrive as
   * streamed job partials, so counting them made the FIRST CLOSED SENTENCE — no
   * user action at all, roughly 1% into a ten-minute transcription — unmount the
   * Welcome screen and take the progress bar, the Cancel button and the only
   * error surface with it. A transcribe failure at 80% was therefore completely
   * silent.
   *
   * `hasSource` is the honest signal now: the import controller commits the
   * project the moment ffprobe returns, so this flips within about a second of
   * an import starting — earlier than the old predicate, not later — and it
   * flips exactly ONCE, on a real event, instead of mid-stream.
   */
  const showEditor = hasSource || hasClips

  const generating = useProjectStore((s) => s.generating)

  // The PRE-FLIGHT panel (FEAT-n762y6). Generate used to fire straight off the
  // header button with zero configuration; it now opens a panel whose fields are
  // all defaulted, so the primary action is still one press away.
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [preflight, setPreflight] = useState<PreflightConfig | null>(null)

  // The "Auto Generate Clips" header action: build the request from the open
  // project + app settings (segments only — words stay local) and dispatch the
  // clipsSlice action. The ClipSidebar already surfaces generating/generateError.
  // Built AT DISPATCH with the config in scope, rather than once per render off
  // a `preflight` that may be a render behind the press that produced it.
  const runGenerateClips = (config?: PreflightConfig): Promise<void> =>
    createGenerateClipsHandler({
      // composeProject() so the request's segments come from the LIVE transcript
      // slice (the same source `hasTranscript` gates on), not a possibly-stale
      // currentProject.transcript.
      getProject: () => useProjectStore.getState().composeProject(),
      getSettings: () => useSettingsStore.getState().settings,
      generateClips: (req) => useProjectStore.getState().generateClips(req),
      // The button enables on `hasTranscript` while the handler needs a composable
      // project; if those ever disagree the click must not dead-end (BUG-19bt2k).
      onError: (message) => toast.error('Cannot generate clips', { description: message }),
      getPreflight: () => config
    })()

  /** Open the panel, seeded from the last run (or the project defaults). */
  const openPreflight = (): void => {
    const project = useProjectStore.getState().composeProject()
    if (!project) {
      toast.error('Cannot generate clips', {
        description: 'No project is open — import a video before generating clips.'
      })
      return
    }
    setPreflight(preflight ?? defaultPreflight(project, useSettingsStore.getState().settings))
    setPreflightOpen(true)
  }

  /** Submit the panel: remember the config, persist it, and run. */
  const handlePreflightGenerate = (config: PreflightConfig): void => {
    setPreflight(config)
    setPreflightOpen(false)
    // Persisted onto the project so a later Regenerate — in this session or the
    // next — opens where the user left off rather than back at the defaults.
    useProjectStore.getState().setProjectSettings(preflightToProjectSettings(config))
    void runGenerateClips(config)
  }

  // Wire the debounced autosave subscriber (Wave-1 integration) once for the app
  // lifetime; tears down on unmount.
  useEffect(() => installAutosave(), [])
  // Announce finished/failed jobs to the OS + a toast on failure, so a long
  // transcription or batch export is genuinely walk-away-able (FEAT-ckxz8d).
  useEffect(() => installJobNotifications(), [])
  // Hydrate Settings from disk at boot. `settingsStore.load()` previously had NO
  // caller anywhere in the renderer — SettingsPanel called it, but it only mounts
  // when the user opens the Settings dialog. So the store held DEFAULT_SETTINGS
  // for the whole session: the readiness gate saw `model: ''` and no key and
  // greyed out Generate for a correctly-configured user, and the import path read
  // the default whisper model instead of the chosen one.
  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])
  // Chromium's DEFAULT drop behaviour is to navigate to file:///… — so a video
  // dropped anywhere outside ImportPanel replaced the whole app with the raw
  // file and lost all state. The Welcome copy invites dropping, so this has to
  // be window-wide, not just on the panel that handles it.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
  // Default to the dark editor aesthetic; the header toggle flips chrome theme.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  const handleNeedModel = (model: WhisperModelSize): void => {
    setNeededModel(model)
    setModelDialogOpen(true)
  }

  // The import controller is a shared singleton, so this is the SAME in-flight
  // import ImportPanel started — which is what lets the model dialog hand the
  // interrupted import back instead of silently abandoning it (FEAT-kncqxf).
  // Pass the handler explicitly: App constructs the shared controller (parent
  // hooks run before children's), so it must supply the callback rather than
  // relying on ImportPanel to register one later.
  const importCtl = useImportController({ onNeedModel: handleNeedModel })

  // First-run readiness: what the user still has to set up, and whether Generate
  // can run at all (FEAT-c5a15c).
  const readiness = useReadiness()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-transparent text-foreground">
      {/* ── Native hidden-inset title bar (draggable). Left padding clears the
          macOS traffic lights; interactive controls carry .app-no-drag. ── */}
      <header className="app-drag flex h-[52px] shrink-0 items-center justify-between border-b border-border/60 pl-20 pr-3">
        <div className="flex items-center gap-2">
          <Clapperboard className="size-4 text-primary" />
          <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
          {/* Persistence was entirely silent on success (FEAT-51hnwx): the only
              signal in the whole path was an error toast. Nothing before the
              first save — inventing "Saved" there would be a lie. */}
          {saveLabel && (
            <span
              className="text-[11px] text-muted-foreground"
              data-testid="save-status"
              role="status"
            >
              {saveLabel}
            </span>
          )}
        </div>
        <div className="app-no-drag flex items-center gap-2">
          <ReadinessBar
            chips={readiness.chips}
            onOpenSettings={() => setModal('settings')}
            onDownloadModel={() => {
              // Pre-select the model the chip is complaining about. Without this
              // a chip reading "Transcription: large-v3 — not installed" opened
              // the dialog on `base`, so the download left the chip still red.
              setNeededModel(useSettingsStore.getState().settings.whisperModel)
              setModelDialogOpen(true)
            }}
          />
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

      {/* ── The persistent job surface (EPIC-zpa1nd). Mounted HERE, between the
          title bar and the body, so it belongs to neither layout and survives
          both the Welcome→editor swap and every modal dismissal. Renders
          nothing when there is no work. ── */}
      <JobStatusBar />

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
                  data-testid="auto-generate-clips"
                  disabled={!hasTranscript || generating || !readiness.canGenerate}
                  // Name the missing piece instead of a dead grey button.
                  title={
                    readiness.blockingReason ??
                    (!hasTranscript ? 'Transcribe a video first.' : 'Generate clips with AI')
                  }
                  onClick={openPreflight}
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
              <ClipSidebar onRegenerate={openPreflight} />
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

      {/* Dismissing mid-export does NOT kill the encode — JobStatusBar is mounted
          above, outside every modal, and keeps the row (with its Cancel and, when
          it lands, "Open folder") reachable. That is the behaviour we want: an
          export you can navigate away from and come back to. What was missing is
          that nobody TOLD the user, so the dialog's progress bar and "Open
          folder" appeared to simply vanish (FEAT-az3sxm). */}
      <Dialog
        open={modal === 'export'}
        onOpenChange={(o) => {
          if (o) return
          if (exportRunning) {
            toast('Export continues in the background', {
              description: 'Track it — or cancel it — in the status bar at the top.'
            })
          }
          setModal('none')
        }}
      >
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
          <SettingsPanel
            onDownloadModel={(m) => {
              setNeededModel(m)
              setModelDialogOpen(true)
            }}
            onModelsChanged={readiness.refresh}
          />
        </DialogContent>
      </Dialog>

      <ModelDownloadDialog
        open={modelDialogOpen}
        initialModel={neededModel}
        onDownloaded={() => {
          setModelDialogOpen(false)
          readiness.refresh() // flip the chip green without a restart
          // Pick the import back up rather than dropping the user on the Welcome
          // screen wondering why nothing happened (FEAT-kncqxf).
          if (importCtl.pendingImport) {
            toast.info('Model ready — resuming your import…')
            void importCtl.resumePending()
          }
        }}
        onDismiss={() => {
          setModelDialogOpen(false)
          importCtl.discardPending()
        }}
      />

      {/* The Generate pre-flight panel (FEAT-n762y6). Rendered only while open so
        it re-seeds from `preflight` on every open — Regenerate must show the
        LAST run's values, not the ones from two runs ago. */}
      {preflightOpen && preflight && (
        <GeneratePreflightDialog
          open={preflightOpen}
          duration={useProjectStore.getState().currentProject?.sourceVideo.duration ?? 0}
          initial={preflight}
          segments={useProjectStore.getState().transcript?.segments ?? []}
          onCancel={() => setPreflightOpen(false)}
          onGenerate={handlePreflightGenerate}
        />
      )}

      {/* App-wide toasts (autosave failures, etc.). Mounted once. */}
      <Toaster />
    </div>
  )
}

export default App
