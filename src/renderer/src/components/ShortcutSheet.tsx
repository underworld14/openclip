/**
 * ShortcutSheet — the `?` cheat sheet (FEAT-vvaycm).
 *
 * The three shortcuts that existed were documented only inside the timeline's
 * `aria-label`, which is to say: not at all, for anyone not using a screen
 * reader. A desktop app's advantage over a browser tool is that keystrokes reach
 * it — an advantage worth nothing if nobody knows which ones.
 *
 * Rendered straight from `@shared/shortcuts`, the same table that builds the
 * application menu and drives the keydown hook, so this list cannot describe a
 * binding that does not exist.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { shortcutGroups } from '@shared/shortcuts'

export interface ShortcutSheetProps {
  open: boolean
  onClose: () => void
}

export function ShortcutSheet({ open, onClose }: ShortcutSheetProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="app-no-drag max-w-md" data-testid="shortcut-sheet">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? at any time to reopen this.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {shortcutGroups().map(({ group, items }) => (
            <div key={group} className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </span>
              {items.map((s) => (
                <div
                  key={s.id}
                  data-testid="shortcut-row"
                  data-shortcut-id={s.id}
                  className="flex items-baseline justify-between gap-4 text-sm"
                >
                  <span>{s.label}</span>
                  <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {s.hint}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ShortcutSheet
