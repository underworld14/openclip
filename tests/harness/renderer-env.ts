/**
 * tests/harness/renderer-env.ts — the shared setup for DOM-rendering renderer
 * specs (FEAT-26tkya).
 *
 * The suite's default vitest environment stays `node`, because the bulk of it is
 * main-process and pure view-model code that a jsdom global would only slow
 * down. A spec that needs to actually RENDER opts in with a
 *
 *   // @vitest-environment jsdom
 *
 * docblock on line 1, then calls `installRendererEnv()` in a `beforeEach`.
 *
 * WHY this exists: before FEAT-26tkya the only way to exercise a component was
 * `renderToStaticMarkup`, which — because zustand v5 feeds React's
 * `getServerSnapshot` from `getInitialState()` — can only ever observe the
 * store's INITIAL state. That makes every effect, event handler and subscription
 * untestable, which is precisely where both EPIC-xzzpty regressions lived (a
 * mis-bound `onNeedModel`, and a `settingsStore.load()` with zero callers).
 *
 * What this helper owns is the stuff that leaks BETWEEN specs: `window.openclip`
 * (a fresh mock bridge per test) and the renderer's module-level singletons
 * (the import controller and its need-model handler slot). Zustand stores are
 * module singletons too; a spec that mutates one is responsible for restoring it.
 */

import { createMockOpenclip, type MockOptions } from '../mocks/openclip'
import type { OpenClipBridge } from '@preload/index'
import { __resetImportHostForTests } from '@renderer/hooks/importControllerHost'
import { __resetImportControllerForTests } from '@renderer/hooks/useImportController'
import { __resetJobPortRegistry } from '@renderer/hooks/jobPort'

declare global {
  interface Window {
    openclip: OpenClipBridge
  }
}

/**
 * Install a fresh mock bridge on `window` and reset the renderer singletons.
 * Returns the bridge so a spec can override individual methods (the mock is a
 * plain object) or assert on calls.
 */
export function installRendererEnv(opts: MockOptions = {}): OpenClipBridge {
  __resetImportControllerForTests()
  __resetImportHostForTests()
  __resetJobPortRegistry()
  const bridge = createMockOpenclip(opts)
  window.openclip = bridge
  return bridge
}

/**
 * Let queued microtasks and timers settle. React Testing Library's `waitFor` is
 * the right tool for assertions; this is for the cases where a spec needs to let
 * an already-asserted async chain finish before tearing the DOM down.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
