/**
 * tests/unit/job-status.spec.ts — the pure job-status view-model (EPIC-zpa1nd /
 * FEAT-vh2bwz).
 *
 * The app streams `{pct, stage}` for every long operation and the UI used to
 * print the stage token verbatim ("transcribing · 62%"). These are the rules
 * that turn that stream into something a person can read and act on — and, just
 * as importantly, the rules about when to say NOTHING rather than guess.
 */

import { describe, expect, it } from 'vitest'
import {
  STAGE_LABELS,
  stageLabel,
  stageChecklist,
  estimateEta,
  formatEta,
  describeDetail,
  describeTask,
  isCancellation,
  activeTasks,
  childTasks,
  selectPrimaryTask,
  type JobTask
} from '@renderer/components/jobStatus'

const T0 = 1_700_000_000_000

function task(patch: Partial<JobTask> = {}): JobTask {
  return {
    id: 'task-1',
    kind: 'import',
    label: 'talk.mp4',
    stage: 'transcribing',
    pct: 50,
    status: 'running',
    startedAt: T0,
    stageStartedAt: T0,
    ...patch
  }
}

describe('stageLabel', () => {
  it('humanises every stage token the runners actually emit', () => {
    // The tokens grepped out of src/main: if a runner gains a stage and this
    // map is not updated, the bar shows a raw identifier to the user.
    const emitted = [
      'queued',
      'downloading',
      'probing',
      'extracting',
      'transcribing',
      'analyzing',
      'encoding'
    ]
    for (const stage of emitted) {
      expect(STAGE_LABELS[stage], `no label for "${stage}"`).toBeTruthy()
      expect(stageLabel(stage)).not.toBe(stage)
    }
  })

  it('title-cases an unknown token rather than leaking it or blanking', () => {
    // A future runner stage should read slightly awkwardly, never as code.
    expect(stageLabel('post-processing')).toBe('Post processing')
    expect(stageLabel('')).toBe('')
  })
})

describe('stageChecklist', () => {
  const stages = ['probing', 'extracting', 'transcribing']

  it('marks passed stages done, the current one active, the rest pending', () => {
    const steps = stageChecklist(task({ stages, stage: 'extracting' }))
    expect(steps.map((s) => s.state)).toEqual(['done', 'active', 'pending'])
  })

  it('counts a stage that was never observed as done once we are past it', () => {
    // A fast probe can finish between renders; position in the sequence is the
    // authority, not whether the UI happened to see the event.
    const steps = stageChecklist(task({ stages, stage: 'transcribing' }))
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'active'])
  })

  it('marks every stage done once the task succeeds', () => {
    const steps = stageChecklist(task({ stages, stage: 'transcribing', status: 'done' }))
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('returns nothing when the caller declared no stages', () => {
    expect(stageChecklist(task({ stages: undefined }))).toEqual([])
  })
})

describe('estimateEta', () => {
  it('extrapolates remaining time from elapsed vs percent', () => {
    // 30s in at 25% ⇒ 120s total ⇒ 90s left.
    const eta = estimateEta(task({ pct: 25 }), T0 + 30_000)
    expect(eta).toBe(90_000)
  })

  it('says nothing below 5% — a 2-second sample cannot predict a 10-minute job', () => {
    expect(estimateEta(task({ pct: 2 }), T0 + 30_000)).toBeNull()
  })

  it('says nothing above 97%, where the countdown is noise', () => {
    expect(estimateEta(task({ pct: 99 }), T0 + 30_000)).toBeNull()
  })

  it('says nothing in the first three seconds', () => {
    expect(estimateEta(task({ pct: 50 }), T0 + 1_000)).toBeNull()
  })

  it('says nothing for a task that is not running', () => {
    expect(estimateEta(task({ status: 'error' }), T0 + 30_000)).toBeNull()
  })
})

describe('formatEta', () => {
  it('is coarse on purpose', () => {
    expect(formatEta(8_000)).toBe('~8s left')
    expect(formatEta(185_000)).toBe('~3m left')
    expect(formatEta(3_900_000)).toBe('~1h 5m left')
  })

  it('never rounds down to zero seconds', () => {
    expect(formatEta(200)).toBe('~1s left')
  })
})

describe('describeDetail', () => {
  it('reports bytes and throughput for a download', () => {
    // 10 MB in 5s ⇒ 2 MB/s. These byte counts already existed on the wire and
    // were discarded before the UI ever saw them (FEAT-8559h1).
    const t = task({
      kind: 'model-download',
      stage: 'downloading',
      detail: { receivedBytes: 10_000_000, totalBytes: 140_000_000 }
    })
    expect(describeDetail(t, T0 + 5_000)).toBe('10 MB of 140 MB · 2 MB/s')
  })

  it('omits throughput in the first second, where the figure is meaningless', () => {
    const t = task({ detail: { receivedBytes: 10_000_000, totalBytes: 140_000_000 } })
    expect(describeDetail(t, T0 + 100)).toBe('10 MB of 140 MB')
  })

  it('reports a human 1-based chunk position for map-reduce generation', () => {
    const t = task({ kind: 'generate-clips', detail: { chunkIndex: 1, chunkCount: 6 } })
    expect(describeDetail(t, T0)).toBe('chunk 2 of 6')
  })

  it('reports sampled frames so the analyze phase is visibly moving', () => {
    const t = task({ kind: 'export', detail: { framesSampled: 120, frameBudget: 480 } })
    expect(describeDetail(t, T0)).toBe('120 of 480 frames sampled')
  })

  it('is empty when the stage has nothing extra to say', () => {
    expect(describeDetail(task(), T0)).toBe('')
  })
})

describe('describeTask', () => {
  it('leads with the stage while running, so the verb is the real work', () => {
    expect(describeTask(task(), T0 + 10_000).title).toBe('Transcribing talk.mp4')
  })

  it('names a failure as a failure and a cancellation as a cancellation', () => {
    expect(describeTask(task({ status: 'error' }), T0).title).toBe('Importing talk.mp4 failed')
    expect(describeTask(task({ status: 'canceled' }), T0).title).toBe('Importing talk.mp4 canceled')
  })

  it('reports a 0% task as indeterminate rather than drawing an empty bar', () => {
    // A bar pinned at 0% is exactly the "frozen" impression this epic kills.
    expect(describeTask(task({ pct: 0 }), T0).determinate).toBe(false)
    expect(describeTask(task({ pct: 1 }), T0).determinate).toBe(true)
  })
})

describe('isCancellation', () => {
  it('recognises the terminal CANCELLED that drainJob throws', () => {
    // A cancel is not a failure; presenting it as one is a lie the user
    // just disproved by clicking Cancel.
    expect(isCancellation(new Error('transcribe failed [CANCELLED]: job cancelled'))).toBe(true)
  })

  it('does not mistake a real failure for one', () => {
    expect(isCancellation(new Error('export failed [SIDECAR_CRASH]: ffmpeg died'))).toBe(false)
    expect(isCancellation('some string')).toBe(false)
  })
})

describe('selection', () => {
  const running = task({ id: 'a', startedAt: T0 })
  const newer = task({ id: 'b', startedAt: T0 + 1000 })
  const finished = task({ id: 'c', startedAt: T0 + 2000, status: 'error' })
  const child = task({ id: 'd', startedAt: T0 + 500, parentId: 'a' })
  const all = { a: running, b: newer, c: finished, d: child }

  it('lists only unfinished top-level work, most recent first', () => {
    expect(activeTasks(all).map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('keeps children out of the top-level list and under their parent', () => {
    expect(childTasks(all, 'a').map((t) => t.id)).toEqual(['d'])
  })

  it('shows running work first', () => {
    expect(selectPrimaryTask(all)?.id).toBe('b')
  })

  it('falls back to a settled task so a failure does not vanish with the job', () => {
    // The bug this whole epic exists for: an error that unmounts before it can
    // be read is the same as no error at all.
    expect(selectPrimaryTask({ c: finished })?.id).toBe('c')
  })

  it('shows nothing when there is nothing to show', () => {
    expect(selectPrimaryTask({})).toBeNull()
  })
})
