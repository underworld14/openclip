/**
 * jobStatus.ts — the PURE view-model behind the persistent job status bar
 * (EPIC-zpa1nd / FEAT-vh2bwz).
 *
 * Every long operation in the app already streams `{pct, stage}` over a per-job
 * MessagePort, but `stage` is an INTERNAL token emitted by a runner ('probing',
 * 'analyzing', 'encoding'), and the only thing the UI ever did with it was print
 * it verbatim next to a percentage. This module is where those tokens become
 * something a person can read, and where "how much longer?" is answered.
 *
 * Pure — no React, no zustand, no DOM — so it is unit-testable in the repo's node
 * vitest env, matching `readinessView` / `clipView` / `Dashboard.view`. The
 * `JobTask` type lives here (not in the store) so the view-model has no runtime
 * dependency on the store it describes.
 */

import { formatBytes } from './formatBytes'
import { formatSeconds } from './format-time'

// ============================================================================
// The task record — one user-visible ACTIVITY, not one job
// ============================================================================

/**
 * An activity spans however many jobs + invokes it takes. An import is
 * `url-download` → probe → extract → `transcribe`: three jobs and two invokes,
 * but ONE bar. Tracking at this level is why the status bar can say "Import
 * talk.mp4" instead of narrating plumbing.
 */
export type TaskKind = 'import' | 'export' | 'batch-export' | 'model-download' | 'generate-clips'

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

/** Stage-specific extras. Every field optional: most stages report none. */
export interface TaskDetail {
  /** Downloads (yt-dlp, GGML models). */
  receivedBytes?: number
  totalBytes?: number
  /** Map-reduce clip generation. */
  chunkIndex?: number
  chunkCount?: number
  /** Export's reframe face-sampling pass. */
  framesSampled?: number
  frameBudget?: number
  /** Batch export roll-up. */
  itemsDone?: number
  itemsTotal?: number
}

export interface JobTask {
  id: string
  kind: TaskKind
  /** Per-clip rows nest under their batch task. */
  parentId?: string
  /** What the work is being done TO — a filename, a clip title, a model name. */
  label: string
  /** The internal stage token last reported; `stageLabel()` humanises it. */
  stage: string
  pct: number
  status: TaskStatus
  /**
   * The stages this activity will pass through, in order — set at begin time by
   * the caller, which is the only place that knows (a URL import downloads
   * first, a file import does not; an export only analyzes when reframe or
   * silence-removal is on). Absent ⇒ no checklist, just a bar.
   */
  stages?: string[]
  startedAt: number
  /** Reset whenever `stage` changes, so per-stage elapsed is truthful. */
  stageStartedAt: number
  detail?: TaskDetail
  error?: string
  /** Set on a completed export so the bar can offer "Reveal in Finder". */
  outputPath?: string
  cancel?: () => Promise<void>
  retry?: () => Promise<void>
}

// ============================================================================
// Stage vocabulary
// ============================================================================

/**
 * Internal stage token → what the user reads. Keys are every stage any runner
 * emits; `job-status.spec.ts` asserts this map covers them all, so a new runner
 * stage cannot silently reach the UI as a raw token.
 */
export const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting in queue',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  probing: 'Reading video',
  extracting: 'Extracting audio',
  transcribing: 'Transcribing',
  analyzing: 'Analyzing',
  encoding: 'Rendering',
  done: 'Finishing up'
}

/**
 * Humanise a stage token. An UNKNOWN token is title-cased rather than dropped:
 * a future runner stage should read slightly awkwardly, never render as a
 * lowercase identifier and never blank the label.
 */
export function stageLabel(stage: string): string {
  if (!stage) return ''
  const known = STAGE_LABELS[stage]
  if (known) return known
  const spaced = stage.replace(/[-_]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export type ChecklistState = 'done' | 'active' | 'pending'

export interface ChecklistStep {
  stage: string
  label: string
  state: ChecklistState
}

/**
 * The named stage checklist — "Read video ✓ → Extract audio ✓ → Transcribing
 * (62%) → …". A single bar cannot tell the user that four minutes of silence
 * means whisper is running rather than that the app has hung; a checklist can.
 *
 * A stage the task has passed WITHOUT reporting (a fast probe that never
 * rendered) still counts as done — position in the sequence is the authority,
 * not whether we happened to observe it.
 */
export function stageChecklist(task: JobTask): ChecklistStep[] {
  const stages = task.stages
  if (!stages || stages.length === 0) return []
  // A terminal task has passed every stage it is ever going to.
  const currentIndex = task.status === 'done' ? stages.length : stages.indexOf(task.stage)
  return stages.map((stage, i) => ({
    stage,
    label: stageLabel(stage),
    state:
      currentIndex < 0
        ? 'pending'
        : i < currentIndex
          ? 'done'
          : i === currentIndex
            ? 'active'
            : 'pending'
  }))
}

// ============================================================================
// Elapsed / ETA
// ============================================================================

/**
 * Remaining milliseconds, linearly extrapolated from elapsed vs percent.
 *
 * Deliberately returns null outside a middle band. Below ~5% the extrapolation
 * is noise (a 2-second sample predicting a 10-minute job), and above ~97% it
 * counts down to a number the user has already stopped caring about. A missing
 * ETA reads as honest; a wildly wrong one reads as broken.
 */
export function estimateEta(task: JobTask, now: number): number | null {
  if (task.status !== 'running') return null
  if (task.pct < 5 || task.pct > 97) return null
  const elapsed = now - task.startedAt
  if (elapsed < 3000) return null
  const total = (elapsed / task.pct) * 100
  const remaining = total - elapsed
  return remaining > 0 ? remaining : null
}

/** "~8s left" / "~3m left" / "~1h 5m left" — coarse on purpose. */
export function formatEta(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${Math.max(1, s)}s left`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m left`
  const h = Math.floor(m / 60)
  return `~${h}h ${m % 60}m left`
}

/** Wall-clock since the activity began, as `m:ss` (or `h:mm:ss` past an hour). */
export function formatElapsed(task: JobTask, now: number): string {
  return formatSeconds(Math.max(0, now - task.startedAt) / 1000, { hours: 'auto' })
}

// ============================================================================
// Detail line
// ============================================================================

/**
 * The stage-specific second line: bytes + throughput for downloads, chunk
 * position for map-reduce generation, frames for the reframe sampling pass,
 * item counts for a batch. Returns '' when the stage has nothing extra to say.
 *
 * The byte counts in particular already existed and were being THROWN AWAY —
 * `runUrlDownload` collapsed a `{downloadedBytes,totalBytes,pct}` partial down
 * to just the percent before the UI ever saw it (FEAT-8559h1).
 */
export function describeDetail(task: JobTask, now: number): string {
  const d = task.detail
  if (!d) return ''

  if (d.receivedBytes !== undefined && d.receivedBytes > 0) {
    const got = formatBytes(d.receivedBytes)
    const total = formatBytes(d.totalBytes)
    const size = total ? `${got} of ${total}` : got
    const rate = throughput(d.receivedBytes, now - task.stageStartedAt)
    return rate ? `${size} · ${rate}` : size
  }
  if (d.chunkCount !== undefined && d.chunkIndex !== undefined) {
    return `chunk ${Math.min(d.chunkIndex + 1, d.chunkCount)} of ${d.chunkCount}`
  }
  if (d.frameBudget !== undefined && d.framesSampled !== undefined) {
    return `${d.framesSampled} of ${d.frameBudget} frames sampled`
  }
  if (d.itemsTotal !== undefined) {
    return `${d.itemsDone ?? 0} of ${d.itemsTotal} done`
  }
  return ''
}

/** Bytes/ms → "2.1 MB/s". Suppressed under a second — the figure is meaningless. */
function throughput(bytes: number, elapsedMs: number): string {
  if (elapsedMs < 1000) return ''
  const perSecond = bytes / (elapsedMs / 1000)
  const formatted = formatBytes(perSecond)
  return formatted ? `${formatted}/s` : ''
}

// ============================================================================
// Whole-task description + selection
// ============================================================================

export interface TaskDescription {
  /** "Transcribing talk.mp4" — the one line to show when collapsed. */
  title: string
  /** The stage on its own, for the checklist / aria labels. */
  stage: string
  detail: string
  /** '' when no honest estimate is available. */
  eta: string
  elapsed: string
  /** Whether a determinate bar makes sense (false ⇒ render indeterminate). */
  determinate: boolean
}

const KIND_VERBS: Record<TaskKind, string> = {
  import: 'Importing',
  export: 'Exporting',
  'batch-export': 'Exporting',
  'model-download': 'Downloading',
  'generate-clips': 'Finding clips in'
}

export function describeTask(task: JobTask, now: number): TaskDescription {
  const stage = stageLabel(task.stage)
  const eta = estimateEta(task, now)
  // Mid-flight the STAGE is the useful verb ("Transcribing talk.mp4"); before a
  // stage is reported, and after the task settles, fall back to the kind.
  const verb = task.status === 'running' && stage ? stage : KIND_VERBS[task.kind]
  return {
    title:
      task.status === 'error'
        ? `${KIND_VERBS[task.kind]} ${task.label} failed`
        : task.status === 'canceled'
          ? `${KIND_VERBS[task.kind]} ${task.label} canceled`
          : task.status === 'done'
            ? `${task.label} finished`
            : `${verb} ${task.label}`,
    stage,
    detail: describeDetail(task, now),
    eta: eta === null ? '' : formatEta(eta),
    elapsed: formatElapsed(task, now),
    // A 0% that has been sitting there is exactly the "frozen bar" this epic
    // exists to kill — show motion instead of a lie.
    determinate: task.pct > 0
  }
}

/**
 * `drainJob` reports a terminal job error as
 * `` `${kind} failed [${code}]: ${message}` `` (hooks/useJob.ts), and the
 * sidecar emits `CANCELLED` for a user cancel, an app quit and a renderer
 * port-close alike. A cancellation is not a failure and must not be presented
 * as one — hence sniffing the code rather than surfacing the raw string.
 */
export function isCancellation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /\[CANCELLED\]/.test(message)
}

/** Running/queued work, most recent first; children excluded (they nest). */
export function activeTasks(tasks: Record<string, JobTask>): JobTask[] {
  return Object.values(tasks)
    .filter((t) => !t.parentId && (t.status === 'running' || t.status === 'queued'))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** All top-level tasks (including settled-but-not-dismissed), most recent first. */
export function visibleTasks(tasks: Record<string, JobTask>): JobTask[] {
  return Object.values(tasks)
    .filter((t) => !t.parentId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** A batch task's per-item children, in the order they were begun. */
export function childTasks(tasks: Record<string, JobTask>, parentId: string): JobTask[] {
  return Object.values(tasks)
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * The one task the collapsed bar shows: the most recently started running or
 * queued activity, else the most recent settled one still awaiting dismissal
 * (so a failure does not vanish the instant the job ends — the whole point).
 */
export function selectPrimaryTask(tasks: Record<string, JobTask>): JobTask | null {
  const active = activeTasks(tasks)
  if (active.length > 0) return active[0]
  return visibleTasks(tasks)[0] ?? null
}
