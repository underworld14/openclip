/**
 * usePrefersReducedMotion.ts — the one motion trigger CSS can't stop
 * (BUG-qcvhcn).
 *
 * The global `prefers-reduced-motion` CSS rule (assets/index.css) collapses
 * every CSS animation/transition, but a native `<video autoPlay loop>` is
 * neither — it is JS/HTML-driven playback, so the media query has to be read
 * in JS and used to skip mounting the element. Currently the only consumer:
 * ClipCard's hover preview.
 */

import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  )

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
