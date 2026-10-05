// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CameraOff } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { CameraItem } from '../../lib/queries'
import { apiService } from '../../lib/apiService'
import { rebaseToCurrentOrigin } from '../../lib/streamUrl'
import { useCameraStatus } from '../../hooks/useCameraStatus'
import { VideoPlayer } from '../../components/VideoPlayer'
import { cameraState } from '../dashboard/WidgetFrame'

type StreamInfo = { urls?: { webrtc?: string; webrtc_sub?: string; hls?: string }; token?: string }

/**
 * One grid cell. Same stream logic as the dashboard wall's LiveTile: prefers
 * the substream when the server publishes one and falls back to the main
 * stream if that path does not exist. No controls — the grid is chromeless.
 */
export function GridTile({ cam, index, playing }: {
  cam: CameraItem
  index: number
  playing: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const state = cameraState(cam)
  const { version } = useCameraStatus(cam.id)
  const [preferSub, setPreferSub] = useState(true)

  // Shares its cache entry with the dashboard wall (same key and lifetimes).
  const info = useQuery({
    queryKey: ['stream-info', cam.id, version],
    enabled: playing && state !== 'offline' && state !== 'error',
    queryFn: async () => {
      const { data } = await apiService.getStreamUrls(cam.id)
      return data as StreamInfo
    },
    staleTime: 45 * 60_000,
    gcTime: 50 * 60_000,
  })

  const lastRefresh = useRef(0)
  const onAuthExpired = useCallback(() => {
    const now = Date.now()
    if (now - lastRefresh.current < 10_000) return
    lastRefresh.current = now
    qc.invalidateQueries({ queryKey: ['stream-info', cam.id] })
  }, [qc, cam.id])

  const sub = info.data?.urls?.webrtc_sub
  const usingSub = preferSub && !!sub
  const whep = rebaseToCurrentOrigin(usingSub ? sub : info.data?.urls?.webrtc)
  const hls = rebaseToCurrentOrigin(info.data?.urls?.hls)
  const onError = useCallback((msg: string) => {
    // A 404 on the substream while the camera itself is up means this
    // camera has no substream path: use the main stream instead.
    if (usingSub && msg === 'Camera offline' && cam.live_online) setPreferSub(false)
  }, [usingSub, cam.live_online])

  const live = state === 'online' || state === 'degraded'

  return (
    <div className="relative min-w-0 min-h-0 overflow-hidden bg-black">
      {live && playing && (whep || hls) ? (
        <div className="absolute inset-0">
          <VideoPlayer
            key={`${cam.id}-${version}-${usingSub ? 's' : 'm'}`}
            mode="live"
            chrome="none"
            persistentRetry
            whepUrl={whep}
            hlsUrl={hls}
            mediamtxToken={info.data?.token}
            onAuthExpired={onAuthExpired}
            onError={onError}
            preferredStreamType="webrtc"
            autoPlay
            muted
            displayAspectOverride={cam.display_aspect_ratio}
            cameraId={cam.id}
            className="w-full h-full !bg-black"
          />
        </div>
      ) : (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-white/45"
          style={{ background: 'repeating-linear-gradient(135deg, #07090d 0 10px, #0b0f16 10px 20px)' }}
        >
          {live ? (
            <div className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
          ) : (
            <>
              <CameraOff size={18} />
              <div className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('grid.offline')}</div>
            </>
          )}
        </div>
      )}

      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-white/80 transition-opacity duration-500 [[data-idle=true]_&]:opacity-0">
        {cam.name || `CAM ${index + 1}`}
      </span>
    </div>
  )
}

/** A slot with no camera: an unknown id from ?cameras= (labelled) or a spare cell (blank). */
export function EmptySlot({ label }: { label?: string }) {
  return (
    <div className="flex min-w-0 min-h-0 items-center justify-center bg-black font-mono text-[11px] text-white/30">
      {label}
    </div>
  )
}
