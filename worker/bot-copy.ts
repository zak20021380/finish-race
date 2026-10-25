/**
 * bot-copy.ts — everything the Telegram bot says, and what each of its buttons does.
 *
 * Three languages, because that is the audience this bot serves: English, Persian and Arabic.
 * The strings here are the whole of the bot's voice; `bot.ts` only decides when to say them.
 *
 * Two rules keep the text safe to send:
 *
 *   - every reply goes out as HTML, because the only characters that then need escaping are `&`,
 *     `<` and `>`. Legacy Markdown would also have to watch `_`, `` ` `` and `[` — all three of
 *     which appear in ordinary player names and in the invite link this module puts in a message.
 *   - copy is authored with `**bold**` and `render()` escapes *before* it substitutes, so a `<`
 *     sitting inside a bold span is already an entity by the time a tag could be built from it.
 *
 * Keyboards are built here rather than inlined at the call sites, so the callback grammar —
 * `lang:<code>`, `menu:rules:<code>`, `menu:invite:<code>`, `menu:lang` — has one owner. Note that
 * every callback carries its own language: that is what lets a menu survive a cold worker, because
 * nothing has to be remembered in order to draw the next screen. The remembered language is only
 * ever a convenience for a bare `/rules` or `/play`.
 */

export type BotLang = 'en' | 'fa' | 'ar';

/** The picker order: Latin first, then the two right-to-left audiences. */
export const BOT_LANGS: BotLang[] = ['en', 'fa', 'ar'];

export function isBotLang(value: string): value is BotLang {
  return value === 'en' || value === 'fa' || value === 'ar';
}

/**
 * Telegram's `language_code` (`fa`, `ar`, `en-US`, …) narrowed to a language the bot actually has
 * copy for. English answers anyone the bot cannot speak to.
 */
export function langFromTelegramCode(code: string): BotLang {
  const prefix = (code ?? '').slice(0, 2).toLowerCase();
  return isBotLang(prefix) ? prefix : 'en';
}

/* ---------- keyboards ---------- */

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  /** The Mini App to launch. `type` is how Bot API 7+ names the button; the payload rides with it. */
  type?: string;
  web_app?: { url: string };
  /** Opens the chooser for any chat with this text already typed, so the bot's inline answer lands. */
  switch_inline_query?: string;
}

export interface Keyboard {
  inline_keyboard: InlineButton[][];
}

/* ---------- the words ---------- */

interface Copy {
  /** the language's own name, shown on its button in the picker */
  native: string;
  flag: string;
  /** the headline of the main menu */
  welcome: string;
  /** the rules card */
  rules: string;
  /** the invite card; `{link}` is the player's personal invite link */
  invite: string;
  /** one-line pitch handed to the share sheet and the inline answer */
  pitch: string;
  /** the `/play` launch card */
  launch: string;
  play: string;
  rulesBtn: string;
  inviteBtn: string;
  langBtn: string;
  back: string;
  menuBtn: string;
  shareBtn: string;
  challengeBtn: string;
  /** what the Command Center registers with `setMyCommands` */
  commands: Record<'start' | 'lang' | 'play' | 'rules', string>;
}

export const COPY: Record<BotLang, Copy> = {
  en: {
    native: 'English',
    flag: '🇬🇧',
    welcome: '🏁 **WELCOME TO THE ARENA!**\n\n'
      + 'Outsmart your rival in real-time 1v1 tactical races! Block paths with walls, plant sneaky '
      + 'mines on the finish line, dodge rolling logs, and claim victory.\n\n'
      + '⚡ **Are you fast enough to master Tactix?**\n'
      + 'Tap below to jump straight into the action!',
    rules: '📖 **HOW TO PLAY Tactix**\n\n'
      + '🎯 **Goal:** Be the first to reach the **FINISH** row at the top!\n\n'
      + '🕹️ **On Your Turn:**\n'
      + '• **Move:** Step 1 tile in any direction (or sidestep around your opponent).\n'
      + '• **Place a Wall:** Drop tactical walls to block your rival\'s path (you cannot completely '
      + 'lock them in!).\n'
      + '• **Plant Mines:** Set hidden traps—even right on the finish line—to blast your opponent '
      + 'backward!\n'
      + '• **Watch for Logs:** Maximum 2 rolling logs sweep down the board. Step out of their lane!\n\n'
      + '🏆 Win matches, climb the Ranks, and conquer the Channel Wars!',
    invite: '🤝 **INVITE FRIENDS**\n\n'
      + 'Beating a stranger is satisfying. Beating someone who knows you is better. Send your link '
      + 'and let the arena do the rest.\n\n'
      + '🔗 {link}\n\n'
      + '🎁 You both get 500 coins when a friend joins through it.',
    pitch: 'Race me on Tactix — we both get 500 coins when you join!',
    launch: '⚡ **THE ARENA IS OPEN**\n\n'
      + 'One tap and you are in the race. Walls, mines, rolling logs — beat your rival to the '
      + 'FINISH line!',
    play: '▶️ PLAY NOW',
    rulesBtn: '📖 How to Play',
    inviteBtn: '🤝 Invite Friends',
    langBtn: '🌐 Change Language',
    back: '🔙 Back to Menu',
    menuBtn: '🏠 Main Menu',
    shareBtn: '📤 Share Invite Link',
    challengeBtn: '💬 Challenge a Friend',
    commands: {
      start: 'Open the main menu',
      lang: 'Choose your language',
      play: 'Jump straight into a race',
      rules: 'How to play',
    },
  },

  fa: {
    native: 'فارسی',
    flag: '🇮🇷',
    welcome: '🏁 **به میدان نبرد Tactix خوش اومدی!**\n\n'
      + 'توی یه رقابت سرعتی و تاکتیکی ۱ به ۱، حریفت رو غافلگیر کن! جلوی مسیرش دیوار بکش، روی خط '
      + 'پایان مین کار بذار، از تنه‌های درخت جاخالی بده و اول از همه به خط پایان برس!\n\n'
      + '⚡ **آماده‌ای نشون بدی کی باهوش‌تره؟**\n'
      + 'روی دکمه زیر بزن و مستقیم وارد بازی شو!',
    rules: '📖 **قوانین و راهنمای Tactix**\n\n'
      + '🎯 **هدف:** اولین نفری باش که گوی خودش رو به خط **FINISH** در بالای صفحه می‌رسونه!\n\n'
      + '🕹️ **در هر نوبت می‌تونی یکی از این کارها رو انجام بدی:**\n'
      + '• **حرکت مهره:** یک خانه به جلو، عقب یا طرفین حرکت کن (پرش از روی حریف وجود نداره و باید '
      + 'دورش بزنی!).\n'
      + '• **گذاشتن دیوار:** جلوی مسیر حریف دیوار بذار تا مجبور بشه راهش رو دور کنه.\n'
      + '• **کاشتن مین:** توی مسیر یا حتی روی خط پایان مین مخفی بکار تا حریف به عقب پرتاب بشه!\n'
      + '• **مراقب تنه‌های درخت باش:** حداکثر ۲ تنه درخت در مسیر حرکت می‌کنن؛ از لاین اون‌ها کنار '
      + 'برو!\n\n'
      + '🏆 ببر، سکه جمع کن و توی جدول رده‌بندی اول شو!',
    invite: '🤝 **دعوت از دوستان**\n\n'
      + 'بردن از یه غریبه حال داره، ولی بردن از کسی که می‌شناسی خیلی بهتره. لینکت رو بفرست، بقیه‌اش '
      + 'با میدان نبرد!\n\n'
      + '🔗 {link}\n\n'
      + '🎁 با هر دعوت، تو و دوستت ۵۰۰ سکه می‌گیرید!',
    pitch: 'توی Tactix با من مسابقه بده — وقتی بیای، هر دوتون ۵۰۰ سکه می‌گیرید!',
    launch: '⚡ **میدان نبرد آماده‌ست!**\n\n'
      + 'یه ضربه و توی بازی هستی. دیوار، مین، تنه‌های درخت — زودتر از حریفت به خط پایان برس!',
    play: '▶️ شروع بازی (PLAY)',
    rulesBtn: '📖 راهنمای بازی',
    inviteBtn: '🤝 دعوت از دوستان',
    langBtn: '🌐 تغییر زبان',
    back: '🔙 بازگشت به منو',
    menuBtn: '🏠 منوی اصلی',
    shareBtn: '📤 ارسال لینک دعوت',
    challengeBtn: '💬 دعوت به مسابقه',
    commands: {
      start: 'نمایش منوی اصلی',
      lang: 'انتخاب زبان',
      play: 'مستقیم بری توی بازی',
      rules: 'راهنمای بازی',
    },
  },

  ar: {
    native: 'العربية',
    flag: '🇸🇦',
    welcome: '🏁 **مرحباً بك في ساحة Tactix!**\n\n'
      + 'تفوّق على خصمك في سباقات تكتيكية حماسية ١ ضد ١ في الوقت الفعلي! أغلق الطرق بالجدران، '
      + 'ازرع الألغام الذكية عند خط النهاية، وتفادَ الجذوع المتدحرجة لتنتزع الفوز.\n\n'
      + '⚡ **هل تملك السرعة والذكاء للوصول أولاً؟**\n'
      + 'اضغط بالأسفل وابدأ التحدي الآن!',
    rules: '📖 **طريقة اللعب والقوانين في Tactix**\n\n'
      + '🎯 **الهدف:** كن أول من يصل إلى خط النهاية (**FINISH**) في أعلى اللوحة!\n\n'
      + '🕹️ **في دورك يمكنك:**\n'
      + '• **التحرك:** تحرك مربعاً واحداً في أي اتجاه (لا يمكنك القفز فوق خصمك، بل الالتفاف حوله).\n'
      + '• **وضع جدار:** ضع جدراناً تكتيكية لإعاقة طريق خصمك وإجباره على تغيير مساره.\n'
      + '• **زرع الألغام:** ازرع ألغاماً خفية حتى على خط النهاية لقذف خصمك إلى الوراء!\n'
      + '• **احذر الجذوع:** يتدحرج بحد أقصى جذعان في الميدان، ابتعد عن مسارهما!\n\n'
      + '🏆 حقق الانتصارات، اجمع العملات، وتصدر قائمة المتصدرين!',
    invite: '🤝 **دعوة الأصدقاء**\n\n'
      + 'الفوز على شخص مجهول ممتع، لكن الفوز على من يعرفك أحلى. أرسل رابطك واترك الباقي للساحة.\n\n'
      + '🔗 {link}\n\n'
      + '🎁 تحصلان معاً على ٥٠٠ عملة عندما ينضم صديقك عبر هذا الرابط!',
    pitch: 'تحدّني في سباق Tactix — عند انضمامك نحصل على ٥٠٠ عملة!',
    launch: '⚡ **الساحة جاهزة!**\n\n'
      + 'ضغطة واحدة وتكون في قلب السباق. جدران، ألغام، وجذوع متدحرجة — كن أول من يبلغ خط النهاية!',
    play: '▶️ العب الآن (PLAY)',
    rulesBtn: '📖 طريقة اللعب',
    inviteBtn: '🤝 دعوة الأصدقاء',
    langBtn: '🌐 تغيير اللغة',
    back: '🔙 العودة للقائمة',
    menuBtn: '🏠 القائمة الرئيسية',
    shareBtn: '📤 مشاركة رابط الدعوة',
    challengeBtn: '💬 تحدي صديق',
    commands: {
      start: 'فتح القائمة الرئيسية',
      lang: 'اختيار اللغة',
      play: 'ابدأ سباقاً فوراً',
      rules: 'طريقة اللعب',
    },
  },
};

/**
 * The multilingual greeting that opens every conversation. Deliberately trilingual and never
 * localised: it is the screen a player sees *before* they have a language.
 */
export const GREETING = '🌐 **Welcome to Tactix!**\n'
  + 'Please select your language to continue:\n\n'
  + '🇮🇷 لطفاً زبان خود را انتخاب کنید:\n'
  + '🇸🇦 يرجى اختيار لغتك للمتابعة:';

/* ---------- rendering ---------- */

const HTML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
];

/** Copy authored with `**bold**` -> HTML safe to hand Telegram as `parse_mode: "HTML"`. */
export function render(copy: string): string {
  let out = copy;
  for (const [pattern, entity] of HTML_ESCAPES) out = out.replace(pattern, entity);
  return out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

/* ---------- buttons ---------- */

const webApp = (label: string, url: string): InlineButton =>
  ({ text: label, type: 'web_app', web_app: { url } });

/** The `?startapp=` the player arrived on, carried into the Mini App so the referral is not lost. */
export function launchUrl(app: string, startParam: string): string {
  const code = (startParam ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  if (!code) return app;
  try {
    /* Built through `URL` so a bare origin still comes out as a real path: `https://host/?startapp=`
       rather than the legal-but-odd `https://host?startapp=`. */
    const url = new URL(app);
    url.searchParams.set('startapp', code);
    return url.toString();
  } catch {
    return app;
  }
}

export function languagePicker(): Keyboard {
  return {
    inline_keyboard: BOT_LANGS.map((code) => [
      { text: `${COPY[code].flag} ${COPY[code].native}`, callback_data: `lang:${code}` },
    ]),
  };
}

export function mainMenu(lang: BotLang, play: string): Keyboard {
  const c = COPY[lang];
  return {
    inline_keyboard: [
      [webApp(c.play, play)],
      [
        { text: c.rulesBtn, callback_data: `menu:rules:${lang}` },
        { text: c.inviteBtn, callback_data: `menu:invite:${lang}` },
      ],
      [{ text: c.langBtn, callback_data: 'menu:lang' }],
    ],
  };
}

/** The rules card answers itself with the two things a new player wants after reading it. */
export function rulesMenu(lang: BotLang, play: string): Keyboard {
  const c = COPY[lang];
  return {
    inline_keyboard: [
      [webApp(c.play, play)],
      [{ text: c.back, callback_data: `lang:${lang}` }],
    ],
  };
}

export function inviteMenu(lang: BotLang, share: string, pitch: string): Keyboard {
  const c = COPY[lang];
  return {
    inline_keyboard: [
      [{ text: c.shareBtn, url: share }],
      [{ text: c.challengeBtn, switch_inline_query: pitch }],
      [{ text: c.back, callback_data: `lang:${lang}` }],
    ],
  };
}

export function launchCard(lang: BotLang, play: string): Keyboard {
  const c = COPY[lang];
  return {
    inline_keyboard: [
      [webApp(c.play, play)],
      [{ text: c.menuBtn, callback_data: `lang:${lang}` }],
    ],
  };
}

/** A lone PLAY button: what an inline answer dropped into someone else's chat needs. */
export function playOnly(lang: BotLang, play: string): Keyboard {
  return { inline_keyboard: [[webApp(COPY[lang].play, play)]] };
}

/* ---------- commands & menu button ---------- */

export type CommandName = 'start' | 'lang' | 'play' | 'rules';

export const COMMAND_NAMES: CommandName[] = ['start', 'lang', 'play', 'rules'];

/** One `setMyCommands` payload per language, so the client's own `/` autocomplete is localised. */
export function commandScope(lang: BotLang): { commands: { command: string; description: string }[] } {
  const c = COPY[lang];
  return { commands: COMMAND_NAMES.map((name) => ({ command: name, description: c.commands[name] })) };
}

export function inviteLink(handle: string, userId: string): string {
  return `https://t.me/${handle}?start=ref_u${userId}`;
}

/** The share-sheet link: the personal invite plus the language's own one-line pitch. */
export function shareUrl(invite: string, pitch: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent(pitch)}`;
}
