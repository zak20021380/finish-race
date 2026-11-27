/**
 * verify-matches.mjs — the server-authoritative match ledger, asserted directly.
 *
 * `worker/matches.ts` is pure: no Durable Object, no storage, no clock of its own. Everything the
 * settlement door promises is therefore a function, and every promise is checked here:
 *
 *   - the mode vocabulary, and that only `pvp` mints a leaderboard point;
 *   - `matchFinishGate` in order — unknown id, non-participant, spent receipt, instant submit,
 *     stale tab, impossible winner, self-pairing;
 *   - the exact 15-second floor: 14,999 ms is refused, 15,000 ms passes;
 *   - `completeMatch` paying the winner and nothing to the loser;
 *   - the friendly-pair allowance: two boards a day per pairing, order-independent, rolled at UTC
 *     midnight, and charged only when a board actually settles;
 *   - the per-seat rate window: the allowance, the refusal, the retry hint, and key isolation;
 *   - the sweep: abandoned rows expire unpaid, old rows are forgotten, the cap is honoured;
 *   - operator exclusion, from `ADMIN_IDS` and from the room's appointed roles;
 *   - the defensive parse: a corrupt row is dropped, never fatal.
 *
 *   node --experimental-strip-types scripts/verify-matches.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const M = await import(pathToFileURL(path.resolve('worker/matches.ts')).href);

const {
  MATCH_MIN_MS, MATCH_MAX_AGE_MS, MATCH_KEEP_MS, MATCH_OPEN_MAX, MATCHES_MAX,
  FRIENDLY_PAIR_DAILY_MAX, PVP_PAIR_DAILY_MAX, MATCH_RATE, MATCH_REWARD, MATCH_NO_REWARD,
  matchKindOf, countsForLeaderboard, rewardFor, matchSeatOf,
  newMatchRecord, readMatchRecord, readMatchLedger, matchFinishGate, completeMatch, expireMatch,
  friendlyPairKey, friendlyQuotaKey, friendlyQuotaSpent, chargeFriendlyQuota, trimFriendlyQuota,
  trimMatchLedger, openMatchesOf, RateWindow, isOperatorSeat, utcDay,
} = M;

let ran = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  ran += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const ME = 'tg-100000001';
const RIVAL = 'tg-200000002';

console.log('\n-- the vocabulary --');
ok('the three modes are accepted', matchKindOf('pvp') === 'pvp' && matchKindOf('friendly') === 'friendly' && matchKindOf('ai') === 'ai');
ok('anything else is refused', matchKindOf('ranked') === null && matchKindOf('') === null && matchKindOf(7) === null);
ok('only pvp counts for the leaderboard',
  countsForLeaderboard('pvp') && !countsForLeaderboard('friendly') && !countsForLeaderboard('ai'));
ok('a pvp win pays ladder points', rewardFor('pvp', true).tiq > 0);
ok('a friendly win pays no ladder points', rewardFor('friendly', true).tiq === 0);
ok('an ai win pays no ladder points', rewardFor('ai', true).tiq === 0);
ok('a defeat pays nothing at all',
  JSON.stringify(rewardFor('pvp', false)) === JSON.stringify(MATCH_NO_REWARD));
ok('the reward is copied, not shared', rewardFor('pvp', true) !== MATCH_REWARD.pvp);

console.log('\n-- seat normalization --');
ok('a bare numeric id becomes a tg seat', matchSeatOf('12345') === 'tg-12345');
ok('a tg seat survives', matchSeatOf('tg-12345') === 'tg-12345');
ok('the literal ai survives', matchSeatOf('ai') === 'ai');
ok('a guest seat survives', matchSeatOf('guest-abcdef12') === 'guest-abcdef12');
ok('a forged seat is refused', matchSeatOf('tg-../../etc') === '' && matchSeatOf('admin') === '');

console.log('\n-- the 15-second floor --');
const fresh = newMatchRecord('m-1', ME, RIVAL, 'pvp', T0);
ok('a new row is active and unpaid', fresh.status === 'active' && fresh.reward.tiq === 0 && fresh.winnerId === '');
ok('14,999 ms is too fast', matchFinishGate(fresh, ME, ME, T0 + MATCH_MIN_MS - 1) === 'too_fast');
ok('15,000 ms passes', matchFinishGate(fresh, ME, ME, T0 + MATCH_MIN_MS) === null);
ok('a stale tab is expired', matchFinishGate(fresh, ME, ME, T0 + MATCH_MAX_AGE_MS + 1) === 'expired');

console.log('\n-- the participant gate --');
const stranger = newMatchRecord('m-2', ME, RIVAL, 'pvp', T0);
ok('the opener is a participant', matchFinishGate(stranger, ME, ME, T0 + 20_000) === null);
ok('the rival is a participant', matchFinishGate(stranger, RIVAL, ME, T0 + 20_000) === null);
ok('a stranger is not', matchFinishGate(stranger, 'tg-999', ME, T0 + 20_000) === 'not_participant');
ok('a stranger learns nothing about liveness',
  matchFinishGate({ ...stranger, status: 'completed' }, 'tg-999', ME, T0 + 20_000) === 'not_participant');
ok('an unknown id is unknown', matchFinishGate(null, ME, ME, T0 + 20_000) === 'unknown_match');

console.log('\n-- the winner gate --');
const winner = newMatchRecord('m-3', ME, RIVAL, 'pvp', T0);
ok('a third party cannot be the winner', matchFinishGate(winner, ME, 'tg-999', T0 + 20_000) === 'bad_winner');
const selfPaired = newMatchRecord('m-4', ME, ME, 'pvp', T0);
ok('a self-pairing is refused', matchFinishGate(selfPaired, ME, ME, T0 + 20_000) === 'self_opponent');

console.log('\n-- the atomic flip --');
const settling = newMatchRecord('m-5', ME, RIVAL, 'pvp', T0);
ok('the row passes the gate once', matchFinishGate(settling, ME, ME, T0 + 20_000) === null);
completeMatch(settling, ME, T0 + 20_000);
ok('the row is completed', settling.status === 'completed' && settling.completedAt === T0 + 20_000);
ok('the winner is recorded', settling.winnerId === ME);
ok('the winner was paid the pvp line',
  settling.reward.tiq === MATCH_REWARD.pvp.tiq && settling.reward.coins === MATCH_REWARD.pvp.coins);
ok('THE REPLAY IS REFUSED', matchFinishGate(settling, ME, ME, T0 + 21_000) === 'not_active');
ok('a friendly win pays no ladder points',
  (() => {
    const row = newMatchRecord('m-6', ME, RIVAL, 'friendly', T0);
    completeMatch(row, ME, T0 + 20_000);
    return row.reward.tiq === 0 && row.reward.coins > 0;
  })());
ok('a loser is paid nothing',
  (() => {
    const row = newMatchRecord('m-7', ME, RIVAL, 'pvp', T0);
    completeMatch(row, RIVAL, T0 + 20_000);
    return row.reward.tiq === 0 && row.reward.coins === 0;
  })());

console.log('\n-- the pairing allowance --');
const day = utcDay(T0);
const pair = friendlyPairKey(ME, RIVAL);
ok('the pairing key is order-independent', pair === friendlyPairKey(RIVAL, ME));
const quota = {};
ok('a fresh pairing may play', friendlyQuotaSpent(quota, pair, day) === false);
chargeFriendlyQuota(quota, pair, day);
ok('one board still leaves room', friendlyQuotaSpent(quota, pair, day) === false);
chargeFriendlyQuota(quota, pair, day);
ok(`after ${FRIENDLY_PAIR_DAILY_MAX} the friendly pairing is capped`, friendlyQuotaSpent(quota, pair, day) === true);
ok('another pairing is unaffected', friendlyQuotaSpent(quota, friendlyPairKey(ME, 'tg-3'), day) === false);
ok('the next day is a fresh allowance', friendlyQuotaSpent(quota, pair, day + 1) === false);
ok('the quota key names the day', friendlyQuotaKey(pair, day).endsWith(`|${day}`));
ok('the quota key names its kind', friendlyQuotaKey(pair, day, 'pvp').startsWith('pvp:'));
trimFriendlyQuota(quota, day + 1);
ok("yesterday's row is swept", Object.keys(quota).length === 0);

console.log('\n-- the ranked allowance (the two-account farm gate) --');
const ranked = {};
let rankedWins = 0;
for (let i = 0; i < PVP_PAIR_DAILY_MAX + 3; i++) {
  if (!friendlyQuotaSpent(ranked, pair, day, 'pvp')) {
    chargeFriendlyQuota(ranked, pair, day, 'pvp');
    rankedWins += 1;
  }
}
ok(`a ranked pairing is worth exactly ${PVP_PAIR_DAILY_MAX} wins a day`, rankedWins === PVP_PAIR_DAILY_MAX);
ok('the ranked cap is separate from the friendly one',
  friendlyQuotaSpent(ranked, pair, day, 'friendly') === false);
ok('a different rival is a different allowance',
  friendlyQuotaSpent(ranked, friendlyPairKey(ME, 'tg-3'), day, 'pvp') === false);
ok('the ranked cap rolls with the day', friendlyQuotaSpent(ranked, pair, day + 1, 'pvp') === false);

console.log('\n-- the rate window --');
const rates = new RateWindow();
let allowed = 0;
for (let i = 0; i < MATCH_RATE.start.limit; i++) {
  if (rates.take('start:me', MATCH_RATE.start, T0 + i).ok) allowed += 1;
}
ok(`the allowance is exactly ${MATCH_RATE.start.limit}`, allowed === MATCH_RATE.start.limit);
const blocked = rates.take('start:me', MATCH_RATE.start, T0 + 100);
ok('the next call is refused', blocked.ok === false);
ok('the refusal says when to retry', blocked.retryAfterMs > 0 && blocked.retryAfterMs <= MATCH_RATE.start.windowMs);
ok('another seat is unaffected', rates.take('start:other', MATCH_RATE.start, T0 + 100).ok === true);
ok('a different door has its own allowance', rates.take('end:me', MATCH_RATE.end, T0 + 100).ok === true);
ok('the window rolls forward', rates.take('start:me', MATCH_RATE.start, T0 + MATCH_RATE.start.windowMs + 1).ok === true);
rates.clear();
ok('clear() forgets everything', rates.take('start:me', MATCH_RATE.start, T0 + 200).ok === true);

console.log('\n-- open rows per seat --');
const open = [
  newMatchRecord('o-1', ME, RIVAL, 'pvp', T0),
  newMatchRecord('o-2', ME, 'ai', 'ai', T0),
  newMatchRecord('o-3', 'tg-other', RIVAL, 'pvp', T0),
];
ok('the seat holds two open rows', openMatchesOf(open, ME) === 2);
ok('a settled row is not open', openMatchesOf([{ ...open[0], status: 'completed' }], ME) === 0);
ok('the cap is a small number', MATCH_OPEN_MAX >= 1 && MATCH_OPEN_MAX <= 5);

console.log('\n-- the sweep --');
const stale = newMatchRecord('s-1', ME, RIVAL, 'pvp', T0);
const settledRow = newMatchRecord('s-2', ME, RIVAL, 'pvp', T0);
completeMatch(settledRow, ME, T0 + 20_000);
const ancient = newMatchRecord('s-3', ME, RIVAL, 'pvp', T0 - MATCH_KEEP_MS - 1);
const state = { matches: [stale, settledRow, ancient], friendly: {} };
trimMatchLedger(state, T0 + MATCH_MAX_AGE_MS + 1);
ok('an abandoned open row is expired', stale.status === 'expired' && stale.reward.tiq === 0);
ok('a settled row is kept', state.matches.some((row) => row.matchId === 's-2'));
ok('a row past the keep window is forgotten', !state.matches.some((row) => row.matchId === 's-3'));
ok('an expired row never becomes payable',
  matchFinishGate(stale, ME, ME, T0 + MATCH_MAX_AGE_MS + 2) === 'not_active');

console.log('\n-- the cap --');
const flood = { matches: [], friendly: {} };
for (let i = 0; i < MATCHES_MAX + 50; i++) {
  const row = newMatchRecord(`f-${i}`, ME, RIVAL, 'ai', T0 + i);
  completeMatch(row, ME, T0 + i + 20_000);
  flood.matches.push(row);
}
trimMatchLedger(flood, T0 + 100_000);
ok(`the ledger is capped at ${MATCHES_MAX}`, flood.matches.length <= MATCHES_MAX);
ok('the newest rows survive', flood.matches.some((row) => row.matchId === `f-${MATCHES_MAX + 49}`));

console.log('\n-- operator exclusion --');
const env = { ADMIN_IDS: '1350508522, 42' };
const appointed = new Set(['tg-777', '888']);
ok('a root admin is an operator', isOperatorSeat('tg-1350508522', env, appointed) === true);
ok('a whitespace-padded root is still a root', isOperatorSeat('tg-42', env, appointed) === true);
ok('an appointed seat is an operator', isOperatorSeat('tg-777', env, appointed) === true);
ok('an appointed bare id is an operator', isOperatorSeat('tg-888', env, appointed) === true);
ok('a normal player is not', isOperatorSeat('tg-100000001', env, appointed) === false);
ok('a guest is not', isOperatorSeat('guest-abcdef12', env, appointed) === false);
ok('an empty allowlist excludes nobody', isOperatorSeat('tg-1350508522', {}, appointed) === false);

console.log('\n-- the defensive parse --');
ok('a garbage row is dropped', readMatchRecord(null) === null && readMatchRecord({}) === null);
ok('a row without a mode is dropped', readMatchRecord({ matchId: 'x', player1Id: ME, startedAt: T0 }) === null);
const revived = readMatchRecord({
  matchId: 'r-1', player1Id: ME, player2Id: RIVAL, mode: 'pvp',
  status: 'completed', startedAt: T0, completedAt: T0 + 20_000, winnerId: ME,
  reward: { tiq: 25, coins: 40, xp: 30 },
});
ok('a valid row survives a round trip',
  revived.matchId === 'r-1' && revived.status === 'completed' && revived.reward.tiq === 25);
ok('an unknown status reads as active',
  readMatchRecord({ matchId: 'r-2', player1Id: ME, mode: 'ai', startedAt: T0, status: 'hacked' }).status === 'active');
const ledger = readMatchLedger({
  matches: [{ matchId: 'r-1', player1Id: ME, mode: 'pvp', startedAt: T0 }, null, 'nope'],
  friendly: { [`${pair}|${day}`]: 2, junk: -5 },
});
ok('a mixed ledger keeps only its readable rows', ledger.matches.length === 1);
ok('the quota is read back', ledger.friendly[`${pair}|${day}`] === 2);
ok('a negative quota is dropped', !('junk' in ledger.friendly));
ok('an empty ledger is safe', readMatchLedger(undefined).matches.length === 0);

console.log(`\n${ran - failed}/${ran} checks passed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
console.log('match ledger verification passed');
