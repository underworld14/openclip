/**
 * tests/unit/sidecar-manager.spec.ts — exercises the trunk sidecar HOST seam:
 * `registerRunner` + the JOB_RUNNERS registry, port handoff over a real Node
 * MessageChannel, the job-termination invariant (always done|error), queue/
 * concurrency math, and PID kill-on-cancel — all with the fake scripted runner
 * (no real binaries). Mirrors plan E.2/E.7.
 *
 * NOTE: registry registration is process-global, so we register once and reuse.
 */

import { describe, expect, it, vi } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import {
  SidecarManager,
  registerRunner,
  hasRunner,
  getRunner,
  concurrencyFor,
  exportConcurrency,
  type EventPort
} from '@main/services/sidecar-manager'
import { scriptedRunner } from '../harness/fake-utility-process'
import { transcribeResultFixture, transcribePartialFixture } from '../fixtures/contract'

// Register fake runners for every kind exactly once (registry is module-global).
registerRunner(
  'transcribe',
  scriptedRunner({
    steps: [
      { t: 'progress', pct: 50, stage: 'transcribing' },
      { t: 'partial', data: transcribePartialFixture },
      { t: 'done', result: transcribeResultFixture }
    ]
  })
)
registerRunner(
  'export',
  scriptedRunner({
    steps: [
      { t: 'progress', pct: 100, stage: 'encoding' },
      { t: 'done', result: { outputPath: '/out.mp4', width: 1080, height: 1920, durationMs: 1000 } }
    ]
  })
)

/** Collect every event posted to a port until it closes (or a terminal event). */
function collectPort(port: {
  on: (e: 'message' | 'close', l: (v?: unknown) => void) => void
  start: () => void
}): {
  events: Array<{ t: string; [k: string]: unknown }>
  done: Promise<void>
} {
  const events: Array<{ t: string; [k: string]: unknown }> = []
  let resolve!: () => void
  const done = new Promise<void>((r) => (resolve = r))
  port.on('message', (value) => {
    const v = value as { t: string }
    if (v.t === 'job-id') return
    events.push(v as { t: string })
    if (v.t === 'done' || v.t === 'error') resolve()
  })
  port.start()
  return { events, done }
}

describe('SidecarManager registry + seam', () => {
  it('has runners registered for transcribe + export', () => {
    expect(hasRunner('transcribe')).toBe(true)
    expect(hasRunner('export')).toBe(true)
  })

  it('re-registering a kind throws (catches duplicate ownership)', () => {
    expect(() => registerRunner('transcribe', scriptedRunner({ steps: [] }))).toThrow(
      /already registered/
    )
  })
})

describe('SidecarManager concurrency math (PRD §17)', () => {
  it('transcribe is strictly serial', () => {
    expect(concurrencyFor('transcribe', 10)).toBe(1)
  })
  it('exports = min(2, ceil(cores/4))', () => {
    expect(exportConcurrency(10)).toBe(2) // ceil(10/4)=3 → min(2,3)=2
    expect(exportConcurrency(4)).toBe(1) // ceil(4/4)=1
    expect(exportConcurrency(8)).toBe(2)
    expect(concurrencyFor('export', 4)).toBe(1)
  })
})

describe('SidecarManager.startJob drives a scripted runner to done over a real port', () => {
  it('streams progress + partial then a terminal done', async () => {
    const mgr = new SidecarManager({ coreCount: 10 })
    const { port1, port2 } = new MessageChannel()

    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }

    const collected = collectPort(port1 as never)
    const jobId = mgr.startJob(
      'transcribe',
      {
        projectId: 'p1',
        wavPath: '/tmp/a.wav',
        model: 'base'
      },
      eventPort
    )
    expect(jobId).toMatch(/^transcribe-/)

    await collected.done
    const kinds = collected.events.map((e) => e.t)
    expect(kinds).toEqual(['progress', 'partial', 'done'])
    const doneEv = collected.events.at(-1) as { t: 'done'; result: unknown }
    expect(doneEv.result).toEqual(transcribeResultFixture)
  })

  it('emits a typed INPUT_INVALID error when no runner is registered (never hangs)', async () => {
    const mgr = new SidecarManager({ coreCount: 10 })
    const { port1, port2 } = new MessageChannel()
    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }
    const collected = collectPort(port1 as never)
    // 'model-download' has no runner registered in this spec.
    mgr.startJob('model-download', { model: 'base' }, eventPort)
    await collected.done
    const last = collected.events.at(-1) as { t: string; code?: string }
    expect(last.t).toBe('error')
    expect(last.code).toBe('INPUT_INVALID')
  })

  it('cancel() escalates SIGTERM to tracked PIDs', async () => {
    const killPid = vi.fn()
    const mgr = new SidecarManager({ coreCount: 10, killPid, killGraceMs: 5 })

    // A long-running runner that registers a PID then waits for abort.
    registerRunner('model-download', async (_p, emit, ctx) => {
      ctx.trackPid(424242)
      emit.progress(1, 'downloading')
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return { model: 'base', path: '/x', bytes: 1 }
    })

    const { port1, port2 } = new MessageChannel()
    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }
    const collected = collectPort(port1 as never)
    const jobId = mgr.startJob('model-download', { model: 'base' }, eventPort)

    // Let the runner register its PID + emit first progress.
    await new Promise((r) => setTimeout(r, 10))
    mgr.cancel(jobId)
    await collected.done

    expect(killPid).toHaveBeenCalledWith(424242, 'SIGTERM')
    const last = collected.events.at(-1) as { t: string; code?: string }
    expect(last.t).toBe('error')
    expect(last.code).toBe('CANCELLED')
  })

  it('forced port-close (renderer crash/nav) is an implicit cancel that terminates the job', async () => {
    // The manager wires `port.on('close', …)` → implicit cancel (PRD §17). In
    // Electron that 'close' is emitted by MessagePortMain when the renderer's
    // peer port closes (renderer crash / navigation). Node's worker_threads
    // MessagePort does NOT emit 'close' on the peer, so we drive the manager via
    // a fake EventPort whose registered 'close' listener we trigger explicitly —
    // proving the close→cancel→CANCELLED wiring at the seam.
    let onClose: (() => void) | undefined
    const posted: Array<{ t: string; code?: string }> = []
    const mgr = new SidecarManager({ coreCount: 10, killGraceMs: 5 })

    // A long-running runner that rejects on abort (registry is global; reuse any
    // already-registered model-download runner — the cancel test registers one
    // that also rejects on abort, so CANCELLED is emitted either way).
    if (!hasRunner('model-download')) {
      registerRunner('model-download', async (_p, emit, ctx) => {
        emit.progress(1, 'downloading')
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return { model: 'base', path: '/x', bytes: 1 }
      })
    }
    expect(getRunner('model-download')).toBeTruthy()

    const eventPort: EventPort = {
      postMessage: (v) => posted.push(v as { t: string; code?: string }),
      close: () => {},
      on: (e, l) => {
        if (e === 'close') onClose = l
      },
      start: () => {}
    }
    const jobId = mgr.startJob('model-download', { model: 'base' }, eventPort)
    expect(mgr.activeJobIds()).toContain(jobId)
    expect(typeof onClose).toBe('function')

    // Let the runner emit first progress, then simulate the renderer port close.
    await new Promise((r) => setTimeout(r, 10))
    onClose!() // peer close → manager.cancel(jobId)

    await new Promise((r) => setTimeout(r, 30))
    expect(mgr.activeJobIds()).not.toContain(jobId)
    const last = posted.at(-1)
    expect(last?.t).toBe('error')
    expect(last?.code).toBe('CANCELLED')
  })
})
