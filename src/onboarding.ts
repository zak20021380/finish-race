/**
 * onboarding.ts — the GUARANTEED FIRST-MATCH controller (FTUE "win at all costs").
 *
 * One match only, armed by `startGame()` when `storage.isFirstOnboardingEligible()` holds and the
 * board is not a friendly invite room, a server-verified Referral Hard Bot quest, or the standalone
 * scripted lesson (which is already a guaranteed finish). It is a CLIENT side presentation layer:
 * `rules.ts` stays the single source of truth (the Worker imports its
 * `apply` directly), so nothing here forks the engine. Every candidate action is dry-run through
 * `apply(state, action)` on the FULL board and the resulting state is inspected. A rival action is
 * committed only if that resulting state still says `winner === null` and the local player is no
 * worse off. That single invariant is what makes the 100% claim real, including the awkward paths:
 * a ball crossing FINISH, a checkmate, a mine chain's seal, and the anti-oscillation adjudication
 * all set `winner` inside `apply`, so all of them are refused by the same gate.
 *
 * The layers, in the order they are applied:
 *   A. Never-win gate        — no action that produces any winner (or eliminates the player) is legal.
 *      Goal-line brake       — the rival may never stand within GOAL_BRAKE rows of FINISH; it wastes
 *                             turns on lateral steps or harmless edge walls instead.
 *      Zero hostile blocking — the player's shortest path may never grow, all pawns keep a route,
 *                             and rival mines may only sit BEHIND the player, off every route.
 *      Natural pacing        — the standard brain's own choice is kept through the first half; in
 *                             the second half the rival coasts and shadows the player one step back.
 *   B. Player fail-safes     — a self-sealing wall, a step onto a live charge, or any action that
 *                             would end the race against the player is rewritten into the best safe
 *                             forward step. The blitz clock gets double the allowance and its
 *                             timeout plays that same safe forward step.
 *      Forced-win fallback   — `onboardingRivalAction()` returns `null` when the rival has no safe,
 *                             non-winning action left (or the player is boxed in); main.ts answers
 *                             with an immediate opponent resignation in the player's favour.
 *
 * `botAction()` is passed in as `preferred` rather than imported here: the brain keeps reasoning on
 * the fog-of-war projection it has always been fed, while these gates read the full board. That
 * keeps `bot.ts` untouched for every other match and leaves exactly one dispatch seam in main.ts.
 */
import {
  allWalls, apply, ballById, distField, isEliminated, mineCells, pathOn, steps, wallOk,
  type Action, type GameState, type Player,
} from './rules';

/** The rival is never allowed to stand this close to FINISH (row 0). */
const GOAL_BRAKE = 3;
/** In the second half, how often the rival wastes a turn so the player closes the gap naturally. */
const PACE_HOLD_ODDS = 0.55;
/** How many harmless edge slots one held turn will price. */
const WALL_TRIES = 64;

let armed = false;
/** Is the board on screen the one debut match the controller governs? */
export const onboardingActive = (): boolean => armed;
export function activateOnboarding(): void { armed = true; }
export function deactivateOnboarding(): void { armed = false; }

/** The debut seat's blitz allowance, as a multiple of the engine's own turn limit. */
export const ONBOARDING_TURN_GRACE = 2;

const field = (s: GameState): Int16Array => distField(s.walls, s.cols, s.rows);

/** Distance to FINISH of a seat's nearest live pawn; Infinity when it has no runner. */
function teamDistance(s: GameState, team: Player, d: Int16Array): number {
  let best = Infinity;
  for (const b of s.balls) {
    if (b.team !== team || b.isCheckmated) continue;
    const v = pathOn(d, b.pos, s.cols);
    if (v < best) best = v;
  }
  return best;
}

/** Every pawn still in the race reaches FINISH — the anti-stalemate / no-sealing guard. */
function allReach(s: GameState, d: Int16Array): boolean {
  for (const b of s.balls) {
    if (b.isCheckmated) continue;
    if (d[b.pos.r * s.cols + b.pos.c] < 0) return false;
  }
  return true;
}

/**
 * Charges rebuilt as `triggered` are exactly the ones this transition spent: `apply()` carries
 * every other record through by identity (see rules.ts `detached` / `doMove` / `doMine`).
 */
function detonated(before: GameState, after: GameState): boolean {
  return after.mines.some((m) => m.triggered && !before.mines.includes(m));
}

/**
 * A rival charge may only ever sit BEHIND the player. Every shortest route from the player's pawn
 * to FINISH runs through cells whose distance is <= the player's own distance, so refusing that
 * band (plus the four neighbours of every live player pawn, and the FINISH approach) means the
 * charge can never be walked into by the player. The `play()`-door guard is the hard backstop.
 */
function harmlessMine(s: GameState, cell: { c: number; r: number }, localSide: Player): boolean {
  if (cell.c < 0 || cell.c >= s.cols || cell.r < 0 || cell.r >= s.rows) return false;
  if (cell.r <= GOAL_BRAKE) return false;
  const d = field(s);
  const playerD = teamDistance(s, localSide, d);
  const k = cell.r * s.cols + cell.c;
  if (Number.isFinite(playerD) && d[k] >= 0 && d[k] <= playerD) return false;
  for (const b of s.balls) {
    if (b.team !== localSide || b.isCheckmated) continue;
    if (Math.abs(b.pos.c - cell.c) + Math.abs(b.pos.r - cell.r) <= 1) return false;
  }
  return true;
}

/**
 * THE NEVER-WIN GATE. Every rival action is dry-run on the full board before it is committed.
 * `winner !== null` covers a ball crossing FINISH, a checkmate verdict, the last-seat-standing rule
 * AND the anti-oscillation adjudication (which would otherwise hand a stalled race to whichever
 * pawn sits closest to the line — the very thing stalling near the goal would invite).
 */
function rivalSafe(s: GameState, a: Action, me: Player, localSide: Player): boolean {
  const t = apply(s, a);
  if (!t) return false;                                    // illegal on the full board
  if (t.winner !== null) return false;                     // never win, never lose, never adjudicate
  if (isEliminated(t, localSide)) return false;
  const trap = t.checkmate !== s.checkmate ? t.checkmate : null;
  if (trap && trap.teams.includes(localSide)) return false;

  const d0 = field(s);
  const d2 = field(t);
  if (!allReach(t, d2)) return false;                      // no pawn is ever sealed off

  /* Zero hostile blocking: no wall, mine or body may lengthen the player's shortest route. */
  const before = teamDistance(s, localSide, d0);
  const after = teamDistance(t, localSide, d2);
  if (Number.isFinite(before) && !(after <= before)) return false;

  /* Endgame stall: the rival may never step into the last GOAL_BRAKE rows. */
  if (teamDistance(t, me, d2) <= GOAL_BRAKE) return false;

  /* Mines may only ever threaten the machine's own half. */
  if (a.kind === 'mine' && !harmlessMine(s, a.cell, localSide)) return false;
  return true;
}

/**
 * Can the player commit this action without ending the race against themselves? A win is fine
 * (`winner === localSide`); anything else terminal is not. A `move` that spends a charge is the
 * mine-immunity gate — the player's pawn can never be thrown back by any trap, their own included.
 */
function playerSafe(s: GameState, a: Action, localSide: Player): boolean {
  const t = apply(s, a);
  if (!t) return false;
  if (t.winner !== null && t.winner !== localSide) return false;
  if (isEliminated(t, localSide)) return false;
  const trap = t.checkmate !== s.checkmate ? t.checkmate : null;
  if (trap && trap.teams.includes(localSide)) return false;
  const d2 = field(t);
  for (const b of t.balls) {
    if (b.team !== localSide || b.isCheckmated) continue;
    if (d2[b.pos.r * t.cols + b.pos.c] < 0) return false;
  }
  if (a.kind === 'move' && detonated(s, t)) return false;
  return true;
}

/**
 * The best FORWARD step that keeps the seat alive: the timeout's auto-play and the self-sabotage
 * rewrite both land here, so a debut player never loses a turn to a skipped clock or a bad tap.
 */
export function bestSafeStep(s: GameState, localSide: Player): Action | null {
  if (s.winner !== null || s.turn !== localSide) return null;
  const d = field(s);
  const ranked: { a: Action; gain: number; dist: number }[] = [];
  for (const st of steps(s, localSide)) {
    const b = ballById(s, st.ball);
    const from = b ? pathOn(d, b.pos, s.cols) : Infinity;
    const to = pathOn(d, st.to, s.cols);
    const gain = Number.isFinite(from) && Number.isFinite(to) ? from - to : 0;
    ranked.push({ a: { kind: 'move', ball: st.ball, to: st.to }, gain, dist: to });
  }
  ranked.sort((x, y) => y.gain - x.gain || x.dist - y.dist);
  for (const c of ranked) if (playerSafe(s, c.a, localSide)) return c.a;
  return null;
}

/**
 * Rewrite a local action that would hurt the player. Called at the top of `play()` for the local
 * seat only. A `pass` is always safe (it never files a board in the shuffle ledger), so the debut
 * can never be lost to a stray wall or a step onto a buried charge.
 */
export function guardPlayerAction(s: GameState, a: Action, localSide: Player): Action {
  if (s.turn !== localSide || s.winner !== null) return a;
  if (playerSafe(s, a, localSide)) return a;
  /* An ILLEGAL action stays illegal: let `play()` reject it exactly as it always has, so a stray
     tap is never silently promoted into a move the player did not ask for. */
  if (!apply(s, a)) return a;
  return bestSafeStep(s, localSide) ?? { kind: 'pass' };
}

/** True when the player is genuinely boxed in: sealed off, eliminated, or with no legal step. */
export function playerIsStuck(s: GameState, localSide: Player): boolean {
  if (s.winner !== null) return false;
  if (isEliminated(s, localSide)) return true;
  const d = field(s);
  let live = 0;
  for (const b of s.balls) {
    if (b.team !== localSide || b.isCheckmated) continue;
    live++;
    if (d[b.pos.r * s.cols + b.pos.c] < 0) return true;
  }
  if (!live) return true;
  return s.turn === localSide && steps(s, localSide).length === 0;
}

/**
 * Pick the rival's turn. `preferred` is the standard brain's own choice (or the lesson's
 * deterministic step); it is kept whenever it is safe, which is what makes the first half of the
 * board feel like a real race. `hold` is false during the scripted lesson and its live-play
 * intermission, whose choreography needs the rival to gain its two rows.
 *
 * A `null` answer is the ULTIMATE FALLBACK: no safe, non-winning action is left, so the caller
 * awards the player an immediate opponent resignation rather than letting the rival play a winner.
 */
export function onboardingRivalAction(
  s: GameState,
  localSide: Player,
  preferred: Action | null,
  hold: boolean,
): Action | null {
  if (s.winner !== null) return null;
  const me = s.turn;
  const d = field(s);
  const myD = teamDistance(s, me, d);
  const foeD = teamDistance(s, localSide, d);
  const half = Math.max(GOAL_BRAKE + 2, Math.floor(s.rows * 0.55));
  const secondHalf = myD <= half || foeD <= half;
  /* In the second half the rival is kept at least one step behind the player, and never closer
     than GOAL_BRAKE + 1 to the line. It therefore crosses behind them, every single time. */
  const ceiling = Math.max(GOAL_BRAKE + 1, foeD + 1);
  const mustHold = hold && secondHalf && myD <= ceiling;
  const coast = hold && secondHalf && !mustHold && myD <= ceiling + 2
    && Math.random() < PACE_HOLD_ODDS;

  /* 1. Natural pacing: keep the ordinary AI's decision while the race is genuinely open. */
  if (preferred && !mustHold && !coast && rivalSafe(s, preferred, me, localSide)) return preferred;

  /* 2. Steps. When holding, lateral/backward squares are tried first; otherwise the biggest
        forward gain wins. Every single one still passes through the never-win gate. */
  const ranked: { a: Action; cost: number; dist: number }[] = [];
  for (const st of steps(s, me)) {
    const b = ballById(s, st.ball);
    const from = b ? pathOn(d, b.pos, s.cols) : Infinity;
    const to = pathOn(d, st.to, s.cols);
    const gain = Number.isFinite(from) && Number.isFinite(to) ? from - to : 0;
    ranked.push({
      a: { kind: 'move', ball: st.ball, to: st.to },
      cost: mustHold || coast ? (gain > 0 ? 10 + gain : -gain) : -gain,
      dist: to,
    });
  }
  ranked.sort((x, y) => x.cost - y.cost || x.dist - y.dist);
  for (const c of ranked) if (rivalSafe(s, c.a, me, localSide)) return c.a;

  /* 3. Harmless EDGE walls — the "waste a turn" the goal-line brake asks for. `rivalSafe` still
        refuses any bar that lengthens the player's own route or seals a pawn. */
  let tried = 0;
  for (const w of allWalls(me, s.cols, s.rows)) {
    if (tried >= WALL_TRIES) break;
    const edge = w.o === 'h'
      ? (w.x === 0 || w.x === s.cols - 2)
      : (w.y === 0 || w.y === s.rows - 2);
    if (!edge) continue;
    tried++;
    if (!wallOk(s, w)) continue;
    const a: Action = { kind: 'wall', wall: w };
    if (rivalSafe(s, a, me, localSide)) return a;
  }

  /* 4. A charge buried behind the player can only ever bite the machine. */
  for (const cell of mineCells(s, me)) {
    if (!harmlessMine(s, cell, localSide)) continue;
    const a: Action = { kind: 'mine', cell };
    if (rivalSafe(s, a, me, localSide)) return a;
  }

  /* 5. Zero legal non-winning actions: hand the caller the forced-resignation signal. */
  return null;
}
