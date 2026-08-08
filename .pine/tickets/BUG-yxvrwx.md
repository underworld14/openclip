---
id: BUG-yxvrwx
title: Settings are written without Zod validation and a malformed file silently resets every setting
status: todo
priority: low
labels:
    - bug
    - settings
    - hardening
parent: EPIC-4sa5jb
created: "2026-08-08T15:57:27Z"
updated: "2026-08-08T15:57:27Z"
---

## Verdict

**PARTIAL** (high confidence) · severity **P3**

This finding was produced by a finder agent and then handed to an independent adversarial
verifier whose instructions were to *refute* it, defaulting to REFUTED when uncertain. It
survived. Four sibling claims in the same pass did not — see `.pine/MEMORY.md`.

## User impact

Today: none from a normal user's UI actions — every reachable patch value is enum- or string-constrained at its source, so the file on disk stays schema-valid and settings never reset. The reachable-in-practice residue is the corruption path: `writeFileSync` is non-atomic (no tmp+rename), so a crash, power loss, or full disk during the write leaves truncated JSON, and the very next launch silently comes back with provider=openai, model='' and language cleared — no toast, no log, no "couldn't read your settings" message. The user's next AI generate then quietly runs against the wrong provider/model (it will fail with a missing-key/model error that points nowhere near the real cause). A future required field added to the Settings schema would trigger the same total reset for every existing user on upgrade (the team already hardened the *unknown-key* direction in commit 94a2522 "looseObject persistence schemas so newer-version keys survive"; the missing-required-key direction is still unguarded).

## Evidence

MECHANISM: CONFIRMED, exactly as described.

/Users/izzadev/projects/openclip/src/main/ipc/settings.ts:40-53
```
function readSettings(path: string): SettingsType {
  if (!existsSync(path)) return DEFAULT_SETTINGS
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : DEFAULT_SETTINGS   // <- full-object fallback, no log, no error
  } catch {
    return DEFAULT_SETTINGS
  }
}
function writeSettings(path: string, settings: SettingsType): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')  // <- no safeParse, non-atomic
}
```
settings.ts:60-68
```
    async (_e, req: { settings: Partial<SettingsType> }) => {
      const path = settingsPath()
      const merged: SettingsType = { ...readSettings(path), ...req.settings }   // TS-only "type", trusted from renderer
      writeSettings(path, merged)
```

PROOF (ran the REAL handlers; temp spec at tests/unit/zzz-scratch-settings-reset.spec.ts, since deleted; electron's CJS `require('electron')` stubbed via Module._load so app.getPath -> a temp dir):
1. renderer-shaped writes -> `{"aiProvider":"anthropic","model":"claude-sonnet-4-5","language":"id",...}` on disk.
2. one out-of-contract patch `{ maxClips: NaN }` -> handler returns it happily and disk gets `"maxClips": null` (JSON.stringify(NaN)==="null").
3. next GET_SETTINGS -> `{"aiProvider":"openai","model":"","whisperModel":"base","aspectRatio":"9:16","maxClips":5,...}` — provider, model and language all gone. Total silent reset. Confirmed.
4. Also confirmed the same total reset from a truncated file (simulating crash/power-loss mid `writeFileSync`, which is not atomic — no tmp+rename): `TRUNCATED READ: {"aiProvider":"openai","model":"", ...}`.

REACHABILITY: REFUTED for the "normal user" framing. No renderer path can produce a schema-invalid value today. `SET_SETTINGS` is only ever called from settingsStore.save() (/Users/izzadev/projects/openclip/src/renderer/src/stores/settingsStore.ts:102), and the complete set of call sites is SettingsPanel.tsx lines 154, 172, 229, 265, 273, 346, 383, 400 — i.e. only five fields are writable at all:
- `aiProvider` / `emojiProvider`: values come from `PROVIDERS` in src/renderer/src/components/settingsView.ts:31 = `['openai','anthropic','google','ollama','openrouter']`, byte-identical to `AIProvider` in schema.ts:324.
- `model` / `emojiModel`: `z.string()` (any string passes; `emojiModel` is `|| undefined`).
- `language`: `e.target.value.trim() || undefined`, `z.string().optional()`.
There is NO UI for maxClips / minDuration / maxDuration / whisperModel / forceCpu / telemetryOptIn / aspectRatio / baseUrl (grep over src/renderer shows those names only in per-project `ProjectSettings` and export presets, never in a `save({...})`). So the "NaN from a number input" style trigger does not exist. Additionally `Settings` is `z.looseObject` (schema.ts:327), so unknown/extra keys cannot break the parse either.

BLAST RADIUS is also smaller than claimed: API keys are NOT in this file — KeyVault persists to `userData/secrets.json` (src/main/utils/security.ts:131), so a reset loses aiProvider/model/emojiProvider/emojiModel/language only, not key material.

## Fix

src/main/ipc/settings.ts, three small changes:
1. Validate on write: in the SET_SETTINGS handler, `const parsed = Settings.safeParse({ ...readSettings(path), ...req.settings })`; on failure throw a typed IPC error (or drop the offending keys) instead of persisting — never write an unvalidated object.
2. Repair instead of nuke on read: on `safeParse` failure, merge field-by-field — keep every key that individually validates against `Settings.shape[k]`, fall back to the default only for the keys that fail. Log the discarded keys via the app logger so it is not silent.
3. Make the write atomic: `writeFileSync(path + '.tmp', json)` then `renameSync(tmp, path)`, so a crash mid-write cannot truncate the live file.

## Regression test

New tests/unit/settings-ipc.spec.ts (stub `require('electron')`'s `app.getPath` to a tmpdir via Module._load, register the real `registerSettingsHandlers`):
- "a schema-invalid patch does not clobber good settings": set `{aiProvider:'anthropic', model:'claude-sonnet-4-5', language:'id'}`, then call SET_SETTINGS with `{maxClips: Number.NaN}`; expect the call to reject AND a subsequent GET_SETTINGS to still return aiProvider 'anthropic' / model 'claude-sonnet-4-5' / language 'id'. Fails today (GET returns the full DEFAULT_SETTINGS — verified).
- "a corrupt settings.json preserves the keys that still parse": write a good file, truncate it to 60 bytes (or hand-set `maxClips: null`), expect GET_SETTINGS to keep aiProvider/model where recoverable and to log a warning rather than returning defaults silently. Fails today.
