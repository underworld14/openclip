/**
 * src/main/utils/security.ts — API-key storage via Electron `safeStorage`.
 *
 * TRUNK INFRA, frozen after Stage 3 and HOISTED here (plan E.2 fix m8) so the
 * AI track can start before a Settings track exists. Owner: trunk.
 *
 * HARD INVARIANT (PRD §12.2 / plan Part B): the raw key value NEVER crosses
 * IPC. The renderer only ever receives `ApiKeyStatus = {provider, hasKey,
 * last4}`. Keys are encrypted at rest with the OS keychain (`safeStorage`) and
 * decrypted lazily in main only, at the point of an outbound provider call.
 *
 * Persistence is gated on `safeStorage.isEncryptionAvailable()` (plan Part B):
 * if the OS keychain is unavailable we refuse to persist rather than store
 * plaintext.
 *
 * The on-disk store is a tiny JSON map `{ [provider]: base64(cipher) }` under
 * `userData/secrets.json`. We keep it self-contained (no settings coupling).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { App, SafeStorage } from 'electron'
import type { AIProvider } from '@shared/schema'
import type { ApiKeyStatus } from '@shared/channels'

/**
 * The thin slice of Electron's `safeStorage` we depend on. Declared as an
 * interface so unit tests can inject a fake (PRD §18 "mock safeStorage")
 * without importing the Electron runtime.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

/** Pluggable backing store so tests can use an in-memory map. */
export interface SecretStoreBackend {
  read(): Record<string, string>
  write(map: Record<string, string>): void
}

/** Default backend: a JSON file under userData (resolved lazily). */
function fileBackend(filePath: string): SecretStoreBackend {
  return {
    read(): Record<string, string> {
      if (!existsSync(filePath)) return {}
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>
      } catch {
        return {}
      }
    },
    write(map: Record<string, string>): void {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf8')
    }
  }
}

/**
 * The key vault. Construct with `createKeyVault()` in main; tests construct it
 * directly with a fake `SafeStorageLike` + in-memory backend.
 */
export class KeyVault {
  constructor(
    private readonly safe: SafeStorageLike,
    private readonly backend: SecretStoreBackend
  ) {}

  /** Whether the OS keychain is usable; persistence is refused otherwise. */
  available(): boolean {
    return this.safe.isEncryptionAvailable()
  }

  /**
   * Persist (encrypted) a provider key. Returns the status shape (never the
   * key). Throws if encryption is unavailable — caller surfaces a typed error.
   */
  setKey(provider: AIProvider, key: string): ApiKeyStatus {
    if (!this.available()) {
      throw new Error('safeStorage encryption unavailable; refusing to store key in plaintext')
    }
    const map = this.backend.read()
    map[provider] = this.safe.encryptString(key).toString('base64')
    this.backend.write(map)
    return this.status(provider)
  }

  /** Decrypt a key for an outbound provider call — MAIN-ONLY, never returned via IPC. */
  getKey(provider: AIProvider): string | null {
    const map = this.backend.read()
    const b64 = map[provider]
    if (!b64) return null
    if (!this.available()) return null
    return this.safe.decryptString(Buffer.from(b64, 'base64'))
  }

  /** Remove a stored key. */
  clearKey(provider: AIProvider): void {
    const map = this.backend.read()
    delete map[provider]
    this.backend.write(map)
  }

  /**
   * The renderer-safe status for a provider. Decrypts only to derive `last4`,
   * which is the only fragment ever exposed (plan Part B).
   */
  status(provider: AIProvider): ApiKeyStatus {
    const key = this.getKey(provider)
    if (!key) return { provider, hasKey: false }
    return { provider, hasKey: true, last4: key.slice(-4) }
  }
}

/** Factory used in the main process: real `safeStorage` + a JSON file backend. */
export function createKeyVault(): KeyVault {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as { app: App; safeStorage: SafeStorage }
  const filePath = join(electron.app.getPath('userData'), 'secrets.json')
  return new KeyVault(electron.safeStorage as SafeStorageLike, fileBackend(filePath))
}
