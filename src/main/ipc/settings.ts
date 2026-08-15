/**
 * src/main/ipc/settings.ts — settings + API-key-status handlers (T-AI, plan E.3,
 * settings folded in).
 *
 * Wires GET_SETTINGS / SET_SETTINGS / GET_API_KEY_STATUS / SET_API_KEY.
 * SET_API_KEY persists via `ctx.keyVault` and returns ONLY {provider,hasKey,
 * last4} — the raw key NEVER crosses IPC (PRD §12.2 / plan Part B). The settings
 * document itself (provider/model/whisper/etc.) is the app-global `Settings`
 * (PRD §11.2); it is persisted as a tiny JSON file under userData, kept here so
 * the renderer's settingsStore has a single backing channel.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPCChannels } from '@shared/channels'
import { Settings, type Settings as SettingsType } from '@shared/schema'
import { endpointFingerprint } from '@shared/endpoint-url'
import { customKeyMatchesEndpoint } from '@shared/ai-providers'
import type { IpcContext } from './index'

const DEFAULT_SETTINGS: SettingsType = {
  aiProvider: 'openai',
  model: '',
  baseUrl: undefined,
  whisperModel: 'base',
  language: undefined,
  aspectRatio: '9:16',
  maxClips: 5,
  minDuration: 15,
  maxDuration: 90,
  forceCpu: false,
  telemetryOptIn: false
}

/** Resolve the settings file path lazily (Electron app may be mocked in tests). */
function settingsPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as { app: { getPath(name: string): string } }
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Read the settings document, REPAIRING it rather than discarding it (BUG-yxvrwx).
 *
 * This used to be `safeParse(...) ? data : DEFAULT_SETTINGS` — one bad field and
 * every setting silently reverted. The user's next generate then ran against the
 * wrong provider and model and failed with an error pointing nowhere near the
 * cause, with no toast and no log to connect the two. The realistic trigger is
 * not a bad UI value (every reachable patch is enum- or string-constrained) but a
 * truncated file from a crash mid-write, and — more likely over time — a newly
 * REQUIRED field added to the schema, which would reset settings for every
 * existing user on upgrade. The unknown-key direction was already hardened by
 * making the persistence schemas `looseObject`; this is the other direction.
 *
 * So: keep every key that still validates on its own, fall back to the default
 * only for the ones that don't, and say out loud which were dropped.
 */
export function readSettings(path: string): SettingsType {
  if (!existsSync(path)) return DEFAULT_SETTINGS
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.warn(
      `[settings] ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); ` +
        `falling back to defaults. A crash or full disk during a write can truncate it.`
    )
    return DEFAULT_SETTINGS
  }
  const parsed = Settings.safeParse(raw)
  if (parsed.success) return parsed.data

  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS
  const repaired: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  const dropped: string[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = (Settings.shape as Record<string, { safeParse(v: unknown) } | undefined>)[key]
    // Unknown keys are preserved as-is: `Settings` is a looseObject precisely so
    // a document written by a NEWER version survives a round-trip through an
    // older one instead of being stripped.
    if (!field) {
      repaired[key] = value
      continue
    }
    if (field.safeParse(value).success) repaired[key] = value
    else dropped.push(key)
  }
  const revalidated = Settings.safeParse(repaired)
  if (!revalidated.success) {
    console.warn(`[settings] ${path} could not be repaired; falling back to defaults.`)
    return DEFAULT_SETTINGS
  }
  console.warn(
    `[settings] ${path} had invalid field(s) [${dropped.join(', ')}]; reset those to defaults and ` +
      `kept the rest. Your other settings were preserved.`
  )
  return revalidated.data
}

/**
 * Write ATOMICALLY (BUG-yxvrwx). A bare `writeFileSync` truncates the live file
 * first, so a crash, power loss or full disk mid-write leaves half a document —
 * which is exactly the corruption the repair path above then has to cope with.
 * tmp+rename means a reader either sees the whole old file or the whole new one.
 */
export function writeSettings(path: string, settings: SettingsType): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, path)
}

/**
 * Read → merge → VALIDATE → write, as one pure-given-a-path step.
 *
 * Extracted from the handler so it is testable: `settingsPath()` lazily
 * `require`s electron, which `vi.mock('electron')` cannot intercept (the same
 * constraint media-protocol.spec.ts documents). Keeping the logic here and the
 * handler a one-liner follows the codebase's pure-core/thin-shell split.
 */
export function updateSettings(path: string, patch: Partial<SettingsType>): SettingsType {
  const current = readSettings(path)
  // VALIDATE BEFORE WRITING (BUG-yxvrwx). The merged object went to disk
  // unchecked, so a malformed patch persisted a document that then failed to
  // parse on the next read — and the old read path answered that by discarding
  // every setting. Rejecting here keeps the file valid by construction, and the
  // caller gets a real error instead of silent damage.
  const parsed = Settings.safeParse({ ...current, ...patch })
  if (!parsed.success) {
    throw new Error(`INPUT_INVALID settings: ${parsed.error.message}`)
  }
  writeSettings(path, parsed.data)
  return parsed.data
}

/**
 * The live Settings document — the accessor the trunk injects as
 * `IpcContext.getSettings` (FEAT-bysdwg).
 *
 * Lives here because `settingsPath()` is this module's business, and reading it
 * from `ipc/ai.ts` would be one domain module reaching into another (E.4).
 */
export function readCurrentSettings(): SettingsType {
  return readSettings(settingsPath())
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(IPCChannels.GET_SETTINGS, async () => {
    return readSettings(settingsPath())
  })

  ctx.ipcMain.handle(
    IPCChannels.SET_SETTINGS,
    async (_e, req: { settings: Partial<SettingsType> }) => {
      return updateSettings(settingsPath(), req.settings)
    }
  )

  // The raw key NEVER crosses IPC — only the {provider,hasKey,last4} status.
  ctx.ipcMain.handle(
    IPCChannels.GET_API_KEY_STATUS,
    async (_e, req: { provider: SettingsType['aiProvider'] }) => {
      const status = ctx.keyVault.status(req.provider)
      // Report a key bound to a DIFFERENT endpoint as absent, or readiness goes
      // green over a key that will never be used (FEAT-bysdwg).
      if (
        req.provider === 'custom' &&
        status.hasKey &&
        !customKeyMatchesEndpoint(readCurrentSettings())
      ) {
        return { provider: req.provider, hasKey: false }
      }
      return status
    }
  )

  ctx.ipcMain.handle(
    IPCChannels.SET_API_KEY,
    async (_e, req: { provider: SettingsType['aiProvider']; key: string }) => {
      // setKey persists the encrypted key and returns the renderer-safe status.
      const status = ctx.keyVault.setKey(req.provider, req.key)
      // Bind the custom key to the endpoint it was entered for, in the same
      // operation — a key and the URL it belongs to are one fact.
      if (req.provider === 'custom') {
        const path = settingsPath()
        updateSettings(path, {
          customKeyEndpoint: endpointFingerprint(readSettings(path).baseUrl)
        })
      }
      return status
    }
  )
}
