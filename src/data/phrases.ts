/**
 * phrases.ts — the entire vocabulary of quick chat.
 *
 * There is no free text anywhere in `chat.ts`: every message a player can send is one of the
 * four tactical one-liners or one of the three psychological emote pods below. Both lists are
 * closed and about the board only — no names, no appearance, no nationality, nothing about the
 * person on the other side. Anything that did not ship in this file cannot be said.
 *
 * Emotes are inline SVG (never emoji), drawn as glossy 3D sticker icons in the language of
 * Fluent / AAA mobile-game emote packs: one large saturated sphere with a polished radial light,
 * a soft internal crescent for volume, a clean specular gloss, and a face reduced to its clearest
 * universal read — closed-arc laughter, furrowed rage, raised-brow urgency. The palette is
 * deliberately loud — gold, crimson, ice — because these faces are read at 38-42px on a phone
 * over dark clay, where mud is the same as invisible.
 *
 * Two rules keep them legible that small, and both are load-bearing:
 *  - the body gradient ends on a BRIGHT stop. A dark rim melts into the obsidian well, so the
 *    volume is carried by the crescent shade painted inside the sphere instead of by the rim.
 *  - one big feature per face. The grin, the scowl, the side-eye: the mouth is the message,
 *    the eyes support it, everything else is a texture that has to survive at 38px or be cut.
 *    Sticker reads only: no jagged teeth, no feathers of detail, no clutter around the face.
 *
 * Each face also names its `motion` class: the CSS keyframes in `chat.css` are hung off
 * `.emote-haha` / `.emote-grrr` / `.emote-hurry`, applied to the art wrapper in the sheet and to
 * the node inside the bubble, so the same loop plays in both places.
 *
 * Each gradient id is unique per emote; the art is duplicated between the pod and its bubble,
 * and identical definitions render identically, so the ids may repeat by design.
 */

export type ChatEmoteId = 'laugh' | 'fury' | 'impatient';

/** The CSS keyframe family a face is wired to — see the `.emote-*` rules in `chat.css`. */
export type ChatEmoteMotion = 'haha' | 'grrr' | 'hurry';

export interface ChatEmote {
  id: ChatEmoteId;
  /** The animation family: `.emote-haha`, `.emote-grrr`, `.emote-hurry`. */
  motion: ChatEmoteMotion;
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

/** Every emote id, in sheet order. The wire and a roaming frame accept nothing outside this list. */
export const EMOTE_IDS: readonly ChatEmoteId[] = ['laugh', 'fury', 'impatient'];

/** A frame's emote field is only an emote when it names one of the three pods above. */
export const isChatEmoteId = (v: unknown): v is ChatEmoteId =>
  typeof v === 'string' && (EMOTE_IDS as readonly string[]).includes(v);

export const EMOTES: readonly ChatEmote[] = [
  {
    id: 'laugh',
    motion: 'haha',
    label: 'Joyful laugh',
    micro: 'Haha!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-laugh-face" cx="32%" cy="22%" r="88%">
          <stop offset="0" stop-color="#FFFDF0" />
          <stop offset=".3" stop-color="#FDE047" />
          <stop offset=".64" stop-color="#FBBF24" />
          <stop offset="1" stop-color="#F59E0B" />
        </radialGradient>
        <radialGradient id="ce-laugh-gloss" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity=".85" />
          <stop offset="1" stop-color="#FFFFFF" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="ce-laugh-mouth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7F1D1D" />
          <stop offset="1" stop-color="#3F0A0A" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="33" r="22" fill="url(#ce-laugh-face)" />
      <path d="M10 35a22 22 0 0 0 44 0 28 28 0 0 1-44 0Z" fill="#B45309" opacity=".32" />
      <path d="M45.8 49.4A21.4 21.4 0 0 1 35 54.2" fill="none" stroke="#FEF3C7" stroke-width="2.2" stroke-linecap="round" opacity=".55" />
      <ellipse cx="21.6" cy="18.8" rx="9.8" ry="5.8" fill="url(#ce-laugh-gloss)" transform="rotate(-26 21.6 18.8)" />
      <circle cx="14.8" cy="23.4" r="1.8" fill="#FFFFFF" opacity=".85" />
      <path d="M15.2 30.4c3.4-5.6 8.6-5.6 12 0" fill="none" stroke="#3B1E05" stroke-width="3.6" stroke-linecap="round" />
      <path d="M36.8 30.4c3.4-5.6 8.6-5.6 12 0" fill="none" stroke="#3B1E05" stroke-width="3.6" stroke-linecap="round" />
      <ellipse cx="14.4" cy="37.2" rx="4.4" ry="2.4" fill="#FB923C" opacity=".5" />
      <ellipse cx="49.6" cy="37.2" rx="4.4" ry="2.4" fill="#FB923C" opacity=".5" />
      <path d="M16.8 36.8c9.8-2.8 20.6-2.8 30.4 0-1.2 9.8-8.4 15.2-15.2 15.2S18 46.6 16.8 36.8Z" fill="url(#ce-laugh-mouth)" />
      <path d="M18.2 38.2c9.2-2.4 18.4-2.4 27.6 0l-1 3.8c-8.6-2.1-17-2.1-25.6 0Z" fill="#FFFDF5" />
      <ellipse cx="32" cy="47.6" rx="7.6" ry="4.2" fill="#FB7185" />
      <ellipse cx="29.8" cy="46.4" rx="3" ry="1.4" fill="#FDA4AF" />
      <path d="M54.6 8.8l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3-3.3-1.2 3.3-1.2Z" fill="#FFFBEB" opacity=".92" />
    </svg>`,
  },
  {
    id: 'fury',
    motion: 'grrr',
    label: 'Boiling rage',
    micro: 'Grrr!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-fury-face" cx="32%" cy="20%" r="86%">
          <stop offset="0" stop-color="#FFE4DC" />
          <stop offset=".26" stop-color="#FCA5A5" />
          <stop offset=".58" stop-color="#EF4444" />
          <stop offset="1" stop-color="#DC2626" />
        </radialGradient>
        <radialGradient id="ce-fury-gloss" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity=".8" />
          <stop offset="1" stop-color="#FFFFFF" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="ce-fury-smoke" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#FFF7F2" stop-opacity=".8" />
          <stop offset="1" stop-color="#F8FAFC" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="ec-steam" fill="none" stroke="url(#ce-fury-smoke)" stroke-width="2.1" stroke-linecap="round">
        <path d="M24.9 16.9c-3-2.4-3-5.4-.3-7.6-2.4-2-2.4-5-.4-7.3" />
        <path d="M39.1 16.9c3-2.4 3-5.4.3-7.6 2.4-2 2.4-5 .4-7.3" />
      </g>
      <circle cx="32" cy="34" r="22" fill="url(#ce-fury-face)" />
      <path d="M10 36a22 22 0 0 0 44 0 28 28 0 0 1-44 0Z" fill="#7F1D1D" opacity=".34" />
      <path d="M45.8 50.4A21.4 21.4 0 0 1 35 55.2" fill="none" stroke="#FCA5A5" stroke-width="2.2" stroke-linecap="round" opacity=".45" />
      <ellipse cx="21.8" cy="19" rx="9.4" ry="5.6" fill="url(#ce-fury-gloss)" transform="rotate(-26 21.8 19)" />
      <circle cx="15.2" cy="23.6" r="1.8" fill="#FFFFFF" opacity=".8" />
      <path d="M14.2 21.8 28.4 27.6" fill="none" stroke="#1E0808" stroke-width="4" stroke-linecap="round" />
      <path d="M49.8 21.8 35.6 27.6" fill="none" stroke="#1E0808" stroke-width="4" stroke-linecap="round" />
      <ellipse cx="21.4" cy="34.2" rx="4.8" ry="4.4" fill="#FFF7F7" />
      <ellipse cx="42.6" cy="34.2" rx="4.8" ry="4.4" fill="#FFF7F7" />
      <circle cx="22.2" cy="34.2" r="2.2" fill="#240606" />
      <circle cx="41.8" cy="34.2" r="2.2" fill="#240606" />
      <circle cx="21.4" cy="33.2" r=".8" fill="#FFFFFF" />
      <circle cx="41" cy="33.2" r=".8" fill="#FFFFFF" />
      <path d="M21.4 50c3.5-5.2 17.7-5.2 21.2 0" fill="none" stroke="#240606" stroke-width="4.4" stroke-linecap="round" />
    </svg>`,
  },
  {
    id: 'impatient',
    motion: 'hurry',
    label: 'Impatient',
    micro: 'Hurry!',
    svg: `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ce-tick-face" cx="32%" cy="20%" r="88%">
          <stop offset="0" stop-color="#F2FEFF" />
          <stop offset=".3" stop-color="#A5F3FC" />
          <stop offset=".62" stop-color="#22D3EE" />
          <stop offset="1" stop-color="#06B6D4" />
        </radialGradient>
        <radialGradient id="ce-tick-gloss" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity=".85" />
          <stop offset="1" stop-color="#FFFFFF" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="ce-tick-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#FDE68A" stop-opacity=".55" />
          <stop offset="1" stop-color="#FDE68A" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="ce-tick-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFF7D6" />
          <stop offset=".45" stop-color="#FBBF24" />
          <stop offset="1" stop-color="#D97706" />
        </linearGradient>
        <linearGradient id="ce-tick-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity=".92" />
          <stop offset="1" stop-color="#A5F3FC" stop-opacity=".3" />
        </linearGradient>
        <linearGradient id="ce-tick-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FEF3C7" />
          <stop offset="1" stop-color="#F59E0B" />
        </linearGradient>
        <linearGradient id="ce-tick-hand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#E0F2FE" />
          <stop offset="1" stop-color="#7DD3FC" />
        </linearGradient>
      </defs>
      <circle cx="51" cy="37.5" r="14.6" fill="url(#ce-tick-halo)" />
      <circle cx="24.5" cy="31.5" r="19.5" fill="url(#ce-tick-face)" />
      <path d="M5 33.5a19.5 19.5 0 0 0 39 0 25 25 0 0 1-39 0Z" fill="#0E7490" opacity=".3" />
      <path d="M36.7 46.1A19 19 0 0 1 27.1 50.3" fill="none" stroke="#CFFAFE" stroke-width="2" stroke-linecap="round" opacity=".5" />
      <ellipse cx="15.2" cy="17.6" rx="8" ry="4.8" fill="url(#ce-tick-gloss)" transform="rotate(-26 15.2 17.6)" />
      <circle cx="9.6" cy="21.6" r="1.6" fill="#FFFFFF" opacity=".85" />
      <path d="M11.8 23.8c2.6-4 7.2-4.8 10.6-2.2" fill="none" stroke="#083344" stroke-width="3" stroke-linecap="round" />
      <path d="M25.8 25.8 34.6 25" fill="none" stroke="#083344" stroke-width="3" stroke-linecap="round" />
      <ellipse cx="17.4" cy="31.4" rx="4.4" ry="3.8" fill="#F8FEFF" />
      <ellipse cx="29.4" cy="31.8" rx="4.4" ry="3.8" fill="#F8FEFF" />
      <g class="ec-eyes">
        <circle cx="18.8" cy="32" r="2" fill="#062A3A" />
        <circle cx="30.8" cy="32.4" r="2" fill="#062A3A" />
        <circle cx="18.1" cy="31.2" r=".7" fill="#FFFFFF" />
        <circle cx="30.1" cy="31.6" r=".7" fill="#FFFFFF" />
      </g>
      <path d="M19.8 39.9h6.8" fill="none" stroke="#083344" stroke-width="2.8" stroke-linecap="round" />
      <path d="M33.4 44.2c1.5-.6 2.7-1.7 3.3-3.1" fill="none" stroke="#A5F3FC" stroke-width="1.6" stroke-linecap="round" opacity=".9" />
      <path d="M34.4 48.2c1.3-.4 2.4-1.4 3-2.6" fill="none" stroke="#A5F3FC" stroke-width="1.6" stroke-linecap="round" opacity=".6" />
      <g transform="rotate(-9 27.5 48.4)">
        <circle cx="23.8" cy="45.2" r="1.7" fill="url(#ce-tick-hand)" stroke="#0B4A6F" stroke-width="1.2" />
        <circle cx="27.2" cy="44.7" r="1.8" fill="url(#ce-tick-hand)" stroke="#0B4A6F" stroke-width="1.2" />
        <circle cx="30.6" cy="45.2" r="1.7" fill="url(#ce-tick-hand)" stroke="#0B4A6F" stroke-width="1.2" />
        <rect x="21.8" y="44.6" width="10.8" height="7.8" rx="3.7" fill="url(#ce-tick-hand)" stroke="#0B4A6F" stroke-width="1.2" />
      </g>
      <g class="eh-glass">
        <rect x="43.2" y="19.6" width="15.6" height="4.6" rx="2.3" fill="url(#ce-tick-gold)" />
        <rect x="43.2" y="50.4" width="15.6" height="4.6" rx="2.3" fill="url(#ce-tick-gold)" />
        <path d="M45.4 24.2H56.6L52 37c-.2.3-.2.7 0 1l4.6 12.4H45.4L50 38c.2-.3.2-.7 0-1Z" fill="url(#ce-tick-glass)" stroke="#E8FBFF" stroke-width="1" stroke-linejoin="round" />
        <path d="M46.4 25.8h9.2l-3.8 10.4a1.15 1.15 0 0 1-1.9 0Z" fill="url(#ce-tick-sand)" />
        <rect x="50.4" y="36.4" width="1.2" height="7" fill="url(#ce-tick-sand)" />
        <path d="M46.4 49.8c1.8-3.2 3.2-5 4.6-5s2.8 1.8 4.6 5Z" fill="url(#ce-tick-sand)" />
        <path d="M46.6 25.8l2.9 7.6" fill="none" stroke="#FFFFFF" stroke-width="1.3" stroke-linecap="round" opacity=".85" />
        <circle cx="47" cy="27.4" r=".8" fill="#FFFFFF" opacity=".9" />
      </g>
      <path d="M58.8 12.6l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1Z" fill="#FEF9C3" />
    </svg>`,
  },
];
