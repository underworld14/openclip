---
id: BUG-4tscfq
title: settings.json is written 0644 while secrets.json is deliberately 0600
status: todo
priority: medium
created: "2026-08-15T08:35:22Z"
updated: "2026-08-15T08:35:22Z"
---

# Description

`writeSettings` (`src/main/ipc/settings.ts`) does a bare `writeFileSync(tmp, …)`,
so `userData/settings.json` lands at 0644. `fileBackend` in
`src/main/utils/security.ts` deliberately writes `secrets.json` at 0600 with a
chmod fallback (audit fix openclip-g7f) — settings never got the same treatment.

Lower severity than it looks: `settings.json` holds no secret, and FEAT-bysdwg's
`Settings.baseUrl` refine now rejects URLs carrying credentials, which was the
realistic way a password could have ended up in there. Worth aligning anyway.

# Acceptance Criteria
- [ ] settings.json is created 0600, and an existing world-readable file is tightened
- [ ] A test mirrors the `fileBackend` mode assertions in trunk-infra.spec.ts

# Implementation Plan

Mirror `fileBackend`: `writeFileSync(tmp, data, { mode: 0o600 })` plus a
best-effort `chmodSync` for a pre-existing file, then the atomic rename.

# Notes

# Related Files
- src/main/ipc/settings.ts
- src/main/utils/security.ts

# Attachments
