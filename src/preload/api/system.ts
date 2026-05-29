/**
 * preload/api/system.ts — `window.openclip.system` namespace builder (EXPORT
 * spine, plan E.5). system:open-folder / system:save-dialog / system:check-update
 * → openFolder / saveDialog / checkUpdate.
 *
 * Derived from the frozen `ChannelMap` exactly like the other namespaces
 * (`buildNamespace('system')` pairs each `system:*` channel with its camelCased
 * method). The trunk shipped these channels in `ChannelMap` but exposed no
 * namespace for them; the export UX needs `saveDialog` + `openFolder`, so the
 * spine adds this builder (and wires it into the assembled bridge in
 * `preload/index.ts`). Parity with the mock is asserted by `preload-parity.spec`.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildSystemApi(): NamespaceMethods<'system'> {
  return buildNamespace('system') as NamespaceMethods<'system'>
}
