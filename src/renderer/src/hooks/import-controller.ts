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

/** localStorage key gating the one-time yt-dlp/TOS consent (PRD §20.4). */
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
  setCurrentProject(project: Project): void
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
    span: number
  ): Promise<void> {
    const projectId = genId()
    const result = await runImport({
      bridge: deps.bridge,
      filePath,
      projectId,
      model,
      onProgress: (p, s) => {
        const scaled = base + Math.round((p / 100) * span)
        set({ pct: scaled, stage: s })
        deps.ui?.upsertTask?.({ jobId: 'import', progress: scaled, status: 'running' })
      },
      onPartial: (partial) => deps.store.appendTranscriptPartial(partial),
      onTranscript: (t: JobResult['transcribe']) => deps.store.hydrateTranscript(t)
    })

    const current = deps.store.getCurrentProject()
    if (current) {
      try {
        await deps.store.saveProject(current)
      } catch {
        /* best-effort flush — don't block the new import on a save error */
      }
    }
    const blank = deps.createBlankProject(name, result.sourceVideo)
    deps.store.setCurrentProject({ ...blank, id: projectId, transcript: result.transcript })
    deps.ui?.setView?.('editor')
  }

  async function importFile(path: string): Promise<void> {
    if (!path) return
    set({ busy: true, error: null, pct: 0 })
    try {
      if (!(await ensureModel())) {
        set({ busy: false })
        return
      }
      await runPipeline(path, basename(path), 0, 100)
      set({ stage: 'done' })
    } catch (e) {
      set({ error: asMessage(e) })
    } finally {
      set({ busy: false })
      deps.ui?.clearTask?.('import')
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
    set({ busy: true, error: null, pct: 0, stage: 'downloading' })
    try {
      if (!(await ensureModel())) {
        set({ busy: false })
        return
      }
      const dl = await runUrl({
        bridge: deps.bridge,
        url: u,
        onProgress: (p) => set({ pct: Math.round(p * 0.2), stage: 'downloading' }) // 0..20% band
      })
      await runPipeline(dl.filePath, dl.title ?? 'Imported video', 20, 80)
      set({ stage: 'done' })
    } catch (e) {
      set({ error: asMessage(e) })
    } finally {
      set({ busy: false })
      deps.ui?.clearTask?.('import')
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
    acceptConsent,
    declineConsent
  }
}
