/**
 * tests/e2e/vertical-slice.e2e.spec.ts — the T-Media I1 vertical-slice E2E
 * (plan E.3 done-when), run against the REAL built Electron app over the REAL IPC
 * + preload bridge + sidecar manager + per-job MessagePort handoff.
 *
 * The "sidecar" is the fake-emitter harness: launching with
 * OPENCLIP_FAKE_TRANSCRIBE makes T-Media's OWN handlers binary-free —
 * `audio.extract` returns a fixed WAV path and the registered `transcribe` job
 * runner streams a FIXED transcript (the "fake-sidecar harness emitting a fixed
 * transcript", plan E.10). No real whisper/FFmpeg binary runs here; the
 * real-binary path is covered by the @serial whisper smoke.
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
const ACQUIRE_PORT_SHIM = `
  function acquireJobPort(jobId) {
    return new Promise((resolve) => {
      window.addEventListener('message', function onMsg(ev) {
        const d = ev.data
        if (d && d.__openclip === 'openclip:job-port' && d.jobId === jobId) {
          window.removeEventListener('message', onMsg)
          resolve(ev.ports[0])
        }
      })
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

  const out = await win.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = (window as any).openclip
    // 1) Audio extract → a 16kHz WAV path (PRD §6.1), over the real handler.
    const { wavPath } = await oc.audio.extract({ projectId: 'p1', sourcePath: '/tmp/x.mp4' })
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
  })

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
    const acquireJobPort = new Function(acquireSrc + '; return acquireJobPort')() as (
      jobId: string
    ) => Promise<MessagePort>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = (window as any).openclip
    const { wavPath } = await oc.audio.extract({ projectId: 'p1', sourcePath: '/tmp/x.mp4' })
    const { jobId } = await oc.jobs.start('transcribe', { projectId: 'p1', wavPath, model: 'base' })

    // Acquire the LIVE per-job port delivered out-of-band (the contextBridge fix).
    const port = await acquireJobPort(jobId)

    // REGRESSION GUARD: the port must be a REAL MessagePort, not a cloned Object.
    const portType = Object.prototype.toString.call(port) // "[object MessagePort]"
    const isRealPort =
      typeof (port as MessagePort).postMessage === 'function' &&
      'onmessage' in (port as MessagePort) &&
      typeof (port as MessagePort).start === 'function'

    const events: string[] = []
    let done: unknown = null
    await new Promise<void>((resolve) => {
      port.onmessage = (ev: MessageEvent): void => {
        const d = ev.data as { t: string; result?: unknown }
        if (d.t === 'job-id') return
        events.push(d.t)
        if (d.t === 'done') {
          done = d.result
          resolve()
        }
        if (d.t === 'error') resolve()
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
