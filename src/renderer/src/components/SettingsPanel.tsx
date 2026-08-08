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

import { useEffect, useMemo, useState } from 'react'
import type { AIProvider } from '@shared/schema'
import type { WhisperModelSize } from '@shared/jobs'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  providerLabel,
  keyStatusLabel,
  PROVIDERS,
  providerOptions,
  filterModels,
  partitionRecommended,
  formatModelPrice,
  LANGUAGES,
  languageLabel,
  resolveDefaultModel
} from '@renderer/components/settingsView'
import { BrandKitEditor } from '@renderer/components/BrandKitEditor'
import { TranscriptionSettings } from '@renderer/components/TranscriptionSettings'
import type { ModelInfo } from '@shared/channels'

/** Sentinel: the emoji-provider option meaning "same as clip detection". */
const SAME_AS_CLIP = '__same__'

/** Radix Select forbids an empty-string item value, so Auto-detect uses this
 * sentinel in the picker and maps to `Settings.language = undefined` on save. */
const AUTO_LANG = 'auto'

/** A labelled group of model rows in the OpenRouter picker (Part H). */
function ModelGroup(props: {
  label: string
  models: ModelInfo[]
  selected: string
  onPick: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      {props.models.map((m) => (
        <button
          key={m.id}
          type="button"
          data-testid="model-option"
          onClick={() => props.onPick(m.id)}
          className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent ${
            m.id === props.selected ? 'bg-accent' : ''
          }`}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm">{m.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{m.id}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatModelPrice(m)}</span>
        </button>
      ))}
    </div>
  )
}

export interface SettingsPanelProps {
  /** Open the model-download dialog pre-selected on a size (wired by App). */
  onDownloadModel?: (model: WhisperModelSize) => void
  /** Re-probe readiness after the installed model set changes. */
  onModelsChanged?: () => void
}

export function SettingsPanel({
  onDownloadModel,
  onModelsChanged
}: SettingsPanelProps = {}): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const keyStatus = useSettingsStore((s) => s.keyStatus)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const refreshKeyStatus = useSettingsStore((s) => s.refreshKeyStatus)
  const models = useSettingsStore((s) => s.models)
  const modelsLoading = useSettingsStore((s) => s.modelsLoading)
  const modelsError = useSettingsStore((s) => s.modelsError)
  const modelsFetchedAt = useSettingsStore((s) => s.modelsFetchedAt)
  const loadModels = useSettingsStore((s) => s.loadModels)

  // Local-only key entry; cleared after submit (never persisted in renderer).
  const [keyDraft, setKeyDraft] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  // "Test connection" — one cheap real round-trip so a bad key or model id is
  // caught HERE rather than after a full transcription (FEAT-6v92dk).
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Part K — separate key entry for the (optional) independent emoji provider.
  const [emojiKeyDraft, setEmojiKeyDraft] = useState('')

  // The free-text MODEL id fields (clip model + optional emoji model) keep a LOCAL
  // draft and persist on blur/Enter instead of an async `settings.set` IPC + disk
  // write per keystroke (audit fix openclip-i68): typing a model id like
  // 'anthropic/claude-sonnet-4.5' fired ~25 round-trips and the controlled value
  // depending on each round-trip could drop/reorder characters. Each draft re-syncs
  // when the stored value changes externally (e.g. the OpenRouter model picker). The
  // language ISO field stays immediate — it's 2-3 chars and its display couples to
  // the curated-list Select.
  const [modelDraft, setModelDraft] = useState(settings.model)
  const [prevModel, setPrevModel] = useState(settings.model)
  const [emojiModelDraft, setEmojiModelDraft] = useState(settings.emojiModel ?? '')
  const [prevEmojiModel, setPrevEmojiModel] = useState(settings.emojiModel)
  // React's "adjust state during render when a prop/store value changes" pattern (no
  // effect) re-syncs each draft when the stored value changes externally — e.g. the
  // OpenRouter model picker calling save({model}).
  if (settings.model !== prevModel) {
    setPrevModel(settings.model)
    setModelDraft(settings.model)
  }
  if (settings.emojiModel !== prevEmojiModel) {
    setPrevEmojiModel(settings.emojiModel)
    setEmojiModelDraft(settings.emojiModel ?? '')
  }

  useEffect(() => {
    void load()
  }, [load])

  const provider = settings.aiProvider
  const status = keyStatus[provider]

  // Transcription language (Part I): the Select shows the curated list (Auto-detect
  // via the AUTO_LANG sentinel); a custom ISO code lives in the free-text field
  // below and is reflected when the stored code isn't one of the listed options.
  const langIsListed = LANGUAGES.some((l) => l.code === settings.language)
  const langSelectValue = settings.language && langIsListed ? settings.language : AUTO_LANG

  // Auto-load the OpenRouter model list once per provider selection. Gate on
  // modelsFetchedAt (a positive "attempted" signal reset to null on provider
  // change) — NOT models.length, which would re-fire forever if a fetch
  // legitimately returns zero models (review H: infinite-refetch loop).
  useEffect(() => {
    // Every offered provider has a catalogue now (FEAT-6v92dk), so the picker
    // loads for all of them rather than only OpenRouter. But do NOT auto-fetch
    // before a key exists: the handler rejects without one, and the first thing a
    // brand-new user would see in Settings is a raw IPC error string. They can
    // still press "Load models" explicitly.
    const keyed = provider === 'ollama' || (status?.hasKey ?? false)
    if (keyed && modelsFetchedAt === null && !modelsLoading && !modelsError) {
      void loadModels(false)
    }
  }, [provider, status?.hasKey, modelsFetchedAt, modelsLoading, modelsError, loadModels])

  // Never leave the model field empty (FEAT-6v92dk): as soon as we know what the
  // provider offers, seed it. Only fills a BLANK field — it never overwrites a
  // choice the user made.
  useEffect(() => {
    if (settings.model.trim()) return
    const next = resolveDefaultModel(provider, models)
    if (next) void save({ model: next })
  }, [provider, models, settings.model, save])

  // Memoized so typing in the filter doesn't re-walk the full catalog + re-mount
  // unchanged rows each render.
  const { recommended, others } = useMemo(() => {
    return partitionRecommended(filterModels(models, modelQuery))
  }, [models, modelQuery])

  const onProviderChange = async (value: string): Promise<void> => {
    const p = value as AIProvider
    setTestResult(null)
    // Clear the model too: an id from the previous provider (e.g. `gpt-5` after
    // switching to Anthropic) is a guaranteed 404 on the next generate. The seed
    // effect refills it once the new provider's catalogue arrives.
    await save({ aiProvider: p, model: '' })
    await refreshKeyStatus(p)
  }

  const onTestConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.openclip.ai.testConnection({ provider, model: modelDraft.trim() })
      setTestResult({ ok: res.ok, message: res.message })
    } catch (e) {
      // The handler is designed never to throw, so this is a bridge-level fault.
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const onSaveKey = async (): Promise<void> => {
    if (!keyDraft.trim()) return
    await setApiKey(provider, keyDraft.trim())
    setKeyDraft('') // never keep the raw key around in the renderer
    // A new key may unlock more models / personalized pricing — refresh the list.
    // A new key may unlock the catalogue (and, on OpenRouter, personalised
    // pricing) — refresh for every provider, not just OpenRouter.
    void loadModels(true)
  }

  // Part K — the (optional) independent emoji AI provider. Falls back to the clip
  // provider when unset; its key lives in the same per-provider keyVault.
  const emojiProvider = settings.emojiProvider ?? provider
  const emojiStatus = keyStatus[emojiProvider]
  const onEmojiProviderChange = async (value: string): Promise<void> => {
    const p = value === SAME_AS_CLIP ? undefined : (value as AIProvider)
    await save({ emojiProvider: p })
    if (p) await refreshKeyStatus(p)
  }
  const onSaveEmojiKey = async (): Promise<void> => {
    if (!emojiKeyDraft.trim()) return
    await setApiKey(emojiProvider, emojiKeyDraft.trim())
    setEmojiKeyDraft('')
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
            {providerOptions().map(({ provider: p, disabled }) => (
              <SelectItem key={p} value={p} disabled={disabled}>
                {providerLabel(p)}
                {disabled ? ' — not available yet' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="ai-model">Model</Label>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="load-models"
              onClick={() => void loadModels(true)}
              disabled={modelsLoading}
            >
              {modelsLoading ? 'Loading…' : 'Load models'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="test-connection"
              onClick={() => void onTestConnection()}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test'}
            </Button>
          </div>
        </div>
        {/* Free-text id is always available — the escape hatch for any model id. */}
        <Input
          id="ai-model"
          value={modelDraft}
          placeholder="Pick one below, or type a model id"
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => {
            if (modelDraft !== settings.model) void save({ model: modelDraft })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />

        {testResult && (
          <span
            data-testid="test-connection-result"
            className={testResult.ok ? 'text-xs text-emerald-500' : 'text-xs text-destructive'}
          >
            {testResult.message}
          </span>
        )}

        <div className="mt-1 flex flex-col gap-1.5" data-testid="model-picker">
          <Input
            aria-label="Filter models"
            placeholder="Filter models…"
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
          />
          {modelsError && (
            <span className="text-xs text-destructive" data-testid="models-error">
              {modelsError} — you can still type a model id above.
            </span>
          )}
          <ScrollArea className="h-56 rounded-md border">
            {modelsLoading && models.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">Loading models…</div>
            ) : recommended.length === 0 && others.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">
                {models.length === 0
                  ? `No models loaded — add your ${providerLabel(provider)} key, then press Load models.`
                  : 'No models match your filter.'}
              </div>
            ) : (
              <div className="flex flex-col py-1">
                {recommended.length > 0 && (
                  <ModelGroup
                    label="Recommended"
                    models={recommended}
                    selected={settings.model}
                    onPick={(id) => void save({ model: id })}
                  />
                )}
                {others.length > 0 && (
                  <ModelGroup
                    label={recommended.length > 0 ? 'More models' : 'Models'}
                    models={others}
                    selected={settings.model}
                    onPick={(id) => void save({ model: id })}
                  />
                )}
              </div>
            )}
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            Clip detection needs a model that supports strict JSON output. Not every listed model
            does — press Test to check one before relying on it. You can also type a model id that
            isn’t listed.
          </p>
        </div>
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

      {/* Emoji AI (Part K) — an OPTIONAL independent provider/model/key for the
          auto-emoji "AI" mode. Defaults to the clip-detection provider/model. */}
      <div className="flex flex-col gap-1.5 border-t pt-3" data-testid="emoji-ai-settings">
        <Label htmlFor="emoji-provider">Emoji AI (optional)</Label>
        <p className="text-xs text-muted-foreground">
          The model that suggests emoji when a caption’s emoji mode is “AI”. Defaults to your
          clip-detection provider &amp; model — set a separate one (e.g. a cheaper model, or a local
          Ollama) here.
        </p>
        <Select
          value={settings.emojiProvider ?? SAME_AS_CLIP}
          onValueChange={(v) => void onEmojiProviderChange(v)}
        >
          <SelectTrigger id="emoji-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAME_AS_CLIP}>
              Same as clip detection ({providerLabel(provider)})
            </SelectItem>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {settings.emojiProvider && (
          <>
            <Input
              aria-label="Emoji model"
              value={emojiModelDraft}
              placeholder={`e.g. ${settings.model || 'a fast cheap model'} — blank = clip model`}
              onChange={(e) => setEmojiModelDraft(e.target.value)}
              onBlur={() => {
                const next = emojiModelDraft || undefined
                if (next !== settings.emojiModel) void save({ emojiModel: next })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <Label htmlFor="emoji-api-key">
              API key for {providerLabel(emojiProvider)} —{' '}
              <span className="text-muted-foreground">{keyStatusLabel(emojiStatus)}</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="emoji-api-key"
                type="password"
                value={emojiKeyDraft}
                placeholder="Stored in the OS keychain; never leaves this machine"
                onChange={(e) => setEmojiKeyDraft(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => void onSaveEmojiKey()}
                disabled={!emojiKeyDraft.trim()}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Brand kit (Part K) — logo + brand colors/font applied to exports. */}
      <BrandKitEditor />

      <TranscriptionSettings
        active={settings.whisperModel}
        onSelect={(m) => void save({ whisperModel: m })}
        onDownload={(m) => onDownloadModel?.(m)}
        onChanged={onModelsChanged}
      />

      <div className="flex flex-col gap-1.5" data-testid="language-picker">
        <Label htmlFor="transcribe-language">Transcription language</Label>
        <Select
          value={langSelectValue}
          onValueChange={(v) => void save({ language: v === AUTO_LANG ? undefined : v })}
        >
          <SelectTrigger id="transcribe-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.code || AUTO_LANG} value={l.code || AUTO_LANG}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Custom language ISO code"
          placeholder="Or a custom ISO-639-1 code, e.g. sw, fa, bn"
          value={langIsListed ? '' : (settings.language ?? '')}
          onChange={(e) => void save({ language: e.target.value.trim() || undefined })}
        />
        <p className="text-xs text-muted-foreground">
          Transcribing in: <span className="font-medium">{languageLabel(settings.language)}</span>.
          Auto-detect lets whisper guess the language; set it explicitly if detection picks the
          wrong language (e.g. an Indonesian video transcribed as English).
        </p>
      </div>
    </div>
  )
}

export default SettingsPanel
