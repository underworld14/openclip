---
topic: renderer
updated: 2026-08-08T17:53:55Z
---

# renderer

- 2026-08-08: The import controller (renderer/src/hooks/useImportController.ts) is a MODULE SINGLETON, not per-component state. ImportPanel unmounts partway through a first-run import — App flips to the editor on the first transcript partial — so a per-component controller took the in-flight progress, cancel and error state with it. Anything that needs to observe or resume an in-flight import must go through the shared instance. (cites: src/renderer/src/hooks/useImportController.ts)
- 2026-08-08: Do not hardcode provider model catalogues. The curated OpenRouter pin list already shipped a retired model as the app's own top recommendation. Fetch each provider's /models endpoint (provider-models.ts); the only static entry left is one seed id in settingsView.DEFAULT_MODEL_BY_PROVIDER, used until the live list loads. (cites: src/main/services/provider-models.ts)
