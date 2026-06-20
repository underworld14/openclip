/**
 * tests/unit/usejob.spec.ts — Gate A: "a scripted job over a real MessagePort
 * (via the fake harness) drives useJob to a 'done' event."
 *
 * `useJob`'s entire streaming path is the `jobEvents()` async iterable +the
 * event switch it runs. We exercise that path over a REAL Node MessageChannel
 * in two ways:
 *
 *   1. `jobEvents()` directly over a channel driven by the fake harness — proves
 *      MessagePort → AsyncIterable<JobEvent> ends at the first terminal event.
 *   2. The full `createMockOpenclip().jobs.start()` → returned port → consume
 *      with the SAME switch `useJob` uses — proves the bridge's MessageChannel
 *      handoff drives a consumer to a `done` result (the renderer runtime path,
 *      minus React's setState).
 */

import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { jobEvents, type MessagePortLike, type JobStatus } from '@renderer/hooks/useJob'
import { acquireJobPort, registerJobPort } from '@renderer/hooks/jobPort'
import { driveScriptOverChannel } from '../harness/fake-utility-process'
import { createMockOpenclip } from '../mocks/openclip'
import { transcribeResultFixture, transcribePartialFixture } from '../fixtures/contract'
import type { JobEventFor } from '@shared/jobs'

describe('jobEvents: MessagePort → AsyncIterable<JobEvent>', () => {
  it('yields progress/partial then terminates at the first done', async () => {
    const { port1, port2 } = new MessageChannel()
    port1.start()

    void driveScriptOverChannel(port2, {
      steps: [
        { t: 'progress', pct: 10, stage: 'extracting' },
        { t: 'progress', pct: 70, stage: 'transcribing' },
        { t: 'partial', data: transcribePartialFixture },
        { t: 'done', result: transcribeResultFixture }
      ]
    })

    const seen: string[] = []
    let terminalResult: unknown = null
    for await (const ev of jobEvents<'transcribe'>(port1 as unknown as MessagePortLike)) {
      seen.push(ev.t)
      if (ev.t === 'done') terminalResult = ev.result
    }

    expect(seen).toEqual(['progress', 'progress', 'partial', 'done'])
    expect(terminalResult).toEqual(transcribeResultFixture)
  })

  it('terminates at an error event (job-termination invariant)', async () => {
    const { port1, port2 } = new MessageChannel()
    port1.start()
    void driveScriptOverChannel(port2, {
      steps: [
        { t: 'progress', pct: 5, stage: 'queued' },
        { t: 'error', code: 'CANCELLED', message: 'cancelled', retriable: false }
      ]
    })

    const seen: string[] = []
    for await (const ev of jobEvents<'transcribe'>(port1 as unknown as MessagePortLike)) {
      seen.push(ev.t)
    }
    expect(seen).toEqual(['progress', 'error'])
  })
})

describe('useJob streaming path drives a consumer to a "done" result', () => {
  it('mock bridge job → acquireJobPort(jobId) → port → done (the renderer runtime path)', async () => {
    const openclip = createMockOpenclip()
    // The real renderer path: start() resolves { jobId } only, then the live
    // per-job port is acquired out-of-band keyed by that jobId.
    const { jobId } = await openclip.jobs.start('transcribe', {
      projectId: 'p1',
      wavPath: '/tmp/audio.16k.wav',
      model: 'base'
    })
    expect(jobId).toBe('transcribe-mock-1')
    const port = await acquireJobPort(jobId)

    // Reproduce useJob's exact event switch over the real port.
    let status: JobStatus = 'idle'
    let progress = 0
    let result: typeof transcribeResultFixture | null = null
    let partials = 0

    for await (const ev of jobEvents<'transcribe'>(port as unknown as MessagePortLike)) {
      const e = ev as JobEventFor<'transcribe'>
      switch (e.t) {
        case 'progress':
          status = e.stage === 'queued' ? 'queued' : 'running'
          progress = e.pct
          break
        case 'partial':
          partials += 1
          break
        case 'done':
          status = 'done'
          progress = 100
          result = e.result
          break
        case 'error':
          status = 'error'
          break
      }
    }

    expect(status).toBe('done')
    expect(progress).toBe(100)
    expect(partials).toBe(1)
    expect(result).toEqual(transcribeResultFixture)
  })
})

describe('acquireJobPort: bounded wait (audit fix openclip-ki6/me0/jp1)', () => {
  it('rejects after the timeout when the per-job port never arrives (no silent hang)', async () => {
    // No registerJobPort for this id ⇒ the port never arrives. Without the timeout
    // this Promise would hang forever; with it the consumer gets a typed rejection.
    await expect(acquireJobPort('port-never-arrives', 20)).rejects.toThrow(
      /never arrived|timed out/i
    )
  })

  it('still resolves immediately when the port arrives before the timeout fires', async () => {
    const noop = (): void => undefined
    const fakePort = {
      postMessage: noop,
      close: noop,
      start: noop,
      addEventListener: noop
    }
    const p = acquireJobPort('port-arrives', 1000)
    registerJobPort('port-arrives', fakePort as unknown as MessagePortLike)
    await expect(p).resolves.toBe(fakePort)
  })
})
