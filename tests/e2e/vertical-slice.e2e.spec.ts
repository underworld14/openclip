/**
 * tests/e2e/vertical-slice.e2e.spec.ts — the T-Media I1 vertical-slice E2E
 * (plan E.3 done-when), run against the REAL built Electron app over the REAL IPC
 * + preload bridge + sidecar manager + per-job MessagePort handoff.
 *
 * The "sidecar" is the fake-emitter harness: launching with
 * OPENCLIP_FAKE_TRANSCRIBE makes T-Media's OWN handlers binary-free — the
 * registered `extract-audio` job returns a fixed WAV path and the registered
 * `transcribe` job runner streams a FIXED transcript (the "fake-sidecar
 * harness emitting a fixed transcript", plan E.10). No real whisper/FFmpeg
 * binary runs here; the real-binary path is covered by the @serial whisper
 * smoke.
 *
 * BLOCKER FIXED (integration Wave-1 Stage 2): the per-job MessagePort is no
 * longer (incorrectly) returned across `contextBridge` (which clone+froze it
 * into a dead Object). `jobs.start()` now returns `{ jobId }` only, and the main
 * process delivers the LIVE port OUT-OF-BAND — `MessageChannelMain` →
 * `senderFrame.postMessage(JOB_PORT,{jobId},[port2])` → the preload forwards it
 * into the MAIN world via `window.postMessage(…, [port])`. The streaming test
 * below acquires that live port (asserting it is a REAL MessagePort with
 * postMessage/onmessage) and consumes progress→done over it.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

// The main-world port-acquisition shim the renderer uses (hooks/jobPort.ts):
// listen for the preload's forwarded `window.postMessage` tagged with the jobId
// and resolve the LIVE MessagePort. Inlined here so `win.evaluate` (which runs
// in the main world, where the bundled module is not importable) can use it.
//
// It MUST buffer for either arrival order, exactly like the production registry
// does — the port is NOT delivered after `jobs.start()` resolves. main/index.ts
// posts it (`senderFrame.postMessage(JOB_PORT, …, [port2])`, :245) BEFORE the
// JOB_START handler returns `{ jobId }`, so the forwarded `window.postMessage`
// routinely lands FIRST. A shim that only subscribes after awaiting `start()`
// misses it and hangs forever (the 60s CI timeout in BUG-zcqyb7) — it only ever
// "passed" on machines where the invoke reply happened to win the race. So:
// install the listener ONCE at evaluate-time, before any job starts, and stash
// ports by jobId for a waiter that may not exist yet.
const ACQUIRE_PORT_SHIM = `
  const __ready = new Map()
  const __waiters = new Map()
  window.addEventListener('message', function (ev) {
    const d = ev.data
    if (!d || d.__openclip !== 'openclip:job-port' || typeof d.jobId !== 'string') return
    const port = ev.ports[0]
    if (!port) return
    const waiter = __waiters.get(d.jobId)
    if (waiter) {
      __waiters.delete(d.jobId)
      waiter(port)
    } else {
      __ready.set(d.jobId, port)
    }
  })
  function acquireJobPort(jobId, timeoutMs) {
    const existing = __ready.get(jobId)
    if (existing) {
      __ready.delete(jobId)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(function () {
        __waiters.delete(jobId)
        reject(new Error('acquireJobPort(' + jobId + '): no per-job MessagePort arrived within ' +
          timeoutMs + 'ms — main never transferred it (see the main-process senderFrame log)'))
      }, timeoutMs || 15000)
      __waiters.set(jobId, function (port) { clearTimeout(timer); resolve(port) })
    })
  }
  // Drain a per-job port to its terminal event (EPIC-k83ghw / BUG-sg6kqg —
  // audio extraction is now a streaming job like transcribe, so the fixed-WAV
  // step needs the same acquire+drain dance instead of a plain invoke await).
  function drainJobPort(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const events = []
      const timer = setTimeout(function () {
        reject(new Error('drainJobPort: no terminal event within ' + (timeoutMs || 15000) +
          'ms — saw [' + events.join(', ') + ']'))
      }, timeoutMs || 15000)
      port.onmessage = function (ev) {
        const d = ev.data
        if (d.t === 'job-id') return
        events.push(d.t)
        if (d.t === 'done') {
          clearTimeout(timer)
          resolve({ events: events, result: d.result })
        }
        if (d.t === 'error') {
          clearTimeout(timer)
          reject(new Error('job failed [' + d.code + ']: ' + d.message))
        }
      }
      port.start()
    })
  }
`

test('owned slice over the real app: audio extract + transcribe job start/cancel', async () => {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const out = await win.evaluate(async (acquireSrc) => {
    const { acquireJobPort, drainJobPort } = new Function(
      acquireSrc + '; return { acquireJobPort: acquireJobPort, drainJobPort: drainJobPort }'
    )() as {
      acquireJobPort: (jobId: string, timeoutMs?: number) => Promise<MessagePort>
      drainJobPort: (port: MessagePort, timeoutMs?: number) => Promise<{ result: unknown }>
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = (window as any).openclip
    // 1) Audio extract → a 16kHz WAV path (PRD §6.1), over the real `extract-audio`
    //    job (EPIC-k83ghw / BUG-sg6kqg — no longer a plain invoke).
    const { jobId: extractJobId } = await oc.jobs.start('extract-audio', {
      projectId: 'p1',
      sourcePath: '/tmp/x.mp4'
    })
    const extractPort = await acquireJobPort(extractJobId, 15_000)
    const { result: extractResult } = await drainJobPort(extractPort, 15_000)
    const wavPath = (extractResult as { wavPath: string }).wavPath
    // 2) The transcribe job starts and the real main side assigns a jobId
    //    (the JOB_START control plane round-trips as a plain invoke → { jobId }).
    const { jobId } = await oc.jobs.start('transcribe', {
      projectId: 'p1',
      wavPath,
      model: 'base'
    })
    // 3) Cancel round-trips (request/response, never starved — PRD §10.2).
    await oc.jobs.cancel(jobId)
    return { wavPath, jobId }
  }, ACQUIRE_PORT_SHIM)

  expect(out.wavPath).toContain('audio.16k.wav')
  expect(out.jobId).toMatch(/^transcribe-/)

  await app.close()
})

test('transcribe streams progress + a fixed transcript to the renderer over the transferred port', async () => {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const result = await win.evaluate(async (acquireSrc) => {
    const { acquireJobPort, drainJobPort } = new Function(
      acquireSrc + '; return { acquireJobPort: acquireJobPort, drainJobPort: drainJobPort }'
    )() as {
      acquireJobPort: (jobId: string, timeoutMs?: number) => Promise<MessagePort>
      drainJobPort: (port: MessagePort, timeoutMs?: number) => Promise<{ result: unknown }>
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = (window as any).openclip
    // Audio extract is now the `extract-audio` streaming job (EPIC-k83ghw /
    // BUG-sg6kqg), same acquire+drain dance as transcribe below.
    const { jobId: extractJobId } = await oc.jobs.start('extract-audio', {
      projectId: 'p1',
      sourcePath: '/tmp/x.mp4'
    })
    const extractPort = await acquireJobPort(extractJobId, 15_000)
    const { result: extractResult } = await drainJobPort(extractPort, 15_000)
    const wavPath = (extractResult as { wavPath: string }).wavPath
    const { jobId } = await oc.jobs.start('transcribe', { projectId: 'p1', wavPath, model: 'base' })

    // Acquire the LIVE per-job port delivered out-of-band (the contextBridge fix).
    // Bounded: a bare `await` here turns any delivery failure into an opaque 60s
    // Playwright timeout with no error context (BUG-zcqyb7). Fail with the reason.
    const port = await acquireJobPort(jobId, 15_000)

    // REGRESSION GUARD: the port must be a REAL MessagePort, not a cloned Object.
    const portType = Object.prototype.toString.call(port) // "[object MessagePort]"
    const isRealPort =
      typeof (port as MessagePort).postMessage === 'function' &&
      'onmessage' in (port as MessagePort) &&
      typeof (port as MessagePort).start === 'function'

    const events: string[] = []
    let done: unknown = null
    // Also bounded: every job terminates with done xor error (the jobs.ts invariant),
    // so a silent stall here is a real contract violation and must be reported as one
    // rather than as a nondescript suite timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `job ${jobId}: stream never terminated within 15000ms — saw [${events.join(', ')}] ` +
                `but no done/error (violates the jobs.ts done-xor-error invariant)`
            )
          ),
        15_000
      )
      port.onmessage = (ev: MessageEvent): void => {
        const d = ev.data as { t: string; result?: unknown }
        if (d.t === 'job-id') return
        events.push(d.t)
        if (d.t === 'done') {
          done = d.result
          clearTimeout(timer)
          resolve()
        }
        if (d.t === 'error') {
          clearTimeout(timer)
          resolve()
        }
      }
      port.start()
    })
    return { events, done, portType, isRealPort }
  }, ACQUIRE_PORT_SHIM)

  // The port the renderer received is a genuine, live MessagePort.
  expect(result.isRealPort).toBe(true)
  expect(result.portType).toBe('[object MessagePort]')

  // The fixed transcript streamed progress → done over the transferred port.
  expect(result.events).toContain('progress')
  expect(result.events).toContain('done')
  const r = result.done as { segments: Array<{ text: string }> }
  expect(r.segments.map((s) => s.text)).toContain('Hello world!')

  await app.close()
})
