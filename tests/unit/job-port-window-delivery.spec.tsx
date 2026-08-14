// @vitest-environment jsdom
/**
 * tests/unit/job-port-window-delivery.spec.tsx — the per-job MessagePort must
 * survive arriving BEFORE anyone asks for it (BUG-zcqyb7).
 *
 * `jobPort.ts` documents that it buffers "for EITHER arrival order
 * (port-before-waiter or waiter-before-port)". The waiter-before-port half was
 * well covered; the port-before-waiter half was not testable before FEAT-26tkya
 * because it can only happen through the real `window` message listener, and the
 * one existing consumer-level test double (`createMockOpenclip`) calls
 * `registerJobPort()` directly — bypassing that listener, and with it the entire
 * code path under test.
 *
 * That gap hid a real defect. The listener was installed lazily, from inside
 * `acquireJobPort()`. For the FIRST job on a page nothing had called
 * `acquireJobPort` yet, so no listener existed, so the forwarded port message
 * was dropped on the floor and `ready` stayed empty — the consumer then waited
 * out the full 30s timeout. Main posts the port BEFORE the JOB_START invoke
 * returns (main/index.ts:245), so whether the port beats the `await` is a pure
 * race, which is exactly how it presented: an intermittent CI hang on whichever
 * spec happened to start the first transcribe of its app instance.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { acquireJobPort, __resetJobPortRegistry, JOB_PORT_MESSAGE } from '@renderer/hooks/jobPort'

/**
 * Deliver a port exactly as the preload forwarder does: a main-world
 * `window.postMessage` tagged with the jobId, carrying the live port.
 */
function forwardPortFromPreload(jobId: string): MessagePort {
  const { port1, port2 } = new MessageChannel()
  void port2
  const port = port1 as unknown as MessagePort
  window.dispatchEvent(
    Object.assign(new Event('message'), {
      data: { __openclip: JOB_PORT_MESSAGE, jobId },
      ports: [port]
    })
  )
  return port
}

beforeEach(() => {
  __resetJobPortRegistry()
})

afterEach(() => {
  __resetJobPortRegistry()
})

describe('jobPort: a port that arrives before anyone waits for it', () => {
  it('is buffered and handed to the FIRST acquireJobPort call on the page', async () => {
    // Nothing has touched the registry yet — this is a freshly loaded page, and
    // the very first job of the session. The port lands first.
    const sent = forwardPortFromPreload('transcribe-1')

    const got = await acquireJobPort('transcribe-1', 250)
    expect(got).toBe(sent)
  })

  it('still resolves when the waiter comes first (the covered half, unchanged)', async () => {
    const pending = acquireJobPort('transcribe-2', 250)
    const sent = forwardPortFromPreload('transcribe-2')
    expect(await pending).toBe(sent)
  })

  it('rejects with a typed error when the port genuinely never arrives', async () => {
    await expect(acquireJobPort('transcribe-3', 50)).rejects.toThrow(
      /per-job MessagePort never arrived/
    )
  })

  it('keeps ports for distinct jobs apart', async () => {
    const a = forwardPortFromPreload('transcribe-a')
    const b = forwardPortFromPreload('transcribe-b')
    expect(await acquireJobPort('transcribe-b', 250)).toBe(b)
    expect(await acquireJobPort('transcribe-a', 250)).toBe(a)
  })
})
