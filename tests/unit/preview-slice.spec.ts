/**
 * tests/unit/preview-slice.spec.ts — the transient preview/compose selection
 * slice (Part K, Step 3): defaults + one-writer setters.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMockOpenclip } from '../mocks/openclip'

function installBridge(): void {
  ;(globalThis as { window?: unknown }).window = { openclip: createMockOpenclip() }
}

describe('previewSlice', () => {
  beforeEach(() => installBridge())

  it('has the expected defaults and setters', async () => {
    const { useProjectStore } = await import('@renderer/stores/projectStore')
    const s = useProjectStore.getState()
    expect(s.aspectOverride).toBeNull()
    expect(s.reframeMode).toBe('off')
    expect(s.captionsPreviewEnabled).toBe(true)

    s.setAspectOverride('1:1')
    s.setReframeMode('auto')
    s.setCaptionsPreviewEnabled(false)

    const s2 = useProjectStore.getState()
    expect(s2.aspectOverride).toBe('1:1')
    expect(s2.reframeMode).toBe('auto')
    expect(s2.captionsPreviewEnabled).toBe(false)
  })
})
