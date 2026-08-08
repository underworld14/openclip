---
id: FEAT-56bxyh
title: No BYOK cost estimate before sending, and the token heuristic breaks on CJK
status: todo
priority: medium
labels:
    - ux
    - ai
    - cost
parent: EPIC-f953vk
created: "2026-08-08T15:58:26Z"
updated: "2026-08-08T15:58:26Z"
---

## Current behavior

PRD §16 requires: *"before sending, show estimated input tokens × the selected model's known price so users aren't surprised"*. Not implemented.

`estimateTokens` exists at `src/main/services/ai-client.ts:350-352` but only feeds the internal 10k-token chunk budget — it is never surfaced. The only price surface in the whole app is a static per-model label inside the OpenRouter picker (`settingsView.ts:114-115`, `formatModelPrice`).

Two things make this worse than a missing nicety:

1. **Each chunk asks for the full `numClips` independently** (`ai-client.ts:781-796`), so a 6-chunk video requests 6× the clips it will keep and pays ~6× the output tokens to throw most away.
2. `estimateTokens` is a fixed `chars/4` heuristic. That is roughly right for English and Indonesian but badly wrong for CJK/Thai, where a character is often ~1 token — and the app supports whisper auto-detect over any language, so a Chinese transcript would be chunked at ~4× the intended token budget.

## Desired behavior

Before dispatch, show "~N input tokens · est. $X.XX with `<model>`" next to the Generate button, and surface the actual spend after the run. BYOK means the user pays per click; an unpriced button is a trust problem, and this app's entire pitch is *cheap because we only send text*. Not showing the number forfeits the differentiator.

## Implementation sketch

- Expose the existing `estimateTokens` result through the generate request path.
- Reuse `formatModelPrice` / the OpenRouter price table; fall back to "unknown price" for providers with no price data rather than hiding the estimate.
- Fix the tokenizer heuristic for CJK: branch on script (a cheap Unicode-range check) rather than a flat `chars/4`.
- Consider asking each chunk for `ceil(numClips / chunkCount) + slack` instead of the full `numClips`.
