// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useCameras } from '../../lib/queries'
import { usePermissions } from '../../hooks/usePermissions'
import { GridTile } from './GridTile'
import { parseIndex, parseRotation, wrapIndex } from './rotation'
import { useIdleAttr, useKioskViewport, usePageVisible, useWakeLock } from './hooks'

function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-white/60">{children}</div>
}

/**
 * One camera full-screen: `/1`, `/1?auto`, `/1?auto&delay=15`. The position is
 * kept in `?i=` so a reload or bookmark keeps it. Manual navigation restarts
 * the auto-rotate countdown.
 */
export function SingleView() {
  const { t } = useTranslation()
  const { hasPermission, loading: permLoading } = usePermissions()
  const [params, setParams] = useSearchParams()
  const cams = useCameras()
  const visible = usePageVisible()
  const rootRef = useRef<HTMLDivElement>(null)
  useIdleAttr(rootRef)
  useWakeLock(visible)
  useKioskViewport()

  const list = useMemo(() => [...(cams.data?.cameras ?? [])].sort((a, b) => a.id - b.id), [cams.data])
  const n = list.length
  const { auto, delayMs } = parseRotation(params)
  const index = parseIndex(params.get('i'), n)
  const cam = list[index]

  const go = useCallback((next: number) => {
    setParams((p) => {
      const q = new URLSearchParams(p)
      q.set('i', String(wrapIndex(next, n)))
      return q
    }, { replace: true })
  }, [n, setParams])

  // Keep the same camera (by id) if the list itself changes under us. Runs on
  // list changes only: reacting to `index` would undo every navigation.
  const camIdRef = useRef<number | null>(null)
  useEffect(() => {
    const id = camIdRef.current
    if (id === null) return
    const at = list.findIndex((c) => c.id === id)
    if (at >= 0 && at !== index) go(at)
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps
  // Declared after the effect above so it still sees the previous camera id.
  useEffect(() => { camIdRef.current = cam?.id ?? null })

  // Auto-rotate. Re-armed on every index change, so manual moves reset it.
  useEffect(() => {
    if (!auto || n < 2 || !visible) return
    const timer = window.setTimeout(() => go(index + 1), delayMs)
    return () => window.clearTimeout(timer)
  }, [auto, n, visible, delayMs, index, go])

  useEffect(() => {
    if (n < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(index - 1)
      else if (e.key === 'ArrowRight') go(index + 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [n, index, go])

  const touchX = useRef<number | null>(null)
  const onTouchStart = (e: React.TouchEvent) => { touchX.current = e.touches[0].clientX }
  const onTouchEnd = (e: React.TouchEvent) => {
    const x0 = touchX.current
    touchX.current = null
    if (x0 === null || n < 2) return
    const dx = e.changedTouches[0].clientX - x0
    if (Math.abs(dx) > 60) go(index + (dx < 0 ? 1 : -1))
  }

  const btn = 'pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white/90 hover:bg-black/80 disabled:opacity-30'
  const multi = n > 1

  const body = permLoading || cams.isLoading ? null
    : !hasPermission('live.view') ? <Center>{t('grid.noPermission')}</Center>
    : !cam ? <Center>{t('grid.noCameras')}</Center>
    : (
      <>
        <div className="h-full w-full grid grid-cols-1 grid-rows-1">
          <GridTile key={cam.id} cam={cam} index={index} playing={visible} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex items-center justify-center gap-2 transition-opacity duration-500 [[data-idle=true]_&]:opacity-0">
          <button type="button" className={btn} disabled={!multi} onClick={() => go(0)} aria-label={t('single.first')}><ChevronsLeft size={18} /></button>
          <button type="button" className={btn} disabled={!multi} onClick={() => go(index - 1)} aria-label={t('single.prev')}><ChevronLeft size={18} /></button>
          <span className="rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-white/80">
            {index + 1} / {n}{auto && multi ? ` · ${t('single.auto', { s: Math.round(delayMs / 1000) })}` : ''}
          </span>
          <button type="button" className={btn} disabled={!multi} onClick={() => go(index + 1)} aria-label={t('single.next')}><ChevronRight size={18} /></button>
          <button type="button" className={btn} disabled={!multi} onClick={() => go(n - 1)} aria-label={t('single.last')}><ChevronsRight size={18} /></button>
        </div>
      </>
    )

  return (
    <div
      ref={rootRef}
      data-idle="false"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="fixed inset-x-0 top-0 h-dvh overflow-hidden overscroll-none select-none touch-manipulation bg-black text-white data-[idle=true]:cursor-none"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}
    >
      {body}
    </div>
  )
}
