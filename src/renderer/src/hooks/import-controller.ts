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
  runImportPipeline as defaultRunImportPipeline,
  runUrlDownload as defaultRunUrlDownload,
  isUrl,
  type OpenClipBridge
} from '@renderer/components/import-pipeline'

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

export interface ImportControllerState {
  busy: boolean
  pct: number
  stage: string
  error: string | null
  /** True when a URL import is blocked awaiting the one-time TOS consent. */
  needsConsent: boolean
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

/** Optional UI seam (view routing + the task/progress map). */
export interface ImportControllerUi {
  setView?(view: 'editor'): void
  upsertTask?(task: { jobId: string; progress: number; status: 'running' | 'done' | 'error' }): void
  clearTask?(jobId: string): void
}

export interface ImportControllerDeps {
  bridge: OpenClipBridge
  store: ImportControllerStore
  createBlankProject(name: string, sourceVideo: SourceVideo): Project
  model?: WhisperModelSize
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
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}
function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createImportController(deps: ImportControllerDeps): ImportController {
  const model = deps.model ?? DEFAULT_MODEL
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
    needsConsent: false
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
    taskId: string
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
    const result = await runImport({
      bridge: deps.bridge,
      filePath: sourcePath,
      projectId,
      model,
      // Source language for whisper (undefined/'' ⇒ auto-detect). Read lazily so
      // the latest Settings value applies without rebuilding the controller.
      language: deps.getLanguage?.(),
      onProgress: (p, s) => {
        const scaled = base + Math.round((p / 100) * span)
        set({ pct: scaled, stage: s })
        deps.ui?.upsertTask?.({ jobId: taskId, progress: scaled, status: 'running' })
      },
      onPartial: (partial) => deps.store.appendTranscriptPartial(partial),
      onTranscript: (t: JobResult['transcribe']) => deps.store.hydrateTranscript(t),
      onStart: (jobId) => {
        activeJobId = jobId
      }
    })

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
    const sourceVideo = { ...result.sourceVideo, path: sourcePath, appOwned }
    const blank = deps.createBlankProject(name, sourceVideo)
    // hydrateProject (NOT setCurrentProject): `blank` carries clips: [] and
    // exportHistory: [], so this is what clears the outgoing project's slices.
    deps.store.hydrateProject({ ...blank, id: projectId, transcript: result.transcript })
    // The project is now LIVE/visible — past here a failure must not reclaim its media.
    markCommitted()
    deps.ui?.setView?.('editor')
  }

  async function importFile(path: string): Promise<void> {
    if (!path) return
    // Per-import task key (audit fix openclip-ce3): a hardcoded 'import' key meant two
    // concurrent imports would share one tasks entry and the first to finish would
    // clearTask the other's progress. genId() makes each import's task key unique.
    const taskId = genId()
    set({ busy: true, error: null, pct: 0 })
    try {
      if (!(await ensureModel())) {
        set({ busy: false })
        return
      }
      await runPipeline(path, basename(path), 0, 100, false, taskId) // file import: user's original, not app-owned
      set({ stage: 'done' })
    } catch (e) {
      set({ error: asMessage(e) })
    } finally {
      activeJobId = null
      set({ busy: false })
      deps.ui?.clearTask?.(taskId)
    }
  }

  async function importUrl(url: string): Promise<void> {
    const u = url.trim()
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
    try {
      if (!(await ensureModel())) {
        set({ busy: false })
        return
      }
      const dl = await runUrl({
        bridge: deps.bridge,
        url: u,
        onProgress: (p) => set({ pct: Math.round(p * 0.2), stage: 'downloading' }), // 0..20% band
        onStart: (jobId) => {
          activeJobId = jobId
        }
      })
      await runPipeline(dl.filePath, dl.title ?? 'Imported video', 20, 80, true, taskId) // URL import: app-owned download
      set({ stage: 'done' })
    } catch (e) {
      set({ error: asMessage(e) })
    } finally {
      activeJobId = null
      set({ busy: false })
      deps.ui?.clearTask?.(taskId)
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
    declineConsent
  }
}
