/**
 * preload/api/brand.ts — `window.openclip.brand` namespace builder (Part K brand
 * kit). brand:list / brand:save / brand:delete / brand:set-logo →
 * list / save / delete / setLogo.
 *
 * Derived from the frozen `ChannelMap` exactly like the other namespaces
 * (`buildNamespace('brand')` pairs each `brand:*` channel with its camelCased
 * method). Parity with the mock is asserted by `preload-parity.spec`.
 */

import { buildNamespace } from './_invoke'
import type { NamespaceMethods } from './types'

export function buildBrandApi(): NamespaceMethods<'brand'> {
  return buildNamespace('brand') as NamespaceMethods<'brand'>
}
