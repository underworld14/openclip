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
      hasJobs: !!(o && typeof o.jobs.start === 'function' && typeof o.jobs.cancel === 'function')
    }
  })
  expect(bridge.namespaces).toEqual([
    'ai',
    'audio',
    'jobs',
    'model',
    'project',
    'settings',
    'system',
    'video'
  ])
  expect(bridge.videoMethods).toEqual(['export', 'import'])
  // F.3: the native file picker auto-derives `system.openDialog` from ChannelMap.
  expect(bridge.systemMethods).toEqual(['checkUpdate', 'openDialog', 'openFolder', 'saveDialog'])
  expect(bridge.hasJobs).toBe(true)

  // 3) security baseline: nodeIntegration off ⇒ no Node `process` in renderer.
  const hasProcess = await window.evaluate(() => {
    // @ts-expect-error renderer global
    return typeof window.process !== 'undefined' && !!window.process?.versions?.node
  })
  expect(hasProcess).toBe(false)

  await app.close()
})
