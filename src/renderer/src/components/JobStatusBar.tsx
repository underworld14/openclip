/**
 * JobStatusBar — the persistent, app-level surface for everything that is
 * running (EPIC-zpa1nd / FEAT-vh2bwz).
 *
 * Mounted in `App.tsx` BETWEEN the title bar and the body, so it survives the
 * Welcome→editor swap and every modal dismissal. That placement is the whole
 * point: before this, progress lived inside `ImportPanel`, `ExportPanel` and
 * `ModelDownloadDialog`, each of which can unmount while its job keeps running —
 * taking the progress bar, the Cancel button and the only error surface with it.
 *
 * Presentation only. The state lives in `jobsStore`, every decision (labels,
 * ETA, which task to show) in the pure `jobStatus` view-model.
 */

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader2,
  RotateCcw,
  X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { useJobsStore } from '@renderer/stores/jobsStore'
import { openExportFolder } from '@renderer/components/export-run'
import {
  describeTask,
  stageChecklist,
  visibleTasks,
  childTasks,
  selectPrimaryTask,
  type JobTask
} from '@renderer/components/jobStatus'

/**
 * Elapsed and ETA are derived from wall-clock, so the bar needs its own tick —
 * job events alone can be seconds apart (whisper) or absent entirely (a wedged
 * provider), and a clock that stops during exactly those gaps is the frozen-UI
 * impression this component exists to dispel.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function JobStatusBar(): React.JSX.Element | null {
  const tasks = useJobsStore((s) => s.tasks)
  const dismissTask = useJobsStore((s) => s.dismissTask)
  const [expanded, setExpanded] = useState(false)

  const top = visibleTasks(tasks)
  const primary = selectPrimaryTask(tasks)
  const now = useNow(top.some((t) => t.status === 'running' || t.status === 'queued'))

  if (!primary) return null

  return (
    <div
      data-testid="job-status-bar"
      // `relative z-[60] pointer-events-auto` is what makes this bar USABLE while
      // a dialog is open (BUG-45xt77). Radix modals put `pointer-events: none` on
      // the body and paint an overlay at z-50, so the bar rendered underneath was
      // visible but inert: you could watch a download and not reach its Cancel,
      // and closing the dialog to reach it used to kill the download.
      className="app-no-drag pointer-events-auto relative z-[60] shrink-0 border-b border-border/60 bg-muted/30 px-3 py-1.5"
    >
      <JobRow task={primary} now={now} onDismiss={dismissTask} />

      {top.length > 1 && (
        <button
          type="button"
          data-testid="job-status-more"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {expanded ? 'Hide' : `${top.length - 1} more`}
        </button>
      )}

      {expanded &&
        top
          .filter((t) => t.id !== primary.id)
          .map((task) => (
            <div key={task.id} className="mt-1.5 border-t border-border/40 pt-1.5">
              <JobRow task={task} now={now} onDismiss={dismissTask} />
            </div>
          ))}

      {/* A batch's per-clip rows nest under it, so a single failure among ten is
          nameable instead of being folded into an "N failed" counter. */}
      {childTasks(tasks, primary.id).map((child) => (
        <ChildRow key={child.id} task={child} now={now} />
      ))}
    </div>
  )
}

interface JobRowProps {
  task: JobTask
  now: number
  onDismiss: (id: string) => void
}

function JobRow({ task, now, onDismiss }: JobRowProps): React.JSX.Element {
  const view = describeTask(task, now)
  const checklist = stageChecklist(task)
  const terminal = task.status !== 'running' && task.status !== 'queued'

  return (
    <div className="flex flex-col gap-1" data-testid="job-status-row" data-kind={task.kind}>
      <div className="flex items-center gap-2">
        {task.status === 'error' ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        ) : task.status === 'done' ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : task.status === 'canceled' ? (
          <X className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        )}

        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          data-testid="job-status-stage"
        >
          {view.title}
        </span>

        {!terminal && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {task.pct > 0 ? `${task.pct}%` : ''} {view.eta || view.elapsed}
          </span>
        )}

        {!terminal && task.cancel && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            data-testid="job-status-cancel"
            onClick={() => void task.cancel?.()}
          >
            Cancel
          </Button>
        )}

        {terminal && task.retry && task.status !== 'done' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            data-testid="job-status-retry"
            onClick={() => void task.retry?.()}
          >
            <RotateCcw className="size-3" /> Retry
          </Button>
        )}

        {terminal && task.outputPath && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            data-testid="job-status-reveal"
            onClick={() => void openExportFolder(window.openclip, task.outputPath!)}
          >
            <FolderOpen className="size-3" /> Reveal
          </Button>
        )}

        {terminal && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Dismiss"
            data-testid="job-status-dismiss"
            onClick={() => onDismiss(task.id)}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      {!terminal && (
        <Progress
          value={task.pct}
          className={'h-1 ' + (view.determinate ? '' : 'animate-pulse')}
          data-testid="job-status-progress"
        />
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {checklist.length > 0 && !terminal && (
          <span className="flex items-center gap-1.5" data-testid="job-status-checklist">
            {checklist.map((step, i) => (
              <span
                key={step.stage}
                data-state={step.state}
                className={
                  step.state === 'done'
                    ? 'text-emerald-500'
                    : step.state === 'active'
                      ? 'font-medium text-foreground'
                      : 'opacity-50'
                }
              >
                {step.state === 'done' ? '✓ ' : ''}
                {step.label}
                {i < checklist.length - 1 ? ' ›' : ''}
              </span>
            ))}
          </span>
        )}
        {/* tabular-nums: the byte counter and rate climb continuously, and
            proportional digits made the whole line jitter as they changed. */}
        {view.detail && (
          <span data-testid="job-status-detail" className="tabular-nums">
            {view.detail}
          </span>
        )}
        {task.status === 'error' && task.error && (
          <span className="min-w-0 flex-1 truncate text-destructive" role="alert">
            {task.error}
          </span>
        )}
      </div>
    </div>
  )
}

/** A per-item row inside a batch — compact, no checklist, no own chrome. */
function ChildRow({ task, now }: { task: JobTask; now: number }): React.JSX.Element {
  const view = describeTask(task, now)
  return (
    <div
      className="mt-1 flex items-center gap-2 pl-5 text-[11px] text-muted-foreground"
      data-testid="job-status-child"
    >
      {task.status === 'error' ? (
        <AlertCircle className="size-3 shrink-0 text-destructive" />
      ) : task.status === 'done' ? (
        <Check className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      )}
      <span className="min-w-0 flex-1 truncate">{task.label}</span>
      {task.status === 'error' && task.error ? (
        <span className="max-w-[50%] truncate text-destructive">{task.error}</span>
      ) : (
        <span className="tabular-nums">{task.pct > 0 ? `${task.pct}%` : view.stage}</span>
      )}
    </div>
  )
}

export default JobStatusBar
