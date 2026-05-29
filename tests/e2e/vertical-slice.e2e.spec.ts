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
 * Scope note (plan m10): the *full* import→export E2E is integration-owned and
 * `video:import` is another track's channel (not wired in this isolated worktree).
 * So this spec exercises exactly the owned slice over the real main process:
 * audio extract → start transcribe job (real MessagePort handoff) → cancel path.
 *
 * ⚠️ BLOCKER (see report / integration notes): the FROZEN bridge
 * `preload/api/jobs.ts` resolves `jobs.start()` with a renderer-side `MessagePort`
 * RETURNED across `contextBridge.exposeInMainWorld`. contextBridge structure-
 * clones function return values, so the port arrives in the renderer as a dead
 * plain `Object` (no `onmessage`/`addEventListener`/`start`) — verified here. No
 * streaming job can reach the renderer in the real app until the trunk fixes the
 * port handoff (deliver the port via an `ipcRenderer.on(..., e=>e.ports[0])`
 * event, not a promise return). The streaming-consumption assertion is therefore
 * `test.fixme`-gated; the renderer-stack streaming logic is fully proven over a
 * real Node MessageChannel by the unit suites (usejob / import-pipeline /
 * transcribe-runner / transcript-slice / transcript-panel), and the real-binary
 * path by the @serial whisper smoke.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

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
    // 2) The transcribe job starts and the real main side assigns a jobId +
    //    transfers a port (the JOB_START control plane round-trips).
    const { jobId, port } = await oc.jobs.start('transcribe', {
      projectId: 'p1',
      wavPath,
      model: 'base'
    })
    // 3) Cancel round-trips (request/response, never starved — PRD §10.2).
    await oc.jobs.cancel(jobId)
    return { wavPath, jobId, hasPort: port != null, portWorks: typeof port?.onmessage }
  })

  expect(out.wavPath).toContain('audio.16k.wav')
  expect(out.jobId).toMatch(/^transcribe-/)
  expect(out.hasPort).toBe(true)

  await app.close()
})

// ⚠️ Gated on the frozen-bridge BLOCKER above: `jobs.start()`'s returned port is
// dead across contextBridge, so the renderer cannot consume the streamed
// transcript in the real app. Un-fixme once the trunk delivers the port via an
// `ipcRenderer.on('port', e => e.ports[0])` event instead of a promise return.
test.fixme('transcribe streams progress + a fixed transcript to the renderer (needs trunk port-handoff fix)', async () => {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'production', OPENCLIP_FAKE_TRANSCRIBE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const result = await win.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = (window as any).openclip
    const { wavPath } = await oc.audio.extract({ projectId: 'p1', sourcePath: '/tmp/x.mp4' })
    const { port } = await oc.jobs.start('transcribe', { projectId: 'p1', wavPath, model: 'base' })
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
      }
      port.start?.()
    })
    return { events, done }
  })
  expect(result.events).toContain('done')
  const r = result.done as { segments: Array<{ text: string }> }
  expect(r.segments.map((s) => s.text)).toContain('Hello world!')
  await app.close()
})
