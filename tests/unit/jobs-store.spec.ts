/**
 * tests/unit/jobs-store.spec.ts — the live job registry (EPIC-zpa1nd /
 * FEAT-vh2bwz).
 *
 * The registry it replaces (`uiStore.tasks`) was written and never read, so
 * nothing ever exercised its lifecycle. These are the rules the status bar
 * depends on: a task settles exactly once, a cancel is not a failure, a
 * dismissed task cannot be resurrected by a late event, and work that never
 * started leaves no trace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DONE_DISMISS_MS,
  hasActiveKind,
  trackTask,
  useJobsStore,
  __resetJobsStoreForTests
} from '@renderer/stores/jobsStore'

beforeEach(() => {
  __resetJobsStoreForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

const store = (): ReturnType<typeof useJobsStore.getState> => useJobsStore.getState()

describe('beginTask', () => {
  it('registers a running task seeded at the first declared stage', () => {
    const id = store().beginTask({
      kind: 'import',
      label: 'talk.mp4',
      stages: ['probing', 'transcribing']
    })
    const task = store().tasks[id]
    expect(task.status).toBe('running')
    expect(task.pct).toBe(0)
    expect(task.stage).toBe('probing')
  })

  it('honours a caller-supplied id, so the import controller keeps its own key', () => {
    store().beginTask({ id: 'import-7', kind: 'import', label: 'a.mp4' })
    expect(store().tasks['import-7']).toBeDefined()
  })
})

describe('updateTask', () => {
  it('merges detail instead of replacing it', () => {
    // A download reports bytes and an export reports frames; neither resends
    // the other's fields on every tick.
    const id = store().beginTask({ kind: 'model-download', label: 'base' })
    store().updateTask(id, { detail: { totalBytes: 140_000_000 } })
    store().updateTask(id, { detail: { receivedBytes: 10_000_000 } })
    expect(store().tasks[id].detail).toEqual({
      totalBytes: 140_000_000,
      receivedBytes: 10_000_000
    })
  })

  it('restarts the per-stage clock only on a real stage change', () => {
    vi.useFakeTimers()
    const id = store().beginTask({ kind: 'import', label: 'a.mp4', stages: ['probing'] })
    const started = store().tasks[id].stageStartedAt

    vi.advanceTimersByTime(5000)
    store().updateTask(id, { pct: 20, stage: 'probing' })
    expect(store().tasks[id].stageStartedAt).toBe(started)

    store().updateTask(id, { pct: 30, stage: 'extracting' })
    expect(store().tasks[id].stageStartedAt).toBeGreaterThan(started)
  })

  it('ignores an update for a task the user already dismissed', () => {
    // A late progress event must not resurrect a dismissed row as a zombie.
    const id = store().beginTask({ kind: 'export', label: 'clip' })
    store().dismissTask(id)
    store().updateTask(id, { pct: 90 })
    expect(store().tasks[id]).toBeUndefined()
  })
})

describe('settleTask', () => {
  it('snaps a success to a full bar and drops the cancel handle', () => {
    // The last progress event routinely lands at 98%, and a finished row at
    // 98% reads as stalled.
    const id = store().beginTask({ kind: 'export', label: 'clip', cancel: async () => {} })
    store().updateTask(id, { pct: 98 })
    store().settleTask(id, 'done')
    expect(store().tasks[id].pct).toBe(100)
    expect(store().tasks[id].cancel).toBeUndefined()
  })

  it('keeps a failure on screen until it is dismissed', () => {
    vi.useFakeTimers()
    const id = store().beginTask({ kind: 'import', label: 'a.mp4' })
    store().settleTask(id, 'error', { error: 'whisper died' })

    vi.advanceTimersByTime(DONE_DISMISS_MS * 10)
    // An error that clears itself is the silent-failure bug with a timer on it.
    expect(store().tasks[id].status).toBe('error')
    expect(store().tasks[id].error).toBe('whisper died')
  })

  it('clears a success on its own after the dismiss window', () => {
    vi.useFakeTimers()
    const id = store().beginTask({ kind: 'export', label: 'clip' })
    store().settleTask(id, 'done')
    expect(store().tasks[id]).toBeDefined()

    vi.advanceTimersByTime(DONE_DISMISS_MS + 1)
    expect(store().tasks[id]).toBeUndefined()
  })

  it('does not preserve a percentage on a cancel', () => {
    const id = store().beginTask({ kind: 'import', label: 'a.mp4' })
    store().updateTask(id, { pct: 40 })
    store().settleTask(id, 'canceled')
    expect(store().tasks[id].pct).toBe(40)
    expect(store().tasks[id].status).toBe('canceled')
  })
})

describe('dismissTask', () => {
  it('takes a batch task’s children with it', () => {
    const parent = store().beginTask({ kind: 'batch-export', label: '3 clips' })
    store().beginTask({ kind: 'export', label: 'one', parentId: parent })
    store().beginTask({ kind: 'export', label: 'two', parentId: parent })
    expect(Object.keys(store().tasks)).toHaveLength(3)

    store().dismissTask(parent)
    expect(store().tasks).toEqual({})
  })
})

describe('hasActiveKind', () => {
  it('reports a running import — the autosave suspension depends on it', () => {
    // With the project committed before transcription, every streamed partial
    // would otherwise schedule a full .ocproj write (FEAT-ky1jfw).
    const id = store().beginTask({ kind: 'import', label: 'a.mp4' })
    expect(hasActiveKind('import')).toBe(true)
    expect(hasActiveKind('export')).toBe(false)

    store().settleTask(id, 'error', { error: 'nope' })
    expect(hasActiveKind('import')).toBe(false)
  })
})

describe('trackTask', () => {
  it('settles done and returns the orchestrator’s value', async () => {
    const result = await trackTask({ kind: 'export', label: 'clip' }, async (t) => {
      t.progress(50, 'encoding')
      return 'output.mp4'
    })
    expect(result).toBe('output.mp4')
    const task = Object.values(store().tasks)[0]
    expect(task.status).toBe('done')
  })

  it('records a thrown failure and rethrows it for the caller’s own handling', async () => {
    // The bar is an ADDITIONAL surface, never a replacement for the panel's
    // inline error — so the error must still reach the caller.
    await expect(
      trackTask({ kind: 'export', label: 'clip' }, async () => {
        throw new Error('export failed [SIDECAR_CRASH]: ffmpeg died')
      })
    ).rejects.toThrow('ffmpeg died')

    const task = Object.values(store().tasks)[0]
    expect(task.status).toBe('error')
    expect(task.error).toContain('ffmpeg died')
  })

  it('files a cancellation as canceled, not as an error', async () => {
    await expect(
      trackTask({ kind: 'import', label: 'a.mp4' }, async () => {
        throw new Error('transcribe failed [CANCELLED]: job cancelled')
      })
    ).rejects.toThrow()

    const task = Object.values(store().tasks)[0]
    expect(task.status).toBe('canceled')
    expect(task.error).toBeUndefined()
  })

  it('leaves no row at all for work that never started', async () => {
    // An export whose save dialog was dismissed neither succeeded nor failed;
    // "clip.mp4 finished" for a file that was never written is the worse lie.
    await trackTask({ kind: 'export', label: 'clip' }, async (t) => {
      t.abandon()
      return { canceled: true }
    })
    expect(store().tasks).toEqual({})
  })

  it('attaches the cancel handle once the job reports its id', async () => {
    const cancel = vi.fn(async () => {})
    let captured: (() => Promise<void>) | undefined
    await trackTask({ kind: 'export', label: 'clip' }, async (t) => {
      t.setCancel(cancel)
      captured = Object.values(store().tasks)[0].cancel
      return null
    })
    expect(captured).toBe(cancel)
  })
})
