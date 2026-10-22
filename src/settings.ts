/**
 * settings.ts — the switches and the last menu choice. Storage itself is `storage.ts`'s door:
 * every access there is wrapped, so a webview that refuses localStorage still gets a working app.
 */
import type { Difficulty } from './bot';
import { readJson, writeJson } from './storage';

export type Mode = 'bot' | 'online';
/** Which tier of the launcher is showing: a solo race, or two sides. */
export type ModeTab = 'solo' | 'party';

export interface Settings {
  /** the engine's step, wall and blast effects and the matchmaking chime */
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
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
const DEFAULT_SETTINGS: Settings = { sound: true, haptics: true, reducedMotion: false };
const DEFAULT_MENU: MenuState = { mode: 'bot', tab: 'solo', difficulty: 'normal', sizes: [1, 1] };

const motion = matchMedia('(prefers-reduced-motion: reduce)');
let systemReduce = motion.matches;
try { motion.addEventListener('change', (e) => { systemReduce = e.matches; }); } catch { /* fixed at load */ }

export const settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Settings>(S_KEY) };
export const menuState: MenuState = { ...DEFAULT_MENU, ...readJson<MenuState>(M_KEY) };
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

function paintLangAttrs() {
  try {
    const d = langDef(lang);
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', d.dir);
  } catch { /* headless */ }
}

export function t(key: string): string {
  const table = STRINGS[lang] ?? STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

export function setLang(code: LangCode) {
  if (!LANG_SET.has(code) || code === lang) return;
  lang = code;
  try { window.localStorage.setItem(L_KEY, code); } catch { /* stay in memory */ }
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
    versionBadge: 'Detour v1.0.0 · Local Save',
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
  },
  fa: {
    settingsTitle: 'تنظیمات',
    gameplayAudio: 'گیم‌پلی و صدا',
    language: 'زبان',
    languageSub: 'زبان برنامه · اعمال فوری',
    sound: 'صدا',
    haptics: 'لرزش لمسی',
    communitySupport: 'جامعه و پشتیبانی',
    tgChannel: 'کانال رسمی تلگرام',
    tgChannelSub: 'اخبار، جام‌ها و رویدادهای اسکواد',
    contactAdmin: 'ارتباط با ادمین',
    contactAdminSub: 'کمک مستقیم، پرسش‌ها و بازخورد',
    versionBadge: 'Detour و۱٫۰٫۰ · فقط ذخیره محلی',
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
    versionBadge: 'Detour v1.0.0 · Локальное сохранение',
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
    versionBadge: 'Detour v1.0.0 · حفظ محلي',
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
    versionBadge: 'Detour v1.0.0 · Guardado local',
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

export function saveMenu(patch: Partial<MenuState>) {
  Object.assign(menuState, patch);
  writeJson(M_KEY, menuState);
}

paintLangAttrs();
applyMotion();
