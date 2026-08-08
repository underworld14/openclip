---
id: BUG-2smqpv
title: Curated OpenRouter model list recommends a retired model
status: todo
priority: medium
labels:
    - bug
    - ai
parent: EPIC-4sa5jb
created: "2026-08-08T15:59:08Z"
updated: "2026-08-08T15:59:08Z"
---

## Problem

`src/main/services/openrouter-models.ts:23-32` pins a curated "recommended models" list that the app presents as its own advice. It includes `anthropic/claude-opus-4.1`, which is **retired** — a user who takes the app's top recommendation can get a hard failure from the provider.

The file's own doc comment already anticipates this: *"Verify/refresh against https://openrouter.ai/models as the catalogue moves."* Nothing enforces it.

Current Anthropic ids are the Claude 5 family — `claude-opus-5`, `claude-sonnet-5` — plus `claude-haiku-4-5`.

## Why it is more than a one-line edit

A hardcoded model list in a BYOK app has a guaranteed expiry date, and this is the second time it has bitten (PRD §4.3 explicitly says model IDs "change frequently — the implementation resolves current model names via provider docs at build time rather than hardcoding stale ones"). The list already contradicts the PRD.

## Acceptance criteria

- [ ] Refresh the pinned ids to models that currently exist.
- [ ] The curated list degrades safely: if a pinned id is absent from the live `/models` response, drop it from "Recommended" rather than offering it.
- [ ] A test asserts every curated id is present in a recorded `/models` fixture, so the list fails loudly in CI ([[FEAT-ks4yy4]]) rather than failing silently for a user.
- [ ] Consider surfacing the "Recommended" list for OpenAI/Anthropic/Ollama too — today `AI_LIST_MODELS` returns an empty list for every provider except OpenRouter (`src/main/ipc/ai.ts:209-211`), which is the root of [[FEAT-6v92dk]].
