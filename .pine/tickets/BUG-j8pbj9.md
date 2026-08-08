---
id: BUG-j8pbj9
title: E2E ping spec asserts a stale hand-written bridge namespace list — fails on 'brand'
status: todo
priority: medium
labels:
    - test
    - e2e
parent: EPIC-4sa5jb
created: "2026-08-08T15:32:35Z"
updated: "2026-08-08T15:32:44Z"
---

## Problem

`tests/e2e/ping.e2e.spec.ts:41` asserts an exact, hand-maintained list of preload bridge namespaces. The bridge now exposes a `brand` namespace, so the assertion fails.

Reproduced locally (after repairing the broken Electron install):

```
  2) tests/e2e/ping.e2e.spec.ts:15:5 › ping IPC round-trips and the openclip bridge is exposed

    - Expected  - 0
    + Received  + 1
        "ai",
        "audio",
    +   "brand",
        "jobs",
        "media",
        ...
```

## Why it matters

Low user impact, but it is one of only two red specs and it makes the E2E suite non-green, which is exactly the condition that lets *real* failures hide. It is also a **duplicated contract assertion**: `tests/unit/contract.spec.ts` and `preload-parity.spec.ts` already enforce bridge/type parity from `channels.ts`. A hand-written literal list in an E2E spec is a second source of truth that will rot again on the next namespace.

## Fix

Either update the literal to include `brand`, or better — derive the expected namespace list from the frozen `ChannelMap`/preload builders the way the unit contract tests already do, so the spec cannot drift again.

## Acceptance criteria

- [ ] `npx playwright test tests/e2e/ping.e2e.spec.ts` passes.
- [ ] Adding a new preload namespace does not require editing this spec by hand.

Blocked-by context: this only stays green if [[FEAT-ks4yy4]] (CI) lands, otherwise it will rot again unobserved.
