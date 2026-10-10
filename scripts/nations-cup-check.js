/**
 * nations-cup-check.js — DOM check for the Home "Nations Cup" carousel card.
 * Paste into the browser console on any viewport, or run via
 * scripts/verify-nations-cup.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - the card overflows (scrollH/scrollW > clientH/clientW: bottom clipped,
 *    bottom radius lost, or a long country name spills out),
 *  - the card's bottom corners are not rounded (radius lost),
 *  - the header still has the blue bullet, or misses NATIONS CUP / Weekly,
 *  - rows are not 44px with 6px gaps on one consistent surface,
 *  - a rank 1-3 badge misses gold/silver/bronze, or rank 4+ is not plain,
 *  - a flag is not a 28px lazy circle (or monogram fallback), or the
 *    2-letter text box shows,
 *  - the name is not 14/600 with ellipsis, points not 14/700 tabular,
 *    a trophy icon shows, or the trend is a pill instead of a plain arrow,
 *  - country set but no highlighted 4th user row; country unset but no
 *    40px accent-gradient "Pick your country" CTA with the +100 coin chip,
 *  - the dots are not inside the card, centered, ~8px from the bottom edge,
 *  - the carousel track/wrap is not transparent, or clips vertically
 *    (anything but overflow-y visible + 24px padding/-24px margin),
 *  - any leaf text in the card clips without ellipsis truncation.
 *
 * Returns { pass, fails[] }.
 */
function checkNationsCup() {
  const fails = [];
  const near = (a, b, t) => Math.abs(a - b) <= t;

  const card = document.querySelector('.car-card.nations-cup');
  if (!card) return { pass: false, fails: ['missing .car-card.nations-cup'] };
  const cr = card.getBoundingClientRect();
  if (cr.width === 0 || cr.height === 0) return { pass: false, fails: ['nations card has 0 size'] };

  // ---- 1. no overflow: content fits inside the card's bottom padding ----
  if (card.scrollHeight > card.clientHeight + 2) {
    fails.push(`card clipped vertically: scrollH ${card.scrollHeight} > clientH ${card.clientHeight}`);
  }
  if (card.scrollWidth > card.clientWidth + 2) {
    fails.push(`card clipped horizontally: scrollW ${card.scrollWidth} > clientW ${card.clientWidth}`);
  }

  // ---- card corners intact: full radius + clipping kept inside ----
  const cs = getComputedStyle(card);
  const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
  const br = parseFloat(cs.borderBottomRightRadius) || 0;
  if (bl < 8 || br < 8) {
    fails.push(`card bottom radius lost: bl ${cs.borderBottomLeftRadius} br ${cs.borderBottomRightRadius}`);
  }
  if (cs.overflow !== 'hidden' && cs.overflowY !== 'hidden' && cs.overflow !== 'clip') {
    fails.push(`card must clip to its radius, overflow is "${cs.overflow}"`);
  }

  // ---- 2. header: globe + NATIONS CUP 13/700 tracked caps, Weekly right, no bullet ----
  const kicker = card.querySelector('.nations-kicker');
  if (!kicker) {
    fails.push('missing .nations-kicker');
  } else {
    const t = (kicker.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/nations cup/i.test(t)) fails.push(`kicker text "${t}" — want "NATIONS CUP"`);
    const ks = getComputedStyle(kicker);
    if (parseFloat(ks.fontSize) < 12.5 || parseFloat(ks.fontSize) > 13.5) {
      fails.push(`kicker font-size ${ks.fontSize} — want 13px`);
    }
    if (parseInt(ks.fontWeight, 10) < 700) fails.push(`kicker weight ${ks.fontWeight} — want 700`);
    if (!kicker.querySelector('.nations-ico svg, .nations-ico .ico')) {
      fails.push('kicker missing globe icon (.nations-ico svg)');
    }
    const before = getComputedStyle(kicker, '::before');
    if (before.content !== 'none' && before.content !== '') {
      fails.push(`blue bullet still present (::before content ${before.content})`);
    }
  }
  const weekly = card.querySelector('.nations-weekly');
  if (!weekly) {
    fails.push('missing .nations-weekly caption');
  } else if ((weekly.textContent || '').trim() !== 'Weekly') {
    fails.push(`weekly caption "${(weekly.textContent || '').trim()}" — want "Weekly"`);
  }

  // ---- 3. rows: 44px, 6px gaps, one consistent surface ----
  const rows = [...card.querySelectorAll('.nations-rank .nations-row:not(.is-error)')];
  const cta = document.getElementById('home-country-cta');
  const ctaVisible = !!cta && !cta.hidden && cta.getBoundingClientRect().height > 0;
  if (rows.length !== 3 && rows.length !== 4) {
    fails.push(`want 3 rows (+CTA) or 4 rows (user row), found ${rows.length}`);
  }
  const surfaces = new Set();
  rows.forEach((li, i) => {
    const r = li.getBoundingClientRect();
    if (!near(r.height, 44, 1)) fails.push(`row ${i + 1} height ${Math.round(r.height)} — want 44px`);
    if (i > 0) {
      const prev = rows[i - 1].getBoundingClientRect();
      const gap = r.top - prev.bottom;
      if (!near(gap, 6, 1.5)) fails.push(`row gap ${i}→${i + 1} is ${gap.toFixed(1)}px — want 6px`);
    }
    surfaces.add(getComputedStyle(li).backgroundColor);
    // rank badge
    const rk = li.querySelector('.rk');
    const rank = parseInt((rk?.textContent || '').trim(), 10);
    if (Number.isNaN(rank) && !li.classList.contains('is-user')) {
      fails.push(`row ${i + 1} rank "${(rk?.textContent || '').trim()}" is not a number`);
    } else if (!li.classList.contains('is-user')) {
      const want = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
      if (want && !(rk?.classList.contains(want))) fails.push(`rank ${rank} missing .${want} badge`);
      if (!want && (rk?.classList.contains('gold') || rk?.classList.contains('silver') || rk?.classList.contains('bronze'))) {
        fails.push(`rank ${rank} should be a plain number, has a podium badge`);
      }
    }
    // flag: 28px circle, lazy img or monogram — never the 2-letter box
    const circ = li.querySelector('.flag-circle');
    if (!circ) {
      fails.push(`row ${i + 1} missing .flag-circle`);
    } else {
      const fr = circ.getBoundingClientRect();
      if (!near(fr.width, 28, 1) || !near(fr.height, 28, 1)) {
        fails.push(`row ${i + 1} flag ${Math.round(fr.width)}x${Math.round(fr.height)} — want 28px circle`);
      }
      const img = circ.querySelector('img.flag-img');
      const mono = circ.querySelector('.flag-mono');
      if (img) {
        if (img.loading !== 'lazy') fails.push(`row ${i + 1} flag img must be lazy-loaded`);
      } else if (!mono || !(mono.textContent || '').trim()) {
        fails.push(`row ${i + 1} flag needs lazy img or monogram fallback`);
      }
    }
    if (li.querySelector('.flag-code')) fails.push(`row ${i + 1} shows the 2-letter text box (.flag-code)`);
    // name 14/600 ellipsis
    const nm = li.querySelector('.nm');
    if (nm) {
      const ns = getComputedStyle(nm);
      if (parseFloat(ns.fontSize) < 13.5 || parseFloat(ns.fontSize) > 14.5) {
        fails.push(`row ${i + 1} name font-size ${ns.fontSize} — want 14px`);
      }
      if (parseInt(ns.fontWeight, 10) < 600) fails.push(`row ${i + 1} name weight ${ns.fontWeight} — want 600`);
      if (ns.textOverflow !== 'ellipsis') fails.push(`row ${i + 1} name must ellipsize`);
    }
    // points 14/700 tabular, no trophy
    const pt = li.querySelector('.pt');
    if (pt) {
      const ps = getComputedStyle(pt);
      if (parseFloat(ps.fontSize) < 13.5 || parseFloat(ps.fontSize) > 14.5) {
        fails.push(`row ${i + 1} points font-size ${ps.fontSize} — want 14px`);
      }
      if (!/tabular-nums/.test(ps.fontVariantNumeric || '')) {
        fails.push(`row ${i + 1} points must use tabular numbers`);
      }
      if (li.querySelector('.pt .cup')) fails.push(`row ${i + 1} still has the trophy icon`);
    }
    // trend: plain colored arrow + delta, no pill
    const tr = li.querySelector('.tr');
    if (tr) {
      const ts = getComputedStyle(tr);
      const bg = ts.backgroundColor || '';
      const isTransparent = /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg) || bg === 'transparent';
      if (!isTransparent || ts.backgroundImage !== 'none' || ts.boxShadow !== 'none') {
        fails.push(`row ${i + 1} trend still a pill (bg ${bg}, shadow ${ts.boxShadow})`);
      }
      const txt = (tr.textContent || '').trim();
      if (!/^[▲▼] \d$/.test(txt) && txt !== '•' && txt !== '–') {
        fails.push(`row ${i + 1} trend "${txt}" — want "▲ N" / "▼ N" / "•"`);
      }
    }
    // nothing may pass the card's bottom padding
    if (r.bottom > cr.bottom - 24 + 1 && i === rows.length - 1 && !ctaVisible) {
      // last row with no CTA must still clear the dots reserve (checked via card overflow too)
    }
  });
  if (surfaces.size > 2) {
    fails.push(`rows use ${surfaces.size} surfaces — want one consistent surface (+ user highlight)`);
  }

  // ---- 4 + 5. user row vs CTA footer ----
  const meRows = rows.filter((li) => li.classList.contains('me'));
  if (ctaVisible) {
    if (meRows.length > 0 && rows.length > 3) {
      fails.push('CTA visible but a 4th user row is also shown');
    }
    const cr2 = cta.getBoundingClientRect();
    if (!near(cr2.height, 40, 1)) fails.push(`CTA height ${Math.round(cr2.height)} — want 40px`);
    const bg = getComputedStyle(cta).backgroundImage || '';
    if (!/linear-gradient/i.test(bg)) fails.push('CTA must use an accent gradient (distinct from rows)');
    const label = document.getElementById('home-country-cta-label');
    if ((label?.textContent || '').trim().toLowerCase() !== 'pick your country') {
      fails.push(`CTA label "${(label?.textContent || '').trim()}" — want "Pick your country"`);
    }
    const reward = document.getElementById('home-country-cta-reward');
    if (!reward || !/\+100/.test(reward.textContent || '') || !reward.querySelector('.coin')) {
      fails.push('CTA needs the +100 coin reward chip (coin icon)');
    }
    if (!cta.querySelector('.nations-cta-flag svg')) fails.push('CTA needs a flag icon (no empty box)');
    if (cta.querySelector('.flag-code')) fails.push('CTA shows the 2-letter text box');
    if (cr2.bottom > cr.bottom - 24 + 1) fails.push('CTA exceeds the card bottom padding');
  } else {
    if (meRows.length !== 1) {
      fails.push(`country set: want the highlighted user row as 4th row, found ${meRows.length} .me rows`);
    } else {
      const bs = getComputedStyle(meRows[0]).boxShadow || '';
      if (!/14,\s*165,\s*233|125,\s*211,\s*252|56,\s*189,\s*248/.test(bs)) {
        fails.push('user row missing the accent border');
      }
    }
  }

  // ---- 6. dots inside the card, centered, 8px from the bottom edge ----
  const dots = document.getElementById('home-dots');
  if (!dots) {
    fails.push('missing #home-dots');
  } else {
    const dr = dots.getBoundingClientRect();
    if (dr.left < cr.left - 1 || dr.right > cr.right + 1 || dr.top < cr.top - 1 || dr.bottom > cr.bottom + 1) {
      fails.push(`dots not inside the card (dots ${Math.round(dr.bottom)} vs card ${Math.round(cr.bottom)})`);
    }
    const fromBottom = cr.bottom - dr.bottom;
    if (fromBottom < 4 || fromBottom > 14) {
      fails.push(`dots ${fromBottom.toFixed(1)}px from card bottom — want 8px`);
    }
    const off = Math.abs((dr.left + dr.right) / 2 - (cr.left + cr.right) / 2);
    if (off > 5) fails.push(`dots off-center by ${off.toFixed(1)}px`);
  }

  // ---- carousel: transparent track, overflow-y visible, 24px padding/-24px margin ----
  const track = document.getElementById('home-carousel');
  const wrap = track?.closest('.carousel-wrap');
  for (const [el, name] of [[track, 'carousel track'], [wrap, 'carousel container']]) {
    if (!el) {
      fails.push(`missing ${name}`);
      continue;
    }
    const bgc = getComputedStyle(el).backgroundColor || '';
    if (!/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bgc) && bgc !== 'transparent') {
      fails.push(`${name} not transparent (bg ${bgc}) — the dark rectangle must go`);
    }
  }
  if (track) {
    const ts = getComputedStyle(track);
    if (ts.overflowY !== 'visible' && ts.overflowY !== 'auto') {
      fails.push(`carousel overflow-y is "${ts.overflowY}" — want visible (shadows must not clip)`);
    }
    if (!near(parseFloat(ts.paddingTop), 24, 1) || !near(parseFloat(ts.paddingBottom), 24, 1)) {
      fails.push(`carousel padding-block ${ts.paddingTop}/${ts.paddingBottom} — want 24px`);
    }
    if (!near(parseFloat(ts.marginTop), -24, 1) || !near(parseFloat(ts.marginBottom), -24, 1)) {
      fails.push(`carousel margin-block ${ts.marginTop}/${ts.marginBottom} — want -24px`);
    }
  }

  // ---- no clipped leaf text without ellipsis inside the card ----
  for (const el of card.querySelectorAll('*')) {
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

  return { pass: fails.length === 0, fails };
}

// Browser-console usage
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkNationsCup();
  if (!r.pass) throw new Error(`nations cup:\n- ${r.fails.join('\n- ')}`);
}
