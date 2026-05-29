import './assets/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useProjectStore } from './stores/projectStore'
import { runImportPipeline } from './components/import-pipeline'
import { projectActions } from './hooks/useProject'
import { runExport } from './components/export-run'
import { buildExportParams } from './stores/projectStore/exportSlice'
import { resolveBounds } from '@shared/clip-bounds'

// E2E test harness (integration Wave-1 m10). Exposes the REAL renderer
// orchestration + store on `window.__openclipTest` so the Playwright
// integration spec can drive the live spine (import → transcribe over the
// transferred MessagePort → generate clips → save/load) through the real
// modules and then assert the DOM renders. Harmless in production: it attaches
// only already-bundled pure functions + the store singleton, no behaviour change.
declare global {
  interface Window {
    __openclipTest?: {
      store: typeof useProjectStore
      runImportPipeline: typeof runImportPipeline
      projectActions: typeof projectActions
      runExport: typeof runExport
      /** TIMELINE E2E (P6): prove a drag retrim → resolveBounds → export span. */
      buildExportParams: typeof buildExportParams
      resolveBounds: typeof resolveBounds
    }
  }
}
window.__openclipTest = {
  store: useProjectStore,
  runImportPipeline,
  projectActions,
  runExport,
  buildExportParams,
  resolveBounds
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
