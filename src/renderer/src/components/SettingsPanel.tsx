/**
 * SettingsPanel — API keys, provider, model (T-AI, plan E.3). PRD §11.2.
 *
 * The raw API key NEVER leaves main (PRD §12.2); this panel only ever sees
 * `{provider,hasKey,last4}`. The user types a key into a field whose value is
 * sent straight to `settingsStore.setApiKey` (→ main → safeStorage) and then
 * cleared from local component state — it is never persisted in the renderer.
 *
 * Pure presentation helpers (`providerLabel`, `keyStatusLabel`) are extracted so
 * they are unit-tested without a DOM (vitest `node` env).
 */

import { useEffect, useState } from 'react'
import type { AIProvider } from '@shared/schema'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { providerLabel, keyStatusLabel, PROVIDERS } from '@renderer/components/settingsView'

export function SettingsPanel(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const keyStatus = useSettingsStore((s) => s.keyStatus)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const refreshKeyStatus = useSettingsStore((s) => s.refreshKeyStatus)

  // Local-only key entry; cleared after submit (never persisted in renderer).
  const [keyDraft, setKeyDraft] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const provider = settings.aiProvider
  const status = keyStatus[provider]

  const onProviderChange = async (value: string): Promise<void> => {
    const p = value as AIProvider
    await save({ aiProvider: p })
    await refreshKeyStatus(p)
  }

  const onSaveKey = async (): Promise<void> => {
    if (!keyDraft.trim()) return
    await setApiKey(provider, keyDraft.trim())
    setKeyDraft('') // never keep the raw key around in the renderer
  }

  return (
    <div data-testid="settings-panel" className="flex flex-col gap-4 p-3 text-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Settings
      </h2>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-provider">AI Provider (BYOK)</Label>
        <Select value={provider} onValueChange={(v) => void onProviderChange(v)}>
          <SelectTrigger id="ai-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-model">Model</Label>
        <Input
          id="ai-model"
          value={settings.model}
          placeholder="e.g. gpt-4o-mini, claude-sonnet-4-5, llama3.1"
          onChange={(e) => void save({ model: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="api-key">
          API key for {providerLabel(provider)} —{' '}
          <span className="text-muted-foreground">{keyStatusLabel(status)}</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="api-key"
            type="password"
            value={keyDraft}
            placeholder="Stored in the OS keychain; never leaves this machine"
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <Button size="sm" onClick={() => void onSaveKey()} disabled={!keyDraft.trim()}>
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The key is encrypted with the OS keychain (safeStorage) and used only on this device for
          outbound AI calls. It is never sent to OpenClip.
        </p>
      </div>
    </div>
  )
}

export default SettingsPanel
