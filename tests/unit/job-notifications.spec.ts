/**
 * tests/unit/job-notifications.spec.ts — completion delivery (EPIC-zpa1nd /
 * FEAT-ckxz8d).
 *
 * The status bar answers "what is happening now"; a ten-minute transcription is
 * exactly the work a user walks away from. These are the rules about WHEN the
 * app is allowed to interrupt them, which matter more than the notification
 * itself — an app that announces everything trains people to ignore it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announcementFor,
  startJobNotifications,
  type JobNotificationSinks
} from '@renderer/stores/jobNotifications'
import { useJobsStore, __resetJobsStoreForTests } from '@renderer/stores/jobsStore'
import type { JobTask } from '@renderer/components/jobStatus'

beforeEach(() => __resetJobsStoreForTests())

function sinks(): JobNotificationSinks & {
  notify: ReturnType<typeof vi.fn>
  toastError: ReturnType<typeof vi.fn>
} {
  return { notify: vi.fn(), toastError: vi.fn() }
}

const store = (): ReturnType<typeof useJobsStore.getState> => useJobsStore.getState()

describe('announcementFor', () => {
  const base: JobTask = {
    id: 't1',
    kind: 'import',
    label: 'talk.mp4',
    stage: 'transcribing',
    pct: 100,
    status: 'done',
    startedAt: 0,
    stageStartedAt: 0
  }

  it('announces a success', () => {
    expect(announcementFor(base)?.title).toContain('talk.mp4')
  })

  it('announces a failure with its reason', () => {
    const a = announcementFor({ ...base, status: 'error', error: 'whisper died' })
    expect(a?.body).toBe('whisper died')
  })

  it('says nothing about a cancellation', () => {
    // The user cancelled it seconds ago. Announcing it tells them what they
    // just did.
    expect(announcementFor({ ...base, status: 'canceled' })).toBeNull()
  })
})

describe('startJobNotifications', () => {
  it('announces a task once, not on every subsequent store tick', async () => {
    const s = sinks()
    const stop = startJobNotifications(s)

    const id = store().beginTask({ kind: 'import', label: 'talk.mp4' })
    store().settleTask(id, 'error', { error: 'whisper died' })
    // A settled task stays in the map until dismissed, so the store keeps
    // emitting it; without an id guard every later update re-fires.
    store().beginTask({ kind: 'export', label: 'clip' })
    store().beginTask({ kind: 'export', label: 'clip 2' })

    expect(s.notify).toHaveBeenCalledTimes(1)
    stop()
  })

  it('toasts a failure but not a success', async () => {
    const s = sinks()
    const stop = startJobNotifications(s)

    const ok = store().beginTask({ kind: 'export', label: 'good clip' })
    store().settleTask(ok, 'done')
    const bad = store().beginTask({ kind: 'export', label: 'bad clip' })
    store().settleTask(bad, 'error', { error: 'no space left on device' })

    // Both reach the OS…
    expect(s.notify).toHaveBeenCalledTimes(2)
    // …but only the failure gets an in-app toast. The bar already showed the
    // success; stacking a toast on every finished job is notification fatigue.
    expect(s.toastError).toHaveBeenCalledTimes(1)
    expect(s.toastError.mock.calls[0][1]).toContain('no space left')
    stop()
  })

  it('stays quiet while work is running', () => {
    const s = sinks()
    const stop = startJobNotifications(s)

    const id = store().beginTask({ kind: 'import', label: 'talk.mp4' })
    store().updateTask(id, { pct: 50, stage: 'transcribing' })
    store().updateTask(id, { pct: 90 })

    expect(s.notify).not.toHaveBeenCalled()
    stop()
  })

  it('announces a batch once, not once per clip', () => {
    const s = sinks()
    const stop = startJobNotifications(s)

    const parent = store().beginTask({ kind: 'batch-export', label: '3 clips' })
    const a = store().beginTask({ kind: 'export', label: 'one', parentId: parent })
    const b = store().beginTask({ kind: 'export', label: 'two', parentId: parent })
    store().settleTask(a, 'done')
    store().settleTask(b, 'done')
    store().settleTask(parent, 'done')

    expect(s.notify).toHaveBeenCalledTimes(1)
    expect(s.notify.mock.calls[0][0].title).toContain('3 clips')
    stop()
  })

  it('stops announcing after teardown', () => {
    const s = sinks()
    const stop = startJobNotifications(s)
    stop()

    const id = store().beginTask({ kind: 'export', label: 'clip' })
    store().settleTask(id, 'done')

    expect(s.notify).not.toHaveBeenCalled()
  })
})
