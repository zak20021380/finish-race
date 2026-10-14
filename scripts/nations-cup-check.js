/**
 * nations-cup-check.js — DOM check for the Home carousel: the two authentic
 * slides — Nations Cup (slide 0) and The Mind Ladder (slide 1).
 * Paste into the browser console on any viewport, or run via
 * scripts/verify-nations-cup.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - the track is not strictly 2 slides (data-index 0 and 1) with 2 dots, and
 *    no slide carries the removed mock text (Neon Rush / Featured Tournament /
 *    Daily Challenge / Telegram Channel Cup / Fight for Squad),
 *  - a card overflows (scrollH/scrollW > clientH/clientW), loses its radius or
 *    does not clip to it,
 *  - anything samples the backdrop (backdrop-filter / blur) — the dark-clay
 *    rule,
 *  - the Nations Cup header is not "NATIONS CUP · S4" with the globe glyph and
 *    a glowing LIVE pill, does not carry gold/silver/bronze rank markers on
 *    three 40px rows with a real flag badge, name and score each, misses the
 *    "Your nation" contribution strip, or misses the 48px "View Cup Table" pill,
 *  - The Mind Ladder header is not "THE MIND LADDER" with the brain glyph and a
 *    TOP 100 pill, does not carry three 40px podium rows (sphere avatar + flag
 *    badge + name + tier chip + gold TIQ score), misses the "You: Rank #
 *    · TIQ · Top %" standing bar, or misses the 48px "View Full Ladder" pill,
 *  - a CTA pill is under 48px tall, or a nation/podium row under 40px,
 *  - the active carousel dot / aria-selected / .is-active are out of sync with
 *    the scrolled slide,
 *  - any element bottoms out behind the tab dock, the page or #s-home scrolls,
 *    or any leaf text clips without ellipsis truncation.
 *
 * Returns { pass, fails[] }.
 */
function checkHomeCarousel() {
  const fails = [];
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const $ = (s) => document.querySelector(s);

  const track = document.getElementById('home-carousel');
  if (!track) return { pass: false, fails: ['missing #home-carousel'] };
  const cards = [...track.querySelectorAll('.car-card')];
  const dots = [...document.querySelectorAll('#home-dots .dot')];

  // ---- 1. strictly two slides ----
  if (cards.length !== 2) fails.push(`want exactly 2 slides, found ${cards.length}`);
  if (dots.length !== 2) fails.push(`want exactly 2 pagination dots, found ${dots.length}`);
  if (cards.map((c) => c.dataset.index).join(',') !== '0,1') {
    fails.push(`slide data-index must be 0,1 — found ${cards.map((c) => c.dataset.index).join(',')}`);
  }
  if (!cards[0]?.classList.contains('nations-cup')) fails.push('slide 0 must be .car-card.nations-cup');
  if (!cards[1]?.classList.contains('mind-ladder')) fails.push('slide 1 must be .car-card.mind-ladder');

  // ---- 2. no mock tournament copy anywhere on Home ----
  const homeText = (document.getElementById('s-home')?.innerText || '').replace(/\s+/g, ' ');
  for (const banned of ['Neon Rush', 'Featured Tournament', 'Daily Challenge', 'Telegram Channel Cup', 'Fight for Squad']) {
    if (new RegExp(banned, 'i').test(homeText)) fails.push(`mock slide text still present: "${banned}"`);
  }

  // ---- 3. every card clips to its radius, no overflow, no backdrop sampling ----
  for (const c of cards) {
    const name = c.className.toString().split(' ').find((x) => x !== 'car-card') || 'car-card';
    const cr = c.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0) { fails.push(`${name} has 0 size`); continue; }
    if (c.scrollHeight > c.clientHeight + 2) fails.push(`${name} clipped vertically: ${c.scrollHeight} > ${c.clientHeight}`);
    if (c.scrollWidth > c.clientWidth + 2) fails.push(`${name} clipped horizontally: ${c.scrollWidth} > ${c.clientWidth}`);
    const cs = getComputedStyle(c);
    if ((parseFloat(cs.borderBottomLeftRadius) || 0) < 8) fails.push(`${name} lost its bottom radius`);
    if (cs.overflow !== 'hidden' && cs.overflowY !== 'hidden' && cs.overflow !== 'clip') {
      fails.push(`${name} must clip to its radius (overflow ${cs.overflow})`);
    }
    const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
    if (bf !== 'none') fails.push(`${name} samples the backdrop (backdrop-filter ${bf})`);
    if (/blur\(/.test(cs.filter || '')) fails.push(`${name} applies blur()`);
  }

  // ---- 4. Nations Cup (slide 0) ----
  const cup = cards.find((c) => c.classList.contains('nations-cup'));
  if (cup) {
    const kicker = cup.querySelector('.nations-kicker');
    const ktxt = (kicker?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/nations cup/i.test(ktxt) || !/s4/i.test(ktxt)) fails.push(`cup header "${ktxt}" — want "NATIONS CUP · S4"`);
    if (!kicker?.querySelector('.nations-ico use[href="#i-globe"]')) fails.push('cup header missing the globe glyph');
    const live = cup.querySelector('.cup-live');
    if (!live || !/live/i.test(live.textContent || '')) fails.push('cup missing the LIVE pill');
    if (live) {
      const before = getComputedStyle(live, '::before');
      if (before.content === 'none') { /* pulse dot is a child, not a pseudo */ }
      if (!live.querySelector('.live-dot')) fails.push('LIVE pill missing its pulse dot');
    }
    const rows = [...cup.querySelectorAll('.nations-rank .nations-row:not(.is-error)')];
    if (rows.length !== 3) fails.push(`cup wants exactly 3 nation rows, found ${rows.length}`);
    const wantBadge = ['gold', 'silver', 'bronze'];
    rows.forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (r.height < 39.5) fails.push(`nation row ${i + 1} height ${Math.round(r.height)} < 40px`);
      const rk = li.querySelector('.rk');
      if ((rk?.textContent || '').trim() !== String(i + 1)) fails.push(`nation row ${i + 1} rank marker "${(rk?.textContent || '').trim()}" — want "${i + 1}"`);
      if (!rk?.classList.contains(wantBadge[i])) fails.push(`nation row ${i + 1} rank ${i + 1} missing .${wantBadge[i]} badge`);
      const circ = li.querySelector('.flag-circle');
      if (!circ) fails.push(`nation row ${i + 1} missing .flag-circle flag badge`);
      else {
        const img = circ.querySelector('img.flag-img');
        if (img && img.loading !== 'lazy') fails.push(`nation row ${i + 1} flag must be lazy-loaded`);
        if (!img && !circ.querySelector('.flag-mono')) fails.push(`nation row ${i + 1} flag needs a lazy img or a monogram fallback`);
        if (li.querySelector('.flag-code')) fails.push(`nation row ${i + 1} shows the 2-letter text box`);
      }
      const nm = li.querySelector('.nm');
      if (!(nm?.textContent || '').trim()) fails.push(`nation row ${i + 1} missing a country name`);
      if (nm && getComputedStyle(nm).textOverflow !== 'ellipsis') fails.push(`nation row ${i + 1} name must ellipsize`);
      const pt = li.querySelector('.pt b');
      if (!/^[\d,]+$/.test((pt?.textContent || '').trim())) fails.push(`nation row ${i + 1} missing a numeric score`);
      if (!/tabular-nums/.test(getComputedStyle(li.querySelector('.pt')).fontVariantNumeric || '')) fails.push(`nation row ${i + 1} score must use tabular numbers`);
    });
    const mine = document.getElementById('home-nation-mine');
    if (!mine || !/^your nation:/i.test((mine.textContent || '').trim())) fails.push('cup missing the "Your nation" contribution strip');
    const btn = document.getElementById('home-cup-table');
    if (!btn) fails.push('cup missing #home-cup-table');
    else {
      if ((btn.textContent || '').trim() !== 'View Cup Table') fails.push(`cup CTA "${(btn.textContent || '').trim()}" — want "View Cup Table"`);
      const h = btn.getBoundingClientRect().height;
      if (h < 47.5) fails.push(`cup CTA height ${Math.round(h)} < 48px`);
    }
  }

  // ---- 5. The Mind Ladder (slide 1) ----
  const mind = cards.find((c) => c.classList.contains('mind-ladder'));
  if (mind) {
    const kicker = mind.querySelector('.mind-kicker');
    if (!/mind ladder/i.test((kicker?.textContent || '').replace(/\s+/g, ' '))) fails.push('ladder header missing "THE MIND LADDER"');
    if (!kicker?.querySelector('.mind-ico use[href="#i-brain"]')) fails.push('ladder header missing the brain glyph');
    const top = mind.querySelector('.mind-top');
    if (!/top 100/i.test((top?.textContent || '').trim())) fails.push(`ladder status pill "${(top?.textContent || '').trim()}" — want "Top 100"`);
    const rows = [...mind.querySelectorAll('.mind-podium .mind-row:not(.is-error)')];
    if (rows.length !== 3) fails.push(`ladder wants exactly 3 podium rows, found ${rows.length}`);
    rows.forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (r.height < 39.5) fails.push(`podium row ${i + 1} height ${Math.round(r.height)} < 40px`);
      if (!li.querySelector('.mind-av')) fails.push(`podium row ${i + 1} missing the sphere avatar`);
      if (!li.querySelector('.mind-flag')) fails.push(`podium row ${i + 1} missing the flag badge`);
      if (!(li.querySelector('.mind-nm')?.textContent || '').trim()) fails.push(`podium row ${i + 1} missing the player name`);
      if (!(li.querySelector('.mind-tier')?.textContent || '').trim()) fails.push(`podium row ${i + 1} missing the tier chip`);
      const sc = li.querySelector('.mind-score');
      if (!/^[\d,]+$/.test((sc?.textContent || '').trim())) fails.push(`podium row ${i + 1} missing a numeric TIQ score`);
      const col = sc ? getComputedStyle(sc).color : '';
      if (!/rgb\(252,\s*211,\s*77\)/.test(col)) fails.push(`podium row ${i + 1} TIQ score not gold (${col})`);
    });
    const mine = document.getElementById('home-mind-mine');
    if (!/^you: rank #\d+ · tiq [\d,]+ · top \d+% global mind$/i.test((mine?.textContent || '').trim())) {
      fails.push(`ladder standing bar "${(mine?.textContent || '').trim()}" — want "You: Rank #N · TIQ N · Top N% Global Mind"`);
    }
    const btn = document.getElementById('home-mind-cta');
    if (!btn) fails.push('ladder missing #home-mind-cta');
    else {
      if ((btn.textContent || '').trim() !== 'View Full Ladder') fails.push(`ladder CTA "${(btn.textContent || '').trim()}" — want "View Full Ladder"`);
      const h = btn.getBoundingClientRect().height;
      if (h < 47.5) fails.push(`ladder CTA height ${Math.round(h)} < 48px`);
    }
  }

  // ---- 6. dots: inside the card, synced to the scrolled slide ----
  const dotsBox = document.getElementById('home-dots');
  const active = (() => {
    const step = cards[1] ? cards[1].offsetLeft - cards[0].offsetLeft : 1;
    return Math.min(cards.length - 1, Math.max(0, Math.round(track.scrollLeft / (step || 1))));
  })();
  if (dotsBox) {
    const dr = dotsBox.getBoundingClientRect();
    const cr = cards[active].getBoundingClientRect();
    if (dr.left < cr.left - 1 || dr.right > cr.right + 1) fails.push('dots are not inside the active card');
    const dot = dotsBox.querySelector('.dot');
    const after = dot ? getComputedStyle(dot, '::after') : null;
    if (after) {
      const w = parseFloat(after.width) || 0;
      const h = parseFloat(after.height) || 0;
      // The card's inside dot reserve (28px) is the ceiling for the band: it may
      // not grow upward or it would swallow the CTA's tap area.
      if (w < 44 || h < 24) fails.push(`dot hit area ${w}x${h} — want at least 44x24`);
    }
    dots.forEach((d, i) => {
      const on = i === active;
      if (d.classList.contains('on') !== on) fails.push(`dot ${i} .on out of sync (active slide ${active})`);
      if (d.getAttribute('aria-selected') !== String(on)) fails.push(`dot ${i} aria-selected out of sync`);
    });
    cards.forEach((c, i) => {
      if (c.classList.contains('is-active') !== (i === active)) fails.push(`slide ${i} .is-active out of sync`);
    });
  } else {
    fails.push('missing #home-dots');
  }

  // ---- 7. column fit + nothing behind the dock ----
  const tabs = document.getElementById('tabs');
  const tabTop = tabs ? tabs.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  const home = document.getElementById('s-home');
  if (document.documentElement.scrollHeight > window.innerHeight + 1) fails.push('the page scrolls');
  if (home && home.scrollHeight > home.clientHeight + 2) fails.push(`#s-home overflows (${home.scrollHeight} > ${home.clientHeight})`);
  if (home) {
    for (const el of home.querySelectorAll('*')) {
      if (el.closest('#tabs')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > tabTop + 1) {
        fails.push(`behind the tab dock: <${el.tagName.toLowerCase()} class="${el.className.toString().slice(0, 40)}">`);
        break;
      }
    }
  }
  const play = document.getElementById('home-play');
  if (play && play.getBoundingClientRect().bottom > tabTop + 1) fails.push('PLAY is pushed behind the dock');

  // ---- 8. no clipped leaf text without ellipsis inside the deck ----
  for (const c of cards) {
    for (const el of c.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.scrollWidth <= el.clientWidth + 2) continue;
      const st = getComputedStyle(el);
      if (st.textOverflow === 'ellipsis') continue;
      if (st.position === 'absolute' && (st.clip !== 'auto' || /rect\(/.test(st.clipPath || ''))) continue;
      if (el.children.length === 0 && (el.textContent || '').trim().length > 0) {
        fails.push(`text clipped without ellipsis: <${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent || '').trim().slice(0, 32)}"`);
        break;
      }
    }
  }

  return { pass: fails.length === 0, fails };
}

/** Back-compat entry point used by scripts/verify-nations-cup.mjs. */
function checkNationsCup() {
  return checkHomeCarousel();
}

// Browser-console usage
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkHomeCarousel();
  if (!r.pass) throw new Error(`home carousel:\n- ${r.fails.join('\n- ')}`);
}
