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
  /** placeholder until the app actually has audio */
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
    soundSub: 'Kept for you — the game has no audio yet',
    haptics: 'Haptics',
    hapticsSub: 'Buzz on walls, moves and the result',
    reducedMotion: 'Reduced motion',
    reducedMotionSub: 'No floating, sliding or pulsing',
    communitySupport: 'Community & Support',
    tgChannel: 'Official Telegram Channel',
    tgChannelSub: 'News, cups and squad events',
    supportFeedback: 'Support & Feedback',
    supportFeedbackSub: 'Help, ideas and bug reports',
    appStorage: 'App & Storage',
    resetData: 'Reset Local Data',
    resetDataSub: 'Coins, teams and progress on this device',
    versionBadge: 'Version 1.0.0 · Local save only',
    savedNote: 'Saved on this device only. Nothing else is stored.',
    chooseLanguage: 'Choose language',
    chooseLanguageSub: 'Applies instantly to the whole app.',
    cancel: 'Cancel',
    resetTitle: 'Reset local data?',
    resetBody: 'Coins, owned items, stats, teams and settings go back to defaults. This cannot be undone.',
    resetConfirm: 'Reset everything',
    resetDone: 'Local data cleared — fresh start.',
    supportNote: 'Support lives in our Telegram channel — come say hi.',
  },
  fa: {
    settingsTitle: 'تنظیمات',
    gameplayAudio: 'گیم‌پلی و صدا',
    language: 'زبان',
    languageSub: 'زبان برنامه · اعمال فوری',
    sound: 'صدا',
    soundSub: 'برای شما نگه داشته شد — بازی هنوز صدا ندارد',
    haptics: 'لرزش لمسی',
    hapticsSub: 'لرزش برای دیوارها، حرکت‌ها و نتیجه',
    reducedMotion: 'کاهش حرکت',
    reducedMotionSub: 'بدون شناور شدن، لغزش یا تپش',
    communitySupport: 'جامعه و پشتیبانی',
    tgChannel: 'کانال رسمی تلگرام',
    tgChannelSub: 'اخبار، جام‌ها و رویدادهای اسکواد',
    supportFeedback: 'پشتیبانی و بازخورد',
    supportFeedbackSub: 'کمک، ایده‌ها و گزارش باگ',
    appStorage: 'برنامه و حافظه',
    resetData: 'پاک‌سازی داده‌های محلی',
    resetDataSub: 'سکه‌ها، تیم‌ها و پیشرفت در این دستگاه',
    versionBadge: 'نسخه ۱٫۰٫۰ · فقط ذخیره محلی',
    savedNote: 'فقط در همین دستگاه ذخیره می‌شود. چیز دیگری ذخیره نمی‌شود.',
    chooseLanguage: 'انتخاب زبان',
    chooseLanguageSub: 'بلافاصله در کل برنامه اعمال می‌شود.',
    cancel: 'انصراف',
    resetTitle: 'داده‌های محلی پاک شود؟',
    resetBody: 'سکه‌ها، آیتم‌ها، آمار، تیم‌ها و تنظیمات به پیش‌فرض برمی‌گردند. این کار برگشت‌ناپذیر است.',
    resetConfirm: 'پاک‌سازی همه',
    resetDone: 'داده‌های محلی پاک شد — شروع تازه.',
    supportNote: 'پشتیبانی در کانال تلگرام ماست — بیا سلام کن.',
  },
  ru: {
    settingsTitle: 'Настройки',
    gameplayAudio: 'Игра и звук',
    language: 'Язык',
    languageSub: 'Язык приложения · применяется сразу',
    sound: 'Звук',
    soundSub: 'Сохранено для вас — в игре пока нет звука',
    haptics: 'Вибрация',
    hapticsSub: 'Отклик на стены, ходы и результат',
    reducedMotion: 'Меньше движения',
    reducedMotionSub: 'Без парения, скольжения и пульсации',
    communitySupport: 'Сообщество и поддержка',
    tgChannel: 'Официальный Telegram-канал',
    tgChannelSub: 'Новости, кубки и события сквадов',
    supportFeedback: 'Поддержка и отзывы',
    supportFeedbackSub: 'Помощь, идеи и баги',
    appStorage: 'Приложение и хранилище',
    resetData: 'Сбросить локальные данные',
    resetDataSub: 'Монеты, команды и прогресс на устройстве',
    versionBadge: 'Версия 1.0.0 · Только локальное сохранение',
    savedNote: 'Хранится только на этом устройстве. Больше ничего не сохраняется.',
    chooseLanguage: 'Выберите язык',
    chooseLanguageSub: 'Применяется ко всему приложению сразу.',
    cancel: 'Отмена',
    resetTitle: 'Сбросить локальные данные?',
    resetBody: 'Монеты, предметы, статистика, команды и настройки вернутся к значениям по умолчанию. Это необратимо.',
    resetConfirm: 'Сбросить всё',
    resetDone: 'Локальные данные очищены — чистый старт.',
    supportNote: 'Поддержка — в нашем Telegram-канале, заходите.',
  },
  ar: {
    settingsTitle: 'الإعدادات',
    gameplayAudio: 'اللعب والصوت',
    language: 'اللغة',
    languageSub: 'لغة التطبيق · تُطبق فورًا',
    sound: 'الصوت',
    soundSub: 'محفوظ لك — لا صوت في اللعبة بعد',
    haptics: 'الاهتزاز',
    hapticsSub: 'اهتزاز عند الجدران والحركات والنتيجة',
    reducedMotion: 'تقليل الحركة',
    reducedMotionSub: 'بدون طفو أو انزلاق أو نبض',
    communitySupport: 'المجتمع والدعم',
    tgChannel: 'قناة تيليجرام الرسمية',
    tgChannelSub: 'الأخبار والكؤوس وفعاليات الفرق',
    supportFeedback: 'الدعم والملاحظات',
    supportFeedbackSub: 'مساعدة وأفكار وبلاغات',
    appStorage: 'التطبيق والتخزين',
    resetData: 'إعادة تعيين البيانات المحلية',
    resetDataSub: 'العملات والفرق والتقدم على هذا الجهاز',
    versionBadge: 'الإصدار 1.0.0 · حفظ محلي فقط',
    savedNote: 'يُحفظ على هذا الجهاز فقط. لا يُخزن أي شيء آخر.',
    chooseLanguage: 'اختر اللغة',
    chooseLanguageSub: 'تُطبق فورًا على التطبيق كله.',
    cancel: 'إلغاء',
    resetTitle: 'إعادة تعيين البيانات المحلية؟',
    resetBody: 'ستعود العملات والعناصر والإحصاءات والفرق والإعدادات إلى الافتراضي. لا يمكن التراجع.',
    resetConfirm: 'إعادة تعيين الكل',
    resetDone: 'تم مسح البيانات المحلية — بداية جديدة.',
    supportNote: 'الدعم في قناة تيليجرام — تعال وسلّم.',
  },
  es: {
    settingsTitle: 'Ajustes',
    gameplayAudio: 'Juego y audio',
    language: 'Idioma',
    languageSub: 'Idioma de la app · se aplica al instante',
    sound: 'Sonido',
    soundSub: 'Guardado para ti — el juego aún no tiene audio',
    haptics: 'Vibración',
    hapticsSub: 'Vibra con muros, movimientos y el resultado',
    reducedMotion: 'Movimiento reducido',
    reducedMotionSub: 'Sin flotar, deslizar ni pulsar',
    communitySupport: 'Comunidad y ayuda',
    tgChannel: 'Canal oficial de Telegram',
    tgChannelSub: 'Noticias, copas y eventos de escuadras',
    supportFeedback: 'Ayuda y comentarios',
    supportFeedbackSub: 'Ayuda, ideas y errores',
    appStorage: 'App y almacenamiento',
    resetData: 'Borrar datos locales',
    resetDataSub: 'Monedas, equipos y progreso en este dispositivo',
    versionBadge: 'Versión 1.0.0 · Solo guardado local',
    savedNote: 'Solo se guarda en este dispositivo. Nada más se almacena.',
    chooseLanguage: 'Elige idioma',
    chooseLanguageSub: 'Se aplica a toda la app al instante.',
    cancel: 'Cancelar',
    resetTitle: '¿Borrar datos locales?',
    resetBody: 'Monedas, objetos, estadísticas, equipos y ajustes vuelven a los valores iniciales. No se puede deshacer.',
    resetConfirm: 'Borrar todo',
    resetDone: 'Datos locales borrados — nuevo comienzo.',
    supportNote: 'La ayuda está en nuestro canal de Telegram — ven a saludar.',
  },
};

const watchers: ((s: Settings) => void)[] = [];

/** The system preference always wins; the toggle can only ask for more restraint. */
export const motionReduced = () => systemReduce || settings.reducedMotion;

export function applyMotion() {
  document.documentElement.classList.toggle('rm', motionReduced());
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
