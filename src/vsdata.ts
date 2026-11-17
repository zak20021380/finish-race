/**
 * vsdata.ts — the tiny, pure language/direction table for the pre-match face-off.
 *
 * The VS screen used to fabricate opponents here: a pool of handles, flags, guilds and TIQ bands
 * hashed from a seat id. All of that is gone. A face-off now renders only the metadata the room or
 * the matchmaker already holds in memory — real names, real avatars, real TIQ, and the honest
 * difficulty of a machine seat. Every label the card prints lives in settings.ts, the app's one
 * locale table, so EN/FA/RU/AR/ES all read the same way.
 *
 * This module stays DOM-free and import-free so the pure parts can be asserted in isolation.
 */

export type ClashLang = 'en' | 'fa' | 'ru' | 'ar' | 'es';
export type ClashDir = 'ltr' | 'rtl';
/** The machine's three levels, kept as a local union so this file stays import-free. */
export type ClashTier = 'easy' | 'normal' | 'hard';

/** The only thing the face-off still needs from a locale: which way the banner reads. */
export interface ClashCopy {
  dir: ClashDir;
}

export const CLASH_COPY: Record<ClashLang, ClashCopy> = {
  en: { dir: 'ltr' },
  fa: { dir: 'rtl' },
  ru: { dir: 'ltr' },
  ar: { dir: 'rtl' },
  es: { dir: 'ltr' },
};

/** The clash speaks the app's language; an unknown code gets English, never a blank card. */
export function clashCopy(code: string | null | undefined): ClashCopy {
  const base = ((code || '').toLowerCase().split(/[-_]/)[0]) as ClashLang;
  return CLASH_COPY[base] ?? CLASH_COPY.en;
}
