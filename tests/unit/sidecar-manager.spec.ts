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
  defaultArrayLimiterFactory,
  type EventPort,
  type Limiter
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

describe('defaultArrayLimiterFactory: a synchronous throw releases the slot (audit fix openclip-40a)', () => {
  it('does not starve the kind when a task throws synchronously', async () => {
    const limiter = defaultArrayLimiterFactory(1) // serial: one slot
    // First task throws SYNCHRONOUSLY (not a rejected promise) — the bug case.
    const p1 = limiter.add((() => {
      throw new Error('sync boom')
    }) as () => Promise<void>)
    await expect(p1).rejects.toThrow('sync boom')
    // The one slot must be freed so a SECOND task runs; without the fix activeCount
    // would stay at 1 and this add() would queue forever (test would time out).
    let ran = false
    await limiter.add(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})

describe('SidecarManager: a QUEUED job is settled synchronously on cancel/killAll', () => {
  // A limiter that NEVER admits the task — simulates a job stuck behind a full queue.
  const neverAdmit = (): Limiter => ({
    get pending(): number {
      return 1
    },
    add: <T>(): Promise<T> => new Promise<T>(() => {}) // never resolves ⇒ runner never starts
  })
  const mkPort = (): { eventPort: EventPort; collected: ReturnType<typeof collectPort> } => {
    const { port1, port2 } = new MessageChannel()
    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }
    return { eventPort, collected: collectPort(port1 as never) }
  }
  const params = { projectId: 'p1', wavPath: '/a.wav', model: 'base' as const }

  it('cancel() on a QUEUED job emits CANCELLED now, not after the limiter drains (openclip-yyi)', async () => {
    const mgr = new SidecarManager({ coreCount: 10, limiterFactory: neverAdmit })
    const { eventPort, collected } = mkPort()
    const jobId = mgr.startJob('transcribe', params, eventPort)
    mgr.cancel(jobId) // runner never started ⇒ must settle synchronously
    await collected.done
    const last = collected.events.at(-1) as { t: string; code?: string }
    expect(last.t).toBe('error')
    expect(last.code).toBe('CANCELLED')
  })

  it('killAll() settles a QUEUED job with terminal CANCELLED (openclip-sf0)', async () => {
    const mgr = new SidecarManager({ coreCount: 10, limiterFactory: neverAdmit })
    const { eventPort, collected } = mkPort()
    mgr.startJob('transcribe', params, eventPort)
    mgr.killAll()
    await collected.done
    const last = collected.events.at(-1) as { t: string; code?: string }
    expect(last.t).toBe('error')
    expect(last.code).toBe('CANCELLED')
  })
})

describe('SidecarManager: settle() never leaks a job when the port throws (audit fix openclip-asx)', () => {
  it('removes the job from active even when port.postMessage throws (renderer torn down)', async () => {
    const mgr = new SidecarManager({ coreCount: 10 })
    // A port whose postMessage ALWAYS throws — as if the peer MessagePort was torn
    // down. Without the fix, settle()'s postMessage throws BEFORE active.delete, so the
    // job (and its PIDs) leak in `active` forever.
    const throwingPort: EventPort = {
      postMessage: () => {
        throw new Error('port closed')
      },
      close: () => {},
      on: () => {},
      start: () => {}
    }
    const jobId = mgr.startJob(
      'transcribe',
      { projectId: 'p1', wavPath: '/a.wav', model: 'base' },
      throwingPort
    )
    // Let the scripted runner run; every emit throws → the error path reaches settle().
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.activeJobIds()).not.toContain(jobId)
  })
})

describe('SidecarManager: untrackPid prevents SIGKILLing a recycled PID (audit fix openclip-yul)', () => {
  it('a PID untracked on normal child exit is NOT SIGTERM/SIGKILLed on a later cancel', async () => {
    const killPid = vi.fn()
    const mgr = new SidecarManager({ coreCount: 10, killPid, killGraceMs: 5 })
    // A runner whose child spawns (trackPid) then EXITS normally (untrackPid) while the
    // job keeps running (e.g. a follow-up step). The exited PID must not be killed later.
    registerRunner('url-download', async (_p, emit, ctx) => {
      ctx.trackPid(919191)
      ctx.untrackPid?.(919191) // child exited normally
      emit.progress(50, 'downloading')
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return { filePath: '/x', title: 't', bytes: 1 }
    })

    const { port1, port2 } = new MessageChannel()
    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }
    const collected = collectPort(port1 as never)
    const jobId = mgr.startJob('url-download', { url: 'https://x.test/v' }, eventPort)
    await new Promise((r) => setTimeout(r, 10)) // let the runner track+untrack the PID
    mgr.cancel(jobId)
    await collected.done
    await new Promise((r) => setTimeout(r, 15)) // past the grace period

    expect(killPid).not.toHaveBeenCalledWith(919191, 'SIGTERM')
    expect(killPid).not.toHaveBeenCalledWith(919191, 'SIGKILL')
  })
})

describe('SidecarManager lifecycle hooks (audit fix openclip-032)', () => {
  it('wires before-quit/will-quit but NOT child-process-gone to killAll', () => {
    const mgr = new SidecarManager({ coreCount: 10 })
    const appEvents: string[] = []
    mgr.installLifecycleHooks({ on: (e: string) => appEvents.push(e) })
    expect(appEvents).toContain('before-quit')
    expect(appEvents).toContain('will-quit')
    // A recoverable GPU/utility child crash must NOT massacre every running job.
    expect(appEvents).not.toContain('child-process-gone')
  })
})

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

describe('SidecarManager concurrency BEHAVIOR (audit fix openclip-nh3)', () => {
  it('serializes tasks at concurrency 1 — the 2nd starts only after the 1st resolves', async () => {
    const limiter = defaultArrayLimiterFactory(1)
    const order: string[] = []
    let release1: () => void = () => {}
    const p1 = limiter.add(
      () =>
        new Promise<void>((r) => {
          order.push('start1')
          release1 = () => {
            order.push('end1')
            r()
          }
        })
    )
    const p2 = limiter.add(async () => {
      order.push('start2')
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['start1']) // task2 is serialized BEHIND the in-flight task1
    release1()
    await Promise.all([p1, p2])
    expect(order).toEqual(['start1', 'end1', 'start2'])
  })

  it('runs the export cap (2) concurrently but queues the overflow', async () => {
    const limiter = defaultArrayLimiterFactory(exportConcurrency(10)) // = 2
    const running: number[] = []
    const releases: Array<() => void> = []
    const mk = (i: number): Promise<void> =>
      limiter.add(
        () =>
          new Promise<void>((r) => {
            running.push(i)
            releases.push(r)
          })
      )
    const ps = [mk(0), mk(1), mk(2)]
    await new Promise((r) => setTimeout(r, 5))
    expect(running).toEqual([0, 1]) // exactly 2 admitted; the 3rd waits
    releases[0]()
    await new Promise((r) => setTimeout(r, 5))
    expect(running).toEqual([0, 1, 2]) // freeing a slot admits the 3rd
    releases[1]()
    releases[2]()
    await Promise.all(ps)
  })

  it('surfaces queue position as a "queued" progress stage when the limiter is busy', async () => {
    // A limiter that reports a non-empty queue + never admits — the manager must emit a
    // `queued` progress for a job that can't start yet (PRD §17 queue UX).
    const busyLimiter: Limiter = {
      get pending(): number {
        return 1
      },
      add: <T>(): Promise<T> => new Promise<T>(() => {})
    }
    const mgr = new SidecarManager({ coreCount: 10, limiterFactory: () => busyLimiter })
    const { port1, port2 } = new MessageChannel()
    const eventPort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (e, l) => port2.on(e, l),
      start: () => port2.start()
    }
    const collected = collectPort(port1 as never)
    mgr.startJob('transcribe', { projectId: 'p1', wavPath: '/a.wav', model: 'base' }, eventPort)
    await new Promise((r) => setTimeout(r, 10))
    expect(
      collected.events.some((e) => e.t === 'progress' && e.stage === 'queued')
    ).toBe(true)
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
  it('model-download overlaps (4) and url-download overlaps (2)', () => {
    expect(concurrencyFor('model-download', 10)).toBe(4)
    expect(concurrencyFor('url-download', 10)).toBe(2)
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

  it('cancel() escalates SIGTERM then SIGKILL after the grace period (audit fix openclip-ai5)', async () => {
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

    // Prove the SIGTERM→SIGKILL escalation TIMER actually fires the SIGKILL after the
    // grace period (audit fix openclip-ai5 — previously only the SIGTERM was asserted,
    // so a broken/zero grace timer would have gone unnoticed). killGraceMs is 5ms here.
    await new Promise((r) => setTimeout(r, 15))
    expect(killPid).toHaveBeenCalledWith(424242, 'SIGKILL')
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
