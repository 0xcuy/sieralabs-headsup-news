// Breaking stories wear a loud marker on the lens so a glance separates
// them from the rest of the digest. Pure helpers, shared by the render
// path (main.ts) and the tests.
export const BREAKING_MARKER = '🚨 BREAKING — '
export const BREAKING_FLASH = '🚨 BREAKING NEWS'

export function markedHeadline(s: { headline: string; breaking?: boolean }): string {
  return s.breaking ? `${BREAKING_MARKER}${s.headline}` : s.headline
}
