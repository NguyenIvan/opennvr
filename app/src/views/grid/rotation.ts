// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

export const DEFAULT_DELAY_S = 10
export const MIN_DELAY_S = 3

/** `?auto&delay=15` -> { auto: true, delayMs: 15000 }. Bad or missing delay -> 10s; clamped to >= 3s. */
export function parseRotation(params: URLSearchParams): { auto: boolean; delayMs: number } {
  const auto = params.has('auto') && params.get('auto') !== 'false' && params.get('auto') !== '0'
  const raw = params.get('delay')
  const n = raw && /^\d+$/.test(raw.trim()) ? Number(raw) : DEFAULT_DELAY_S
  return { auto, delayMs: Math.max(n || DEFAULT_DELAY_S, MIN_DELAY_S) * 1000 }
}

/** Wrap `i` into [0, n). */
export function wrapIndex(i: number, n: number): number {
  return n > 0 ? ((i % n) + n) % n : 0
}

/** `?i=2` -> 2, clamped to [0, n-1]; anything else -> 0. */
export function parseIndex(raw: string | null, n: number): number {
  if (!raw || !/^\d+$/.test(raw)) return 0
  return Math.min(Number(raw), Math.max(n - 1, 0))
}
