/**
 * phrases.ts — the entire vocabulary of quick chat.
 *
 * There is no free text anywhere in `chat.ts`: every message a player can send is one of the
 * four tactical one-liners or one of the three psychological emote pods below. Both lists are
 * closed and about the board only — no names, no appearance, no nationality, nothing about the
 * person on the other side. Anything that did not ship in this file cannot be said.
 *
 * Emotes are inline SVG (never emoji): multi-layered, gradient-shaded, drawn in the app's dark
 * clay language, each one a face with a clear psychological read — mockery, fury, time pressure.
 * Each gradient id is unique per emote; the art is duplicated between the pod and its bubble,
 * and identical definitions render identically, so the ids may repeat by design.
 */

export type ChatEmoteId = 'laugh' | 'fury' | 'impatient';

export interface ChatEmote {
  id: ChatEmoteId;
  /** Spoken name for assistive tech and the button's tooltip — never shown as text on the card. */
  label: string;
  /** The micro-label under the art: the feeling in one word. */
  micro: string;
  /** A 64×64 inline SVG. Static, first-party markup; `chat.ts` never interpolates user input. */
  svg: string;
}

/**
 * The four tactical taunts — one per psychological beat: the mine, the wall, the clock, the ego.
 * Order is fixed: the sheet paints them into a 2×2 grid in exactly this order.
 */
export const TAUNTS: readonly string[] = [
  'Boom! Nice step.',
  'Path closed.',
  'Tick tock...',
  'Outplayed.',
];

export const EMOTES: readonly ChatEmote[] = [
  {
    id: 'laugh',
    label: 'Devilish laugh',
    micro: 'Haha!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-laugh-face" cx="38%" cy="30%" r="75%">
          <stop offset="0" stop-color="#FFE08A" />
          <stop offset=".55" stop-color="#F5B02E" />
          <stop offset="1" stop-color="#B8621B" />
        </radialGradient>
        <linearGradient id="ce-laugh-horn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9A6531" />
          <stop offset="1" stop-color="#43250F" />
        </linearGradient>
        <linearGradient id="ce-laugh-mouth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5B1E14" />
          <stop offset="1" stop-color="#2A0B08" />
        </linearGradient>
      </defs>
      <path d="M16.5 18.5c-2.4-5-1.4-9.2 1.6-11.4 1 4.2 3.2 7.4 6.4 9.4Z" fill="url(#ce-laugh-horn)" />
      <path d="M47.5 18.5c2.4-5 1.4-9.2-1.6-11.4-1 4.2-3.2 7.4-6.4 9.4Z" fill="url(#ce-laugh-horn)" />
      <circle cx="32" cy="35" r="21" fill="url(#ce-laugh-face)" />
      <path d="M11.5 37.5a20.5 20.5 0 0 0 41 0 26 26 0 0 1-41 0Z" fill="#7A3D10" opacity=".35" />
      <ellipse cx="23.5" cy="25" rx="8.5" ry="5.5" fill="#FFF4D6" opacity=".5" />
      <path d="M18.5 31.5c2.8-4 7.6-4 10.4 0" fill="none" stroke="#4A2A12" stroke-width="2.8" stroke-linecap="round" />
      <path d="M35.1 31.5c2.8-4 7.6-4 10.4 0" fill="none" stroke="#4A2A12" stroke-width="2.8" stroke-linecap="round" />
      <circle cx="24.2" cy="28.4" r="1.2" fill="#FFF8E7" />
      <circle cx="39.8" cy="28.4" r="1.2" fill="#FFF8E7" />
      <path d="M17.5 40c3.4 8.6 25.6 8.6 29 0Z" fill="url(#ce-laugh-mouth)" />
      <path d="M19.8 41.6h24.4c-2.2 2.4-6.4 3.2-12.2 3.2s-10-.8-12.2-3.2Z" fill="#FFF7E0" />
      <path d="M22 42l1.8 3.8 1.8-3.8Z" fill="#FFF7E0" />
      <path d="M42 42l-1.8 3.8-1.8-3.8Z" fill="#FFEFC8" />
      <path d="M16.2 38.2l-3.2-2.4M47.8 38.2l3.2-2.4" fill="none" stroke="#8A4A16" stroke-width="2.2" stroke-linecap="round" />
      <ellipse cx="17.5" cy="36.5" rx="3.4" ry="2.1" fill="#FF7A45" opacity=".55" />
      <ellipse cx="46.5" cy="36.5" rx="3.4" ry="2.1" fill="#FF7A45" opacity=".55" />
      <path d="M26 51c4 2 8 2 12 0" fill="none" stroke="#FFE08A" stroke-width="1.6" stroke-linecap="round" opacity=".6" />
    </svg>`,
  },
  {
    id: 'fury',
    label: 'Boiling rage',
    micro: 'Grrr!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-fury-face" cx="38%" cy="28%" r="78%">
          <stop offset="0" stop-color="#FFAB6B" />
          <stop offset=".5" stop-color="#F04425" />
          <stop offset="1" stop-color="#8E1206" />
        </radialGradient>
        <linearGradient id="ce-fury-steam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFC49A" stop-opacity="0" />
          <stop offset=".5" stop-color="#FFC49A" stop-opacity=".85" />
          <stop offset="1" stop-color="#FFC49A" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="ce-fury-mouth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#450B05" />
          <stop offset="1" stop-color="#1C0402" />
        </linearGradient>
      </defs>
      <path d="M20 13c-2.2-3 .8-4.6-.6-8M32 11c-2.2-3 .8-4.6-.6-8M44 13c-2.2-3 .8-4.6-.6-8" fill="none" stroke="url(#ce-fury-steam)" stroke-width="3" stroke-linecap="round" />
      <circle cx="32" cy="36" r="21" fill="url(#ce-fury-face)" />
      <path d="M11.5 38.5a20.5 20.5 0 0 0 41 0 26 26 0 0 1-41 0Z" fill="#5E0A04" opacity=".4" />
      <ellipse cx="24" cy="27" rx="8.5" ry="5.5" fill="#FFD9BE" opacity=".4" />
      <path d="M16.8 27.4 27.4 31M47.2 27.4 36.6 31" fill="none" stroke="#3A0803" stroke-width="4" stroke-linecap="round" />
      <ellipse cx="22.2" cy="34.4" rx="3.6" ry="3" fill="#FFF3E2" />
      <ellipse cx="41.8" cy="34.4" rx="3.6" ry="3" fill="#FFF3E2" />
      <circle cx="22.6" cy="34.6" r="1.6" fill="#280402" />
      <circle cx="41.4" cy="34.6" r="1.6" fill="#280402" />
      <circle cx="21.9" cy="33.8" r=".6" fill="#FFF3E2" />
      <circle cx="40.7" cy="33.8" r=".6" fill="#FFF3E2" />
      <path d="M19 45h26a13 9.4 0 0 1-26 0Z" fill="url(#ce-fury-mouth)" />
      <path d="M20.6 46.2h22.8v2.2H20.6Z" fill="#FFE9D2" />
      <path d="M27.4 46.2v2.6M34.2 46.2v2.6M41 46.2v2.6" fill="none" stroke="#D8A98B" stroke-width=".9" />
      <ellipse cx="15.5" cy="42" rx="3" ry="2" fill="#FF3B14" opacity=".45" />
      <ellipse cx="48.5" cy="42" rx="3" ry="2" fill="#FF3B14" opacity=".45" />
      <path d="M7.5 53c-.4-3.4 1.6-6 4.4-7-1.2 3.4 1 5-.4 8.4Z" fill="#FF8A3C" opacity=".9" />
      <path d="M56.5 53c.4-3.4-1.6-6-4.4-7 1.2 3.4-1 5 .4 8.4Z" fill="#FF8A3C" opacity=".9" />
    </svg>`,
  },
  {
    id: 'impatient',
    label: 'Impatient',
    micro: 'Hurry!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-tick-face" cx="38%" cy="28%" r="78%">
          <stop offset="0" stop-color="#D6F6FF" />
          <stop offset=".55" stop-color="#6CCBE9" />
          <stop offset="1" stop-color="#1D6C93" />
        </radialGradient>
        <linearGradient id="ce-tick-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#F0FDFF" stop-opacity=".95" />
          <stop offset="1" stop-color="#8ADCF5" stop-opacity=".4" />
        </linearGradient>
        <linearGradient id="ce-tick-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFE18A" />
          <stop offset="1" stop-color="#E89112" />
        </linearGradient>
      </defs>
      <path d="M52 24l3-3M55 33h4M52 50l3 3" fill="none" stroke="#9FE8FC" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="27" cy="33" r="20.5" fill="url(#ce-tick-face)" />
      <path d="M7 35a20 20 0 0 0 40 0 25 25 0 0 1-40 0Z" fill="#0E4864" opacity=".38" />
      <ellipse cx="19" cy="24" rx="8" ry="5.4" fill="#ECFCFF" opacity=".55" />
      <path d="M14 26.2h9.6M33.4 24.6h9.4" fill="none" stroke="#103F57" stroke-width="2.6" stroke-linecap="round" />
      <ellipse cx="18.6" cy="32.4" rx="3.7" ry="3.1" fill="#F5FEFF" />
      <ellipse cx="33" cy="32.4" rx="3.7" ry="3.1" fill="#F5FEFF" />
      <circle cx="20.2" cy="32.7" r="1.65" fill="#0A2B3B" />
      <circle cx="34.6" cy="32.7" r="1.65" fill="#0A2B3B" />
      <path d="M19.5 42h12.8" fill="none" stroke="#0D3549" stroke-width="2.8" stroke-linecap="round" />
      <rect x="39" y="32" width="18" height="3.4" rx="1.7" fill="url(#ce-tick-sand)" />
      <rect x="39" y="52.4" width="18" height="3.4" rx="1.7" fill="url(#ce-tick-sand)" />
      <path d="M41 35.4h14l-5.9 8.4 5.9 8.6H41l5.9-8.6Z" fill="url(#ce-tick-glass)" stroke="#C9F2FD" stroke-width="1.3" />
      <path d="M48 43.8v-4.6" fill="none" stroke="url(#ce-tick-sand)" stroke-width="1.8" stroke-linecap="round" />
      <path d="M43.4 52.4c2.6-2.2 6.6-2.2 9.2 0Z" fill="url(#ce-tick-sand)" />
      <rect x="21" y="50" width="13" height="8.4" rx="4.2" fill="#BEEFFF" />
      <path d="M24 50v-2.6M28 50v-3.4M32 50v-2.4" fill="none" stroke="#BEEFFF" stroke-width="2.8" stroke-linecap="round" />
      <path d="M17.6 52c-2.6.6-4.4 2-4.8 4.2M18.8 56.2c-1.8.5-3 1.5-3.4 3" fill="none" stroke="#BEEFFF" stroke-width="2.2" stroke-linecap="round" />
    </svg>`,
  },
];
