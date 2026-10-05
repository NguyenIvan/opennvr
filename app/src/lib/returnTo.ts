// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

const AUTH_PAGES = /^\/(login|register|first-time-setup|mfa-setup|mfa-verify)(?:[/?#]|$)/

/** Same-origin path to resume after auth, or `fallback`. Rejects absolute,
    protocol-relative and backslash URLs (open-redirect) and auth pages (loops). */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  if (AUTH_PAGES.test(raw)) return fallback
  return raw
}
