// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from '../../i18n'
import { useCameras } from '../../lib/queries'
import { usePermissions } from '../../hooks/usePermissions'
import { GridTile, EmptySlot } from './GridTile'
import { resolveSlots } from './slots'
import { useIdleAttr, useKioskViewport, usePageVisible, useWakeLock } from './hooks'

function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-white/60">{children}</div>
}

/**
 * Chromeless 6-camera wall for kiosks and phones: `/grid` or
 * `/grid?cameras=3,1,7`. One DOM tree for both orientations — the 2x3 / 3x2
 * flip is pure CSS, so rotating never remounts a player.
 */
export function GridView() {
  const { t } = useTranslation()
  const { hasPermission, loading: permLoading } = usePermissions()
  const [params] = useSearchParams()
  const cams = useCameras()
  const visible = usePageVisible()
  const rootRef = useRef<HTMLDivElement>(null)
  useIdleAttr(rootRef)
  useWakeLock(visible)
  useKioskViewport()
  const raw = params.get('cameras')
  const slots = useMemo(() => resolveSlots(cams.data?.cameras ?? [], raw), [cams.data, raw])

  const body = permLoading || cams.isLoading ? null // black screen while loading
    : !hasPermission('live.view') ? <Center>{t('grid.noPermission')}</Center>
    : !cams.data?.cameras.length && !raw ? <Center>{t('grid.noCameras')}</Center>
    : (
      <div className="grid h-full w-full gap-[2px] grid-cols-2 grid-rows-3 landscape:grid-cols-3 landscape:grid-rows-2">
        {slots.map((s, i) =>
          s.kind === 'camera' ? <GridTile key={s.key} cam={s.cam} index={i} playing={visible} />
          : <EmptySlot key={s.key} label={s.kind === 'missing' ? t('grid.notFound', { id: s.id }) : undefined} />)}
      </div>
    )

  return (
    <div
      ref={rootRef}
      data-idle="false"
      className="fixed inset-x-0 top-0 h-dvh overflow-hidden overscroll-none select-none touch-manipulation bg-black text-white data-[idle=true]:cursor-none"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}
    >
      {body}
    </div>
  )
}
