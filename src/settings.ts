/**
 * settings.ts — the switches and the last menu choice. Storage itself is `storage.ts`'s door:
 * every access there is wrapped, so a webview that refuses localStorage still gets a working app.
 */
import type { Difficulty } from './bot';
import { readJson, writeJson } from './storage';

export type Mode = 'bot' | 'online';
/** Which tier of the launcher is showing: a solo race, or two sides. */
export type ModeTab = 'solo' | 'party';
/** The race stage's finish: the classic midnight arena, or the pearl chessboard. */
export type Appearance = 'dark' | 'light';

export interface Settings {
  /** the engine's step, wall and blast effects and the matchmaking chime */
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
  /** Light Mode is a race-stage finish, not an app-wide skin: the arena turns pearl, the shell stays. */
  appearance: Appearance;
}

export type LangCode = 'en' | 'fa' | 'ru' | 'ar' | 'es';

export interface LangDef {
  code: LangCode;
  /** short english label for debugging */
  label: string;
  /** native name shown in the picker */
  native: string;
  flag: string;
  dir: 'ltr' | 'rtl';
}

export const LANGS: LangDef[] = [
  { code: 'en', label: 'English', native: 'English', flag: '🇬🇧', dir: 'ltr' },
  { code: 'fa', label: 'Persian', native: 'فارسی', flag: '🇮🇷', dir: 'rtl' },
  { code: 'ru', label: 'Russian', native: 'Русский', flag: '🇷🇺', dir: 'ltr' },
  { code: 'ar', label: 'Arabic', native: 'العربية', flag: '🇸🇦', dir: 'rtl' },
  { code: 'es', label: 'Spanish', native: 'Español', flag: '🇪🇸', dir: 'ltr' },
];

export const langDef = (code: LangCode): LangDef =>
  LANGS.find((l) => l.code === code) ?? LANGS[0];

export interface MenuState {
  mode: Mode;
  tab: ModeTab;
  difficulty: Difficulty;
  /** balls per side for a race, 1 to 3 each — the solo tier always holds [1, 1] */
  sizes: [number, number];
}

const S_KEY = 'detour.settings.v1';
const M_KEY = 'detour.menu.v1';
const DEFAULT_SETTINGS: Settings = { sound: true, haptics: true, reducedMotion: false, appearance: 'dark' };
const DEFAULT_MENU: MenuState = { mode: 'bot', tab: 'solo', difficulty: 'normal', sizes: [1, 1] };

const motion = matchMedia('(prefers-reduced-motion: reduce)');
let systemReduce = motion.matches;
try { motion.addEventListener('change', (e) => { systemReduce = e.matches; }); } catch { /* fixed at load */ }

export const settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Settings>(S_KEY) };
export const menuState: MenuState = { ...DEFAULT_MENU, ...readJson<MenuState>(M_KEY) };
if (settings.appearance !== 'light') settings.appearance = 'dark';
if (menuState.difficulty !== 'easy' && menuState.difficulty !== 'hard') menuState.difficulty = 'normal';
if (menuState.mode !== 'bot') menuState.mode = 'bot';
if (menuState.tab !== 'party') menuState.tab = 'solo';

/** Two sides of 1 to 3 balls: the mode select writes this, the race reads it. */
const clampSize = (n: unknown) => Math.max(1, Math.min(3, typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1));
menuState.sizes = Array.isArray(menuState.sizes) && menuState.sizes.length === 2
  ? [clampSize(menuState.sizes[0]), clampSize(menuState.sizes[1])]
  : [...DEFAULT_MENU.sizes];
/* a save from before the tiers existed only said how many balls each side had */
if (menuState.tab === 'solo' && (menuState.sizes[0] !== 1 || menuState.sizes[1] !== 1)) menuState.tab = 'party';

/* ---------- language: persisted choice + live event ---------- */

const L_KEY = 'detour.lang.v1';
const LANG_SET = new Set<string>(LANGS.map((l) => l.code));

function readLang(): LangCode {
  try {
    const raw = window.localStorage.getItem(L_KEY);
    if (raw && LANG_SET.has(raw)) return raw as LangCode;
    /* first run: honour the Telegram / browser language when it maps cleanly.
       Read Telegram globals directly (no import) to avoid a cycle with telegram.ts. */
    const w = window as unknown as {
      Telegram?: { WebApp?: { initDataUnsafe?: { language_code?: string }; languageCode?: string } };
    };
    const tgLc = w.Telegram?.WebApp?.initDataUnsafe?.language_code ?? w.Telegram?.WebApp?.languageCode ?? '';
    for (const cand of [tgLc, navigator.language || '']) {
      const base = (cand || '').toLowerCase().split('-')[0];
      if (LANG_SET.has(base)) return base as LangCode;
    }
  } catch { /* storage refused — fall through to English */ }
  return 'en';
}

export let lang: LangCode = readLang();

type LangWatcher = (code: LangCode) => void;
const langWatchers: LangWatcher[] = [];

/**
 * Publishes the active language as `data-lang`, never as a global `dir`. Flipping the
 * document would mirror every flex row, dock split, board coordinate and progress fill;
 * Persian gets its direction surgically, in `style.css`, on text containers only.
 */
function paintLangAttrs() {
  try {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.removeAttribute('dir');
  } catch { /* headless */ }
}

export function t(key: string): string {
  const table = STRINGS[lang] ?? STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

export function setLang(code: LangCode) {
  if (!LANG_SET.has(code)) return;
  const changed = code !== lang;
  lang = code;
  /* persist even when the pick matches the current language: that is the manual choice
     that must win over Telegram's language on the next launch */
  try { window.localStorage.setItem(L_KEY, code); } catch { /* stay in memory */ }
  if (!changed) return;
  paintLangAttrs();
  for (const w of [...langWatchers]) { try { w(lang); } catch { /* watcher threw */ } }
  try {
    window.dispatchEvent(new CustomEvent<LangCode>('detour:lang', { detail: lang }));
  } catch { /* no window */ }
}

export function onLang(w: LangWatcher): () => void {
  langWatchers.push(w);
  return () => {
    const i = langWatchers.indexOf(w);
    if (i >= 0) langWatchers.splice(i, 1);
  };
}

/* UI strings for the Settings overhaul. Keys are referenced from `data-i18n`
   attributes so a language switch repaints without a reload. */
export const STRINGS: Record<LangCode, Record<string, string>> = {
  en: {
    settingsTitle: 'Settings',
    gameplayAudio: 'Gameplay & Audio',
    language: 'Language',
    languageSub: 'App language · applies instantly',
    sound: 'Sound',
    haptics: 'Haptics',
    communitySupport: 'Community & Support',
    pieceColor: 'Piece Color',
    pieceColorSub: 'Your pieces · the rival takes the other colour',
    tgChannel: 'Official Telegram Channel',
    tgChannelSub: 'News, cups and squad events',
    contactAdmin: 'Contact Admin',
    contactAdminSub: 'Direct help, inquiries & feedback',
    versionBadge: 'Tactix v1.0.0 · Local Save',
    /* ---- personal standing bar (Nations Cup + The Mind Ladder) ---- */
    hudYou: 'You',
    hudTop: 'Top',
    hudUnranked: 'Unranked',
    hudYourNation: 'Your nation',
    hudPickNation: 'Pick in Profile',
    chooseLanguage: 'Choose language',
    chooseLanguageSub: 'Applies instantly to the whole app.',
    cancel: 'Cancel',
    supportTitle: 'Contact Support',
    supportCatFeedback: 'Feedback',
    supportCatBug: 'Bug Report',
    supportCatStars: 'Stars Help',
    supportSend: 'Send Message',
    supportSending: 'Sending…',
    supportOk: 'Message sent to admins!',
    supportPlaceholder: 'Write your message or feedback here...',
    /* ---- shared tokens ---- */
    play: 'PLAY',
    searching: 'SEARCHING',
    change: 'Change',
    friends: 'FRIENDS',
    quick: 'QUICK',
    practice: 'PRACTICE',
    coins: 'Coins',
    nation: 'Nation',
    nationalDivision: 'National division',
    squadWord: 'Squad',
    members: 'Members',
    leave: 'Leave',
    invite: 'Invite',
    inviteFriend: 'Invite',
    /* ---- play dock & mode drawer ---- */
    dockQuick: 'SOLO',
    dockParty: '2v2',
    dockPractice: 'BOT',
    dockFriends: 'FRIENDS',
    modeDuel: '1v1 Duel',
    modeParty: '2v2 Party',
    modeBot: 'vs Bot',
    modeRoom: 'Custom Room',
    modeRoomCode: 'Room {code}',
    subDuel: 'Ranked · ~5s queue',
    subParty: 'Ranked · ~8s queue',
    subPractice: 'Offline Practice',
    subRoomCode: 'Private · Friends only',
    subRoom: 'Private · Create or join',
    startMatch: 'Start Match',
    start1v1: 'Start 1v1 match',
    start2v2: 'Start 2v2 match',
    startPrivate: 'Start private match',
    startPractice: 'Start practice match',
    startPracticeN: 'Start {n}-player match',
    waitingHost: 'Waiting for host…',
    win: 'Win',
    practiceLead: 'Practice',
    trophiesUnit: 'trophies',
    coinsUnit: 'coins',
    /* ---- friends drawer & lobby ---- */
    selectGameMode: 'Select Game Mode',
    pickHowRace: 'Pick how you want to race',
    playWithFriends: 'Play with Friends',
    friendsLobbySub: 'Invite friends, pick a format, start together',
    friendsEntrySub: 'Create a room or join with a code',
    quickMatch: 'Quick match',
    quickDesc: 'Undergoing elite server tuning · Live soon',
    friendsMode: 'Play with friends',
    friendsModeDesc: 'Invite friends directly via Telegram link',
    practiceMode: 'Practice vs Bot',
    practiceModeDesc: 'No pressure, train your skills',
    customMatchmaking: 'Custom Matchmaking',
    customMatchmakingDesc: 'Filter by Region & Skill tier',
    unlocksLevel5: 'Unlocks at Level 5',
    soon: 'Soon',
    difficultyEasy: 'Easy',
    difficultyNormal: 'Normal',
    difficultyHard: 'Hard',
    createRoom: 'Create New Room',
    createRoomSub: 'You host · pick a format',
    orJoinCode: 'or join with a code',
    enterCode: 'Enter 4-digit code',
    join: 'Join',
    copyLink: 'Copy Link',
    inviteLinkCopied: 'Invite link copied!',
    copyFailed: 'Could not copy the invite link.',
    roomCode: 'Room code',
    roomCodeOf: 'Room code {code}',
    copyInviteFor: 'Copy invite link for room {code}',
    players: 'Players',
    hintInviteMore: 'Invite one more player to start',
    hintReadyHost: 'All set — start the match',
    hintWaitingHost: 'Waiting for host…',
    waitingForHost: 'Waiting for Host...',
    lobbyHostAwaySub: 'Host notified — waiting for them to return...',
    lobbyHostPendingSub: 'Waiting for the host to open this room…',
    lobbyBannerJoined: '⚔️ {name} joined your lobby!',
    lobbyBannerSub: 'Lobby #{code} · Your seat is ready',
    joinNow: 'JOIN NOW',
    waitForNow: 'WAIT',
    addBot: 'Add bot',
    host: 'Host',
    bot: 'Bot',
    you: 'You',
    ready: 'Ready',
    colorBlue: 'Blue',
    colorRed: 'Red',
    colorGreen: 'Green',
    colorYellow: 'Yellow',
    teamBlue: 'Team Blue',
    teamOrange: 'Team Orange',
    switchTeamTo: 'Tap to switch {name} to {team}',
    openSeatInvite: 'Open seat {n}: invite a friend',
    fmtDuel: 'Head-to-head duel · First to the finish wins',
    fmt3p: '3-player free-for-all · Everyone for themselves',
    fmt4p: '4-player free-for-all · Everyone for themselves',
    fmt2v2: '2v2 team match · Team Blue vs Team Orange',
    errRoomNotFound: 'No room with that code.',
    errRoomFull: 'That room is already full.',
    errRoomExists: 'That code is already open. Try joining it.',
    errInviteExpired: 'This invite link has already been used or expired.',
    errRoomClosed: 'The host closed the room.',
    errRoomExpired: 'This room has expired.',
    errReconnecting: 'Reconnecting to the room…',
    seatReconnecting: 'Reconnecting…',
    errStartOffline: 'Your friend is reconnecting — the match can start as soon as they are back.',
    errMaintenance: 'Matchmaking is paused. Try again soon.',
    errBanned: 'This account cannot join rooms.',
    errJoinUnknown: 'Could not join that room.',
    errCode: 'Enter the 4-digit room code.',
    errDropped: 'The room connection dropped. Try again.',
    /* ---- the duel face-off ---- */
    inviteFriendFull: 'Invite Friend',
    rivalWaiting: 'Waiting for a rival',
    rival: 'Rival',
    countdownKicker: 'Room ready · All seated',
    duelStartsIn: 'Match starts in {n}…',
    fight: 'FIGHT!',
    fightLine: 'Everyone seated — go',
    cancelMatch: 'Cancel match',
    /* ---- squads ---- */
    joinSquad: 'Join Squad',
    joinASquad: 'Join a Squad',
    joinSquadDesc: 'Join a Telegram clan or register your own',
    createSquad: 'Create Squad',
    searchSquads: 'Search squads or @channel',
    exploreSquads: 'Explore Squads',
    yourSquad: 'Your Squad',
    openSquadHub: 'Open Squad Hub',
    leaveSquad: 'Leave squad',
    leader: 'Leader',
    admin: 'Admin',
    member: 'Member',
    searchMembers: 'Search members',
    noSquadMatch: 'No squad matches that.',
    noSquadsYet: 'No squads yet.',
    noMembersMatch: 'No members match that search.',
    backToList: 'Back to List',
    squadIntel: 'Squad Intel',
    squadRank: 'Rank',
    allianceTiq: 'Alliance TIQ',
    squadPower: 'Squad power',
    activeRacers: 'Active racers',
    squadLore: 'Race in Arena to earn stars & rank up this squad!',
    squadFine: 'Your TIQ banks for this squad in every Arena match.',
    officialChannel: 'Official Telegram channel',
    officialGroup: 'Official Telegram group',
    newAlliance: 'New Telegram alliance',
    goldMedal: 'Gold Medal',
    silverMedal: 'Silver Medal',
    bronzeMedal: 'Bronze Medal',
    globalPosition: 'Global position',
    awaitingRank: 'Awaiting rank',
    newChannel: 'New channel',
    freshRoster: 'Starts a fresh roster',
    badChannel: 'That channel cannot be bound. Try @channel.',
    bindHandle: 'Bind {handle}',
    searchSquadHint: 'Search a squad or type a channel like @your_channel.',
    squadChannelHint: 'Type a channel like @your_channel.',
    squadFineJoined: 'You represent {handle}. Every Arena point you score banks for this squad.',
    squadFineJoin: 'Joining banks your Arena TIQ for {handle} and its {n} racers.',
    squadFineNew: 'A fresh squad will be minted for {handle} on this device.',
    /* ---- squad detail sheet ---- */
    squadRead: 'Squad read',
    squadTgGroup: 'Telegram Group',
    squadTgChannel: 'Telegram Channel',
    squadAvgIq: 'Avg IQ',
    squadYourShare: 'Your share',
    squadNotEnlisted: 'Not Enlisted',
    squadJoinCta: 'Join Squad',
    squadViewChannel: 'View Channel',
    squadLeague: '{n} squads in this league',
    percentile: 'Percentile',
    addCountry: 'Add country',
    communitySquads: 'Community squads',
    coinsWhenSet: 'Coins when set',
    rewardReady: 'Reward ready',
    noRacesYet: 'No races yet',
    botRaces: '{n} bot races',
    inviteEarn: 'Earn +{n} Coins per invite',
    /* ---- enlist squad: the Channel War registration modal ---- */
    enlistTitle: 'Enlist Squad',
    enlistType: 'Telegram',
    enlistSub: 'Enter your community handle to compete for the 200 Stars pool.',
    enlistChannel: 'Channel',
    enlistGroup: 'Group',
    enlistPlaceholder: 'channel_or_group_username',
    enlistReady: 'Ready to Enlist',
    enlistPerkPool: '🏆 200 Stars Pool',
    enlistPerkBoost: '⚡ Squad Point Boost',
    enlistCta: 'Enlist in Channel War',
    enlistCtaBusy: 'Enlisting…',
    enlistVerifying: 'Verifying on Telegram…',
    enlistVerified: 'Verified',
    enlistMembers: '{n} members',
    enlistErrHandle: 'Use 4–32 letters, numbers or underscores.',
    enlistErrShort: 'Enter at least 4 characters.',
    enlistErrLong: 'Use at most 32 characters.',
    enlistErrChars: 'Only letters, numbers and underscores are allowed.',
    enlistErrPickKind: 'Choose Channel or Group first.',
    enlistErrNotFound: 'Channel or group not found on Telegram.',
    enlistErrPrivate: 'This community is private. Only public channels and groups can enlist.',
    enlistErrPickGroup: 'Handle belongs to a group, not a channel. Switch to the GROUP tab.',
    enlistErrPickChannel: 'Handle belongs to a channel, not a group. Switch to the CHANNEL tab.',
    enlistErrAlready: 'This squad is already enlisted in the competition!',
    enlistErrBusySquad: 'Another enlistment for this squad is in progress. Try again in a moment.',
    enlistErrUnauthorized: 'Open Tactix inside Telegram to verify your community.',
    enlistErrUnsupported: 'Only Telegram channels and groups can enlist.',
    enlistErrAdmin: 'You must be an administrator of this community.',
    enlistErrBot: 'Add the bot as an administrator of this community, then try again.',
    enlistErrOffline: 'Verification is unavailable right now. Try again shortly.',
    /* ---- enlist squad: transport and deployment failures (never blamed on the handle) ---- */
    enlistErrTimeout: 'Telegram did not answer in time. Try again shortly.',
    enlistErrNetwork: 'Could not reach Telegram. Check your connection and try again.',
    enlistErrToken: 'Verification is not configured on the server. Please tell the admin.',
    enlistErrUpstream: 'Telegram could not verify this community. Try again shortly.',
    enlistToast: 'Squad successfully enlisted in Channel War!',
    /* ---- squad membership: the real roster, its leader and the invite door ---- */
    squadLeader: 'Squad Leader',
    adminBadge: 'ADMIN',
    kickMember: 'Kick Member',
    copyInviteLink: 'Copy Invite Link',
    linkCopied: 'Link Copied',
    linkCopyFailed: 'Could not copy the link. Try again.',
    shareInviteLink: 'Share invite link',
    inviteShareText: 'Join my squad {squad} in Tactix — one tap to play:',
    memberRemoved: 'Member removed',
    joiningSquad: 'Joining…',
    confirmLeave: 'Confirm leave',
    confirmLeaveAria: 'Confirm leaving squad',
    subscribers: 'subscribers',
    subscribersNote: 'The Telegram channel audience. It is not the squad member count.',
    enlistSubscribers: '{n} subscribers',
    squadSoloNote: 'You founded this squad. Share the invite link to bring players in.',
    squadErrGone: 'That squad is no longer enlisted.',
    squadErrTelegram: 'Open Tactix inside Telegram to join this squad.',
    squadErrBanned: 'This squad was removed from the competition.',
    squadErrJoinFirst: 'Join this squad before syncing your score.',
    squadErrLeaderLeave: 'The squad leader cannot leave the squad they founded.',
    squadErrKickLeader: 'The squad leader cannot be removed.',
    squadErrKickSelf: 'You cannot remove yourself.',
    squadErrNoMember: 'That player is not on this squad.',
    /* ---- settings, help & rules ---- */
    howToPlay: 'How to play',
    howToPlaySub: 'Board basics · replay the hands-on tutorial',
    playTutorial: 'Play tutorial',
    gotIt: 'Got it',
    helpMove: "<b>Move</b> — tap one of your balls, then tap a glowing dot beside it. One step per turn; teams alternate and each may move any one of their balls.",
    helpWall: "<b>Wall</b> — tap a grid line, then tap the ghost wall again to place it. Each side brings 8 walls to a race; the counters under the board show what is left.",
    helpLegal: "<b>Legal only</b> — a wall must leave every ball a path to the line, and can't share a stretch of line.",
    helpMine: '<b>Mine</b> — the Mine key arms one hidden trap in a square ahead of your rival; the first ball over it is thrown back two rows.',
    helpFinish: '<b>Finish</b> — the first ball of any team onto the gold finish row wins.',
    helpTiq: '<b>TIQ</b> — every race moves your tactical rating: win to climb, lose to slide. The ladder pairs you with minds within ±250.',
    /* ---- match result: victory glory / defeat revenge ---- */
    resultKicker: 'MATCH COMPLETE',
    resultVictoryTitle: 'VICTORY',
    resultDefeatTitle: 'DEFEAT',
    resultVictorySub: 'Total Dominance. Outsmarted and outplayed in every turn.',
    resultDefeatStinger1: 'Outcalculated. You walked right into their trap.',
    resultDefeatStinger2: 'Crushed by intellect. Ready to take your pride back?',
    resultWinner: 'WINNER',
    resultWinnerYou: 'WINNER · YOU',
    resultDefeated: 'DEFEATED',
    resultDefeatedYou: 'DEFEATED · YOU',
    resultPlayAgain: 'PLAY AGAIN',
    resultRevenge: 'REVANCHE / REMATCH',
    resultShare: 'SHARE WIN / FLEX',
    resultMenu: 'MENU',
    resultStakeLost: 'STAKES LOST',
    resultTiqUnit: 'TIQ',
    resultCoinsUnit: 'COINS',
    resultShareText: 'I just outsmarted a rival on Tactix — {tiq} TIQ. Think you can beat me?',
    /* ---- post-match banter: taunts, reactions and the dead-action guard ---- */
    banterLabel: 'Post-match banter',
    banterQuick: 'Quick taunts',
    banterReact: 'Emoji reactions',
    banterReactSend: 'Send reaction: {emoji}',
    banterPlaceholder: 'Type a quick taunt…',
    banterInputLabel: 'Custom taunt, 40 characters max',
    banterSendLabel: 'Send taunt',
    banterOpponentLeft: 'Opponent has left the match.',
    banterLockedPlaceholder: 'Opponent left — cannot send messages',
    banterComposeOpen: 'Write a taunt',
    banterComposeClose: 'Back to quick taunts',
    resultOpponentLeft: 'Opponent Left',
    resultOpponentLeftHint: 'The rematch is unavailable because your opponent left.',
    banterWin1: 'Outsmarted! 🧠',
    banterWin2: 'Too easy! 👑',
    banterWin3: 'Calculated! ⚡',
    banterWin4: 'Read your mind! ✨',
    banterWin5: 'Run it back? 🤝',
    banterLose1: 'Pure luck! 🎲',
    banterLose2: 'Just warm-up! 🔥',
    banterLose3: 'Rematch now! ⚔️',
    banterLose4: 'Misclicked! 😤',
    banterLose5: 'Close game! 🤝',
    banterBot1: 'Calculated! 🤖⚡',
    banterBot2: 'AI supremacy! 🤖👑',
    banterBot3: 'Try again, human! 🔥',
    banterBot4: 'Next round is mine! ⚡',
    /* ---- rewarded video: the TIQ recovery & double-coins surfaces ---- */
    adRecoverCta: 'RECOVER',
    adRecoverProtected: 'PROTECTED',
    adRecoverLimit: 'LIMIT 0/3',
    adDoubleCta: '2× COINS',
    adDoubleClaimed: '2× CLAIMED',
    adToastSkipped: 'Watch the full video to claim your reward.',
    adToastUnavailable: 'No ad available right now. Try again shortly.',
  },
  fa: {
    settingsTitle: 'تنظیمات',
    gameplayAudio: 'گیم‌پلی و صدا',
    language: 'زبان',
    languageSub: 'زبان برنامه · اعمال فوری',
    sound: 'صدا',
    haptics: 'لرزش (ویبره)',
    communitySupport: 'جامعه و پشتیبانی',
    pieceColor: 'رنگ مهره',
    pieceColorSub: 'مهره‌های تو · حریف رنگ دیگه رو می‌گیره',
    tgChannel: 'کانال رسمی تلگرام',
    tgChannelSub: 'اخبار، جام‌ها و رویدادهای اسکواد',
    contactAdmin: 'ارتباط با ادمین',
    contactAdminSub: 'کمک مستقیم، پرسش‌ها و بازخورد',
    versionBadge: 'Tactix v1.0.0 · ذخیره محلی',
    /* ---- personal standing bar (Nations Cup + The Mind Ladder) ---- */
    hudYou: 'تو',
    hudTop: 'برتر',
    hudUnranked: 'بدون رتبه',
    hudYourNation: 'کشور تو',
    hudPickNation: 'انتخاب در پروفایل',
    chooseLanguage: 'انتخاب زبان',
    chooseLanguageSub: 'بلافاصله در کل برنامه اعمال می‌شود.',
    cancel: 'انصراف',
    supportTitle: 'ارتباط با پشتیبانی',
    supportCatFeedback: 'بازخورد',
    supportCatBug: 'گزارش اشکال',
    supportCatStars: 'راهنمای استارز',
    supportSend: 'ارسال پیام',
    supportSending: 'در حال ارسال…',
    supportOk: 'پیام برای ادمین‌ها ارسال شد!',
    supportPlaceholder: 'پیام یا بازخورد خود را اینجا بنویسید...',
    /* ---- shared tokens ---- */
    play: 'شروع بازی',
    searching: 'در حال جستجو',
    change: 'تغییر',
    friends: 'دوستان',
    quick: 'حریف شانسی',
    practice: 'تمرینی',
    coins: 'سکه',
    nation: 'کشور',
    nationalDivision: 'لیگ کشوری',
    squadWord: 'اسکواد',
    members: 'اعضا',
    leave: 'خروج',
    invite: 'دعوت',
    inviteFriend: 'دعوت دوست',
    /* ---- play dock & mode drawer ---- */
    dockQuick: 'حریف شانسی',
    dockParty: '2v2',
    dockPractice: 'تمرینی',
    dockFriends: 'دوستان',
    modeDuel: 'دوئل 1v1',
    modeParty: 'پارتی 2v2',
    modeBot: 'تمرینی',
    modeRoom: 'اتاق خصوصی',
    modeRoomCode: 'اتاق {code}',
    subDuel: 'رنکد · صف ~5 ثانیه',
    subParty: 'رنکد · صف ~8 ثانیه',
    subPractice: 'تمرین آفلاین',
    subRoomCode: 'خصوصی · فقط دوستان',
    subRoom: 'خصوصی · بساز یا وارد شو',
    startMatch: 'شروع مسابقه',
    start1v1: 'شروع مسابقه',
    start2v2: 'شروع مسابقه',
    startPrivate: 'شروع مسابقه',
    startPractice: 'شروع تمرین',
    startPracticeN: 'شروع مسابقه {n} نفره',
    waitingHost: 'منتظر میزبان…',
    win: 'برد',
    practiceLead: 'تمرین',
    trophiesUnit: 'جام',
    coinsUnit: 'سکه',
    /* ---- friends drawer & lobby ---- */
    selectGameMode: 'انتخاب حالت بازی',
    pickHowRace: 'حالت بازی رو انتخاب کن',
    playWithFriends: 'بازی با دوستان',
    friendsLobbySub: 'دوستانت رو دعوت کن، حالت بازی رو انتخاب کن و بزن بریم!',
    friendsEntrySub: 'ساخت اتاق یا ورود با کد',
    quickMatch: 'حریف شانسی',
    quickDesc: 'در حال بهینه‌سازی سرورهای آنلاین · آغاز به زودی',
    friendsMode: 'بازی با دوستان',
    friendsModeDesc: 'با لینک تلگرام دوستانت رو دعوت کن',
    practiceMode: 'تمرینی',
    practiceModeDesc: 'بدون استرس، مهارتت رو بساز',
    customMatchmaking: 'مچ‌میکینگ سفارشی',
    customMatchmakingDesc: 'فیلتر بر اساس منطقه و سطح',
    unlocksLevel5: 'در سطح 5 باز می‌شود',
    soon: 'به‌زودی',
    difficultyEasy: 'آسون',
    difficultyNormal: 'معمولی',
    difficultyHard: 'سخت',
    createRoom: 'ساخت اتاق جدید',
    createRoomSub: 'میزبان تو باش · حالت بازی رو انتخاب کن',
    orJoinCode: 'یا با کد وارد شو',
    enterCode: 'کد 4 رقمی رو وارد کن',
    join: 'ورود',
    copyLink: 'کپی لینک',
    inviteLinkCopied: 'لینک دعوت کپی شد!',
    copyFailed: 'کپی لینک نشد.',
    roomCode: 'کد اتاق',
    roomCodeOf: 'کد اتاق {code}',
    copyInviteFor: 'کپی لینک دعوت اتاق {code}',
    players: 'بازیکن',
    hintInviteMore: 'برای شروع، یک بازیکن دیگر دعوت کن',
    hintReadyHost: 'همه آماده‌ست — مسابقه رو شروع کن',
    hintWaitingHost: 'منتظر میزبان…',
    waitingForHost: 'در انتظار بازگشت میزبان...',
    lobbyHostAwaySub: 'به میزبان اطلاع داده شد — منتظر ورود به اتاق...',
    lobbyHostPendingSub: 'منتظر ورود میزبان به اتاق...',
    lobbyBannerJoined: '⚔️ {name} وارد اتاق بازی شد!',
    lobbyBannerSub: 'لابی #{code} · صندلیت آماده‌ست',
    joinNow: 'ورود به لابی',
    waitForNow: 'فعلاً نه',
    addBot: 'افزودن ربات',
    host: 'میزبان',
    bot: 'ربات',
    you: 'تو',
    ready: 'آماده',
    colorBlue: 'آبی',
    colorRed: 'قرمز',
    colorGreen: 'سبز',
    colorYellow: 'زرد',
    teamBlue: 'تیم آبی',
    teamOrange: 'تیم نارنجی',
    switchTeamTo: 'بزن تا {name} بره {team}',
    openSeatInvite: 'جای خالی {n}: یک دوست دعوت کن',
    fmtDuel: 'دوئل رو در رو · اولین نفری که به خط پایان برسه برنده است',
    fmt3p: 'رقابت آزاد 3 نفره · هر کس برای خودش',
    fmt4p: 'رقابت آزاد 4 نفره · هیجان کامل',
    fmt2v2: 'نبرد تیمی 2 به 2 · آبی در برابر نارنجی',
    errRoomNotFound: 'اتاقی با این کد نیست.',
    errRoomFull: 'این اتاق پره.',
    errRoomExists: 'این کد قبلاً باز شده. برو همون اتاق.',
    errInviteExpired: 'این لینک دعوت منقضی شده یا بازی شروع شده است.',
    errRoomClosed: 'میزبان اتاق رو بست.',
    errRoomExpired: 'این اتاق منقضی شده.',
    errReconnecting: 'در حال اتصال دوباره به اتاق…',
    seatReconnecting: 'منتظر اتصال مجدد…',
    errStartOffline: 'دوستت در حال اتصال دوباره است — به‌محض بازگشت، مسابقه شروع می‌شود.',
    errMaintenance: 'مچ‌میکینگ موقتاً متوقفه. بعداً امتحان کن.',
    errBanned: 'این حساب اجازه ورود به اتاق رو نداره.',
    errJoinUnknown: 'نتونستم وارد اتاق بشم.',
    errCode: 'کد 4 رقمی اتاق رو وارد کن.',
    errDropped: 'اتصال اتاق قطع شد. دوباره تلاش کن.',
    /* ---- the duel face-off ---- */
    inviteFriendFull: 'دعوت دوست',
    rivalWaiting: 'منتظر حریف…',
    rival: 'حریف',
    countdownKicker: 'اتاق آماده · همه نشستند',
    duelStartsIn: 'مسابقه تا {n} شروع میشود…',
    fight: 'بجنگ!',
    fightLine: 'همه حاضرن — برو',
    cancelMatch: 'لغو مسابقه',
    /* ---- squads ---- */
    joinSquad: 'ورود به اسکواد',
    joinASquad: 'ورود به اسکواد',
    joinSquadDesc: 'عضو یک اسکواد تلگرامی شو یا اسکواد خودت رو بساز',
    createSquad: 'ساخت اسکواد',
    searchSquads: 'جستجوی اسکواد یا @کانال...',
    exploreSquads: 'مشاهده اسکوادها',
    yourSquad: 'اسکواد تو',
    openSquadHub: 'ورود به اسکواد',
    leaveSquad: 'خروج از اسکواد',
    leader: 'لیدر',
    admin: 'ادمین',
    member: 'عضو',
    searchMembers: 'جستجوی اعضا...',
    noSquadMatch: 'اسکوادی پیدا نشد.',
    noSquadsYet: 'هنوز اسکوادی نیست.',
    noMembersMatch: 'عضوی با این جستجو پیدا نشد.',
    backToList: 'بازگشت به لیست',
    squadIntel: 'اطلاعات اسکواد',
    squadRank: 'رتبه',
    allianceTiq: 'TIQ اتحاد',
    squadPower: 'قدرت اسکواد',
    activeRacers: 'رزمنده‌های فعال',
    squadLore: 'توی آرنا بجنگ تا ستاره بگیری و این اسکواد رو بالا ببری!',
    squadFine: 'هر مسابقه آرنا، TIQ تو رو برای این اسکواد ذخیره می‌کنه.',
    officialChannel: 'کانال رسمی تلگرام',
    officialGroup: 'گروه رسمی تلگرام',
    newAlliance: 'اتحاد جدید تلگرام',
    goldMedal: 'مدال طلا',
    silverMedal: 'مدال نقره',
    bronzeMedal: 'مدال برنز',
    globalPosition: 'جایگاه جهانی',
    awaitingRank: 'در انتظار رتبه',
    newChannel: 'کانال جدید',
    freshRoster: 'شروع یک ترکیب تازه',
    badChannel: 'این کانال وصل نمی‌شه. @channel رو امتحان کن.',
    bindHandle: 'اتصال {handle}',
    searchSquadHint: 'یک اسکواد رو جستجو کن یا کانالی مثل @your_channel بنویس.',
    squadChannelHint: 'یک کانال مثل @your_channel بنویس.',
    squadFineJoined: 'تو نماینده {handle} هستی. هر امتیاز آرنا برای این اسکواد ذخیره می‌شه.',
    squadFineJoin: 'با ورود، TIQ آرنای تو برای {handle} و {n} رزمنده‌اش ذخیره می‌شه.',
    squadFineNew: 'یک اسکواد تازه برای {handle} روی این دستگاه ساخته می‌شه.',
    /* ---- squad detail sheet ---- */
    squadRead: 'آمار اسکواد',
    squadTgGroup: 'گروه تلگرام',
    squadTgChannel: 'کانال تلگرام',
    squadAvgIq: 'میانگین TIQ',
    squadYourShare: 'سهم شما',
    squadNotEnlisted: 'عضو نیستید',
    squadJoinCta: 'عضویت در اسکواد',
    squadViewChannel: 'مشاهده کانال',
    squadLeague: '{n} اسکواد در این لیگ',
    percentile: 'صدک',
    addCountry: 'انتخاب کشور',
    communitySquads: 'اسکوادهای اجتماعی',
    coinsWhenSet: 'سکه با ثبت',
    rewardReady: 'جایزه آماده',
    noRacesYet: 'هنوز مسابقه‌ای نبوده',
    botRaces: '{n} مسابقه ربات',
    inviteEarn: 'هر دعوت {n} سکه',
    /* ---- enlist squad: the Channel War registration modal ---- */
    enlistTitle: 'ثبت اسکواد',
    enlistType: 'تلگرام',
    enlistSub: 'کانال یا گروه خود را برای رقابت در جایزه ۲۰۰ استارز ثبت کنید.',
    enlistChannel: 'کانال',
    enlistGroup: 'گروه',
    enlistPlaceholder: 'آیدی_کانال_یا_گروه',
    enlistReady: 'آماده ثبت',
    enlistPerkPool: '🏆 استخر ۲۰۰ استارز',
    enlistPerkBoost: '⚡ امتیاز تیمی برای اعضا',
    enlistCta: 'ثبت و ورود به نبرد کانال‌ها',
    enlistCtaBusy: 'در حال ثبت…',
    enlistVerifying: 'در حال بررسی در تلگرام…',
    enlistVerified: 'تأیید شد',
    enlistMembers: '{n} عضو',
    enlistErrHandle: 'از ۴ تا ۳۲ حرف، عدد یا زیرخط استفاده کنید.',
    enlistErrShort: 'حداقل ۴ کاراکتر وارد کنید.',
    enlistErrLong: 'حداکثر ۳۲ کاراکتر مجاز است.',
    enlistErrChars: 'فقط حرف، عدد و زیرخط مجاز است.',
    enlistErrPickKind: 'ابتدا کانال یا گروه را انتخاب کنید.',
    enlistErrNotFound: 'کانال یا گروه در تلگرام پیدا نشد.',
    enlistErrPrivate: 'این جامعه خصوصی است. فقط کانال‌ها و گروه‌های عمومی می‌توانند ثبت شوند.',
    enlistErrPickGroup: 'این آیدی متعلق به یک گروه است، نه کانال. تب گروه را انتخاب کنید.',
    enlistErrPickChannel: 'این آیدی متعلق به یک کانال است، نه گروه. تب کانال را انتخاب کنید.',
    enlistErrAlready: 'این اسکواد قبلاً در مسابقات ثبت شده است!',
    enlistErrBusySquad: 'ثبت این اسکواد در حال انجام است. کمی بعد دوباره تلاش کنید.',
    enlistErrUnauthorized: 'برای تأیید جامعه، تاکتیکس را داخل تلگرام باز کنید.',
    enlistErrUnsupported: 'فقط کانال‌ها و گروه‌های تلگرام قابل ثبت هستند.',
    enlistErrAdmin: 'برای ثبت، باید مدیر این جامعه باشید.',
    enlistErrBot: 'ربات را به‌عنوان مدیر این جامعه اضافه کنید و دوباره تلاش کنید.',
    enlistErrOffline: 'در حال حاضر تأیید ممکن نیست. کمی بعد دوباره تلاش کنید.',
    /* ---- enlist squad: transport and deployment failures (never blamed on the handle) ---- */
    enlistErrTimeout: 'تلگرام به‌موقع پاسخ نداد. کمی بعد دوباره تلاش کنید.',
    enlistErrNetwork: 'دسترسی به تلگرام ممکن نشد. اتصال خود را بررسی کنید و دوباره تلاش کنید.',
    enlistErrToken: 'تأیید روی سرور پیکربندی نشده است. لطفاً به مدیر اطلاع دهید.',
    enlistErrUpstream: 'تلگرام نتوانست این جامعه را تأیید کند. کمی بعد دوباره تلاش کنید.',
    enlistToast: 'اسکواد با موفقیت در نبرد کانال‌ها ثبت شد!',
    /* ---- squad membership: the real roster, its leader and the invite door ---- */
    squadLeader: 'لیدر اسکواد',
    adminBadge: 'ادمین',
    kickMember: 'حذف عضو',
    copyInviteLink: 'کپی لینک دعوت',
    linkCopied: 'لینک کپی شد',
    linkCopyFailed: 'کپی لینک انجام نشد. دوباره تلاش کنید.',
    shareInviteLink: 'ارسال لینک دعوت',
    inviteShareText: 'به اسکواد {squad} در تاکتیکس بپیوند — با یک ضربه بازی کن:',
    memberRemoved: 'عضو حذف شد',
    joiningSquad: 'در حال عضویت…',
    confirmLeave: 'تأیید خروج',
    confirmLeaveAria: 'تأیید خروج از اسکواد',
    subscribers: 'دنبال‌کننده',
    subscribersNote: 'مخاطبان کانال تلگرام. این عدد تعداد اعضای اسکواد نیست.',
    enlistSubscribers: '{n} دنبال‌کننده',
    squadSoloNote: 'این اسکواد را تو ساختی. لینک دعوت را بفرست تا بازیکن‌ها اضافه شوند.',
    squadErrGone: 'این اسکواد دیگر ثبت نشده است.',
    squadErrTelegram: 'برای عضویت در این اسکواد، تاکتیکس را داخل تلگرام باز کنید.',
    squadErrBanned: 'این اسکواد از مسابقات حذف شده است.',
    squadErrJoinFirst: 'برای همگام‌سازی امتیاز، اول عضو این اسکواد شو.',
    squadErrLeaderLeave: 'لیدر اسکواد نمی‌تواند از اسکوادی که ساخته خارج شود.',
    squadErrKickLeader: 'لیدر اسکواد قابل حذف نیست.',
    squadErrKickSelf: 'نمی‌توانی خودت را حذف کنی.',
    squadErrNoMember: 'این بازیکن عضو این اسکواد نیست.',
    /* ---- settings, help & rules ---- */
    howToPlay: 'آموزش بازی',
    howToPlaySub: 'اصول بازی · آموزش تعاملی رو دوباره ببین',
    playTutorial: 'شروع آموزش تعاملی',
    gotIt: 'فهمیدم',
    helpMove: '<b>حرکت</b> — یکی از مهره‌هات رو بزن، بعد روی نقطه نورانی کنارش بزن. هر نوبت یک قدم؛ تیم‌ها یکی‌یکی بازی می‌کنن و هر تیم می‌تونه هر کدوم از مهره‌هاش رو حرکت بده.',
    helpWall: '<b>دیوار</b> — روی خط شبکه بزن، بعد دوباره روی دیوار شبح‌وار بزن تا ساخته بشه. هر طرف 8 دیوار داره؛ شمارنده زیر صفحه نشون می‌ده چقدر مونده.',
    helpLegal: '<b>فقط حرکت قانونی</b> — دیوار باید برای همه مهره‌ها راهی به خط پایان باقی بذاره و نمی‌تونه با دیواره دیگر هم‌مسیر بشه.',
    helpMine: '<b>مین</b> — دکمه مین یک تله مخفی توی خونه جلوی حریف کار می‌ذاره؛ اولین مهره‌ای که روش بیاد دو ردیف عقب پرت می‌شه.',
    helpFinish: '<b>پایان</b> — اولین مهره‌ای که به ردیف طلایی پایان برسه، برنده‌ست.',
    helpTiq: '<b>TIQ</b> — هر مسابقه رتبه تاکتیکیت رو جابه‌جا می‌کنه: ببری بالا می‌ری، ببازی پایین. لدر تو رو با ذهن‌های ±250 هم‌بازی می‌کنه.',
    /* ---- match result: victory glory / defeat revenge ---- */
    resultKicker: 'پایان مسابقه',
    resultVictoryTitle: 'پیروزی',
    resultDefeatTitle: 'شکست',
    resultVictorySub: 'پیروزی قاطع! حریف کاملاً کیش‌ومات شد.',
    resultDefeatStinger1: 'محاسباتت غلط بود؛ مستقیم رفتی توی تله حریف!',
    resultDefeatStinger2: 'له شدی! جرئتشو داری دوباره حریفت رو به چالش بکشی؟',
    resultWinner: 'برنده',
    resultWinnerYou: 'برنده · تو',
    resultDefeated: 'بازنده',
    resultDefeatedYou: 'بازنده · تو',
    resultPlayAgain: 'بازی مجدد',
    resultRevenge: 'انتقام فوری',
    resultShare: 'افتخار / اشتراک برد',
    resultMenu: 'منو',
    resultStakeLost: 'امتیاز از دست رفته',
    resultTiqUnit: 'TIQ',
    resultCoinsUnit: 'سکه',
    resultShareText: 'توی Tactix حریفم رو کیش‌ومات کردم — {tiq} TIQ. جرئت داری تو هم امتحان کنی؟',
    /* ---- طعنه‌های پایان مسابقه و قفل حریف خارج‌شده ---- */
    banterLabel: 'گفتگوی پایان مسابقه',
    banterQuick: 'طعنه‌های سریع',
    banterReact: 'واکنش‌های ایموجی',
    banterReactSend: 'ارسال واکنش: {emoji}',
    banterPlaceholder: 'یک طعنه سریع بنویس…',
    banterInputLabel: 'طعنه دلخواه، حداکثر ۴۰ کاراکتر',
    banterSendLabel: 'ارسال طعنه',
    banterOpponentLeft: 'حریف بازی را ترک کرد.',
    banterLockedPlaceholder: 'حریف خارج شد — ارسال پیام ممکن نیست',
    banterComposeOpen: 'نوشتن طعنه',
    banterComposeClose: 'بازگشت به طعنه‌های سریع',
    resultOpponentLeft: 'حریف خارج شد',
    resultOpponentLeftHint: 'بازی مجدد ممکن نیست چون حریف خارج شده است.',
    banterWin1: 'مغزت رو خوندم! 🧠',
    banterWin2: 'خیلی راحت بود! 👑',
    banterWin3: 'کاملاً محاسبه‌شده! ⚡',
    banterWin4: 'افتادی تو تله! ✨',
    banterWin5: 'جرات راند بعد رو داری؟ 🤝',
    banterLose1: 'فقط شانس آوردی! 🎲',
    banterLose2: 'تازه گرم شدم! 🔥',
    banterLose3: 'بزن بازی مجدد! ⚔️',
    banterLose4: 'دستم خورد! 😤',
    banterLose5: 'نزدیک بود! 🤝',
    banterBot1: 'محاسبه دقیق! 🤖⚡',
    banterBot2: 'قدرت هوش مصنوعی! 🤖👑',
    banterBot3: 'دوباره تلاش کن! 🔥',
    banterBot4: 'دست بعد هم مال منه! ⚡',
    /* ---- ویدیوی جایزه‌دار: بازیابی TIQ و دو برابر سکه ---- */
    adRecoverCta: 'بازیابی',
    adRecoverProtected: 'محافظت شد',
    adRecoverLimit: 'سقف ۰/۳',
    adDoubleCta: '۲× سکه',
    adDoubleClaimed: '۲× دریافت شد',
    adToastSkipped: 'برای دریافت پاداش، ویدیو را کامل تماشا کنید.',
    adToastUnavailable: 'در حال حاضر تبلیغی موجود نیست. کمی بعد تلاش کنید.',
  },
  ru: {
    settingsTitle: 'Настройки',
    gameplayAudio: 'Игра и звук',
    language: 'Язык',
    languageSub: 'Язык приложения · применяется сразу',
    sound: 'Звук',
    haptics: 'Вибрация',
    communitySupport: 'Сообщество и поддержка',
    tgChannel: 'Официальный Telegram-канал',
    tgChannelSub: 'Новости, кубки и события сквадов',
    contactAdmin: 'Связаться с админом',
    contactAdminSub: 'Прямая помощь, вопросы и отзывы',
    versionBadge: 'Tactix v1.0.0 · Локальное сохранение',
    /* ---- personal standing bar (Nations Cup + The Mind Ladder) ---- */
    hudYou: 'Вы',
    hudTop: 'Топ',
    hudUnranked: 'Без ранга',
    hudYourNation: 'Ваша страна',
    hudPickNation: 'Выбрать в профиле',
    chooseLanguage: 'Выберите язык',
    chooseLanguageSub: 'Применяется ко всему приложению сразу.',
    cancel: 'Отмена',
    supportTitle: 'Связь с поддержкой',
    supportCatFeedback: 'Отзыв',
    supportCatBug: 'Ошибка',
    supportCatStars: 'Помощь со Stars',
    supportSend: 'Отправить',
    supportSending: 'Отправка…',
    supportOk: 'Сообщение отправлено админам!',
    supportPlaceholder: 'Напишите здесь ваше сообщение или отзыв...',
  },
  ar: {
    settingsTitle: 'الإعدادات',
    gameplayAudio: 'اللعب والصوت',
    language: 'اللغة',
    languageSub: 'لغة التطبيق · تُطبق فورًا',
    sound: 'الصوت',
    haptics: 'الاهتزاز',
    communitySupport: 'المجتمع والدعم',
    tgChannel: 'قناة تيليجرام الرسمية',
    tgChannelSub: 'الأخبار والكؤوس وفعاليات الفرق',
    contactAdmin: 'تواصل مع الأدمن',
    contactAdminSub: 'مساعدة مباشرة واستفسارات وملاحظات',
    versionBadge: 'Tactix v1.0.0 · حفظ محلي',
    /* ---- personal standing bar (Nations Cup + The Mind Ladder) ---- */
    hudYou: 'أنت',
    hudTop: 'الأفضل',
    hudUnranked: 'غير مصنف',
    hudYourNation: 'بلدك',
    hudPickNation: 'اختر من الملف',
    chooseLanguage: 'اختر اللغة',
    chooseLanguageSub: 'تُطبق فورًا على التطبيق كله.',
    cancel: 'إلغاء',
    supportTitle: 'تواصل مع الدعم',
    supportCatFeedback: 'ملاحظات',
    supportCatBug: 'بلاغ عن خلل',
    supportCatStars: 'مساعدة Stars',
    supportSend: 'إرسال الرسالة',
    supportSending: 'جارٍ الإرسال…',
    supportOk: 'تم إرسال الرسالة إلى الأدمن!',
    supportPlaceholder: 'اكتب رسالتك أو ملاحظاتك هنا...',
  },
  es: {
    settingsTitle: 'Ajustes',
    gameplayAudio: 'Juego y audio',
    language: 'Idioma',
    languageSub: 'Idioma de la app · se aplica al instante',
    sound: 'Sonido',
    haptics: 'Vibración',
    communitySupport: 'Comunidad y ayuda',
    tgChannel: 'Canal oficial de Telegram',
    tgChannelSub: 'Noticias, copas y eventos de escuadras',
    contactAdmin: 'Contactar al admin',
    contactAdminSub: 'Ayuda directa, consultas y comentarios',
    versionBadge: 'Tactix v1.0.0 · Guardado local',
    /* ---- personal standing bar (Nations Cup + The Mind Ladder) ---- */
    hudYou: 'Tú',
    hudTop: 'Top',
    hudUnranked: 'Sin rango',
    hudYourNation: 'Tu nación',
    hudPickNation: 'Elige en tu perfil',
    chooseLanguage: 'Elige idioma',
    chooseLanguageSub: 'Se aplica a toda la app al instante.',
    cancel: 'Cancelar',
    supportTitle: 'Contactar a soporte',
    supportCatFeedback: 'Sugerencias',
    supportCatBug: 'Reportar fallo',
    supportCatStars: 'Ayuda con Stars',
    supportSend: 'Enviar mensaje',
    supportSending: 'Enviando…',
    supportOk: '¡Mensaje enviado a los admins!',
    supportPlaceholder: 'Escribe aquí tu mensaje o sugerencia...',
  },
};

const watchers: ((s: Settings) => void)[] = [];

/** The system preference is the only switch for motion now: the OS speaks for the user. */
export const motionReduced = () => systemReduce || settings.reducedMotion;

/**
 * Applies the motion restraint class to the document. The global kill-switch every pulse, slide
 * and float in the sheet is keyed to. `html.reduced-motion` stills them all; setSetting re-applies
 * it on every write so a leftover saved preference keeps working without a row to flip.
 */
export function applyMotion() {
  document.documentElement.classList.toggle('reduced-motion', motionReduced());
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  writeJson(S_KEY, settings);
  applyMotion();
  for (const w of watchers) w(settings);
}

export function onSettings(w: (s: Settings) => void) { watchers.push(w); }

/* ---------- the race stage's light / dark finish ---------- */

type AppearanceWatcher = (mode: Appearance) => void;
const appearanceWatchers: AppearanceWatcher[] = [];

const appearance = (): Appearance => settings.appearance;

/**
 * Publishes the saved finish to CSS. It is written on the root, so the Light Mode selectors can
 * reach both the stage and the game head, while the shell outside the race stays on its dark clay.
 */
function paintAppearance() {
  try { document.documentElement.dataset.theme = settings.appearance; } catch { /* headless */ }
}

export function setAppearance(mode: Appearance) {
  const next: Appearance = mode === 'light' ? 'light' : 'dark';
  if (settings.appearance === next) return;
  settings.appearance = next;
  writeJson(S_KEY, settings);
  paintAppearance();
  for (const w of appearanceWatchers) { try { w(next); } catch { /* watcher threw */ } }
  try {
    window.dispatchEvent(new CustomEvent<Appearance>('detour:appearance', { detail: next }));
  } catch { /* no window */ }
}

export function onAppearance(w: AppearanceWatcher) {
  appearanceWatchers.push(w);
  return () => {
    const i = appearanceWatchers.indexOf(w);
    if (i >= 0) appearanceWatchers.splice(i, 1);
  };
}

export function toggleAppearance(): Appearance {
  const next: Appearance = settings.appearance === 'light' ? 'dark' : 'light';
  setAppearance(next);
  return next;
}

export { appearance };

export function saveMenu(patch: Partial<MenuState>) {
  Object.assign(menuState, patch);
  writeJson(M_KEY, menuState);
}

paintLangAttrs();
applyMotion();
paintAppearance();
