/**
 * tests/unit/trunk-infra.spec.ts — unit coverage for the trunk-owned infra that
 * does NOT need an Electron runtime: the pure temp-path helpers (paths.ts), the
 * safeStorage KeyVault (security.ts, mocked safeStorage — PRD §18), and the
 * FFmpeg stderr→progress parser (ffmpeg-core.ts).
 */

import { describe, expect, it } from 'vitest'
import {
  openclipTempRoot,
  tempRootFor,
  jobTempDir,
  cacheDirFor,
  TEMP_NAMES,
  platArch
} from '@main/utils/paths'
import {
  KeyVault,
  fileBackend,
  type SafeStorageLike,
  type SecretStoreBackend
} from '@main/utils/security'
import { parseFfmpegProgress, progressPct } from '@main/services/ffmpeg-core'
import { writeSettings } from '@main/ipc/settings'
import { settingsFixture } from '../fixtures/contract'
import { mkdtempSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('paths: pure temp-file lifecycle helpers (PRD §17)', () => {
  const base = '/tmp'
  it('roots temp under <temp>/openclip/<projectId>/<jobId>', () => {
    expect(openclipTempRoot(base)).toBe('/tmp/openclip')
    expect(tempRootFor('proj', base)).toBe('/tmp/openclip/proj')
    expect(jobTempDir('proj', 'job', base)).toBe('/tmp/openclip/proj/job')
    expect(cacheDirFor('proj', base)).toBe('/tmp/openclip/proj/cache')
  })
  it('canonical scratch names', () => {
    expect(TEMP_NAMES.audioWav).toBe('audio.16k.wav')
    expect(TEMP_NAMES.cutMp4('c1')).toBe('clip-c1.cut.mp4')
    expect(TEMP_NAMES.captionsAss('c1')).toBe('clip-c1.captions.ass')
    expect(TEMP_NAMES.thumbJpg('c1')).toBe('thumb-c1.jpg')
  })
  it('platArch reflects the running platform', () => {
    expect(platArch()).toBe(`${process.platform}-${process.arch}`)
  })
})

// A fake safeStorage: reversible base64 "encryption" + an in-memory backend.
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (cipher) => cipher.toString().replace(/^enc:/, '')
  }
}
function memBackend(): SecretStoreBackend {
  let store: Record<string, string> = {}
  return {
    read: () => ({ ...store }),
    write: (m) => {
      store = { ...m }
    }
  }
}

describe('security: fileBackend writes secrets.json owner-only (audit fix openclip-g7f)', () => {
  it('creates the secrets file with mode 0o600 (no group/other read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-secrets-'))
    try {
      const path = join(dir, 'secrets.json')
      fileBackend(path).write({ openai: 'enc:abc' })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tightens an already-existing world-readable secrets file on the next write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-secrets-'))
    try {
      const path = join(dir, 'secrets.json')
      // Simulate a legacy file written before the fix (0o644, group/other readable).
      writeFileSync(path, '{}', 'utf8')
      chmodSync(path, 0o644)
      expect(statSync(path).mode & 0o777).toBe(0o644)
      fileBackend(path).write({ anthropic: 'enc:xyz' })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("settings: writeSettings mirrors fileBackend's owner-only mode (BUG-4tscfq)", () => {
  it('creates settings.json with mode 0o600 (no group/other read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-settings-'))
    try {
      const path = join(dir, 'settings.json')
      writeSettings(path, settingsFixture)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tightens an already-existing world-readable settings file on the next write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-settings-'))
    try {
      const path = join(dir, 'settings.json')
      // Simulate a legacy file written before the fix (0o644, group/other readable).
      writeFileSync(path, '{}', 'utf8')
      chmodSync(path, 0o644)
      expect(statSync(path).mode & 0o777).toBe(0o644)
      writeSettings(path, settingsFixture)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('security: KeyVault (raw key never crosses IPC — PRD §12.2)', () => {
  it('persists encrypted, exposes only {provider,hasKey,last4}', () => {
    const vault = new KeyVault(fakeSafe(), memBackend())
    const status = vault.setKey('openai', 'sk-test-1234ABCD')
    expect(status).toEqual({ provider: 'openai', hasKey: true, last4: 'ABCD' })
    // status object never contains the raw key
    expect(JSON.stringify(status)).not.toContain('sk-test')
  })

  it('decrypts main-side for outbound calls', () => {
    const vault = new KeyVault(fakeSafe(), memBackend())
    vault.setKey('anthropic', 'my-secret-key')
    expect(vault.getKey('anthropic')).toBe('my-secret-key')
  })

  it('reports hasKey:false for an unset provider', () => {
    const vault = new KeyVault(fakeSafe(), memBackend())
    expect(vault.status('google')).toEqual({ provider: 'google', hasKey: false })
  })

  it('refuses to persist when encryption is unavailable (no plaintext)', () => {
    const vault = new KeyVault(fakeSafe(false), memBackend())
    expect(() => vault.setKey('openai', 'x')).toThrow(/unavailable/)
  })

  it('clearKey removes the secret', () => {
    const vault = new KeyVault(fakeSafe(), memBackend())
    vault.setKey('ollama', 'k')
    vault.clearKey('ollama')
    expect(vault.status('ollama').hasKey).toBe(false)
  })
})

describe('ffmpeg-core: stderr→progress parser', () => {
  it('parses out_time_us + frame + speed and end', () => {
    const snap = parseFfmpegProgress(
      ['frame=120', 'out_time_us=2000000', 'speed=1.5x', 'progress=continue'].join('\n')
    )
    expect(snap.frame).toBe(120)
    expect(snap.outTimeUs).toBe(2_000_000)
    expect(snap.speed).toBe(1.5)
    expect(snap.done).toBe(false)
  })

  it('flags done on progress=end', () => {
    expect(parseFfmpegProgress('progress=end').done).toBe(true)
  })

  it('progressPct converts out_time vs total duration, clamped', () => {
    expect(progressPct({ outTimeUs: 2_000_000, done: false }, 4)).toBe(50)
    expect(progressPct({ outTimeUs: 10_000_000, done: false }, 4)).toBe(100) // clamp
    expect(progressPct({ done: true }, 4)).toBe(100)
    expect(progressPct({ done: false }, 4)).toBeUndefined() // no time yet
  })

  it('tolerates split chunks / unknown keys', () => {
    const snap = parseFfmpegProgress('bitrate=N/A\nfoo=bar\nout_time_ms=500000\n')
    expect(snap.outTimeUs).toBe(500_000) // out_time_ms is microseconds (FFmpeg quirk)
  })
})
