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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPCChannels } from '@shared/channels'
import { Settings, type Settings as SettingsType } from '@shared/schema'
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

function readSettings(path: string): SettingsType {
  if (!existsSync(path)) return DEFAULT_SETTINGS
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

function writeSettings(path: string, settings: SettingsType): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(IPCChannels.GET_SETTINGS, async () => {
    return readSettings(settingsPath())
  })

  ctx.ipcMain.handle(
    IPCChannels.SET_SETTINGS,
    async (_e, req: { settings: Partial<SettingsType> }) => {
      const path = settingsPath()
      const merged: SettingsType = { ...readSettings(path), ...req.settings }
      writeSettings(path, merged)
      return merged
    }
  )

  // The raw key NEVER crosses IPC — only the {provider,hasKey,last4} status.
  ctx.ipcMain.handle(
    IPCChannels.GET_API_KEY_STATUS,
    async (_e, req: { provider: SettingsType['aiProvider'] }) => {
      return ctx.keyVault.status(req.provider)
    }
  )

  ctx.ipcMain.handle(
    IPCChannels.SET_API_KEY,
    async (_e, req: { provider: SettingsType['aiProvider']; key: string }) => {
      // setKey persists the encrypted key and returns the renderer-safe status.
      return ctx.keyVault.setKey(req.provider, req.key)
    }
  )
}
