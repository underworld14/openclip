import { Button } from '@renderer/components/ui/button'
import { APP_NAME, APP_VERSION } from '@shared'

/**
 * STAGE 1 scaffold smoke screen. Exercises Tailwind v4 + a shadcn/ui component
 * + the `@shared` alias + the ping IPC. The trunk owner replaces this with the
 * full §11.1 layout (Dashboard / Preview / Clip sidebar) in the contract phase.
 */
function App(): React.JSX.Element {
  const ping = (): void => window.electron.ipcRenderer.send('ping')

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
      <p className="text-sm text-muted-foreground">v{APP_VERSION} — scaffold</p>
      <Button onClick={ping}>Send ping IPC</Button>
    </div>
  )
}

export default App
