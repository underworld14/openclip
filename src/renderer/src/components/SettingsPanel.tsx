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
import {
  providerNeedsBaseUrl,
  providerRequiresKey,
  providerKeyUrl,
  providerCostHint
} from '@shared/ai-providers'
import { isInsecureHttpEndpoint, isSafeEndpointUrl, normalizeBaseUrl } from '@shared/endpoint-url'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
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
  resolveDefaultModel,
  encoderLabel
} from '@renderer/components/settingsView'
import { BrandKitEditor } from '@renderer/components/BrandKitEditor'
import { TranscriptionSettings } from '@renderer/components/TranscriptionSettings'
import type { EncoderBackend, ModelInfo } from '@shared/channels'

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
  /** A download started from a Transcription row (for a toast) — see BUG-45xt77. */
  onDownloadStarted?: (model: WhisperModelSize) => void
  /** Re-probe readiness after the installed model set changes. */
  onModelsChanged?: () => void
}

export function SettingsPanel({
  onDownloadStarted,
  onModelsChanged
}: SettingsPanelProps = {}): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  /** PRD §14 — the encoder backend the startup probe found (FEAT-5hnsby). */
  const [encoder, setEncoder] = useState<EncoderBackend | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void window.openclip.system
      .preflight()
      .then((r) => {
        if (alive) setEncoder(r.encoder)
      })
      .catch(() => {
        // Leave it undefined → "Checking…", rather than claiming a backend we
        // never observed (the same rule useReadiness follows for its chips).
      })
    return () => {
      alive = false
    }
  }, [])
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
  /** A patch main refused (e.g. a base URL that fails the schema) — never silent. */
  const saveError = useSettingsStore((s) => s.saveError)

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
  // The custom endpoint's Base URL follows the same draft/blur rule as the model
  // id, and for the same reason — it is long, and a URL mid-type is invalid
  // (`http:/`), so a per-keystroke save would be rejected on almost every one.
  const [baseUrlDraft, setBaseUrlDraft] = useState(settings.baseUrl ?? '')
  const [prevBaseUrl, setPrevBaseUrl] = useState(settings.baseUrl)
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
  if (settings.baseUrl !== prevBaseUrl) {
    setPrevBaseUrl(settings.baseUrl)
    setBaseUrlDraft(settings.baseUrl ?? '')
  }

  const normalizedDraft = normalizeBaseUrl(baseUrlDraft)
  const baseUrlInvalid = normalizedDraft !== undefined && !isSafeEndpointUrl(normalizedDraft)
  // Only complain about a URL the user has finished writing. A half-typed
  // `http:/` is invalid by definition, so validating per keystroke would show a
  // red error from the second character onwards and teach the user to ignore it.
  const [baseUrlTouched, setBaseUrlTouched] = useState(false)
  const commitBaseUrl = (): void => {
    setBaseUrlTouched(true)
    // Refuse to SEND an invalid value. `settings.set` rejects it main-side and
    // every caller here is `void save(...)`, so persisting-and-failing would look
    // exactly like persisting-and-succeeding (FEAT-bysdwg).
    if (baseUrlInvalid) return
    if (normalizedDraft !== settings.baseUrl) {
      setTestResult(null)
      void save({ baseUrl: normalizedDraft }).then(() => {
        // A saved key is bound to the endpoint it was entered for, so pointing at
        // a different server unbinds it MAIN-side. Re-read the status or the panel
        // keeps showing "Key set ••••1a2b" for a key that will not be sent.
        void refreshKeyStatus(settings.aiProvider)
      })
    }
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
    // A custom endpoint may need no key at all, but it always needs a URL — and
    // the handler rejects without one (FEAT-bysdwg).
    const keyed = !providerRequiresKey(provider) || (status?.hasKey ?? false)
    const addressed = !providerNeedsBaseUrl(provider) || !!normalizeBaseUrl(settings.baseUrl)
    if (keyed && addressed && modelsFetchedAt === null && !modelsLoading && !modelsError) {
      void loadModels(false)
    }
  }, [
    provider,
    status?.hasKey,
    settings.baseUrl,
    modelsFetchedAt,
    modelsLoading,
    modelsError,
    loadModels
  ])

  // Never leave the model field empty (FEAT-6v92dk): as soon as we know what the
  // provider offers, seed it. Only fills a BLANK field — it never overwrites a
  // choice the user made.
  //
  // "Blank" has to mean the DRAFT is blank, not just `settings.model`. The draft
  // only commits on blur (openclip-i68), so a user typing a model id by hand has
  // an empty `settings.model` for as long as the field is focused. Gating on the
  // stored value alone meant a slow `/models` response landing mid-word saved a
  // default, and the render-time re-sync above then replaced what they were
  // typing with it (FEAT-26tkya). Reading modelDraft here is safe precisely
  // because the re-sync keeps it equal to settings.model whenever it is untouched.
  useEffect(() => {
    if (settings.model.trim() || modelDraft.trim()) return
    const next = resolveDefaultModel(provider, models)
    if (next) void save({ model: next })
  }, [provider, models, settings.model, modelDraft, save])

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

      {/*
        Sectioned into tabs (FEAT-7ffxsg). This panel was one continuous stack —
        provider + model + a 224px model list + key + the whole emoji provider
        block + the full brand editor + the language picker — roughly 1300px of
        content in a dialog the app permits to be 600px tall. Bounding the dialog
        made that content reachable; splitting it into three shallow tabs makes it
        navigable, so finding the language picker no longer means scrolling past
        every AI control. `ui/tabs.tsx` was already in the tree with no importers.
      */}
      <Tabs defaultValue="ai">
        <TabsList className="w-full">
          <TabsTrigger value="ai" data-testid="settings-tab-ai">
            AI
          </TabsTrigger>
          <TabsTrigger value="transcription" data-testid="settings-tab-transcription">
            Transcription
          </TabsTrigger>
          <TabsTrigger value="video" data-testid="settings-tab-video">
            Video
          </TabsTrigger>
          <TabsTrigger value="brand" data-testid="settings-tab-brand">
            Brand
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="flex flex-col gap-4">
          {/* Plain-language explainer (EPIC-k83ghw / FEAT-rmgkee): the ONE hard
              prerequisite of the app used to be presented as a password box with
              no context — a creator who had never used an LLM API was told WHAT
              was missing and never WHY or HOW. */}
          <p className="text-xs text-muted-foreground">
            Clip detection reads your transcript with an AI model to find the best moments —{' '}
            <span className="font-medium text-foreground">only transcript text is ever sent</span>,
            never your video. You use your own account with the provider you pick below, so you pay
            them directly — OpenClip never bills you or sees your key. Prefer not to pay anyone?{' '}
            <span className="font-medium text-foreground">Ollama (local)</span> runs free, on this
            Mac, with no key at all.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-provider">AI Provider</Label>
            <Select value={provider} onValueChange={(v) => void onProviderChange(v)}>
              <SelectTrigger id="ai-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions().map(({ provider: p, disabled }) => (
                  <SelectItem key={p} value={p} disabled={disabled}>
                    {providerLabel(p)}
                    {p === 'ollama' ? ' — free, no key' : ''}
                    {disabled ? ' — not available yet' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {provider === 'ollama' && (
              <p
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-600"
                data-testid="ollama-free-badge"
              >
                Free · runs on this Mac · no key needed. Ollama is separate, free software — if you
                haven’t installed it yet,{' '}
                <a
                  href="https://ollama.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  get it at ollama.com ↗
                </a>
                .
              </p>
            )}
          </div>

          {providerNeedsBaseUrl(provider) && (
            <div className="flex flex-col gap-1.5" data-testid="custom-base-url">
              <Label htmlFor="ai-base-url">Base URL</Label>
              <Input
                id="ai-base-url"
                value={baseUrlDraft}
                placeholder="http://localhost:1234/v1"
                onChange={(e) => {
                  setBaseUrlTouched(false)
                  setBaseUrlDraft(e.target.value)
                }}
                onBlur={commitBaseUrl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              {baseUrlTouched && baseUrlInvalid && (
                <span className="text-xs text-destructive" data-testid="base-url-error">
                  Must be an http(s) URL with no credentials, query or fragment — e.g.
                  http://localhost:1234/v1
                </span>
              )}
              {saveError && (
                <span className="text-xs text-destructive" data-testid="settings-save-error">
                  {saveError}
                </span>
              )}
              {!baseUrlInvalid && isInsecureHttpEndpoint(normalizedDraft) && (
                <span className="text-xs text-amber-500" data-testid="base-url-insecure">
                  This endpoint is plain HTTP — your API key would be sent unencrypted. Fine on your
                  own machine or LAN, risky over the internet.
                </span>
              )}
              <p className="text-xs text-muted-foreground">
                Your server’s OpenAI-compatible root — usually ends in <code>/v1</code>. Works with
                LM Studio, vLLM, LiteLLM, Groq, Together, DeepSeek or a company gateway. Only
                transcript text is ever sent.
              </p>
            </div>
          )}

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
                    {models.length > 0
                      ? 'No models match your filter.'
                      : providerNeedsBaseUrl(provider) && !normalizeBaseUrl(settings.baseUrl)
                        ? 'Set a Base URL above, then press Load models.'
                        : providerRequiresKey(provider) && !status?.hasKey
                          ? `No models loaded — add your ${providerLabel(provider)} key, then press Load models.`
                          : 'No models returned — the server may not list them. You can still type a model id above.'}
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
                Clip detection needs a model that can reliably follow the exact result format it
                asks for. Not every listed model does — press Test to check one before relying on
                it. You can also type a model id that isn’t listed.
              </p>
            </div>
          </div>

          {provider !== 'ollama' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="api-key">
                  API key for {providerLabel(provider)}
                  {providerRequiresKey(provider) ? '' : ' (optional)'} —{' '}
                  <span className="text-muted-foreground">{keyStatusLabel(status)}</span>
                </Label>
                {/* "Get a key →" (FEAT-rmgkee) — the ticket's own evidence found
                    ZERO links to a provider's key page anywhere in the app. */}
                {providerKeyUrl(provider) && (
                  <a
                    href={providerKeyUrl(provider)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-2"
                    data-testid="get-a-key-link"
                  >
                    Get a key ↗
                  </a>
                )}
              </div>
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
                An API key is a password that identifies YOUR account to {providerLabel(provider)} —
                it is encrypted in your OS keychain and used only on this device for outbound AI
                calls. It is never sent to OpenClip.
                {providerNeedsBaseUrl(provider) &&
                  ' Leave it blank for a local server that needs no key — a saved key is only ever sent to the endpoint it was entered for.'}
              </p>
              {/* Rough cost hint (FEAT-rmgkee) — previously shown for NO provider
                  except OpenRouter, and only after Settings had already been
                  opened once that session. */}
              {providerCostHint(provider) && (
                <p className="text-xs text-muted-foreground" data-testid="provider-cost-hint">
                  {providerCostHint(provider)}
                </p>
              )}
            </div>
          )}

          {/* Emoji AI (Part K) — an OPTIONAL independent provider/model/key for the
          auto-emoji "AI" mode. Defaults to the clip-detection provider/model. */}
          <div className="flex flex-col gap-1.5 border-t pt-3" data-testid="emoji-ai-settings">
            <Label htmlFor="emoji-provider">Emoji AI (optional)</Label>
            <p className="text-xs text-muted-foreground">
              The model that suggests emoji when a caption’s emoji mode is “AI”. Defaults to your
              clip-detection provider &amp; model — set a separate one (e.g. a cheaper model, or a
              local Ollama) here.
              {providerNeedsBaseUrl(emojiProvider) &&
                ' The custom endpoint uses the same Base URL as above — OpenClip stores one at a time.'}
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
        </TabsContent>

        <TabsContent value="transcription" className="flex flex-col gap-4">
          <TranscriptionSettings
            active={settings.whisperModel}
            onSelect={(m) => void save({ whisperModel: m })}
            onDownloadStarted={onDownloadStarted}
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
              Transcribing in:{' '}
              <span className="font-medium">{languageLabel(settings.language)}</span>. Auto-detect
              lets whisper guess the language; set it explicitly if detection picks the wrong
              language (e.g. an Indonesian video transcribed as English).
            </p>
          </div>
        </TabsContent>

        <TabsContent value="video" className="flex flex-col gap-4">
          {/* PRD §14 — the encoder backend, reported and overridable (FEAT-5hnsby).
              Both halves existed and neither was reachable: the probe did not exist,
              and `forceCpu` was stored but never sent to the export job. */}
          <div className="flex flex-col gap-1.5" data-testid="encoder-settings">
            <Label>Video encoder</Label>
            <p className="text-xs text-muted-foreground" data-testid="encoder-backend">
              {encoderLabel(encoder, settings.forceCpu)}
            </p>
            <label className="flex items-center gap-2 text-xs" data-testid="force-cpu-toggle">
              <input
                type="checkbox"
                checked={settings.forceCpu}
                onChange={(e) => void save({ forceCpu: e.target.checked })}
              />
              <span>Force CPU encoding (libx264)</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Hardware encoding is much faster. Turn this on if exports fail with an encoder error —
              OpenClip also falls back to the CPU automatically when the hardware encoder cannot
              start.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="brand" className="flex flex-col gap-4">
          {/* Brand kit (Part K) — logo + brand colors/font applied to exports. */}
          <BrandKitEditor />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SettingsPanel
