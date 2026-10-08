/**
 * themes.ts — cosmetics as data, and nothing else.
 *
 * Every colour, gradient stop and glow the renderer can paint lives in this file; `render.ts`
 * keeps no palette of its own. The shop, the profile card and the board all read the same objects,
 * so an item can only look in the shop how it looks in play.
 *
 * Two rules the types make impossible to break:
 *  - the other sides are never themed. They are fixed to their own ramps + the Classic material,
 *    so every seat always stays tellable apart whatever you equip;
 *  - a skin's `ramp` is pushed out of both opponent hues by `separate()` before anything reads it,
 *    so no entry — however it is authored later — can make two sides look alike.
 */

/** [offset 0..1, colour]. A colour is a Ramp key ("mid") or any literal CSS colour. */
export type Stop = [number, string];

/** One side's colours. Shared by the ball, its walls, its move dots and its ghost outline. */
export interface Ramp {
  light: string;
  mid: string;
  dark: string;
  /** halo / bloom, an rgba() colour */
  glow: string;
  /** drop shadow as "r,g,b" */
  shade: string;
  /** ball edge stroke */
  edge: string;
  /** wall gradient ends */
  wl: string;
  wd: string;
  /** ghost outlines: quiet preview and loud armed one */
  ol: string;
  os: string;
}

export type Shine = 'soft' | 'metal' | 'glass';

export interface BallSkin {
  id: string;
  name: string;
  desc: string;
  price: number;
  ramp: Ramp;
  /** body radial gradient */
  stops: Stop[];
  /** turn halo strength, 1 = the classic amount */
  halo: number;
  /** bounce light from below, as an alpha */
  bounce: number;
  /** specular strength, 1 = the classic amount */
  gloss: number;
  /** inner rim light, 0 = none */
  ring: number;
  shine: Shine;
}

export interface WallStyle {
  id: string;
  name: string;
  desc: string;
  price: number;
  /** bar thickness, 1 = the classic c * 0.13 */
  thick: number;
  /** body alpha */
  alpha: number;
  /** bloom, 1 = the classic blur */
  glow: number;
  /** highlight alpha */
  gloss: number;
  /** highlight offset, in thicknesses (negative = toward the lit edge) */
  glossAt: number;
  /** crisp edge around the bar, 0 = none */
  rim: number;
  caps: CanvasLineCap;
  /** cross-bar gradient */
  stops: Stop[];
}

export interface BoardTheme {
  id: string;
  name: string;
  desc: string;
  price: number;
  surface: string;
  /** shadow the board casts on the card */
  drop: string;
  grid: string;
  /** border ring: green at FINISH easing into the board's own trim */
  ring: Stop[];
  /** checkered strip: [lit square, dark square] */
  checker: [string, string];
  /** glow under the line */
  glow: Stop[];
  rule: string;
  /** hairline just outside the ring */
  edge: string;
  /** finish light sweep alpha */
  sweep: number;
}

export interface Theme {
  ball: BallSkin;
  wall: WallStyle;
  board: BoardTheme;
}

export type CosKind = 'ball' | 'wall' | 'board';

/* ---------- the two fixed sides ---------- */

/** Yours, with the Classic skin: the look the app shipped with. */
const RED: Ramp = {
  light: '#ffa3b7', mid: '#e0264f', dark: '#80092a', glow: 'rgba(224,38,79,.55)', shade: '90,20,50',
  wl: '#ff6f8d', wd: '#b4113b', edge: 'rgba(90,20,50,.28)', ol: 'rgba(224,38,79,.5)', os: 'rgba(224,38,79,.95)',
};

/** Theirs. Never themed, never for sale. */
export const BOT_RAMP: Ramp = {
  light: '#a6bbff', mid: '#3057db', dark: '#122770', glow: 'rgba(48,87,219,.55)', shade: '20,30,100',
  wl: '#7794ff', wd: '#2142b0', edge: 'rgba(20,30,100,.28)', ol: 'rgba(48,87,219,.5)', os: 'rgba(48,87,219,.95)',
};

/** The rules allow a third team, so a third fixed family exists for it. Also never for sale. */
export const TEAM2_RAMP: Ramp = {
  light: '#8fe3b4', mid: '#17915c', dark: '#0a4d30', glow: 'rgba(23,145,92,.55)', shade: '10,70,50',
  wl: '#4fc98d', wd: '#0c6b41', edge: 'rgba(10,70,50,.28)', ol: 'rgba(23,145,92,.5)', os: 'rgba(23,145,92,.95)',
};

/** An illegal slot. Owns no side, so it keeps the same "no" everywhere. */
export const ERR_RAMP: Ramp = {
  light: '#ffc2c2', mid: '#ff2d55', dark: '#8d0a24', glow: 'rgba(255,45,85,.6)', shade: '120,10,30',
  wl: '#ff9a9a', wd: '#d6173f', edge: 'rgba(120,10,30,.28)', ol: 'rgba(255,45,85,.5)', os: 'rgba(255,45,85,.95)',
};

/* ---------- ball skins ---------- */

export const BALLS: BallSkin[] = [
  {
    id: 'classic', name: 'Classic', price: 0, desc: 'The house red. What the race started with.',
    ramp: RED,
    stops: [[0, 'light'], [0.4, 'mid'], [1, 'dark']],
    halo: 1, bounce: 0.28, gloss: 1, ring: 0, shine: 'soft',
  },
  {
    id: 'neon', name: 'Neon', price: 260, desc: 'Hot core, dark rim and a halo that never quits.',
    ramp: {
      light: '#ff86e0', mid: '#e0268f', dark: '#3d0026', glow: 'rgba(255,45,190,.72)', shade: '70,0,55',
      wl: '#ff9ae8', wd: '#8f0a5a', edge: 'rgba(50,0,40,.45)', ol: 'rgba(255,45,190,.55)', os: 'rgba(255,45,190,1)',
    },
    stops: [[0, '#ffffff'], [0.26, 'light'], [0.66, 'mid'], [1, 'dark']],
    halo: 1.7, bounce: 0.12, gloss: 0.5, ring: 0.75, shine: 'glass',
  },
  {
    id: 'gold', name: 'Gold', price: 520, desc: 'Polished metal: banded highlight, hard little sparkle.',
    ramp: {
      light: '#ffeaa0', mid: '#e2a617', dark: '#6d3f04', glow: 'rgba(226,166,23,.6)', shade: '90,55,10',
      wl: '#ffe08a', wd: '#a3701a', edge: 'rgba(110,63,4,.34)', ol: 'rgba(226,166,23,.5)', os: 'rgba(226,166,23,.95)',
    },
    stops: [[0, '#fffbef'], [0.18, 'light'], [0.42, 'mid'], [0.58, 'light'], [0.78, '#8a5a12'], [1, 'dark']],
    halo: 0.9, bounce: 0.4, gloss: 1.15, ring: 0, shine: 'metal',
  },
  {
    id: 'obsidian', name: 'Obsidian', price: 680, desc: 'Volcanic glass. Quiet, until the ring lights up.',
    ramp: {
      light: '#7b839b', mid: '#242938', dark: '#080a10', glow: 'rgba(60,70,95,.5)', shade: '5,6,12',
      wl: '#8b93ab', wd: '#12151f', edge: 'rgba(200,214,240,.32)', ol: 'rgba(120,132,160,.6)', os: 'rgba(150,162,190,1)',
    },
    stops: [[0, '#aeb8d0'], [0.22, 'light'], [0.6, 'mid'], [1, 'dark']],
    halo: 0.55, bounce: 0.55, gloss: 1.25, ring: 0.2, shine: 'glass',
  },
];

/* ---------- wall styles ---------- */

export const WALLS: WallStyle[] = [
  {
    id: 'classic', name: 'Classic', price: 0, desc: 'The rounded house bar, gloss on the lit edge.',
    thick: 1, alpha: 1, glow: 1, gloss: 0.38, glossAt: -0.18, rim: 0, caps: 'round',
    stops: [[0, 'wl'], [0.5, 'mid'], [1, 'wd']],
  },
  {
    id: 'laser', name: 'Laser', price: 300, desc: 'A thin beam with a blown-out core.',
    thick: 0.7, alpha: 0.95, glow: 3.2, gloss: 0.9, glossAt: 0, rim: 0, caps: 'round',
    stops: [[0, 'mid'], [0.5, 'light'], [1, 'mid']],
  },
  {
    id: 'glass', name: 'Glass', price: 420, desc: 'A pane you can almost see through, edge lit.',
    thick: 1.25, alpha: 0.5, glow: 0.45, gloss: 0.72, glossAt: -0.3, rim: 0.55, caps: 'round',
    stops: [[0, 'light'], [0.45, 'mid'], [1, 'light']],
  },
];

/* ---------- board themes ---------- */

export const BOARDS: BoardTheme[] = [
  {
    id: 'lavender', name: 'Lavender', price: 0, desc: 'Soft lilac court with a green finish glow.',
    surface: '#f7f7fc', drop: 'rgba(88,84,140,.20)', grid: '#d0d0de',
    ring: [[0, '#2fa86f'], [0.06, '#48bb8c'], [0.16, '#8acbb0'], [0.34, '#cbccdd'], [0.62, '#d5d4e4'], [1, '#dbdae9']],
    checker: ['#f4fbf7', '#28a06a'],
    glow: [[0, 'rgba(47,168,111,.30)'], [0.45, 'rgba(47,168,111,.10)'], [1, 'rgba(47,168,111,0)']],
    rule: 'rgba(15,107,69,.32)', edge: 'rgba(255,255,255,.75)', sweep: 0.55,
  },
  {
    id: 'midnight', name: 'Midnight', price: 340, desc: 'Deep indigo. The line burns brighter against it.',
    surface: '#242843', drop: 'rgba(18,20,44,.5)', grid: 'rgba(255,255,255,.13)',
    ring: [[0, '#3ad194'], [0.06, '#2fae7c'], [0.16, '#2a6288'], [0.34, '#39456e'], [0.62, '#333b60'], [1, '#3b4470']],
    checker: ['#eafff6', '#17b373'],
    glow: [[0, 'rgba(56,220,150,.30)'], [0.45, 'rgba(56,220,150,.10)'], [1, 'rgba(56,220,150,0)']],
    rule: 'rgba(190,255,225,.24)', edge: 'rgba(255,255,255,.2)', sweep: 0.4,
  },
  {
    id: 'mint', name: 'Mint', price: 280, desc: 'A pale green pitch with a clean white line.',
    surface: '#eefbf3', drop: 'rgba(70,120,100,.2)', grid: '#c6e2d3',
    ring: [[0, '#2fbf85'], [0.06, '#57cfa0'], [0.16, '#8fdcc0'], [0.34, '#c4e6d6'], [0.62, '#cfe9de'], [1, '#d7eee3']],
    checker: ['#ffffff', '#22a06b'],
    glow: [[0, 'rgba(47,168,111,.26)'], [0.45, 'rgba(47,168,111,.08)'], [1, 'rgba(47,168,111,0)']],
    rule: 'rgba(15,107,69,.28)', edge: 'rgba(255,255,255,.8)', sweep: 0.5,
  },
];

export const CLASSIC_BALL = BALLS[0];
export const CLASSIC_WALL = WALLS[0];
export const CLASSIC_BOARD = BOARDS[0];

export const findBall = (id: string) => BALLS.find((b) => b.id === id) ?? CLASSIC_BALL;
export const findWall = (id: string) => WALLS.find((w) => w.id === id) ?? CLASSIC_WALL;
export const findBoard = (id: string) => BOARDS.find((b) => b.id === id) ?? CLASSIC_BOARD;

const CATALOGS: Record<CosKind, { id: string; price: number }[]> = { ball: BALLS, wall: WALLS, board: BOARDS };

/** Is `id` a real item of this kind? Guards anything read back out of storage. */
export const known = (kind: CosKind, id: string) => CATALOGS[kind].some((x) => x.id === id);

/** What a shop card needs: the label, the price and enough to rebuild a Theme around the item. */
export interface Item { kind: CosKind; id: string; name: string; desc: string; price: number }

const asItems = (kind: CosKind, list: { id: string; name: string; desc: string; price: number }[]): Item[] =>
  list.map((x) => ({ kind, ...x }));

export const ITEMS: Record<CosKind, Item[]> = {
  ball: asItems('ball', BALLS),
  wall: asItems('wall', WALLS),
  board: asItems('board', BOARDS),
};

/** ids → the objects the renderer draws. Unknown ids fall back to the starter item. */
export const themeOf = (ball: string, wall: string, board: string): Theme =>
  ({ ball: safeBall(findBall(ball)), wall: findWall(wall), board: findBoard(board) });

/* ---------- the red / blue guarantee ---------- */

const BOT_HUE = 224;         // BOT_RAMP.mid
const TEAM2_HUE = 154;       // TEAM2_RAMP.mid
const MIN_GAP = 68;          // degrees of hue that count as "clearly not another side"
const MIN_CHROMA = 0.22;     // below this a colour is a grey, and a grey never reads as blue
/** Every seat a skin can never be mistaken for: the opponent and the third team. */
const FOE_HUES = [BOT_HUE, TEAM2_HUE];

interface Col {
  r: number; g: number; b: number;
  /** writes the rotated colour back in the syntax it was parsed from */
  emit: (r: number, g: number, b: number) => string;
}

/** Parses #rgb, #rrggbb, rgb(), rgba() and a bare "r,g,b". */
function parse(c: string): Col | null {
  const hex = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const s = hex[1];
    const n = s.length === 3 ? [s[0] + s[0], s[1] + s[1], s[2] + s[2]] : [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    const [r, g, b] = n.map((h) => parseInt(h, 16));
    return { r, g, b, emit: (R, G, B) => `#${[R, G, B].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` };
  }
  const num = c.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+))?/);
  if (!num) return null;
  const a = num[4] === undefined ? '' : `,${num[4]}`;
  const bare = !c.includes('(');
  return {
    r: +num[1], g: +num[2], b: +num[3],
    emit: bare
      ? (R, G, B) => `${Math.round(R)},${Math.round(G)},${Math.round(B)}`
      : (R, G, B) => `rgba(${Math.round(R)},${Math.round(G)},${Math.round(B)}${a})`,
  };
}

const lim = (v: number) => Math.max(0, Math.min(255, v));
const chroma = (c: Col) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  return mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255));
};
const hue = (c: Col) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
  if (!d) return 0;
  const h = mx === c.r ? ((c.g - c.b) / d) % 6 : mx === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return (h * 60 + 360) % 360;
};
const light = (c: Col) => (Math.max(c.r, c.g, c.b) + Math.min(c.r, c.g, c.b)) / 510;

/** HSL round trip: the only way to land a colour on an exact hue and still keep its feel. */
const toHsl = (r: number, g: number, b: number): [number, number, number] => {
  const [s0, g0, b0] = [r / 255, g / 255, b / 255];
  const mx = Math.max(s0, g0, b0), mn = Math.min(s0, g0, b0), d = mx - mn, l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const h = mx === s0 ? ((g0 - b0) / d) % 6 : mx === g0 ? (b0 - s0) / d + 2 : (s0 - g0) / d + 4;
  return [(h * 60 + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
};
const fromHsl = (h: number, s: number, l: number): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor((((h % 360) + 360) % 360) / 60)];
  return [lim((seg[0] + m) * 255), lim((seg[1] + m) * 255), lim((seg[2] + m) * 255)];
};

/** Moves a colour `deg` around the hue wheel, saturation and lightness untouched. */
function shift(c: Col, deg: number): Col {
  const [h, s, l] = toHsl(c.r, c.g, c.b);
  const [r, g, b] = fromHsl(h + deg, s, l);
  return { r, g, b, emit: c.emit };
}

const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Shift a ramp far enough that its `mid` clears every fixed seat by exactly MIN_GAP, on whichever
 * side is closer. Pale and achromatic ramps pass through untouched: charcoal or ivory cannot be
 * mistaken for a saturated blue or green wherever their hue sits, and shifting them only muddies them.
 */
function separate(ramp: Ramp): Ramp {
  const mid = parse(ramp.mid);
  if (!mid || chroma(mid) < MIN_CHROMA || light(mid) < 0.14 || light(mid) > 0.86) return ramp;
  const h = hue(mid);
  const clear = (x: number) => FOE_HUES.every((f) => gap(x, f) >= MIN_GAP);
  if (clear(h)) return ramp;
  let delta = 0, best = Infinity;
  for (const f of FOE_HUES) for (const s of [MIN_GAP, -MIN_GAP]) {
    const edge = f + s;
    if (!clear(edge)) continue;
    const d = ((edge - h + 540) % 360) - 180;   // shortest rotation onto that edge
    if (Math.abs(d) < best) { best = Math.abs(d); delta = d; }
  }
  if (!Number.isFinite(best)) return ramp;
  const out = {} as Record<keyof Ramp, string>;
  for (const k of Object.keys(ramp) as (keyof Ramp)[]) {
    const c = parse(ramp[k]);
    if (!c) { out[k] = ramp[k]; continue; }
    const s = shift(c, delta);
    out[k] = s.emit(s.r, s.g, s.b);
  }
  return out as Ramp;
}

/**
 * The one way anything gets a theme. A skin's ramp comes back guaranteed tellable apart from
 * BOT_RAMP; every other field is handed on as authored.
 */
export function safeBall(ball: BallSkin): BallSkin {
  const ramp = separate(ball.ramp);
  return ramp === ball.ramp ? ball : { ...ball, ramp };
}

export const DEFAULT_THEME: Theme = themeOf(CLASSIC_BALL.id, CLASSIC_WALL.id, CLASSIC_BOARD.id);
