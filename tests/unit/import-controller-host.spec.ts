/**
 * tests/unit/import-controller-host.spec.ts — the shared import-controller host.
 *
 * Regression guard for a bug the singleton introduced: `useImportController`
 * baked the `onNeedModel` callback of whichever component ran the memo
 * initializer FIRST. React runs a parent's hooks before its children's, so
 * `App` (which passed none) always won and `ImportPanel`'s callback was never
 * captured — the whisper-model dialog stopped opening entirely, and a first-run
 * import dead-ended in silence.
 *
 * The registry below is deliberately framework-free so this can be tested in the
 * repo's node env, with no React render.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  __resetImportHostForTests,
  notifyNeedModel,
  setNeedModelHandler
} from '@renderer/hooks/importControllerHost'

beforeEach(() => __resetImportHostForTests())

describe('need-model handler registry', () => {
  it('forwards to a registered handler', () => {
    const fn = vi.fn()
    setNeedModelHandler(fn)
    notifyNeedModel('base')
    expect(fn).toHaveBeenCalledWith('base')
  })

  it('ignores an undefined registration so a handler-less caller cannot clobber a real one', () => {
    // This is the actual bug: App calls the hook without a handler and its
    // effect runs AFTER ImportPanel's, so a naive "last write wins" slot would
    // overwrite the live callback with undefined.
    const fn = vi.fn()
    setNeedModelHandler(fn)
    setNeedModelHandler(undefined)
    notifyNeedModel('turbo')
    expect(fn).toHaveBeenCalledWith('turbo')
  })

  it('lets a later real handler replace an earlier one', () => {
    const first = vi.fn()
    const second = vi.fn()
    setNeedModelHandler(first)
    setNeedModelHandler(second)
    notifyNeedModel('small')
    expect(second).toHaveBeenCalledWith('small')
    expect(first).not.toHaveBeenCalled()
  })

  it('does not throw when nothing is registered', () => {
    expect(() => notifyNeedModel('base')).not.toThrow()
  })
})
