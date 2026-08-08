---
id: BUG-e06a9d
title: JOB_START projectId is unvalidated as a path segment (defense-in-depth)
status: todo
priority: low
labels:
    - security
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

No impact on a normal user: the projectId is always a locally-generated UUID, so the escaped branch is never taken in practice, and even when forced it cannot delete pre-existing files (the rm leaf is always a fresh `export-<ts>-<n>` jobId). A compromised renderer could use it to create empty directories and write `*.captions.ass` files anywhere the app user can write (e.g. dropping a file into ~/Library/LaunchAgents-adjacent paths is blocked by the mandatory `.captions.ass` suffix). No data loss, no crash, no degraded flow.

## Evidence

WHAT IS TRUE (confirmed):

1. The validation asymmetry is exactly as claimed.
`src/main/ipc/job-start-validation.ts:23-41`:
```
const nonEmpty = z.string().min(1)
...
  export: z.looseObject({
    projectId: nonEmpty,
    clipId: nonEmpty,
```
vs `src/main/services/media-store.ts:28-33`:
```
export function assertSafeProjectId(projectId: string): string {
  if (!projectId || /[\\/]/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new MediaStoreError('INVALID', `unsafe project id: ${JSON.stringify(projectId)}`)
```
`grep -rn "assertSafeProjectId" src` returns hits ONLY in media-store.ts. The JOB_START path (`src/main/index.ts:218-222` -> `validateJobStart`) never calls it. `src/main/ipc/audio.ts:35` also passes an unvalidated `projectId` into `cacheDirFor`.

2. Path construction really does escape the temp root. `src/main/utils/paths.ts:302-315` is a bare `join`, no normalization guard:
```
export function tempRootFor(projectId, baseTemp) { return join(openclipTempRoot(baseTemp), projectId) }
export function jobTempDir(projectId, jobId, baseTemp) { return join(tempRootFor(projectId, baseTemp), jobId) }
```
I ran a throwaway vitest spec calling the REAL exported functions (deleted afterward). Output:
```
TEMP ROOT      : /var/folders/3b/.../T/oc-scratch-base/openclip
"p1"                 | jobTempDir= .../oc-scratch-base/openclip/p1/export-mfoo-1   | escapes= false
"../../../../victim" | jobTempDir= /var/folders/3b/victim/export-mfoo-1             | escapes= true
"../../.."           | jobTempDir= /var/folders/3b/99qpl0gd3vqc.../export-mfoo-1    | escapes= true
".."                 | jobTempDir= .../T/oc-scratch-base/export-mfoo-1              | escapes= true
"a/../../b"          | jobTempDir= .../T/oc-scratch-base/b/export-mfoo-1            | escapes= true
"/etc"               | jobTempDir= .../oc-scratch-base/openclip/etc/export-mfoo-1   | escapes= false  (join swallows the leading /)
```

WHAT IS FALSE (the claimed consequence — a destructive recursive delete):

3. The rm target's LAST segment is always a main-process-generated jobId, never attacker-controlled. `export-runner.ts:112-118`:
```
function defaultRemoveJobTemp(projectId: string, jobId: string): void {
  try { rmSync(jobTempDir(projectId, jobId), { recursive: true, force: true }) } catch {}
```
and `sidecar-manager.ts:233-236`:
```
private nextJobId(kind: JobKind): string {
  this.seq += 1
  return `${kind}-${Date.now().toString(36)}-${this.seq}`
}
```
So a traversal projectId produces `rm -rf <escaped-dir>/export-<base36-timestamp>-<seq>`. It cannot name `Documents`, `Desktop`, a project dir, or the sibling `cache/`. With `force: true`, a non-existent leaf is a silent no-op.

4. Demonstrated on disk in a sandbox (nothing outside it touched). Same spec, second test — `victim/` sits outside the fake temp root, containing a real data dir and a decoy dir named exactly like the jobId:
```
rm target      : .../oc-scratch-sandbox/victim/export-mfoo-1
victim/Important survives   : true      <-- pre-existing user data untouched
victim/<jobId> survives     : false     <-- only a dir literally named export-mfoo-1 dies
nonexistent leaf rm threw?  : no (force:true)
```
The only way the delete removes anything is if the app itself just created that dir — which it does when captions are on: `ffmpeg-caption.ts:69` `mkdirSync(dirname(opts.assPath), { recursive: true })` with `assPath = jobTempDir(...)+'/'+TEMP_NAMES.captionsAss(clipId)` (`export-runner.ts:132-135`). Proven:
```
ass written at : .../oc-scratch-sandbox/victim/export-cap-2/clip-c1.captions.ass true
```
i.e. the real primitive is arbitrary mkdir -p + write of a `*.captions.ass` file outside the temp tree (the created parent dirs survive the rm of the leaf), NOT deletion of existing data. `clipId` is likewise unvalidated and gives a second, filename-suffix-constrained write escape:
```
traversal clipId ass path -> .../openclip/victim/pwn.captions.ass
```

REACHABILITY (honest threat model): not reachable by any normal user flow. `projectId` is `crypto.randomUUID()` generated in the renderer (`src/renderer/src/hooks/useProject.ts:81`, `hooks/import-controller.ts:140`). Reaching this requires arbitrary renderer JS execution — the renderer runs `contextIsolation: true, sandbox: true, nodeIntegration: false` with a strict CSP, and I found zero `dangerouslySetInnerHTML` in `src/renderer`, so there is no in-app injection sink for whisper/LLM text. The other theoretical source is a hand-crafted `.ocproj` (`Project.id` is bare `z.string()` at `src/shared/schema.ts:307`, and `listProjects` reads `json.id` from file content) — but `loadProject` resolves `join(dir, id + '.ocproj')`, so a traversal id fails NOT_FOUND before any job starts, and placing such a file already requires local FS write. Anyone with either capability already has more power than this bug grants.

## Fix

Defense-in-depth, cheap and worth doing since a sibling module already has the helper:
1. `src/main/ipc/job-start-validation.ts`: replace `nonEmpty` for id fields with a segment-safe schema, e.g. `const idSeg = z.string().min(1).refine((s) => !/[\\/]/.test(s) && s !== '.' && s !== '..', 'must be a single path segment')`, and use it for `transcribe.projectId`, `export.projectId` and `export.clipId`. Update the header comment's "SECURITY-SENSITIVE params" list.
2. Apply the same guard to `src/main/ipc/audio.ts:35` (`projectId` -> `cacheDirFor`), or better, hoist `assertSafeProjectId` out of `media-store.ts` into a shared util (e.g. `@main/utils/safe-id.ts`) and call it from `tempRootFor`/`jobTempDir` in `src/main/utils/paths.ts` so every consumer is covered structurally. Note `paths.ts` is FROZEN trunk infra — throwing from it is a contract change; the validation-layer fix (1)+(2) is the lower-risk option.
3. Optional: tighten `Project.id` in `src/shared/schema.ts:307` to a UUID/segment-safe regex (breaking for any existing non-UUID ids, so gate on a load-migration).

## Regression test

Add to `tests/unit/job-start-validation.spec.ts` (today only exercises `projectId: 'p1'`):

```ts
it.each(['../evil', '..', '.', 'a/b', 'a\\b'])('rejects traversal projectId %s', (pid) => {
  expect(() => validateJobStart({ kind: 'export', params: {
    projectId: pid, clipId: 'c1', sourcePath: '/a.mp4', outputPath: '/o.mp4',
    startTime: 0, endTime: 1, aspectRatio: '9:16'
  }})).toThrow(/INPUT_INVALID/)
})
it('rejects traversal clipId', () => { /* same, clipId: '../../pwn' */ })
```
Plus a path-shape assertion that survives refactors, in `tests/unit/paths.spec.ts`:
```ts
const root = openclipTempRoot('/base')
expect(resolve(jobTempDir('../../victim', 'export-1', '/base')).startsWith(resolve(root) + sep)).toBe(true)
```
Both fail today (the first throws nothing, the second resolves to `/victim/export-1`) and pass after the fix.
