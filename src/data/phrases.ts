/**
 * phrases.ts — the entire vocabulary of quick chat.
 *
 * There is no free text anywhere in `chat.ts`: every message a player can send is one of the
 * twelve taunts or one of the eight emotes below. Both lists are closed and about the board only —
 * no names, no appearance, no nationality, nothing about the person on the other side. Anything
 * that did not ship in this file cannot be said. Emotes are inline SVG (never emoji), drawn in the
 * app's clay line language and inheriting `currentColor`.
 */

export type ChatEmoteId =
  | 'laugh' | 'cry' | 'angry' | 'cool' | 'shocked' | 'thumbs-up' | 'gg' | 'wave';

export interface ChatEmote {
  id: ChatEmoteId;
  /** Spoken name for assistive tech and the button's tooltip — never shown as text on the wheel. */
  label: string;
  /** A 24×24 inline SVG. Static, first-party markup; `chat.ts` never interpolates user input. */
  svg: string;
}

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const face = `<circle cx="12" cy="12" r="8.8" ${stroke} />`;

/**
 * The twelve taunts. Game-only trash talk: walls, pathing, mines, tempo, the board itself.
 * Order matters only to the wheel, which paints these two-up in exactly this order.
 */
export const TAUNTS: readonly string[] = [
  'Nice try. Your wall did nothing.',
  'Still thinking?',
  'You took the long way. Again.',
  "Walls can't save you.",
  'Tick tock.',
  'I saw that coming.',
  'Go on, step on the mine.',
  'Interesting plan. Is it working?',
  'Oops, my bad.',
  "Good game. Really. I'm laughing.",
  'Your path just got longer.',
  "Calm down, it's just a board.",
];

export const EMOTES: readonly ChatEmote[] = [
  {
    id: 'laugh',
    label: 'Laugh',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${face}
      <path d="M7.6 9.1 9.8 10.4M16.4 9.1 14.2 10.4" ${stroke} />
      <path d="M7.2 13.4h9.6a4.8 4.8 0 0 1-9.6 0Z" fill="currentColor" />
    </svg>`,
  },
  {
    id: 'cry',
    label: 'Cry',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${face}
      <path d="M8.8 10.1h.01M15.2 10.1h.01" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
      <path d="M8.7 16.7q3.3-3.2 6.6 0" ${stroke} />
      <path d="M7 13.1c-.9 1.4-1.3 2.2-1.3 2.8a1.3 1.3 0 0 0 2.6 0c0-.6-.4-1.4-1.3-2.8Z" fill="currentColor" />
      <path d="M17 13.1c-.9 1.4-1.3 2.2-1.3 2.8a1.3 1.3 0 0 0 2.6 0c0-.6-.4-1.4-1.3-2.8Z" fill="currentColor" />
    </svg>`,
  },
  {
    id: 'angry',
    label: 'Angry',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${face}
      <path d="M6.9 8.3 10 9.7M17.1 8.3 14 9.7" ${stroke} />
      <circle cx="9.3" cy="11.9" r="1" fill="currentColor" />
      <circle cx="14.7" cy="11.9" r="1" fill="currentColor" />
      <path d="M8.8 17q3.2-3 6.4 0" ${stroke} />
      <path d="M18.6 6.2 20 4.8M19.6 8.6h2" ${stroke} stroke-width="1.4" />
    </svg>`,
  },
  {
    id: 'cool',
    label: 'Cool',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${face}
      <path d="M3.6 9.4h16.8" ${stroke} />
      <path d="M6.4 9.6c0 2.3.9 3.5 2.8 3.5s2.7-1.1 2.7-3.5M17.6 9.6c0 2.3-.9 3.5-2.8 3.5s-2.7-1.1-2.7-3.5" ${stroke} />
      <path d="M9.4 16.1q2.6 2 5.2 0" ${stroke} />
    </svg>`,
  },
  {
    id: 'shocked',
    label: 'Shocked',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${face}
      <circle cx="9.1" cy="10.2" r="1.5" fill="currentColor" />
      <circle cx="14.9" cy="10.2" r="1.5" fill="currentColor" />
      <ellipse cx="12" cy="16" rx="2.2" ry="2.8" ${stroke} />
      <path d="M12 1.4v1.8M4.2 4.6 5.5 5.9M19.8 4.6 18.5 5.9" ${stroke} stroke-width="1.5" />
    </svg>`,
  },
  {
    id: 'thumbs-up',
    label: 'Thumbs up',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9.4 10.8V5.6a1.9 1.9 0 0 1 3.8 0v3.1h3.3a2 2 0 0 1 1.95 2.6l-1.35 5.4a2.6 2.6 0 0 1-2.5 1.9H9.4Z" ${stroke} />
      <path d="M9.4 10.8H6.1v8h3.3" ${stroke} />
      <path d="M12.6 8.7h2.4" ${stroke} stroke-width="1.4" />
    </svg>`,
  },
  {
    id: 'gg',
    label: 'Good game',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 3.8h10v5.4a5 5 0 0 1-10 0Z" ${stroke} />
      <path d="M7 5.2H4.6a2.5 2.5 0 0 0 2.6 4.6M17 5.2h2.4a2.5 2.5 0 0 1-2.6 4.6" ${stroke} />
      <path d="M12 14.2v3.4M8.6 20.4h6.8M9.6 17.6h4.8" ${stroke} />
      <path d="m10.4 6.6 1.6 1.4 1.6-1.4" ${stroke} stroke-width="1.4" />
    </svg>`,
  },
  {
    id: 'wave',
    label: 'Wave',
    svg: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8.2 12.8 6.5 8.6a1.6 1.6 0 0 1 3-.9l1.6 4.2" ${stroke} />
      <path d="M11 11.8 9.8 6.5a1.6 1.6 0 0 1 3.1-.6l1.2 5.1" ${stroke} />
      <path d="M14.1 11 13.3 7a1.6 1.6 0 0 1 3.1-.6l.9 4.7" ${stroke} />
      <path d="M17.3 11.1l.4-2.2a1.5 1.5 0 0 1 2.9.5l-1.2 6.4a5.4 5.4 0 0 1-5.3 4.4h-.9a5 5 0 0 1-4.3-2.5L6 13.4" ${stroke} />
    </svg>`,
  },
];
