/**
 * tests/e2e/ping.e2e.spec.ts — Gate A: "a ping IPC round-trips."
 *
 * Launches the REAL built Electron app (out/main/index.js) headlessly via
 * Playwright's `_electron`, then from the renderer invokes `ping` over the
 * preload-exposed `window.electron.ipcRenderer` and asserts the `'pong'`
 * round-trip. Also asserts the frozen `window.openclip` namespaces are present
 * (the derived bridge surface — plan E.4) and that the security baseline is on
 * (contextIsolation: nodeIntegration off ⇒ no `process` in the renderer).
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { IPCChannels } from '../../src/shared/channels'

/**
 * The bridge namespaces, DERIVED from the frozen channel enum rather than typed
 * out by hand — a hand-written literal here is a second source of truth and it
 * rotted once already (it missed `brand`, audit fix BUG-j8pbj9). Every request/
 * response channel is `<namespace>:<verb>`; `job:*` is exposed as the `jobs`
 * namespace (JobsAPI), and `lifecycle:*` is a main→renderer push, not a method.
 */
function expectedNamespaces(): string[] {
  const prefixes = Object.values(IPCChannels).map((c) => c.split(':')[0])
  const named = prefixes.map((p) => (p === 'job' ? 'jobs' : p)).filter((p) => p !== 'lifecycle')
  return [...new Set(named)].sort()
}

test('ping IPC round-trips and the openclip bridge is exposed', async () => {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'production' }
  })

  const window = await app.firstWindow()

  // 1) ping IPC round-trip via the exposed ipcRenderer.invoke.
  const pong = await window.evaluate(async () => {
    // @ts-expect-error window typing is app-side; this runs in the renderer.
    return window.electron.ipcRenderer.invoke('ping')
  })
  expect(pong).toBe('pong')

  // 2) the frozen openclip bridge namespaces exist (derived surface).
  const bridge = await window.evaluate(() => {
    // @ts-expect-error renderer global
    const o = window.openclip
    return {
      namespaces: o ? Object.keys(o).sort() : [],
      videoMethods: o ? Object.keys(o.video).sort() : [],
      systemMethods: o ? Object.keys(o.system).sort() : [],
      hasJobs: !!(o && typeof o.jobs.start === 'function' && typeof o.jobs.cancel === 'function'),
      // Every non-jobs namespace must be a non-empty object of callables.
      allCallable: o
        ? Object.entries(o)
            .filter(([k]) => k !== 'jobs')
            .every(
              ([, ns]) =>
                Object.keys(ns as object).length > 0 &&
                Object.values(ns as object).every((f) => typeof f === 'function')
            )
        : false
    }
  })
  // Sanity-check the DERIVATION itself, so a bug that made it yield an empty or
  // truncated list couldn't turn the assertion below into a no-op. `brand` is the
  // sentinel: it is the namespace the old hand-written literal missed.
  expect(expectedNamespaces()).toContain('brand')
  expect(expectedNamespaces().length).toBeGreaterThanOrEqual(10)

  expect(bridge.namespaces).toEqual(expectedNamespaces())
  // Exact per-namespace METHOD surfaces are asserted type-derived in
  // tests/unit/preload-parity.spec.ts and tests/unit/contract.spec.ts. What only an
  // E2E can prove is that the assembled bridge actually crosses contextIsolation
  // into the renderer, so assert shape, not a second hand-written list.
  expect(bridge.videoMethods.length).toBeGreaterThan(0)
  expect(bridge.systemMethods.length).toBeGreaterThan(0)
  expect(bridge.allCallable).toBe(true)
  expect(bridge.hasJobs).toBe(true)

  // 3) security baseline: nodeIntegration off ⇒ no Node `process` in renderer.
  const hasProcess = await window.evaluate(() => {
    // @ts-expect-error renderer global
    return typeof window.process !== 'undefined' && !!window.process?.versions?.node
  })
  expect(hasProcess).toBe(false)

  await app.close()
})
