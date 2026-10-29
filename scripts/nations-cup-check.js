/**
 * nations-cup-check.js — DOM check for the Home carousel: the three authentic
 * slides — Channel War (slide 0), Nations Cup (slide 1) and The Mind
 * Ladder (slide 2).
 * Paste into the browser console on any viewport, or run via
 * scripts/verify-nations-cup.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - the track is not strictly 3 slides (data-index 0,1,2) with 3 dots in the
 *    same order, and no slide carries the removed mock text (Neon Rush /
 *    Featured Tournament / Daily Challenge / Telegram Channel Cup /
 *    Fight for Squad),
 *  - a card overflows (scrollH/scrollW > clientH/clientW), loses its radius or
 *    does not clip to it,
 *  - anything samples the backdrop (backdrop-filter / blur) — the dark-clay
 *    rule,
 *  - the Channel War header is not "CHANNEL WAR · 200★" behind a 24px
 *    star pod, misses the WINNER TAKES ALL beacon chip, misses the authentic
 *    Telegram Stars PNG hero (64px, star-float loop, warm rim + obsidian cast)
 *    or its recessed dark-clay pedestal dish, still carries the removed
 *    blades/shield SVG frame or the 120/50/30 pool pods, misses the single
 *    200 STARS vault or the recessed telemetry HUD (metallic crown + "LEADER:
 *    @handle" + the amber monospace "NNh NNm left" clock), misses the 48px
 *    "FIGHT FOR YOUR CHANNEL · 200★" gold key, or misses the 22px centered
 *    "Channel admin? Enlist here" Telegram-cyan micro-chip,
 *  - the three slides do not share one exact height (the locked footprint),
 *
 *  - the Nations Cup header is not "NATIONS CUP · S4" with the globe glyph and
 *    a glowing LIVE pill, does not carry gold/silver/bronze rank markers on the
 *    Top-5 30px rows (plain markers on 4-5) with a real flag badge, name and
 *    score each, misses the "Your nation" contribution strip, or misses the
 *    48px "View Cup Table" pill,
 *  - The Mind Ladder header is not "THE MIND LADDER" with the brain glyph and a
 *    TOP 100 pill, does not carry five 30px podium rows (sphere avatar + flag
 *    badge + name + tier chip + gold TIQ score), misses the "You: Rank #
 *    · TIQ · Top %" standing bar, or misses the 48px "View Full Ladder" pill,
 *  - a CTA pill is under 48px tall, or a nation/podium row under 30px,
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

  // ---- 1. three slides, the tournament first ----
  if (cards.length !== 3) fails.push(`want exactly 3 slides, found ${cards.length}`);
  if (dots.length !== 3) fails.push(`want exactly 3 pagination dots, found ${dots.length}`);
  if (cards.map((c) => c.dataset.index).join(',') !== '0,1,2') {
    fails.push(`slide data-index must be 0,1,2 — found ${cards.map((c) => c.dataset.index).join(',')}`);
  }
  if (!cards[0]?.classList.contains('carousel-slide-tournament')) fails.push('slide 0 must be .car-card.carousel-slide-tournament');
  if (!cards[1]?.classList.contains('nations-cup')) fails.push('slide 1 must be .car-card.nations-cup');
  if (!cards[1]?.classList.contains('carousel-slide-nations')) fails.push('slide 1 must also carry .carousel-slide-nations');
  if (!cards[2]?.classList.contains('mind-ladder')) fails.push('slide 2 must be .car-card.mind-ladder');

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
  // The one footprint: no slide may be a pixel taller or shorter than its siblings.
  const heights = cards.map((c) => c.getBoundingClientRect().height);
  for (let i = 1; i < heights.length; i += 1) {
    if (Math.abs(heights[i] - heights[0]) > 0.5) {
      fails.push(`slide ${i} height ${heights[i].toFixed(1)} ≠ slide 0 height ${heights[0].toFixed(1)} — the track must not resize between slides`);
      break;
    }
  }
  const pads = cards.map((c) => parseFloat(getComputedStyle(c).paddingBottom) || 0);
  for (let i = 1; i < pads.length; i += 1) {
    if (Math.abs(pads[i] - pads[0]) > 0.5) {
      fails.push(`slide ${i} bottom reserve ${pads[i]}px ≠ slide 0 reserve ${pads[0]}px — the dots must keep one bottom margin`);
      break;
    }
  }

  // ---- 4. Channel War (slide 0) ----
  const tour = cards.find((c) => c.classList.contains('carousel-slide-tournament'));
  if (tour) {
    const kicker = tour.querySelector('.tour-kicker');
    const title = tour.querySelector('.tour-title');
    const ktxt = (title?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/channel war/i.test(ktxt) || !/200/.test(ktxt)) fails.push(`war header "${ktxt}" — want "CHANNEL WAR · 200★"`);
    const pod = kicker?.querySelector('.tour-star-pod');
    if (!pod) fails.push('war header missing the 24px star pod');
    else {
      const pr = pod.getBoundingClientRect();
      if (!near(pr.width, 24, 1.5) || !near(pr.height, 24, 1.5)) {
        fails.push(`star pod is ${Math.round(pr.width)}x${Math.round(pr.height)} — want 24x24`);
      }
      if (!pod.querySelector('use[href="#i-star-3d"]')) fails.push('star pod missing the 3D star glyph');
    }
    if (title) {
      const ts = getComputedStyle(title);
      if (!near(parseFloat(ts.fontSize), 12.5, .6)) fails.push(`war title font-size ${ts.fontSize} — want 12.5px`);
      if (Number(ts.fontWeight) < 700) fails.push(`war title weight ${ts.fontWeight} — want bold`);
      if (!/rgb\(248,\s*250,\s*252\)/.test(ts.color)) fails.push(`war title colour ${ts.color} — want #F8FAFC`);
      if (!near(parseFloat(ts.letterSpacing) || 0, .5, .25)) fails.push(`war title tracking ${ts.letterSpacing} — want +0.5px`);
    }
    const chip = tour.querySelector('.tour-chip');
    if (!chip) fails.push('war missing the WINNER TAKES ALL chip');
    else {
      if (!/winner takes all|jackpot/i.test((chip.textContent || '').replace(/\s+/g, ' '))) fails.push(`chip "${(chip.textContent || '').trim()}" — want "WINNER TAKES ALL"`);
      const cs = getComputedStyle(chip);
      if (!/220,\s*38,\s*38/.test(cs.backgroundImage) || !/245,\s*158,\s*11/.test(cs.backgroundImage)) {
        fails.push('chip must carry the 135deg ember gradient (220,38,38 → 245,158,11)');
      }
      if (!near(parseFloat(cs.borderTopWidth), 1, .3) || !/245,\s*158,\s*11/.test(cs.borderTopColor)) {
        fails.push(`chip border ${cs.borderTopWidth} ${cs.borderTopColor} — want 1px rgba(245,158,11,.5)`);
      }
      if (!near(parseFloat(cs.fontSize), 8.5, .6)) fails.push(`chip font-size ${cs.fontSize} — want 8.5px`);
      const beacon = chip.querySelector('.tour-beacon');
      if (!beacon) fails.push('chip missing the amber beacon dot');
      else if (getComputedStyle(beacon).animationName === 'none') fails.push('beacon dot is not pulsing');
    }
    const star = tour.querySelector('.tour-star-img');
    if (!star) fails.push('war hero missing the authentic Telegram Star image');
    else {
      if (star.tagName !== 'IMG') fails.push(`war hero star is <${star.tagName.toLowerCase()}> — want the telegram_stars.png <img>`);
      const src = star.currentSrc || star.src || '';
      if (!/telegram_stars/i.test(src)) fails.push(`war hero star src "${src}" — want the telegram_stars asset`);
      if (!star.complete || (star.naturalWidth || 0) < 32 || (star.naturalHeight || 0) < 32) {
        fails.push(`war hero star asset did not render (complete=${star.complete}, ${star.naturalWidth}x${star.naturalHeight})`);
      }
      const sr = star.getBoundingClientRect();
      if (sr.width < 60 || sr.width > 76 || sr.height < 60 || sr.height > 76) {
        fails.push(`war star is ${Math.round(sr.width)}x${Math.round(sr.height)} — want ~64px`);
      }
      const sf = getComputedStyle(star).filter || '';
      if (!/245,\s*158,\s*11/.test(sf) || !/24px/.test(sf)) fails.push(`war star glow "${sf}" — want drop-shadow(0 0 24px rgba(245,158,11,.6))`);
      if (!/10px\s+20px/.test(sf) || !/0,\s*0,\s*0/.test(sf)) fails.push(`war star cast "${sf}" — want drop-shadow(0 10px 20px rgba(0,0,0,.75))`);
      if (getComputedStyle(star).animationName !== 'star-float') fails.push('war star is not levitating (want animation star-float)');
    }
    const dish = tour.querySelector('.tour-pedestal');
    if (!dish) fails.push('war hero missing the recessed pedestal dish');
    else {
      const ds = getComputedStyle(dish);
      if (!/radial-gradient/.test(ds.backgroundImage) || !/245,\s*158,\s*11/.test(ds.backgroundImage) || !/30,\s*41,\s*59/.test(ds.backgroundImage)) {
        fails.push(`pedestal "${ds.backgroundImage}" — want the amber-to-dark-clay radial dish`);
      }
      const db = dish.getBoundingClientRect();
      if (db.width < 90 || db.height < 32) fails.push(`pedestal is ${Math.round(db.width)}x${Math.round(db.height)} — too small to read as a dish`);
    }
    if (tour.querySelector('.tour-blades, .tour-blade, .tour-shield, svg.tour-star')) {
      fails.push('the placeholder blades/shield SVG frame is still in the hero');
    }
    if (tour.querySelector('.tour-pods, .tour-pod')) fails.push('the 3-pod prize split is still in the DOM');
    const cardText = (tour.innerText || '').replace(/\s+/g, ' ');
    for (const gone of ['120', '2ND', '3RD']) {
      if (new RegExp(`\\b${gone}\\b`).test(cardText)) fails.push(`split-prize copy "${gone}" still rendered`);
    }
    const vault = tour.querySelector('.tour-vault');
    if (!vault) fails.push('war missing the winner-takes-all vault card');
    else {
      const vs = getComputedStyle(vault);
      if (!/30,\s*41,\s*59/.test(vs.backgroundImage) || !/15,\s*23,\s*42/.test(vs.backgroundImage)) {
        fails.push('vault must carry the dark-clay gradient (30,41,59 → 15,23,42)');
      }
      if (!near(parseFloat(vs.borderTopWidth), 1, .3) || !/245,\s*158,\s*11/.test(vs.borderTopColor)) {
        fails.push(`vault border ${vs.borderTopWidth} ${vs.borderTopColor} — want 1px rgba(245,158,11,.35)`);
      }
      if (!/254,\s*243,\s*199/.test(vs.boxShadow) || !/8px\s+20px/.test(vs.boxShadow)) {
        fails.push('vault must carry the inset gold line + 0 8px 20px drop');
      }
      const vk = vault.querySelector('.tour-vault-k');
      const ktext = (vk?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/1st place channel wins/i.test(ktext)) fails.push(`vault label "${ktext}" — want "1ST PLACE CHANNEL WINS"`);
      if (vk) {
        const ks = getComputedStyle(vk);
        if (!near(parseFloat(ks.fontSize), 9, .6)) fails.push(`vault label font-size ${ks.fontSize} — want 9px`);
        if (!/251,\s*191,\s*36/.test(ks.color)) fails.push(`vault label colour ${ks.color} — want #FBBF24`);
      }
      const vv = vault.querySelector('.tour-vault-v');
      const vtext = (vv?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/200 stars/i.test(vtext)) fails.push(`vault value "${vtext}" — want "200 STARS"`);
      if (vv) {
        const vvs = getComputedStyle(vv);
        if (!near(parseFloat(vvs.fontSize), 24, .6)) fails.push(`vault value font-size ${vvs.fontSize} — want 24px`);
        if (Number(vvs.fontWeight) < 900) fails.push(`vault value weight ${vvs.fontWeight} — want black`);
        if (!/linear-gradient/.test(vvs.backgroundImage)) fails.push('vault value must carry the gold gradient fill');
        if (vvs.backgroundClip !== 'text' && vvs.webkitBackgroundClip !== 'text') fails.push('vault value gold fill must clip to the text');
        if (!/tabular-nums/.test(vvs.fontVariantNumeric || '')) fails.push('vault value must use tabular numbers');
      }
      const vsub = vault.querySelector('.tour-vault-sub');
      const stext = (vsub?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/runners-up get 0/i.test(stext) || !/conquest/i.test(stext)) fails.push(`vault clause "${stext}" — want the runners-up get 0★ clause`);
      if (vsub) {
        const ss = getComputedStyle(vsub);
        if (!near(parseFloat(ss.fontSize), 9, .6)) fails.push(`vault clause font-size ${ss.fontSize} — want 9px`);
        if (!/100,\s*116,\s*139/.test(ss.color)) fails.push(`vault clause colour ${ss.color} — want #64748B`);
      }
    }
    const hud = tour.querySelector('.tour-hud');
    const leader = hud?.querySelector('.tour-leader');
    if (!hud) fails.push('war missing the telemetry HUD capsule');
    else {
      const hs = getComputedStyle(hud);
      if (!near(parseFloat(hs.borderTopWidth), 1, .3) || !/255,\s*255,\s*255/.test(hs.borderTopColor)) {
        fails.push(`HUD border ${hs.borderTopWidth} ${hs.borderTopColor} — want 1px rgba(255,255,255,.08)`);
      }
      if (!/15,\s*23,\s*42/.test(hs.backgroundColor)) fails.push(`HUD fill ${hs.backgroundColor} — want rgba(15,23,42,.7)`);
      if (!near(parseFloat(hs.borderTopLeftRadius), 8, .6)) fails.push(`HUD radius ${hs.borderTopLeftRadius} — want 8px`);
      if (!near(parseFloat(hs.paddingTop), 4, .6) || !near(parseFloat(hs.paddingLeft), 10, .6)) {
        fails.push(`HUD padding ${hs.padding} — want 4px 10px`);
      }
      if (!near(parseFloat(hs.marginBottom), 8, .6)) fails.push(`HUD margin-bottom ${hs.marginBottom} — want 8px`);
    }
    if (!leader) fails.push('war missing the leader telemetry');
    else {
      if (!/^leader:\s*@[a-z0-9_]+/i.test((leader.textContent || '').replace(/\s+/g, ' ').trim())) {
        fails.push(`leader line "${(leader.textContent || '').trim()}" — want "LEADER: @Handle"`);
      }
      const crown = leader.querySelector('.tour-leader-ico');
      if (!crown?.querySelector('use[href="#i-crown"], use[href="#i-shield"]')) {
        fails.push('leader telemetry missing its crown/shield glyph');
      } else {
        const gr = crown.getBoundingClientRect();
        if (!near(gr.width, 12, 0.6) || !near(gr.height, 12, 0.6)) {
          fails.push(`leader glyph is ${Math.round(gr.width)}x${Math.round(gr.height)} — want 12x12`);
        }
      }
      const k = leader.querySelector('.tour-leader-k');
      if (!/^leader:?$/i.test((k?.textContent || '').trim())) fails.push(`leader label "${(k?.textContent || '').trim()}" — want "LEADER:"`);
      else {
        const ks = getComputedStyle(k);
        if (!near(parseFloat(ks.fontSize), 9, 0.5)) fails.push(`leader label font-size ${ks.fontSize} — want 9px`);
        if (!/148,\s*163,\s*184/.test(ks.color)) fails.push(`leader label colour ${ks.color} — want #94A3B8`);
      }
      const handle = leader.querySelector('.tour-leader-h, #tour-leader-handle');
      if (!handle) fails.push('leader telemetry missing the channel handle');
      else {
        const hs = getComputedStyle(handle);
        if (!near(parseFloat(hs.fontSize), 9, 0.5)) fails.push(`leader handle font-size ${hs.fontSize} — want 9px`);
        if (!/248,\s*250,\s*252/.test(hs.color)) fails.push(`leader handle colour ${hs.color} — want #F8FAFC`);
        if (!/56,\s*189,\s*248/.test(hs.textShadow)) fails.push(`leader handle needs the cyan halo (text-shadow ${hs.textShadow})`);
      }
    }
    const clock = hud?.querySelector('.tour-clock');
    if (!/\d{2}h\s\d{2}m left/i.test((clock?.textContent || '').replace(/\s+/g, ' '))) {
      fails.push(`war clock "${(clock?.textContent || '').trim()}" — want "02h 45m left"`);
    }
    if (clock) {
      const cs = getComputedStyle(clock);
      if (!/monospace/.test(cs.fontFamily)) fails.push('war clock must stay monospace');
      if (!/tabular-nums/.test(cs.fontVariantNumeric || '')) fails.push('war clock must use tabular numbers');
      if (!near(parseFloat(cs.fontSize), 10, 0.6)) fails.push(`war clock font-size ${cs.fontSize} — want 10px`);
      if (!/251,\s*191,\s*36/.test(cs.color)) fails.push(`war clock colour ${cs.color} — want #FBBF24`);
      if (!clock.querySelector('.tour-clock-dot')) fails.push('war clock missing its glowing dot');
    }
    const btn = document.getElementById('home-tournament-cta');
    if (!btn) fails.push('war missing #home-tournament-cta');
    else {
      const bt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/fight for your channel/i.test(bt) || !/200/.test(bt)) {
        fails.push(`war CTA "${bt}" — want "FIGHT FOR YOUR CHANNEL" + "200★"`);
      }
      const h = btn.getBoundingClientRect().height;
      if (h < 47.5) fails.push(`war CTA height ${Math.round(h)} < 48px`);
      const bs = getComputedStyle(btn);
      if (!/245,\s*158,\s*11/.test(bs.backgroundImage) || !/217,\s*119,\s*6/.test(bs.backgroundImage)) {
        fails.push('war CTA must carry the gold gradient (245,158,11 → 217,119,6)');
      }
      if (!/217,\s*119,\s*6/.test(bs.boxShadow) || !/254,\s*243,\s*199/.test(bs.boxShadow)) {
        fails.push(`war CTA shadow "${bs.boxShadow}" — want the amber drop + cream inset line`);
      }
    }
    const admin = document.getElementById('home-tournament-admin');
    if (!admin) fails.push('war missing #home-tournament-admin (channel-admin enlistment)');
    else {
      const at = (admin.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/channel admin/i.test(at) || !/enlist/i.test(at)) {
        fails.push(`enlistment chip "${at}" — want "Channel admin? Enlist here"`);
      }
      if (!admin.querySelector('use[href="#i-send"], use[href="#i-crown"], use[href="#i-bot"]')) {
        fails.push('enlistment chip missing its plane/crown glyph');
      }
      const ab = admin.getBoundingClientRect();
      if (!near(ab.height, 22, 1.5)) fails.push(`enlistment chip height ${Math.round(ab.height)} — want 22px`);
      const tourW = tour.getBoundingClientRect().width;
      if (ab.width >= tourW - 20) fails.push(`enlistment chip spans ${Math.round(ab.width)}px — must stay an auto-width micro-chip`);
      const chipLeft = ab.left - tour.getBoundingClientRect().left;
      const chipRight = tour.getBoundingClientRect().right - ab.right;
      if (Math.abs(chipLeft - chipRight) > 2) fails.push('enlistment chip must be centered in the card');
      const as = getComputedStyle(admin);
      if (!/14,\s*165,\s*233/.test(as.backgroundColor)) fails.push(`enlistment chip fill ${as.backgroundColor} — want rgba(14,165,233,.08)`);
      if (!near(parseFloat(as.borderTopWidth), 1, .3) || !/14,\s*165,\s*233/.test(as.borderTopColor)) {
        fails.push(`enlistment chip border ${as.borderTopWidth} ${as.borderTopColor} — want 1px rgba(14,165,233,.28)`);
      }
      if (!near(parseFloat(as.borderTopLeftRadius), 20, .6)) fails.push(`enlistment chip radius ${as.borderTopLeftRadius} — want 20px`);
      if (!near(parseFloat(as.marginTop), 6, .6)) fails.push(`enlistment chip margin-top ${as.marginTop} — want 6px`);
      if (!near(parseFloat(as.paddingLeft), 12, .6)) fails.push(`enlistment chip padding ${as.padding} — want 0 12px`);
      if (!/56,\s*189,\s*248/.test(as.color)) fails.push(`enlistment chip colour ${as.color} — want #38BDF8`);
      if (!near(parseFloat(as.fontSize), 9, .5)) fails.push(`enlistment chip font-size ${as.fontSize} — want 9px`);
      if (Number(as.fontWeight) < 500) fails.push(`enlistment chip weight ${as.fontWeight} — want medium`);
      if (!near(parseFloat(as.letterSpacing) || 0, .4, .15)) fails.push(`enlistment chip tracking ${as.letterSpacing} — want +0.4px`);
    }
  }

  // ---- 5. Nations Cup (slide 1) ----
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
    if (rows.length !== 5) fails.push(`cup wants Top-5 nation rows, found ${rows.length}`);
    const wantBadge = ['gold', 'silver', 'bronze'];
    rows.forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (r.height < 29.5) fails.push(`nation row ${i + 1} height ${Math.round(r.height)} < 30px`);
      const rk = li.querySelector('.rk');
      if ((rk?.textContent || '').trim() !== String(i + 1)) fails.push(`nation row ${i + 1} rank marker "${(rk?.textContent || '').trim()}" — want "${i + 1}"`);
      if (i < 3) {
        if (!rk?.classList.contains(wantBadge[i])) fails.push(`nation row ${i + 1} rank ${i + 1} missing .${wantBadge[i]} badge`);
      } else if (rk && wantBadge.some((b) => rk.classList.contains(b))) {
        fails.push(`nation row ${i + 1} must carry a plain rank marker, not a medal`);
      }
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
      const wrap = li.querySelector('.nation-score-wrap');
      const pt = wrap && wrap.querySelector('.score-val');
      if (!/^[\d,]+$/.test((pt?.textContent || '').trim())) fails.push(`nation row ${i + 1} missing a numeric score`);
      if ((wrap?.querySelector('.score-tiq')?.textContent || '').trim() !== 'TIQ') fails.push(`nation row ${i + 1} score must carry the TIQ unit`);
      if (!wrap?.querySelector('svg.score-brain-icon')) fails.push(`nation row ${i + 1} score must wear the brain token`);
      if (wrap && !/tabular-nums/.test(getComputedStyle(wrap).fontVariantNumeric || '')) fails.push(`nation row ${i + 1} score must use tabular numbers`);
    });
    const mine = document.getElementById('home-nation-mine');
    if (!mine || !mine.classList.contains('hud-mine')) fails.push('cup missing the "Your nation" standing bar');
    else {
      if (!mine.querySelector('.hm-l .hm-flag')) fails.push('cup standing bar missing the flag plate');
      if (!(mine.querySelector('.hm-l .hm-name')?.textContent || '').trim()) fails.push('cup standing bar missing the nation label');
      if (!mine.querySelector('.hm-c .hm-pill')) fails.push('cup standing bar missing the standing pill');
      if (!/^\+?[\d,]+$/.test((mine.querySelector('.hm-r .hm-v')?.textContent || '').trim())) fails.push('cup standing bar missing a numeric score');
    }
    const btn = document.getElementById('home-cup-table');
    if (!btn) fails.push('cup missing #home-cup-table');
    else {
      if ((btn.textContent || '').trim() !== 'View Cup Table') fails.push(`cup CTA "${(btn.textContent || '').trim()}" — want "View Cup Table"`);
      const h = btn.getBoundingClientRect().height;
      if (h < 47.5) fails.push(`cup CTA height ${Math.round(h)} < 48px`);
    }
  }

  // ---- 6. The Mind Ladder (slide 2) ----
  const mind = cards.find((c) => c.classList.contains('mind-ladder'));
  if (mind) {
    const kicker = mind.querySelector('.mind-kicker');
    if (!/mind ladder/i.test((kicker?.textContent || '').replace(/\s+/g, ' '))) fails.push('ladder header missing "THE MIND LADDER"');
    if (!kicker?.querySelector('.mind-ico use[href="#i-brain"]')) fails.push('ladder header missing the brain glyph');
    const top = mind.querySelector('.mind-top');
    if (!/top 100/i.test((top?.textContent || '').trim())) fails.push(`ladder status pill "${(top?.textContent || '').trim()}" — want "Top 100"`);
    const rows = [...mind.querySelectorAll('.mind-podium .mind-row:not(.is-error)')];
    if (rows.length !== 5) fails.push(`ladder wants Top-5 podium rows, found ${rows.length}`);
    rows.forEach((li, i) => {
      const r = li.getBoundingClientRect();
      if (r.height < 29.5) fails.push(`podium row ${i + 1} height ${Math.round(r.height)} < 30px`);
      if (!li.querySelector('.mind-av')) fails.push(`podium row ${i + 1} missing the sphere avatar`);
      if (!li.querySelector('.mind-flag')) fails.push(`podium row ${i + 1} missing the flag badge`);
      const rk = li.querySelector('.mind-rank');
      if (!/^\d+$/.test((rk?.textContent || '').replace('#', '').trim())) fails.push(`podium row ${i + 1} missing the rank emblem`);
      if (li.querySelector('.mind-tier')) fails.push(`podium row ${i + 1} still wears a deprecated tier pill`);
      if (!(li.querySelector('.mind-nm')?.textContent || '').trim()) fails.push(`podium row ${i + 1} missing the player name`);
      if (!(li.querySelector('.mind-trend')?.textContent || '').trim()) fails.push(`podium row ${i + 1} missing the trend delta`);
      const sc = li.querySelector('.mind-score');
      if (!/^[\d,]+$/.test((sc?.textContent || '').trim())) fails.push(`podium row ${i + 1} missing a numeric TIQ score`);
      if (!sc?.querySelector('use[href="#i-cup"]')) fails.push(`podium row ${i + 1} score has no trophy marker`);
      const col = sc ? getComputedStyle(sc).color : '';
      if (!/rgb\(252,\s*211,\s*77\)/.test(col)) fails.push(`podium row ${i + 1} TIQ score not gold (${col})`);
    });
    const mine = document.getElementById('home-mind-mine');
    if (!mine || !mine.classList.contains('hud-mine')) fails.push('ladder missing the personal standing bar');
    else {
      if (!/^#\d+$/.test((mine.querySelector('.hm-l .hm-badge')?.textContent || '').trim())) fails.push('ladder standing bar missing the rank badge');
      if (!(mine.querySelector('.hm-l .hm-name')?.textContent || '').trim()) fails.push('ladder standing bar missing the YOU label');
      if (!mine.querySelector('.hm-c .hm-pill')) fails.push('ladder standing bar missing the standing pill');
      if (!/^[\d,]+$/.test((mine.querySelector('.hm-r .hm-v')?.textContent || '').trim())) fails.push('ladder standing bar missing a numeric TIQ');
      if (!mine.querySelector('.hm-r .mind-brain')) fails.push('ladder standing bar missing the brain token');
    }
    const btn = document.getElementById('home-mind-cta');
    if (!btn) fails.push('ladder missing #home-mind-cta');
    else {
      if ((btn.textContent || '').trim() !== 'View Full Ladder') fails.push(`ladder CTA "${(btn.textContent || '').trim()}" — want "View Full Ladder"`);
      const h = btn.getBoundingClientRect().height;
      if (h < 47.5) fails.push(`ladder CTA height ${Math.round(h)} < 48px`);
    }
  }

  // ---- 7. dots: inside the card, synced to the scrolled slide ----
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

  // ---- 8. column fit + nothing behind the dock ----
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

  // ---- 9. no clipped leaf text without ellipsis inside the deck ----
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
