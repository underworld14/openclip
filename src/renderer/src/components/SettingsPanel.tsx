/**
 * SettingsPanel — API keys, model, language, hotkeys, storage (STUB; owned by
 * T-AI, E.3). PRD §11.2. The raw API key never leaves main (PRD §12.2); this
 * panel only ever sees `{provider,hasKey,last4}`. Trunk ships the seam only.
 */
export function SettingsPanel(): React.JSX.Element {
  return (
    <div data-testid="settings-panel" className="p-3 text-sm text-muted-foreground">
      Settings (API keys, model, language) — stub
    </div>
  )
}

export default SettingsPanel
