// @vitest-environment jsdom
/**
 * tests/unit/settings-tabs.spec.tsx — Settings is three shallow sections, not one
 * 1300px stack (FEAT-7ffxsg).
 *
 * Bounding the dialog made the lower controls reachable; tabbing makes them
 * findable. What matters is that nothing was LOST in the split — every control
 * that used to be somewhere in the scroll is still reachable, just behind the
 * tab it belongs to. That is exactly the kind of regression a refactor like this
 * introduces silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installRendererEnv } from '../harness/renderer-env'
import { SettingsPanel } from '@renderer/components/SettingsPanel'

beforeEach(() => {
  installRendererEnv({ settings: { aiProvider: 'openai', model: 'gpt-4o' } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Radix tab triggers activate on POINTER events, not a synthetic `click`, so
// user-event (which dispatches the full pointer sequence) is required here.
const clickTab = async (testId: string): Promise<void> => {
  await userEvent.click(screen.getByTestId(testId))
}

describe('SettingsPanel: three tabs, nothing lost in the split', () => {
  it('shows the AI section by default — the reason most people open Settings', async () => {
    render(<SettingsPanel />)
    expect(await screen.findByLabelText('AI Provider (BYOK)')).toBeTruthy()
    expect(screen.getByPlaceholderText('Pick one below, or type a model id')).toBeTruthy()
  })

  it('keeps the optional emoji-AI provider block on the AI tab', async () => {
    render(<SettingsPanel />)
    await waitFor(() => expect(screen.getByTestId('emoji-ai-settings')).toBeTruthy())
  })

  it('reaches the transcription language picker via its tab', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('settings-tab-transcription')
    await clickTab('settings-tab-transcription')
    await waitFor(() => expect(screen.getByTestId('language-picker')).toBeTruthy())
  })

  it('reaches the brand kit via its tab', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('settings-tab-brand')
    await clickTab('settings-tab-brand')
    // Assert on a BrandKitEditor control, not on the word "brand" — the tab
    // trigger itself says "Brand", so a text match would pass without the panel.
    await waitFor(() => expect(screen.getByTestId('brand-kit-editor')).toBeTruthy())
  })

  it('shows one section at a time, which is the entire point', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('settings-tab-transcription')
    // The language picker belongs to another tab, so it must not be mounted while
    // AI is selected — otherwise the "split" is cosmetic and the stack is as tall
    // as it ever was.
    expect(screen.queryByTestId('language-picker')).toBeNull()

    await clickTab('settings-tab-transcription')
    await waitFor(() => expect(screen.getByTestId('language-picker')).toBeTruthy())
    expect(screen.queryByTestId('emoji-ai-settings')).toBeNull()
  })
})
