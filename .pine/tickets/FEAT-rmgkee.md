---
id: FEAT-rmgkee
title: Nothing tells the user what an API key is, where to get one, or that it costs money
status: todo
priority: high
labels:
    - copy
parent: EPIC-k83ghw
phase: p1
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The product's one hard prerequisite is presented as a password box with no context.

## Evidence
Read from the **running packaged app**, AI tab, clean profile:
```
AI Provider (BYOK)              ← "BYOK" is the first label a new user sees
Model  [Load models] [Test]
No models loaded — add your OpenAI key, then press Load models.
Clip detection needs a model that supports strict JSON output. Not every listed
model does — press Test to check one before relying on it.
API key for OpenAI — No key set
The key is encrypted with the OS keychain (safeStorage) and used only on this device…
```
- `grep -rn "platform.openai.com|console.anthropic|openrouter.ai/keys|ollama.com" src/`
  → **zero hits**. The only such URL in the repo is `README.md:61`.
- No cost estimate is shown for any provider except OpenRouter, and only if Settings was
  opened that session.
- `Ollama (local)` — the one no-key, no-cost path — is in the provider list but the default
  is OpenAI and nothing says Ollama needs neither a key nor money (it is separate software).

## Impact
A creator who has never used an LLM API is told *what* is missing and never *how* to get
it. Setup is a 5-step chain (paste key → Save → Load models → pick model → Test) with no
guidance, wrapped in vocabulary from the implementation (`BYOK`, `safeStorage`, "strict
JSON output").

## Fix
Add a per-provider "Get a key →" external link beside the key field, one plain sentence
explaining what an API key is and that the user pays the provider directly, a rough cost
per hour of video, and a "no key needed" badge on Ollama. Replace `BYOK`, `safeStorage`
and "strict JSON output" with user-facing words.

## Acceptance Criteria
- [ ] Each provider links to its key page
- [ ] The AI tab explains what a key is and who charges for it
- [ ] Ollama is presented as the free, no-key option
- [ ] No implementation vocabulary remains in the AI tab
