/**
 * import-controller — the framework-free core of the smart-import state machine
 * (F.2/F.4, hardened in G.3/G.4). All the branchy logic lives here — the one-time
 * yt-dlp/TOS consent gate (PRD §20.4), the whisper-model gate (PRD §13), the
 * file-vs-URL routing, the two-band progress scaling, and the re-import flush —
 * with every side effect (bridge, store, storage, ui, id) INJECTED, so it is
 * unit-testable in the repo's node vitest env with no React/jsdom (mirrors
 * `stores/projectStore/autosave.ts`'s `startAutosave` pattern).
 *
 * `useImportController` is a thin React wrapper that wires these seams to the real
 * `window.openclip` bridge + the zustand stores and mirrors `getState()` via
 * `useSyncExternalStore`.
 */

import type { WhisperModelSize, JobResult, JobPartial } from '@shared/jobs'
import type { Project, SourceVideo } from '@shared/schema'
import {
  isCancellation,
  stripJobErrorPrefix,
  type TaskDetail
} from '@renderer/components/jobStatus'
import {
  runImportPipeline as defaultRunImportPipeline,
  runUrlDownload as defaultRunUrlDownload,
  isUrl,
  normalizeUrlInput,
  type OpenClipBridge
} from '@renderer/components/import-pipeline'
import { drainJob } from '@renderer/hooks/useJob'

/**
 * localStorage key gating the one-time yt-dlp/TOS consent (PRD §20.4).
 *
 * SCOPE (audit note openclip-1o1): this is a RENDERER-SIDE UX / legal-acknowledgement
 * gate, NOT a main-process-enforced security boundary. It exists so the user
 * affirmatively accepts the yt-dlp/site-TOS terms once before their first URL
 * download; a buggy/compromised renderer (or a direct `jobs.start('url-download')`)
 * could reach the main runner without it. That is acceptable because bypassing
 * consent has no security impact — it only skips a legal acknowledgement, not an
 * attack-surface check. The real security boundary for URL imports is `assertSafeUrl`
 * in the MAIN process (validated regardless of the renderer). Do not mistake this
 * flag for an enforced gate; if it must become one, persist + check it in main.
 */
export const CONSENT_KEY = 'openclip:url-consent'
const DEFAULT_MODEL: WhisperModelSize = 'base'

/**
 * The stage sequences the status-bar checklist walks. These are the tokens
 * `runImportPipeline` actually emits, in the order it emits them — a URL import
 * is the same pipeline with a yt-dlp download bolted on the front.
 */
const FILE_IMPORT_STAGES = ['probing', 'extracting', 'transcribing']
const URL_IMPORT_STAGES = ['downloading', ...FILE_IMPORT_STAGES]

/** An import that was blocked on a missing whisper model, kept so it can be replayed. */
export interface PendingImport {
  kind: 'file' | 'url'
  value: string
}

export interface ImportControllerState {
  busy: boolean
  pct: number
  stage: string
  error: string | null
  /** True when a URL import is blocked awaiting the one-time TOS consent. */
  needsConsent: boolean
  /**
   * The import the missing-model gate turned away (audit fix FEAT-kncqxf).
   *
   * Without this the model dialog was a dead end: it downloaded the model,
   * closed, and left the user back on the Welcome screen with no indication that
   * their import had been abandoned and had to be started again by hand.
   */
  pendingImport: PendingImport | null
}

/** The minimal `localStorage`-like surface the consent gate needs (injectable). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Store seam — the project-document reads/writes the controller performs. */
export interface ImportControllerStore {
  getCurrentProject(): Project | null
  /**
   * The open project with the LIVE clips + transcript slices merged in
   * (store `composeProject()`), for the flush-save before a re-import — the raw
   * `currentProject.clips`/`.transcript` are stale (the slices are the source of
   * truth), so saving the raw doc would discard the user's clip edits (G.3).
   */
  composeProject?(): Project | null
  /**
   * Make `project` the open one, REPLACING every slice — clips, exportHistory and
   * the clip selection included.
   *
   * This must not be a bare `setCurrentProject`. Those slices are store singletons
   * (see `hydrateFromProject` in `useProject.ts`), so committing an import without
   * clearing them left the PREVIOUS project's clip cards on screen attached to the
   * new project, and the debounced autosave then persisted them into the new
   * `.ocproj` — cross-project data corruption (audit fix BUG-2hjt1x).
   */
  hydrateProject(project: Project): void
  appendTranscriptPartial(partial: JobPartial['transcribe']): void
  hydrateTranscript(transcript: JobResult['transcribe']): void
  /** Persist a project — used to flush-save the open project before a re-import (G.3). */
  saveProject(project: Project): Promise<void>
}

/**
 * Optional UI seam: view routing + the app-level job registry (EPIC-zpa1nd).
 *
 * This used to be a two-method `upsertTask`/`clearTask` pair feeding
 * `uiStore.tasks`, a map nothing ever read. It now feeds the persistent status
 * bar, which is the surface that survives this panel unmounting mid-import — so
 * it carries what a person actually needs: a name for the work, the stages it
 * will pass through, live progress, a cancel handle, and a terminal state that
 * distinguishes "you cancelled this" from "this failed".
 */
export interface ImportControllerUi {
  setView?(view: 'editor'): void
  beginTask?(task: {
    id: string
    label: string
    stages: string[]
    cancel: () => Promise<void>
    retry: () => Promise<void>
  }): void
  updateTask?(
    id: string,
    patch: { pct?: number; stage?: string; detail?: TaskDetail; label?: string }
  ): void
  settleTask?(id: string, status: 'done' | 'error' | 'canceled', patch?: { error?: string }): void
  /**
   * Remove a task's row (EPIC-k83ghw / BUG-w2jv3w). Every `retry` closure
   * calls this on ITS OWN taskId before starting the replacement run, so a
   * retried import replaces its own status-bar row instead of stacking a
   * second, identical one next to it.
   */
  dismissTask?(id: string): void
}

export interface ImportControllerDeps {
  bridge: OpenClipBridge
  store: ImportControllerStore
  createBlankProject(name: string, sourceVideo: SourceVideo): Project
  /** @deprecated Fixed override for tests. Real callers pass `getWhisperModel`. */
  model?: WhisperModelSize
  /**
   * The user's transcription model, read LAZILY at import time (FEAT-1k76hk).
   *
   * `Settings.whisperModel` existed in the schema and the store from the start,
   * but this controller hardcoded 'base' — so a user who downloaded `large-v3`
   * got `base` transcription anyway, silently. Lazy (like `getLanguage`) so a
   * change in Settings applies to the next import without rebuilding the
   * controller — which now matters more, since it is a singleton.
   */
  getWhisperModel?(): WhisperModelSize
  ui?: ImportControllerUi
  /** Consent storage; defaults to the real `localStorage`, or `null` to disable the gate. */
  storage?: StorageLike | null
  onNeedModel?(model: WhisperModelSize): void
  /** id generator (default crypto.randomUUID) — used for both the audio-cache projectId and the new project id. */
  genId?(): string
  /**
   * Move a downloaded file into the app's managed per-project media store (Part
   * H) and return its new path. Defaults to `bridge.media.adoptSource`. Only used
   * for URL imports (the downloaded file is app-owned); file imports skip it.
   */
  adoptSource?(projectId: string, filePath: string): Promise<{ path: string }>
  /**
   * Reclaim (delete) a project's adopted media dir. Defaults to
   * `bridge.media.reclaim`. Called best-effort when an APP-OWNED import fails after
   * the download was already adopted into persistent media but before any .ocproj was
   * saved, so the orphan isn't left until the next-launch sweep (audit fix openclip-e5s).
   */
  reclaimMedia?(projectId: string): Promise<void>
  /**
   * Source transcription language (PRD §6.2 / Part I cross-language). Read LAZILY
   * at import time so the latest Settings value is used without rebuilding the
   * controller (mirrors the `onNeedModel` ref pattern in `useImportController`).
   * Returns undefined/'' ⇒ whisper auto-detect (no `-l` flag); an ISO-639-1 code
   * ⇒ whisper transcribes in that language.
   */
  getLanguage?(): string | undefined
  /** Injectable pipeline fns (default the real ones) so the core is testable headless. */
  runImportPipeline?: typeof defaultRunImportPipeline
  runUrlDownload?: typeof defaultRunUrlDownload
}

export interface ImportController {
  getState(): ImportControllerState
  subscribe(listener: () => void): () => void
  importFile(path: string): Promise<void>
  importUrl(url: string): Promise<void>
  /** Smart entry: routes to importUrl/importFile by detecting an http(s) URL. */
  importAny(value: string): Promise<void>
  /** Cancel the in-flight import's streaming job (download/transcribe) — openclip-2bm. */
  cancel(): Promise<void>
  acceptConsent(): void
  declineConsent(): void
  /** Replay the import the missing-model gate turned away (FEAT-kncqxf). No-op if none. */
  resumePending(): Promise<void>
  /** Forget the blocked import — the user cancelled the model download instead. */
  discardPending(): void
  /**
   * (Re-)transcribe an already-open, already-saved project — no probe, no
   * new project id (EPIC-k83ghw / FEAT-vz5vya). No-op if `projectId` is not
   * the currently open project.
   */
  retranscribe(projectId: string): Promise<void>
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}
function asMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // EPIC-k83ghw / BUG-whdqsc: this is user-facing text (ctl.error, the status
  // bar row) — drainJob's internal `${kind} failed [${code}]:` prefix stays
  // for isCancellation() to sniff (it runs on the ORIGINAL `e`, before this),
  // but a reader of the toast has no use for job kinds and error codes.
  return stripJobErrorPrefix(raw)
}

export function createImportController(deps: ImportControllerDeps): ImportController {
  const currentModel = (): WhisperModelSize =>
    deps.model ?? deps.getWhisperModel?.() ?? DEFAULT_MODEL
  const runImport = deps.runImportPipeline ?? defaultRunImportPipeline
  const runUrl = deps.runUrlDownload ?? defaultRunUrlDownload
  const genId = deps.genId ?? ((): string => crypto.randomUUID())
  const adoptSource =
    deps.adoptSource ??
    ((pid, fp) => deps.bridge.media.adoptSource({ projectId: pid, filePath: fp }))
  const reclaimMedia =
    deps.reclaimMedia ??
    ((pid: string): Promise<void> =>
      deps.bridge.media.reclaim({ projectId: pid }).then(() => undefined))
  const storage: StorageLike | null =
    deps.storage !== undefined
      ? deps.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null

  let state: ImportControllerState = {
    busy: false,
    pct: 0,
    stage: '',
    error: null,
    needsConsent: false,
    pendingImport: null
  }
  let pendingUrl: string | null = null
  // The in-flight streaming job's id (download or transcribe), tracked so cancel() can
  // abort it (openclip-2bm). Set on each job's onStart, cleared when the import settles.
  let activeJobId: string | null = null
  const listeners = new Set<() => void>()
  const set = (patch: Partial<ImportControllerState>): void => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }

  async function ensureModel(): Promise<boolean> {
    const model = currentModel()
    const statuses = await deps.bridge.model.status({ model })
    if (!statuses.some((s) => s.model === model && s.installed)) {
      deps.onNeedModel?.(model)
      return false
    }
    return true
  }

  // Run probe → extract → transcribe, then START A NEW PROJECT. If a project is
  // already open, flush-save it first so its clips/edits aren't lost and we don't
  // orphan/clobber it (G.3). The audio cache + new project share one fresh id.
  async function runPipeline(
    filePath: string,
    name: string,
    base: number,
    span: number,
    appOwned: boolean,
    taskId: string,
    /**
     * Fires with the new project's id the instant it is committed (visible in
     * the editor). Lets a caller's `retry` closure become commit-aware — see
     * `importFile`/`importUrl` (EPIC-k83ghw / FEAT-vz5vya).
     */
    onCommitted?: (projectId: string) => void
  ): Promise<void> {
    const projectId = genId()
    // For an app-owned (URL/YouTube) download, ADOPT the file into the persistent
    // per-project media store BEFORE probing/extracting, so the source lives at
    // its permanent path from the start and survives OS temp cleanup (Part H). An
    // adopt failure throws (caught by the caller) — we do NOT fall back to the
    // temp path, which would re-introduce the vanish-on-cleanup bug. File imports
    // keep the user's original path untouched.
    let sourcePath = filePath
    if (appOwned) {
      const adopted = await adoptSource(projectId, filePath)
      sourcePath = adopted.path
    }
    let committed = false
    try {
      await runPipelineAfterAdopt(projectId, sourcePath, name, base, span, appOwned, taskId, () => {
        committed = true
        onCommitted?.(projectId)
      })
    } catch (err) {
      // The app-owned download was adopted into persistent media BEFORE any .ocproj was
      // saved; on a failed/cancelled import reclaim the orphan dir now rather than
      // leaving it for the next-launch sweep (audit fix openclip-e5s). Best-effort —
      // never mask the original error. Skip reclaim once the project is COMMITTED (live
      // via setCurrentProject): a later failure must not delete media out from under a
      // project the user can already see (review follow-up).
      if (appOwned && !committed) await reclaimMedia(projectId).catch(() => {})
      throw err
    }
  }

  async function runPipelineAfterAdopt(
    projectId: string,
    sourcePath: string,
    name: string,
    base: number,
    span: number,
    appOwned: boolean,
    taskId: string,
    markCommitted: () => void
  ): Promise<void> {
    /**
     * COMMIT THE PROJECT AT PROBE TIME, not at the end (FEAT-ky1jfw).
     *
     * This used to run after `runImport` resolved — i.e. after a transcription
     * that can take ten minutes — which meant the app held a fully probed video
     * it refused to show, and the user sat on the Welcome screen watching a bar.
     * Worse, `App.showEditor` counted streamed transcript segments, so the first
     * closed sentence swapped the layout anyway and destroyed the progress bar,
     * Cancel and error surface mid-import.
     *
     * Committing here means the editor appears about a second in, with the real
     * video in the preview and the transcript filling the sidebar live, while
     * progress and Cancel live in the app-level status bar that outlives any
     * view. Same steps, same order, just moved ahead of the long work.
     */
    const commitProject = async (probed: SourceVideo): Promise<void> => {
      const current = deps.store.getCurrentProject()
      if (current) {
        // Save the COMPOSED project (live clips + transcript merged), not the raw
        // currentProject — otherwise the flush would persist stale/empty clips and
        // discard the user's edits, the very loss G.3 exists to prevent.
        const toSave = deps.store.composeProject?.() ?? current
        try {
          await deps.store.saveProject(toSave)
        } catch {
          /* best-effort flush — don't block the new import on a save error */
        }
      }
      // Stamp the permanent source path + ownership (Part H): for URL imports the
      // probe ran on the adopted path, but force it explicitly + mark app-owned so
      // project-delete reclaims it; file imports keep their original path, not owned.
      const sourceVideo = { ...probed, path: sourcePath, appOwned }
      const blank = deps.createBlankProject(name, sourceVideo)
      const committed = { ...blank, id: projectId }
      // hydrateProject (NOT setCurrentProject): `blank` carries clips: [] and
      // exportHistory: [], so this is what clears the outgoing project's slices.
      // No transcript is passed — it starts empty and fills from the partials
      // below, then `onTranscript` replaces it with the authoritative result.
      deps.store.hydrateProject(committed)
      // The project is now LIVE/visible — past here a failure must not reclaim its
      // media. A transcription that fails or is cancelled now leaves the user with
      // a real project holding a real video, which is the honest outcome: the
      // import DID happen, only the transcript is missing, and it can be retried.
      markCommitted()
      deps.ui?.setView?.('editor')
      // Write the blank project to disk NOW, not on the next autosave tick
      // (EPIC-k83ghw / BUG-5jwaxf). Autosave is deliberately SUSPENDED for the
      // whole duration of this import (it would otherwise serialize the
      // growing transcript on every streamed partial) and only flushes once
      // the job settles — so before this line, a project that is fully
      // visible in the editor did not exist on disk at all. A quit, crash, or
      // Mac restart during a 10-minute transcription lost it completely, and
      // for a URL import the orphan sweeper reclaimed the video too on next
      // launch. Best-effort: a failure here must not abort the import, since
      // the (suspended) autosave path is still the eventual backstop.
      try {
        await deps.store.saveProject(committed)
      } catch {
        /* best-effort initial persist — autosave still flushes on settle */
      }
    }

    await runImport({
      bridge: deps.bridge,
      filePath: sourcePath,
      projectId,
      model: currentModel(),
      // Source language for whisper (undefined/'' ⇒ auto-detect). Read lazily so
      // the latest Settings value applies without rebuilding the controller.
      language: deps.getLanguage?.(),
      onProgress: (p, s, detail) => {
        const scaled = base + Math.round((p / 100) * span)
        set({ pct: scaled, stage: s })
        deps.ui?.updateTask?.(taskId, { pct: scaled, stage: s, detail })
      },
      onProbed: commitProject,
      // Guarded on the project this transcription belongs to (EPIC-k83ghw /
      // BUG-93txd0): the user can switch to a different project in the
      // sidebar while transcription keeps streaming in the background, and an
      // unguarded write here landed the WRONG video's words — and therefore
      // captions/clip text — into whichever project happened to be open when
      // the partial/final event arrived, silently corrupting its .ocproj.
      onPartial: (partial) => {
        if (deps.store.getCurrentProject()?.id !== projectId) return
        deps.store.appendTranscriptPartial(partial)
      },
      onTranscript: (t: JobResult['transcribe']) => {
        if (deps.store.getCurrentProject()?.id !== projectId) return
        deps.store.hydrateTranscript(t)
      },
      onExtractStart: (jobId) => {
        activeJobId = jobId
      },
      onStart: (jobId) => {
        activeJobId = jobId
      }
    })
  }

  /**
   * Re-run transcription on an ALREADY-open, already-saved project — no
   * probe, no adopt, no new project id (EPIC-k83ghw / FEAT-vz5vya).
   *
   * Before this, the ONLY way to get a transcript was the import pipeline, so
   * a project left without one — wifi dropped mid-transcribe, whisper
   * crashed, the user hit Cancel, or a video was imported for its clips
   * workflow before AI generation existed — had no recovery but re-importing
   * the same file as a brand-new, duplicate project. Used both as the target
   * of a commit-aware Retry (see `importFile`/`importUrl`) and by an explicit
   * "Transcribe" action a caller can offer whenever a project has a source
   * video but no transcript.
   *
   * Extraction goes through the SAME per-project content-addressed WAV cache
   * (the `extract-audio` job) the original import used, so re-running this
   * after a failed transcribe (the common case) does not re-extract a
   * multi-hour source — only whisper actually reruns.
   */
  async function retranscribe(projectId: string): Promise<void> {
    const project = deps.store.getCurrentProject()
    if (!project || project.id !== projectId) return
    const taskId = genId()
    set({ busy: true, error: null, pct: 0, stage: 'extracting' })
    let tracked = false
    try {
      if (!(await ensureModel())) {
        set({ busy: false })
        return
      }
      deps.ui?.beginTask?.({
        id: taskId,
        label: project.name,
        stages: ['extracting', 'transcribing'],
        cancel,
        retry: () => {
          deps.ui?.dismissTask?.(taskId)
          return retranscribe(projectId)
        }
      })
      tracked = true
      // A clean slate: appendTranscriptPartial only APPENDS, so a stale prior
      // transcript would otherwise show duplicated words until the terminal
      // hydrateTranscript below replaces it wholesale.
      if (deps.store.getCurrentProject()?.id === projectId) {
        deps.store.hydrateTranscript({ language: '', segments: [], words: [] })
      }
      deps.ui?.updateTask?.(taskId, { pct: 5, stage: 'extracting' })
      const { wavPath } = await drainJob(
        deps.bridge,
        'extract-audio',
        { projectId, sourcePath: project.sourceVideo.path },
        {
          onStart: (jobId) => {
            activeJobId = jobId
          },
          onProgress: (p, s) => {
            const scaled = 5 + Math.round((p / 100) * 15)
            set({ pct: scaled, stage: s })
            deps.ui?.updateTask?.(taskId, { pct: scaled, stage: s })
          }
        }
      )
      deps.ui?.updateTask?.(taskId, { pct: 20, stage: 'extracting' })
      const transcript = await drainJob(
        deps.bridge,
        'transcribe',
        { projectId, wavPath, model: currentModel(), language: deps.getLanguage?.() },
        {
          onStart: (jobId) => {
            activeJobId = jobId
          },
          onProgress: (p, s) => {
            const scaled = 20 + Math.round((p / 100) * 80)
            set({ pct: scaled, stage: s })
            deps.ui?.updateTask?.(taskId, { pct: scaled, stage: s })
          },
          // Guarded exactly like a fresh import (EPIC-k83ghw / BUG-93txd0): the
          // user can switch projects while this streams.
          onPartial: (partial) => {
            if (deps.store.getCurrentProject()?.id !== projectId) return
            deps.store.appendTranscriptPartial(partial)
          }
        }
      )
      if (deps.store.getCurrentProject()?.id === projectId) {
        deps.store.hydrateTranscript(transcript)
        const composed = deps.store.composeProject?.()
        if (composed) await deps.store.saveProject(composed)
      }
      set({ stage: 'done' })
      deps.ui?.settleTask?.(taskId, 'done')
    } catch (e) {
      const message = asMessage(e)
      set({ error: message })
      if (tracked) {
        deps.ui?.settleTask?.(taskId, isCancellation(e) ? 'canceled' : 'error', { error: message })
      }
    } finally {
      activeJobId = null
      set({ busy: false })
    }
  }

  /**
   * Replay the import the missing-model gate turned away.
   *
   * Clears the intent BEFORE replaying so a second failure re-records it fresh
   * rather than resuming a stale value, and so a double-fire (dialog closing and
   * `onDownloaded` both calling in) cannot start the same import twice.
   */
  async function resumePending(): Promise<void> {
    const pending = state.pendingImport
    if (!pending) return
    set({ pendingImport: null })
    if (pending.kind === 'file') await importFile(pending.value)
    else await importUrl(pending.value)
  }

  function discardPending(): void {
    set({ pendingImport: null })
  }

  async function importFile(path: string): Promise<void> {
    if (!path) return
    // Per-import task key (audit fix openclip-ce3): a hardcoded 'import' key meant two
    // concurrent imports shared one registry entry, and the first to finish wiped the
    // other's progress. genId() makes each import's task key unique.
    const taskId = genId()
    set({ busy: true, error: null, pct: 0 })
    let tracked = false
    // Set the instant `runPipeline` commits the project (EPIC-k83ghw /
    // FEAT-vz5vya). `retry` below reads this at CALL time, so once the
    // project exists on disk a retry re-transcribes it in place instead of
    // probing + adopting + creating a brand-new, duplicate project.
    let committedProjectId: string | null = null
    try {
      if (!(await ensureModel())) {
        // Hold the intent so the model dialog can hand it back (FEAT-kncqxf).
        set({ busy: false, pendingImport: { kind: 'file', value: path } })
        return
      }
      // Register the activity only once it can actually run: a model-gated import
      // never started, and a status-bar row for it would be reporting fiction.
      deps.ui?.beginTask?.({
        id: taskId,
        label: basename(path),
        stages: FILE_IMPORT_STAGES,
        cancel,
        retry: () => {
          // Dismiss THIS row before starting the replacement run — otherwise
          // every retry stacked a second, identical failed row next to the
          // one it was retrying (EPIC-k83ghw / BUG-w2jv3w).
          deps.ui?.dismissTask?.(taskId)
          return committedProjectId ? retranscribe(committedProjectId) : importFile(path)
        }
      })
      tracked = true
      await runPipeline(path, basename(path), 0, 100, false, taskId, (id) => {
        committedProjectId = id
      }) // file import: user's original, not app-owned
      set({ stage: 'done' })
      deps.ui?.settleTask?.(taskId, 'done')
    } catch (e) {
      const message = asMessage(e)
      set({ error: message })
      if (tracked) {
        deps.ui?.settleTask?.(taskId, isCancellation(e) ? 'canceled' : 'error', { error: message })
      }
    } finally {
      activeJobId = null
      set({ busy: false })
    }
  }

  async function importUrl(url: string): Promise<void> {
    // Normalize a bare pasted domain ("youtube.com/watch?v=…") to a full URL
    // (EPIC-k83ghw / BUG-aryvgg) — yt-dlp and the main-process job validator
    // both require an explicit scheme, so this must happen before `u` reaches
    // either, not just at the UI's isUrl() routing decision.
    const u = normalizeUrlInput(url)
    if (!u) return
    // One-time yt-dlp / TOS consent (PRD §20.4) before the first URL download.
    if (storage && storage.getItem(CONSENT_KEY) !== '1') {
      pendingUrl = u
      // Clear any prior error so it doesn't linger beneath the consent dialog.
      set({ needsConsent: true, error: null })
      return
    }
    const taskId = genId() // per-import task key (audit fix openclip-ce3)
    set({ busy: true, error: null, pct: 0, stage: 'downloading' })
    let tracked = false
    // See importFile: set once the project is committed, so a retry after
    // that point re-transcribes in place instead of re-downloading + creating
    // a duplicate project (EPIC-k83ghw / FEAT-vz5vya).
    let committedProjectId: string | null = null
    try {
      if (!(await ensureModel())) {
        set({ busy: false, pendingImport: { kind: 'url', value: u } })
        return
      }
      deps.ui?.beginTask?.({
        id: taskId,
        label: u,
        stages: URL_IMPORT_STAGES,
        cancel,
        retry: () => {
          // Dismiss THIS row first — otherwise every retry stacked a second,
          // identical failed row next to the one it was retrying (EPIC-k83ghw
          // / BUG-w2jv3w), which is exactly what a real yt-dlp 403 showed.
          deps.ui?.dismissTask?.(taskId)
          return committedProjectId ? retranscribe(committedProjectId) : importUrl(u)
        }
      })
      tracked = true
      const dl = await runUrl({
        bridge: deps.bridge,
        url: u,
        onProgress: (p, _stage, detail) => {
          const scaled = Math.round(p * 0.2) // 0..20% band
          set({ pct: scaled, stage: 'downloading' })
          deps.ui?.updateTask?.(taskId, { pct: scaled, stage: 'downloading', detail })
        },
        onStart: (jobId) => {
          activeJobId = jobId
        }
      })
      // Now that yt-dlp has resolved it, name the row after the video rather
      // than the raw URL it was pasted from.
      deps.ui?.updateTask?.(taskId, { pct: 20, label: dl.title ?? u })
      await runPipeline(dl.filePath, dl.title ?? 'Imported video', 20, 80, true, taskId, (id) => {
        committedProjectId = id
      }) // URL import: app-owned download
      set({ stage: 'done' })
      deps.ui?.settleTask?.(taskId, 'done')
    } catch (e) {
      const message = asMessage(e)
      set({ error: message })
      if (tracked) {
        deps.ui?.settleTask?.(taskId, isCancellation(e) ? 'canceled' : 'error', { error: message })
      }
    } finally {
      activeJobId = null
      set({ busy: false })
    }
  }

  function acceptConsent(): void {
    storage?.setItem(CONSENT_KEY, '1')
    set({ needsConsent: false })
    const u = pendingUrl
    pendingUrl = null
    if (u) void importUrl(u)
  }

  function declineConsent(): void {
    pendingUrl = null
    set({ needsConsent: false })
  }

  function importAny(value: string): Promise<void> {
    return isUrl(value) ? importUrl(value) : importFile(value)
  }

  /**
   * Cancel the in-flight import (openclip-2bm): abort the active streaming job (download
   * or transcribe) via the bridge. The job emits a terminal CANCELLED error, so the
   * importUrl/importFile promise rejects and its finally clears busy + reclaims any
   * adopted media. No-op when nothing is running. Best-effort — a cancel IPC failure is
   * swallowed so the UI can't get wedged.
   */
  async function cancel(): Promise<void> {
    const jobId = activeJobId
    if (!jobId) return
    try {
      await deps.bridge.jobs.cancel(jobId)
    } catch {
      /* best-effort — the job may have already settled */
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    importFile,
    importUrl,
    importAny,
    cancel,
    acceptConsent,
    declineConsent,
    resumePending,
    discardPending,
    retranscribe
  }
}
