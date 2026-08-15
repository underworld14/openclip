// @vitest-environment jsdom
/**
 * tests/unit/settings-panel-custom-endpoint.spec.tsx — the Base URL field for a
 * custom OpenAI-compatible endpoint (FEAT-bysdwg).
 *
 * The field follows the model id's draft/blur rule (audit fix openclip-i68), and
 * that matters more here: a URL is invalid for most of the time it is being typed
 * (`http:/`), so a per-keystroke save would be REJECTED main-side on nearly every
 * keystroke. `settingsStore.save` has no throw path its callers await, so a
 * rejected save is silent — the field must therefore refuse to send a value it
 * knows is invalid, which only a rendered test can check.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { useSettingsStore } from '@renderer/stores/settingsStore'

let bridge: OpenClipBridge

function mount(settings: Record<string, unknown>): void {
  bridge = installRendererEnv({ settings: { aiProvider: 'custom', model: '', ...settings } })
  bridge.settings.apiKeyStatus = vi.fn(async ({ provider }) => ({ provider, hasKey: false }))
  bridge.ai.listModels = vi.fn(async ({ provider }) => ({
    provider,
    models: [],
    fetchedAt: 1,
    fromCache: false
  })) as unknown as OpenClipBridge['ai']['listModels']
  useSettingsStore.setState({
    models: [],
    modelsFetchedAt: null,
    modelsLoading: false,
    modelsError: null,
    saveError: null
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function baseUrlField(): Promise<HTMLInputElement> {
  return (await screen.findByPlaceholderText('http://localhost:1234/v1')) as HTMLInputElement
}

/**
 * Wrap the mock bridge's stateful `settings.set` in a spy. It is a real
 * implementation (tests/mocks/openclip.ts keeps settings per instance), not a
 * vi.fn, so it cannot simply be cleared.
 */
function spyOnSet(): ReturnType<typeof vi.fn> {
  const original = bridge.settings.set
  const spy = vi.fn(original)
  bridge.settings.set = spy as unknown as OpenClipBridge['settings']['set']
  return spy
}

describe('SettingsPanel: the custom endpoint Base URL', () => {
  it('appears only for the custom provider', async () => {
    mount({ aiProvider: 'openai' })
    render(<SettingsPanel />)
    await screen.findByLabelText(/AI Provider/i)
    expect(screen.queryByTestId('custom-base-url')).toBeNull()

    cleanup()
    mount({ aiProvider: 'custom' })
    render(<SettingsPanel />)
    expect(await screen.findByTestId('custom-base-url')).toBeTruthy()
  })

  it('does not persist while typing — only on blur', async () => {
    mount({})
    render(<SettingsPanel />)
    const input = await baseUrlField()
    const setSpy = spyOnSet()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'http://localhost:1234/v1' } })
    })
    expect(setSpy).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.blur(input)
    })
    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({
        settings: { baseUrl: 'http://localhost:1234/v1' }
      })
    )
  })

  it('normalizes a trailing slash rather than storing a second spelling', async () => {
    mount({})
    render(<SettingsPanel />)
    const input = await baseUrlField()
    const setSpy = spyOnSet()

    await act(async () => {
      fireEvent.change(input, { target: { value: '  http://localhost:1234/v1/  ' } })
      fireEvent.blur(input)
    })

    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith({ settings: { baseUrl: 'http://localhost:1234/v1' } })
    )
  })

  it('shows a hint and saves NOTHING for a URL main would reject', async () => {
    mount({})
    render(<SettingsPanel />)
    const input = await baseUrlField()
    const setSpy = spyOnSet()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'htp://localhost:1234' } })
      fireEvent.blur(input)
    })

    expect(await screen.findByTestId('base-url-error')).toBeTruthy()
    // Sending it would throw INPUT_INVALID inside a `void save(...)` — an
    // unhandled rejection and a field that looks saved but is not.
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('warns about plain HTTP to a host that is not this machine or LAN', async () => {
    mount({})
    render(<SettingsPanel />)
    const input = await baseUrlField()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'http://api.example.com/v1' } })
    })
    expect(await screen.findByTestId('base-url-insecure')).toBeTruthy()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'http://localhost:1234/v1' } })
    })
    await waitFor(() => expect(screen.queryByTestId('base-url-insecure')).toBeNull())
  })

  it('does not fetch a model list until an endpoint exists', async () => {
    mount({})
    render(<SettingsPanel />)
    await baseUrlField()
    // The handler rejects without a base URL, and the first thing a new user
    // would otherwise see in Settings is a raw IPC error string.
    expect(bridge.ai.listModels).not.toHaveBeenCalled()
    expect(screen.getByTestId('model-picker').textContent).toMatch(/Set a Base URL above/i)
  })

  it('re-reads the key status when the endpoint changes', async () => {
    // A saved key is bound MAIN-side to the endpoint it was entered for, so
    // pointing at a different server unbinds it. Without this the panel keeps
    // showing "Key set ••••1a2b" for a key that will never be sent.
    mount({ baseUrl: 'http://localhost:1234/v1' })
    render(<SettingsPanel />)
    const input = await baseUrlField()
    const statusSpy = vi.mocked(bridge.settings.apiKeyStatus)
    statusSpy.mockClear()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'http://localhost:4321/v1' } })
      fireEvent.blur(input)
    })

    await waitFor(() => expect(statusSpy).toHaveBeenCalledWith({ provider: 'custom' }))
  })

  it('fetches once the endpoint is committed, without needing a key', async () => {
    mount({})
    render(<SettingsPanel />)
    const input = await baseUrlField()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'http://localhost:1234/v1' } })
      fireEvent.blur(input)
    })

    await waitFor(() => expect(bridge.ai.listModels).toHaveBeenCalled())
  })
})
