/**
 * src/renderer/src/stores/jobsStore.ts — the LIVE registry of running work
 * (EPIC-zpa1nd / FEAT-vh2bwz).
 *
 * This replaces `uiStore.tasks`, which was written by the import controller and
 * read by nobody, and the `useJob` hook that was built to feed it and never
 * called. The difference is not the data structure — it is that something
 * finally renders it: `JobStatusBar` mounts at the app shell, above every view
 * and outside every modal, so a running job cannot be hidden by a layout swap or
 * a dismissed dialog.
 *
 * WHY ACTIVITIES, NOT JOBS. Tracking happens at the ORCHESTRATOR level
 * (`import-pipeline`, `export-run`, `batch-export`, `model-download`,
 * `generate-clips-run`) rather than inside `drainJob`. `hooks/useJob.ts` is a
 * FROZEN trunk seam, and more importantly the unit a user cares about is the
 * activity: one import is a `url-download` job, two invokes and a `transcribe`
 * job, but it is ONE line in the status bar. The orchestrators already take
 * `onProgress`/`onStart`, so that is exactly where the boundary sits.
 *
 * Terminal policy: a SUCCESS auto-dismisses after a few seconds (the user saw
 * the bar fill; nothing is owed). A FAILURE or CANCELLATION stays until it is
 * dismissed or retried — an error the user never had a chance to read is the
 * bug this epic exists to fix, and a self-clearing one is the same bug with a
 * timer on it.
 */

import { create } from 'zustand'
import type { JobTask, TaskDetail, TaskKind, TaskStatus } from '@renderer/components/jobStatus'
import { activeTasks, childTasks, isCancellation } from '@renderer/components/jobStatus'

/** How long a SUCCEEDED task stays on screen before it clears itself. */
export const DONE_DISMISS_MS = 6000

export interface BeginTaskSpec {
  /** Caller-supplied id (the import controller already mints one per import). */
  id?: string
  kind: TaskKind
  label: string
  /** The stages this activity will pass through — drives the checklist. */
  stages?: string[]
  parentId?: string
  cancel?: () => Promise<void>
  retry?: () => Promise<void>
}

export interface TaskPatch {
  pct?: number
  stage?: string
  detail?: TaskDetail
  label?: string
  outputPath?: string
  cancel?: () => Promise<void>
  retry?: () => Promise<void>
}

export interface JobsStore {
  tasks: Record<string, JobTask>
  /** Register a new activity as `running`; returns its id. */
  beginTask: (spec: BeginTaskSpec) => string
  /** Merge progress/stage/detail into a live task (no-op if it is gone). */
  updateTask: (id: string, patch: TaskPatch) => void
  /** Move a task to a terminal state. Success schedules its own dismissal. */
  settleTask: (
    id: string,
    status: Extract<TaskStatus, 'done' | 'error' | 'canceled'>,
    patch?: TaskPatch & { error?: string }
  ) => void
  /** Drop a task and any children it owns. */
  dismissTask: (id: string) => void
}

let autoId = 0
function nextTaskId(): string {
  autoId += 1
  return `task-${Date.now().toString(36)}-${autoId}`
}

export const useJobsStore = create<JobsStore>()((set, get) => ({
  tasks: {},

  beginTask: (spec) => {
    const id = spec.id ?? nextTaskId()
    const now = Date.now()
    const task: JobTask = {
      id,
      kind: spec.kind,
      parentId: spec.parentId,
      label: spec.label,
      stage: spec.stages?.[0] ?? '',
      pct: 0,
      status: 'running',
      stages: spec.stages,
      startedAt: now,
      stageStartedAt: now,
      cancel: spec.cancel,
      retry: spec.retry
    }
    set((s) => ({ tasks: { ...s.tasks, [id]: task } }))
    return id
  },

  updateTask: (id, patch) =>
    set((s) => {
      const prev = s.tasks[id]
      // A late progress event for a task the user already dismissed must not
      // resurrect it as a zombie row.
      if (!prev) return s
      // Reset the per-stage clock only on a REAL stage change, so "Transcribing
      // · 4:12" measures the stage and not the whole activity.
      const stageChanged = patch.stage !== undefined && patch.stage !== prev.stage
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...prev,
            ...patch,
            // Merge detail rather than replacing: a download reports bytes and
            // an export reports frames, but neither reports the other's fields
            // on every tick.
            detail: patch.detail ? { ...prev.detail, ...patch.detail } : prev.detail,
            stageStartedAt: stageChanged ? Date.now() : prev.stageStartedAt
          }
        }
      }
    }),

  settleTask: (id, status, patch) => {
    set((s) => {
      const prev = s.tasks[id]
      if (!prev) return s
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...prev,
            ...patch,
            detail: patch?.detail ? { ...prev.detail, ...patch.detail } : prev.detail,
            status,
            // Snap a success to a full bar: the last progress event routinely
            // lands at 98% and a "finished" row at 98% reads as stalled.
            pct: status === 'done' ? 100 : prev.pct,
            error: patch?.error,
            // A settled task cannot be cancelled; drop the handle so the UI
            // cannot offer a button that does nothing.
            cancel: undefined
          }
        }
      }
    })
    if (status === 'done') {
      // `unref` where the runtime has it (node/tests) so a pending dismissal
      // cannot hold the process open past a spec — same treatment the sidecar
      // manager gives its SIGKILL escalation timer. Browsers return a number
      // with no `unref`, hence the optional call.
      const timer = setTimeout(() => get().dismissTask(id), DONE_DISMISS_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
  },

  dismissTask: (id) =>
    set((s) => {
      const next = { ...s.tasks }
      // Children are owned by their parent — dismissing a batch takes its rows.
      for (const child of childTasks(s.tasks, id)) delete next[child.id]
      delete next[id]
      return { tasks: next }
    })
}))

// ============================================================================
// Non-React accessors (the autosave subscriber and orchestrators are not hooks)
// ============================================================================

/**
 * Is any activity of `kind` currently running? Used by the autosave subscriber
 * to suspend itself during an import: the project is now committed BEFORE
 * transcription (FEAT-ky1jfw), so every streamed transcript partial would
 * otherwise schedule a full `.ocproj` write — hundreds of them across a long
 * transcription.
 */
export function hasActiveKind(kind: TaskKind): boolean {
  return activeTasks(useJobsStore.getState().tasks).some((t) => t.kind === kind)
}

/** TEST-ONLY: clear the registry between specs. */
export function __resetJobsStoreForTests(): void {
  useJobsStore.setState({ tasks: {} })
}

// ============================================================================
// trackTask — the wrapper every orchestrator call site uses
// ============================================================================

export interface TrackTaskHandle {
  readonly id: string
  /** Report progress; `detail` is merged, so callers send only what they know. */
  progress: (pct: number, stage?: string, detail?: TaskDetail) => void
  /** Attach the cancel handle once the underlying job has started. */
  setCancel: (cancel: () => Promise<void>) => void
  /** Record the produced file so the settled row can offer "Reveal". */
  setOutputPath: (path: string) => void
  /**
   * Drop the row entirely instead of settling it — for work that turned out
   * never to have started. An export whose save dialog the user dismissed did
   * not succeed and did not fail; reporting either would be a lie, and
   * "clip.mp4 finished" for a file that was never written is the worse one.
   */
  abandon: () => void
}

/**
 * Run an orchestrator with a status-bar task around it. Registers the activity,
 * hands back a handle for progress, and settles it exactly once — `done`,
 * `canceled` or `error` — whichever way `run` resolves.
 *
 * The original error is always RETHROWN: callers keep their own local error
 * handling (ExportPanel's inline message, the clips slice's `generateError`);
 * the bar is an additional surface, never a replacement for one.
 */
export async function trackTask<T>(
  spec: BeginTaskSpec,
  run: (handle: TrackTaskHandle) => Promise<T>
): Promise<T> {
  const store = useJobsStore.getState()
  const id = store.beginTask(spec)
  let abandoned = false
  const handle: TrackTaskHandle = {
    id,
    progress: (pct, stage, detail) =>
      useJobsStore.getState().updateTask(id, { pct: Math.round(pct), stage, detail }),
    setCancel: (cancel) => useJobsStore.getState().updateTask(id, { cancel }),
    setOutputPath: (outputPath) => useJobsStore.getState().updateTask(id, { outputPath }),
    abandon: () => {
      abandoned = true
      useJobsStore.getState().dismissTask(id)
    }
  }
  try {
    const result = await run(handle)
    if (!abandoned) useJobsStore.getState().settleTask(id, 'done')
    return result
  } catch (err) {
    if (abandoned) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (isCancellation(err)) useJobsStore.getState().settleTask(id, 'canceled')
    else useJobsStore.getState().settleTask(id, 'error', { error: message })
    throw err
  }
}
