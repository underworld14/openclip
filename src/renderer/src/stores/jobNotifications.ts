/**
 * src/renderer/src/stores/jobNotifications.ts — completion delivery for long
 * jobs (EPIC-zpa1nd / FEAT-ckxz8d).
 *
 * The status bar answers "what is happening right now", but a ten-minute
 * transcription or a batch export is precisely the work a user walks away from.
 * OpusClip's answer to that is "we'll email you"; the desktop-native equivalent
 * is a system notification plus a dock badge, which is strictly better delivery
 * of the same promise.
 *
 * A FAILURE additionally raises a toast, because the status bar row can be
 * dismissed or scrolled past and a silent failure is the whole reason this epic
 * exists. A success does not toast — the bar already showed it, and stacking a
 * toast on top of every finished job is how notification fatigue starts.
 *
 * Framework-free core + `installJobNotifications()`, mirroring
 * `installAutosave`: subscribing rather than calling from inside the store keeps
 * `jobsStore` free of bridge and toast dependencies, and keeps it testable in
 * the node env with no window.
 */

import { toast } from 'sonner'
import { describeTask, type JobTask } from '@renderer/components/jobStatus'
import { useJobsStore } from './jobsStore'

/** The side effects this subscriber performs, injected so it is testable. */
export interface JobNotificationSinks {
  /** Ask the main process to raise an OS notification (it decides on focus). */
  notify: (n: { title: string; body: string }) => void
  /** Surface a failure prominently in-app. */
  toastError: (title: string, description: string, retry?: () => void) => void
}

/** How a settled task is announced. Exported for the spec. */
export function announcementFor(task: JobTask): { title: string; body: string } | null {
  // A cancellation is the user's own action, seconds ago. Telling them about it
  // is telling them what they just did.
  if (task.status === 'canceled') return null
  const view = describeTask(task, task.startedAt)
  if (task.status === 'error') {
    return { title: view.title, body: task.error ?? 'The job failed.' }
  }
  return { title: view.title, body: 'Ready in OpenClip.' }
}

/**
 * Subscribe terminal task transitions to `sinks`. Returns a teardown.
 *
 * Only announces a task ONCE: the store emits on every update, and a settled
 * task stays in the map until it is dismissed, so an id-keyed guard is what
 * keeps a single failure from firing a notification on every subsequent tick.
 */
export function startJobNotifications(sinks: JobNotificationSinks): () => void {
  const announced = new Set<string>()

  return useJobsStore.subscribe((state) => {
    for (const task of Object.values(state.tasks)) {
      // Child rows roll up into their parent; one batch should announce once,
      // not once per clip.
      if (task.parentId) continue
      if (task.status === 'running' || task.status === 'queued') continue
      if (announced.has(task.id)) continue
      announced.add(task.id)

      const announcement = announcementFor(task)
      if (!announcement) continue

      sinks.notify(announcement)
      if (task.status === 'error') {
        sinks.toastError(announcement.title, announcement.body, task.retry)
      }
    }
  })
}

/** Wire the real bridge + sonner. Called once at app start (see App.tsx). */
export function installJobNotifications(): () => void {
  return startJobNotifications({
    notify: (n) => {
      // Best-effort: a notification that cannot be delivered must never break
      // the job it is reporting on.
      void window.openclip.system.notify(n).catch(() => {})
    },
    toastError: (title, description, retry) =>
      toast.error(title, {
        description,
        action: retry ? { label: 'Retry', onClick: () => void retry() } : undefined
      })
  })
}
