// @vitest-environment jsdom
/**
 * tests/unit/settings-panel-model-draft.spec.tsx — the model field's draft must
 * survive a late-arriving model catalogue (FEAT-26tkya, test #3 in the ticket's
 * value order).
 *
 * The model id is a DRAFT that only persists on blur/Enter (audit fix
 * openclip-i68 — saving per keystroke fired ~25 IPC round-trips and could
 * drop/reorder characters). Meanwhile the auto-fill effect seeds a default the
 * moment the provider's catalogue lands, and the render-time re-sync copies any
 * external `settings.model` change back into the draft.
 *
 * Those three are individually reasonable and collectively destructive: while
 * the user is mid-word, `settings.model` is still blank (nothing has been
 * blurred), so auto-fill considers the field empty, saves a default, and the
 * re-sync overwrites what the user was typing. Only a rendered test can see it —
 * it needs the real effect ordering plus real typing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { useSettingsStore } from '@renderer/stores/settingsStore'

let bridge: OpenClipBridge

const CATALOGUE = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Anthropic: Claude Sonnet 4.5',
    supportsStructured: true,
    recommended: true
  }
]

/**
 * Seed through the BRIDGE, not the store: SettingsPanel calls `load()` on mount,
 * which replaces the store's settings with whatever `settings.get()` answers. A
 * spec that only seeds the store watches its own setup get overwritten.
 */
function mount(model: string): void {
  bridge = installRendererEnv({ settings: { aiProvider: 'openrouter', model } })
  bridge.settings.apiKeyStatus = vi.fn(async ({ provider }) => ({
    provider,
    hasKey: true,
    last4: 'ab12'
  }))
  useSettingsStore.setState({
    models: [],
    modelsFetchedAt: null,
    modelsLoading: false,
    modelsError: null
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPanel: a slow model catalogue must not clobber in-progress typing', () => {
  it('keeps the half-typed model id when the catalogue arrives mid-word', async () => {
    // A brand-new user: a key exists (so the catalogue auto-loads) but no model id
    // has ever been chosen — the exact state the auto-fill effect targets.
    mount('')
    // Hold the catalogue until the user is mid-word.
    let deliver: (v: unknown) => void = () => {}
    bridge.ai.listModels = vi.fn(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    ) as unknown as OpenClipBridge['ai']['listModels']

    render(<SettingsPanel />)
    const input = (await screen.findByPlaceholderText(
      'Pick one below, or type a model id'
    )) as HTMLInputElement

    // The user types a model id by hand. Nothing is persisted yet — the draft
    // only commits on blur, so `settings.model` is still ''.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'openai/gpt-5-mi' } })
    })
    expect(input.value).toBe('openai/gpt-5-mi')

    // …and NOW the /models response lands.
    await act(async () => {
      deliver({ provider: 'openrouter', models: CATALOGUE, fetchedAt: 1, fromCache: false })
      await Promise.resolve()
    })

    // The half-typed id must still be there. Before the fix, auto-fill saw a blank
    // `settings.model`, saved 'anthropic/claude-sonnet-4.5', and the render-time
    // re-sync replaced the user's text with it.
    await waitFor(() => expect(input.value).toBe('openai/gpt-5-mi'))
  })

  it('still auto-fills a blank field when the user has typed nothing', async () => {
    mount('')
    let deliver: (v: unknown) => void = () => {}
    bridge.ai.listModels = vi.fn(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    ) as unknown as OpenClipBridge['ai']['listModels']

    render(<SettingsPanel />)
    const input = (await screen.findByPlaceholderText(
      'Pick one below, or type a model id'
    )) as HTMLInputElement
    expect(input.value).toBe('')

    await act(async () => {
      deliver({ provider: 'openrouter', models: CATALOGUE, fetchedAt: 1, fromCache: false })
      await Promise.resolve()
    })

    // The convenience the effect exists for (FEAT-6v92dk) is preserved: an
    // untouched blank field still gets seeded the moment the catalogue lands.
    await waitFor(() => expect(input.value).toBe('anthropic/claude-sonnet-4.5'))
  })

  it('never overwrites a model id the user already committed', async () => {
    mount('openai/gpt-5-mini')
    render(<SettingsPanel />)
    const input = (await screen.findByPlaceholderText(
      'Pick one below, or type a model id'
    )) as HTMLInputElement

    await act(async () => {
      useSettingsStore.setState({ models: CATALOGUE, modelsFetchedAt: 1 })
      await Promise.resolve()
    })

    await waitFor(() => expect(input.value).toBe('openai/gpt-5-mini'))
  })
})
