/**
 * splash.ts — the live half of the neural boot screen in index.html.
 *
 * The overlay paints before the bundle; this controller teaches it the app's language,
 * rotates a random neuro-benefit through the glass card, runs the boot rail, and lifts
 * the veil once main.ts says the arena is staged. Headless runs skip it outright, both
 * here and through the inline `data-txs-skip` guard, so browser suites never wait on it.
 */

type SplashLang = 'en' | 'fa' | 'ar';
type SplashDir = 'ltr' | 'rtl';

interface SplashCopy {
  dir: SplashDir;
  loading: string;
  progress: string;
  benefitLabel: string;
  benefits: string[];
}

const COPY: Record<SplashLang, SplashCopy> = {
  en: {
    dir: 'ltr',
    loading: 'Tactix is loading',
    progress: 'Tactix loading progress',
    benefitLabel: 'Cognitive benefit',
    benefits: [
      'Spatial Intelligence & Foresight — Calculating multi-step paths and wall blocks actively trains your prefrontal cortex.',
      'Split-Second Decision Making — Real-time 1v1 tactical pressure sharpens cognitive agility and pattern recognition.',
      'Adaptive Counter-Strategy — Reading rival traps and rerouting on the fly builds elite mental flexibility.',
      'Working Memory & Deep Focus — Tracking hidden mines and wall budgets boosts concentration.',
    ],
  },
  fa: {
    dir: 'rtl',
    loading: 'تکتیکس در حال بارگذاری است',
    progress: 'پیشرفت بارگذاری تکتیکس',
    benefitLabel: 'فایده شناختی',
    benefits: [
      'تقویت هوش فضایی و آینده‌نگری — محاسبه مسیرها و بستن راه حریف با دیوار، بخش استراتژیک مغز را فعال می‌کند.',
      'افزایش سرعت تصمیم‌گیری — رقابت زنده ۱ به ۱، چابکی ذهن و تشخیص الگوها را در لحظات حساس تقویت می‌کند.',
      'انعطاف‌پذیری ذهنی بالا — پیش‌بینی تله‌های حریف و تغییر مسیر هوشمندانه، قدرت حل مسئله را دوچندان می‌کند.',
      'تقویت حافظه فعال و تمرکز عمیق — مدیریت هم‌زمان مین‌های مخفی، دیوارها و موانع، تمرکز شما را به اوج می‌رساند.',
    ],
  },
  ar: {
    dir: 'rtl',
    loading: 'تكتيكس قيد التحميل',
    progress: 'تقدم تحميل تكتيكس',
    benefitLabel: 'فائدة معرفية',
    benefits: [
      'تعزيز الذكاء المكاني والاستبصار — حساب المسارات ووضع الجدران ينشط القشرة الجبهية المسؤولة عن التخطيط.',
      'سرعة اتخاذ القرار — المواجهات الحية ١ ضد ١ تطور المرونة الإدراكية وسرعة قراءة الأنماط تحت الضغط.',
      'المرونة الذهنية الفائقة — قراءة فخاخ الخصم وتغيير مسارك بذكاء يبني قدرة استثنائية على حل المشكلات.',
      'تقوية الذاكرة العاملة والتركيز — تتبع الألغام الخفية والجدران والعوائق يرفع مستوى انتباهك إلى أقصى حد.',
    ],
  },
};

const LANG_ATTR = 'data-txs-lang';
const SETTINGS_KEY = 'detour.settings.v1';
const LANG_KEY = 'detour.lang.v1';
const MIN_VISIBLE_MS = 1800;
const EXIT_MS = 420;
const READY_BEAT_MS = 500;
const CYCLE_MS = 2500;
const SWAP_MS = 220;

let onReady: (() => void) | null = null;
let initialized = false;

const LANGS = /^(en|fa|ru|ar|es)(-|$)/i;

function mapLang(raw: string | null | undefined): SplashLang {
  const base = (raw || '').toLowerCase().split('-')[0];
  return base === 'fa' || base === 'ar' ? base : 'en';
}

function detectLang(): SplashLang {
  const candidates: Array<string | null | undefined> = [];
  try { candidates.push(window.localStorage.getItem(LANG_KEY)); } catch { /* storage refused */ }
  try {
    const tg = (window as unknown as {
      Telegram?: {
        WebApp?: {
          initDataUnsafe?: { user?: { language_code?: string }; language_code?: string };
          initData?: string;
          languageCode?: string;
        };
      };
    }).Telegram?.WebApp;
    candidates.push(
      tg?.initDataUnsafe?.user?.language_code,
      tg?.initDataUnsafe?.language_code,
      tg?.languageCode,
    );
    if (tg?.initData) {
      try { candidates.push(new URLSearchParams(tg.initData).get('language_code')); } catch { /* malformed */ }
    }
  } catch { /* no Telegram */ }
  try { candidates.push(navigator.language, navigator.languages?.[0]); } catch { /* headless */ }
  const pick = candidates.find((v): v is string => typeof v === 'string' && LANGS.test(v));
  return mapLang(pick);
}

function prefersQuiet(): boolean {
  let saved = false;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) as { reducedMotion?: unknown } : null;
    saved = parsed?.reducedMotion === true;
  } catch { /* unreadable save */ }
  try {
    return saved || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return saved;
  }
}

function splitBenefit(line: string): { title: string; body: string } {
  const at = line.indexOf(' — ');
  if (at < 0) return { title: line, body: '' };
  return { title: line.slice(0, at), body: line.slice(at + 3) };
}

/**
 * Starts the boot screen's clocks. Safe to call once from boot; `splashReady()` lifts it.
 */
export function initSplash(): void {
  if (initialized) return;
  initialized = true;

  const el = document.getElementById('tactix-splash');
  if (!el) return;
  /* an automated browser must never meet the veil — even before this module runs, CSS hides it */
  if (navigator.webdriver) {
    el.remove();
    return;
  }

  /* the screen beneath is staged but not yet open for business */
  const app = document.getElementById('app');
  app?.setAttribute('inert', '');
  const veil = el;
  const rootLang = document.documentElement.getAttribute(LANG_ATTR);
  const lang = rootLang === 'fa' || rootLang === 'ar' || rootLang === 'en' ? rootLang : detectLang();
  if (!rootLang) document.documentElement.setAttribute(LANG_ATTR, lang);
  const copy = COPY[lang];
  const reduced = prefersQuiet();
  el.classList.toggle('is-reduced', reduced);

  const insightHost = el.querySelector<HTMLElement>('#txs-insight');
  const titleEl = el.querySelector<HTMLElement>('#txs-insight-title');
  const bodyEl = el.querySelector<HTMLElement>('#txs-insight-body');
  const skeleton = el.querySelector<HTMLElement>('#txs-skeleton');
  const fill = el.querySelector<HTMLElement>('#txs-fill');
  const pctN = el.querySelector<HTMLElement>('#txs-pct-n');
  const track = el.querySelector<HTMLElement>('#txs-track');
  const dots = Array.from(el.querySelectorAll<HTMLElement>('#txs-dots > i'));

  el.setAttribute('lang', lang);
  el.setAttribute('aria-label', copy.loading);
  track?.setAttribute('aria-label', copy.progress);
  el.querySelector('.txs-benefit')?.setAttribute('aria-label', copy.benefitLabel);
  if (insightHost) {
    insightHost.dir = copy.dir;
    insightHost.lang = lang;
  }

  const startedAt = performance.now();
  let readyFired = false;
  let skipRequested = false;
  let leaving = false;
  let autoExitTimer = 0;
  let cycleTimer = 0;
  let raf = 0;
  let progress = 0;
  let lastFrame = startedAt;
  let lastPercent = -1;
  let insightIndex = Math.floor(Math.random() * copy.benefits.length);

  /* ---- the insight card: one random start, then a calm 2.5s crossfade ---- */
  function paintInsight(animate: boolean): void {
    if (!titleEl || !bodyEl) return;
    const paint = () => {
      const part = splitBenefit(copy.benefits[insightIndex]);
      titleEl.textContent = part.title;
      bodyEl.textContent = part.body;
      dots.forEach((dot, i) => dot.classList.toggle('is-on', i === insightIndex));
    };
    if (!animate || reduced || !insightHost) { paint(); return; }
    insightHost.classList.add('is-swapping');
    window.setTimeout(() => {
      if (leaving) return;
      paint();
      window.requestAnimationFrame(() => {
        if (!leaving) insightHost.classList.remove('is-swapping');
      });
    }, SWAP_MS);
  }

  if (insightHost) insightHost.hidden = false;
  if (skeleton) skeleton.hidden = true;
  paintInsight(false);
  cycleTimer = window.setInterval(() => {
    if (leaving || document.hidden) return;
    insightIndex = (insightIndex + 1) % copy.benefits.length;
    paintInsight(true);
  }, CYCLE_MS);

  /* ---- the boot rail: eases toward the top, then finishes on the app's ready signal ---- */
  function paintProgress(pct: number): void {
    if (fill) fill.style.width = `${(progress * 100).toFixed(2)}%`;
    if (pct === lastPercent) return;
    lastPercent = pct;
    if (pctN) pctN.textContent = String(pct).padStart(2, '0');
    track?.setAttribute('aria-valuenow', String(pct));
  }

  const tick = (now: number): void => {
    if (leaving) return;
    const dt = Math.min(.064, Math.max(0, now - lastFrame) / 1000);
    lastFrame = now;
    const elapsed = now - startedAt;
    const idle = .93 * (1 - Math.exp(-elapsed / 1150));
    const target = readyFired ? 1 : Math.max(.03, idle);
    const ease = 1 - Math.exp(-dt * (readyFired ? 14 : 2.7));
    progress += (target - progress) * ease;
    if (readyFired && progress > .995) progress = 1;
    paintProgress(Math.round(progress * 100));
    /* the invitation belongs to a rail that has actually filled */
    if (readyFired && progress >= .995) el.classList.add('can-enter');
    raf = window.requestAnimationFrame(tick);
  };
  raf = window.requestAnimationFrame(tick);

  /* ---- lift the veil ---- */
  function finish(): void {
    if (leaving) return;
    leaving = true;
    if (autoExitTimer) window.clearTimeout(autoExitTimer);
    if (cycleTimer) window.clearInterval(cycleTimer);
    if (raf) window.cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    onReady = null;
    veil.classList.remove('can-enter');
    veil.classList.add('is-leaving');
    veil.setAttribute('aria-hidden', 'true');
    veil.setAttribute('aria-busy', 'false');
    window.setTimeout(() => {
      veil.remove();
      app?.removeAttribute('inert');
    }, reduced ? 20 : EXIT_MS + 30);
  }

  function requestEntry(): void {
    if (leaving) return;
    if (readyFired) finish();
    else skipRequested = true;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Escape') return;
    if (!readyFired) { skipRequested = true; return; }
    event.preventDefault();
    finish();
  }

  el.addEventListener('click', requestEntry);
  window.addEventListener('keydown', onKey, true);

  onReady = () => {
    if (readyFired || leaving) return;
    readyFired = true;
    el.setAttribute('aria-busy', 'false');
    if (skipRequested) { finish(); return; }
    const now = performance.now();
    const due = Math.max(startedAt + MIN_VISIBLE_MS, now + READY_BEAT_MS);
    autoExitTimer = window.setTimeout(finish, Math.max(0, due - now));
  };
}

/** Announces that the app is staged; the boot screen exits on its minimum-visible clock. */
export function splashReady(): void {
  onReady?.();
}
