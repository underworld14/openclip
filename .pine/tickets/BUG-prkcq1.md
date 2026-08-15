---
id: BUG-prkcq1
title: AI-suggested emoji are written into the ASS caption file without escaping, so model output can inject override tags
status: todo
priority: medium
labels:
    - security
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
Model output reaches a markup format unescaped.

## Evidence
- AI emoji strings are written into the generated ASS caption file with no ASS escaping,
  so `{...}` override blocks in model output are interpreted as styling directives rather
  than literal text.

## Impact
A provider (including a user-configured custom endpoint, which may be hostile) can alter or
break the burned captions of the exported video — position, colour, transparency, or
garbled output the user only discovers after a long encode.

## Fix
Escape `{`, `}` and backslashes in every model-derived string before it reaches the ASS
writer, next to the existing `redactSecrets` boundary in spirit.

## Acceptance Criteria
- [ ] Emoji/text containing `{\pos(0,0)}` renders literally in the burn
- [ ] A test asserts the escaping
