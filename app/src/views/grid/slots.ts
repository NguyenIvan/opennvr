// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CameraItem } from '../../lib/queries'

export const SLOT_COUNT = 6

export type Slot =
  | { kind: 'camera'; cam: CameraItem; key: string }
  | { kind: 'missing'; id: number; key: string }
  | { kind: 'empty'; key: string }

/** `?cameras=3,1,7` -> [3, 1, 7]: non-numeric parts skipped, deduped, order kept, max SLOT_COUNT. */
export function parseCameraParam(raw: string | null): number[] {
  if (!raw) return []
  const out: number[] = []
  for (const part of raw.split(',')) {
    const s = part.trim()
    if (!/^\d+$/.test(s)) continue
    const n = Number(s)
    if (!out.includes(n)) out.push(n)
    if (out.length === SLOT_COUNT) break
  }
  return out
}

/**
 * Always SLOT_COUNT slots in a stable order (never sorted by live state, so
 * tiles don't reshuffle and remount). Unknown ids keep their position as
 * 'missing'; spare slots are 'empty'.
 */
export function resolveSlots(cams: CameraItem[], raw: string | null): Slot[] {
  const ids = parseCameraParam(raw)
  const byId = new Map(cams.map((c) => [c.id, c]))
  const picked: Slot[] = ids.length
    ? ids.map((id): Slot => {
        const cam = byId.get(id)
        return cam ? { kind: 'camera', cam, key: `c${id}` } : { kind: 'missing', id, key: `m${id}` }
      })
    : [...cams].sort((a, b) => a.id - b.id).slice(0, SLOT_COUNT)
        .map((cam): Slot => ({ kind: 'camera', cam, key: `c${cam.id}` }))
  while (picked.length < SLOT_COUNT) picked.push({ kind: 'empty', key: `e${picked.length}` })
  return picked
}
