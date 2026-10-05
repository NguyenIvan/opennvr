// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, type RefObject } from 'react'

export function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/**
 * Mirrors "no recent input" onto `data-idle` ('true' | 'false') of `ref`'s
 * element, so CSS can fade labels and hide the cursor. Deliberately no React
 * state: an idle flip must not re-render the grid.
 */
export function useIdleAttr(ref: RefObject<HTMLElement | null>, ms = 3000) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { el.dataset.idle = 'true' }, ms)
    }
    const wake = () => {
      el.dataset.idle = 'false'
      arm()
    }
    wake()
    const events = ['pointermove', 'pointerdown', 'touchstart', 'keydown'] as const
    for (const e of events) window.addEventListener(e, wake, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, wake)
    }
  }, [ref, ms])
}

/** Keep the screen on while `enabled`. Best-effort: needs a secure context and browser support. */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) {
          void l.release().catch(() => {})
          return
        }
        lock = l
      } catch {
        // denied or insecure context — nothing to do
      }
    }
    // The browser drops the lock when the tab is hidden; take it again on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!lock || lock.released)) void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [enabled])
}

/** Full-bleed route setup: extend into the notch (viewport-fit=cover) and lock page scroll. Restored on unmount. */
export function useKioskViewport() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const prevContent = meta?.getAttribute('content') ?? null
    if (meta && prevContent !== null && !prevContent.includes('viewport-fit')) {
      meta.setAttribute('content', `${prevContent}, viewport-fit=cover`)
    }
    const html = document.documentElement
    const prevOverflow = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      if (meta && prevContent !== null) meta.setAttribute('content', prevContent)
      html.style.overflow = prevOverflow
    }
  }, [])
}
