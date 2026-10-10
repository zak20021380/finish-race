/**
 * gm-sheet-check.js — DOM check for the "Select Game Mode" bottom sheet (#sheet-game-modes).
 * Paste into the browser console, or run via scripts/verify-gm-sheet.mjs which drives it.
 *
 * @param {'modes'|'room'} pane which pane of the drawer is on screen
 * @returns {{ pass: boolean, fails: string[] }}
 *
 * Fails when:
 *  - the drawer is not open, scrolls, grows past 85dvh or hangs off the viewport,
 *  - it is not exactly 3 rows, or a row is shorter than ~76px,
 *  - more (or fewer) than one row is selected, or a hidden row still shows its options,
 *  - leftovers survive: VIRAL tag, RANKED pill, per-row rewards, "or" divider,
 *    section headers, the drag handle, or the room UI inside the main list,
 *  - there is not exactly one close control,
 *  - the reward caption is missing, or any reward number ships without a labelled icon,
 *  - the sticky Start label does not name the mode,
 *  - any target is under 44px,
 *  - any text is clipped or falls outside the drawer,
 *  - any visible text is below 4.5:1 against the surface it is painted on.
 */
function checkGmSheet(pane) {
  const fails = [];
  const sheet = document.getElementById('sheet-game-modes');
  if (!sheet) return { pass: false, fails: ['missing #sheet-game-modes'] };
  if (sheet.hidden) fails.push('#sheet-game-modes is hidden');
  if (!sheet.classList.contains('open')) fails.push('#sheet-game-modes has no .open class');

  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return !el.hidden && r.width > 0 && r.height > 0;
  };
  const name = (el) => `<${el.tagName.toLowerCase()} class="${String(el.className || '').slice(0, 40)}">`;

  /* ---------- 1. it fits: 85dvh cap, no scrolling, nothing past the bottom edge ---------- */
  const vh = window.innerHeight;
  const r = sheet.getBoundingClientRect();
  if (r.height > vh * 0.85 + 1) fails.push(`sheet height ${Math.round(r.height)} > 85dvh (${Math.round(vh * 0.85)})`);
  if (r.bottom > vh + 1) fails.push(`sheet bottom ${Math.round(r.bottom)} > viewport ${vh}`);
  if (r.top < -1) fails.push(`sheet top ${Math.round(r.top)} < 0`);
  if (sheet.scrollHeight > sheet.clientHeight + 1) {
    fails.push(`#sheet-game-modes scrolls: scrollH ${sheet.scrollHeight} > clientH ${sheet.clientHeight}`);
  }
  if (document.documentElement.scrollHeight > vh + 1) {
    fails.push(`page scrolls: scrollHeight ${document.documentElement.scrollHeight} > innerHeight ${vh}`);
  }
  /* the drawer sits above the safe-area inset: --s4 plus whatever the device reports */
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;height:0;padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const inset = probe.getBoundingClientRect().height;
  probe.remove();
  const padB = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
  if (padB < inset + 15) fails.push(`bottom padding ${padB}px does not clear the ${inset}px safe-area inset`);
  const body = sheet.querySelector('.gm-body');
  if (!body) fails.push('missing .gm-body');
  else if (body.scrollHeight > body.clientHeight + 1) {
    fails.push(`the sheet body scrolls: scrollH ${body.scrollHeight} > clientH ${body.clientHeight}`);
  }
  const foot = sheet.querySelector('.gm-foot');
  if (!foot) fails.push('missing .gm-foot');
  else {
    const fr = foot.getBoundingClientRect();
    if (fr.bottom > r.bottom + 1 || fr.top < r.top - 1) {
      fails.push(`footer outside the drawer: top ${Math.round(fr.top)} bottom ${Math.round(fr.bottom)}`);
    }
  }

  /* ---------- 2. structure: three rows, one selection, options only where they belong ---------- */
  const main = document.getElementById('gm-view-modes');
  const room = document.getElementById('gm-view-room');
  if (!main) fails.push('missing #gm-view-modes');
  if (!room) fails.push('missing #gm-view-room');
  if (main && room) {
    const wantMain = pane !== 'room';
    if (main.hidden === wantMain) fails.push(`#gm-view-modes hidden=${main.hidden}, want ${!wantMain}`);
    if (room.hidden !== wantMain) fails.push(`#gm-view-room hidden=${room.hidden}, want ${!wantMain}`);
  }
  const back = document.getElementById('gm-back');
  if (!back) fails.push('missing #gm-back');
  else if (back.hidden !== (pane !== 'room')) fails.push(`#gm-back hidden=${back.hidden} on the ${pane} pane`);

  const rows = [].slice.call(sheet.querySelectorAll('.gm-card[data-row]'));
  if (rows.length !== 3) fails.push(`want exactly 3 rows, found ${rows.length}`);
  const ids = rows.map((x) => x.dataset.row).sort().join(',');
  if (ids !== 'bot,online,room') fails.push(`rows are "${ids}", want "bot,online,room"`);
  rows.forEach((row) => {
    const h = row.getBoundingClientRect().height;
    const seg = row.querySelector('.gm-seg');
    const expanded = !!(seg && !seg.hidden);
    const lo = expanded ? 120 : 70;
    const hi = expanded ? 155 : 85;
    if (h > 0 && (h < lo || h > hi)) {
      fails.push(`row ${row.dataset.row} height ${Math.round(h)} outside ${lo}–${hi}px (a ~76px row)`);
    }
    const p = row.querySelector('.gm-pick');
    if (!p) fails.push(`row ${row.dataset.row} has no .gm-pick`);
    else {
      if (!txt(row.querySelector('.gm-name'))) fails.push(`row ${row.dataset.row} has no title`);
      const d = txt(row.querySelector('.gm-desc'));
      if (!d) fails.push(`row ${row.dataset.row} has no one-line description`);
      else if (d.length > 40) fails.push(`row ${row.dataset.row} description is ${d.length} chars, not one short line`);
    }
    if (seg) {
      const open = !seg.hidden;
      const active = row.classList.contains('is-active');
      if (open !== active) {
        fails.push(`row ${row.dataset.row} options ${open ? 'shown' : 'hidden'} while the row is ${active ? 'active' : 'inactive'}`);
      }
    }
  });

  const active = rows.filter((x) => x.classList.contains('is-active'));
  if (active.length !== 1) fails.push(`want exactly 1 selected row, found ${active.length}`);
  const checked = [].slice.call(sheet.querySelectorAll('.gm-pick[aria-checked="true"]'));
  if (checked.length !== 1) fails.push(`want exactly 1 aria-checked pick, found ${checked.length}`);
  const onCard = active[0] && active[0].querySelector('.gm-check');
  if (pane !== 'room' && active.length === 1 && (!onCard || !shown(onCard))) {
    fails.push('selected row has no check badge');
  }

  /* ---------- 3. nothing crowding the list any more ---------- */
  for (const sel of ['.gm-viral', '.gm-tag', '.gm-divider', '.gm-sec', '.gm-meta', '.gm-time', '.sheet-grip', '.gm-reward']) {
    if (sheet.querySelector(sel)) fails.push(`leftover "${sel}" still in the drawer`);
  }
  if (sheet.querySelectorAll('[data-sheet-close]').length !== 1) {
    fails.push(`want exactly 1 close control, found ${sheet.querySelectorAll('[data-sheet-close]').length}`);
  }
  if (sheet.querySelector('.sheet-grip')) fails.push('duplicate drag handle is back');
  if (pane === 'modes' && main && main.querySelector('.gm-room, #gm-create, #gm-join-input')) {
    fails.push('the room UI is inside the main list');
  }
  if (/\bVIRAL\b|\bRANKED\b/i.test(txt(sheet))) fails.push('a VIRAL/RANKED tag survived');

  /* ---------- 4. one reward caption, every number behind a labelled icon ---------- */
  const rewards = sheet.querySelector('.gm-rewards');
  if (!rewards) fails.push('missing .gm-rewards');
  else if (!shown(rewards)) fails.push('.gm-rewards is not visible');
  else {
    if (!txt(rewards.querySelector('.gm-lead'))) fails.push('reward caption has no lead word');
    const pairs = [].slice.call(rewards.querySelectorAll('.gm-rw'));
    const live = pairs.filter((x) => !x.hidden);
    if (live.length < 1) fails.push('reward caption shows no reward');
    for (const rw of live) {
      const label = rw.getAttribute('aria-label') || '';
      if (!/^\d[\d,]* (trophies|coins)$/.test(label)) fails.push(`reward icon is not labelled: "${label}"`);
      if (!rw.querySelector('svg')) fails.push(`reward "${label || '?'}" has no icon`);
      const n = txt(rw.querySelector('b'));
      if (!/^\+\d+$/.test(n)) fails.push(`reward number "${n}" is bare/malformed`);
    }
    // no stray number sits in the caption outside an icon+number pair
    for (const node of rewards.childNodes) {
      if (node.nodeType !== 3) continue;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (/\d/.test(t)) fails.push(`bare number in the reward caption: "${t}"`);
    }
  }

  /* ---------- 5. sticky Start names the mode it will run ---------- */
  const start = document.getElementById('gm-start');
  if (!start) fails.push('missing #gm-start');
  else {
    const t = txt(start);
    if (!/^Start (1v1|2v2|practice|private) match$/.test(t)) fails.push(`bad Start label "${t}"`);
    if (!shown(start)) fails.push('Start is not visible');
  }

  /* ---------- 6. targets >= 44px ---------- */
  const target = (el, label) => {
    if (!el || !shown(el)) return;
    const b = el.getBoundingClientRect();
    if (b.height < 43.5) fails.push(`target <44px: ${label} height ${Math.round(b.height)}`);
    if (b.width < 43.5) fails.push(`target <44px: ${label} width ${Math.round(b.width)}`);
  };
  target(sheet.querySelector('.gm-x'), '.gm-x');
  target(back, '#gm-back');
  target(start, '#gm-start');
  for (const p of [].slice.call(sheet.querySelectorAll('.gm-pick'))) target(p, `.gm-pick ${p.dataset.gmode || '?'}`);
  for (const b of [].slice.call(sheet.querySelectorAll('.seg-b'))) target(b, `.seg-b ${txt(b)}`);
  target(document.getElementById('gm-create'), '#gm-create');
  target(document.getElementById('gm-join'), '#gm-join');
  target(document.getElementById('gm-copy'), '#gm-copy');
  target(document.getElementById('gm-invite-btn'), '#gm-invite-btn');
  const field = document.getElementById('gm-join-input');
  if (field && shown(field)) {
    const fr = field.closest('.field') || field;
    const b = fr.getBoundingClientRect();
    if (b.height < 43.5) fails.push(`target <44px: room code field height ${Math.round(b.height)}`);
  }

  /* ---------- 7. no clipped text ---------- */
  const inside = (el, box) => {
    const a = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  };
  for (const el of [].slice.call(sheet.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);
    const own = [].slice.call(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!own) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (!inside(el, sheet)) fails.push(`text outside the drawer: ${name(el)} "${own.slice(0, 40)}"`);
    const ox = cs.overflowX;
    const oy = cs.overflowY;
    if ((ox === 'hidden' || ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') {
      fails.push(`clipped horizontally: ${name(el)} "${own.slice(0, 40)}"`);
    }
    if (oy === 'hidden' && el.scrollHeight > el.clientHeight + 1) {
      fails.push(`clipped vertically: ${name(el)} "${own.slice(0, 40)}"`);
    }
  }

  /* ---------- 8. contrast >= 4.5:1 against the real painted surface ---------- */
  const rgba = (css) => {
    if (!css) return null;
    const s = String(css).trim();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  };
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** Every surface colour the element could be painted over, worst case included. */
  const surfaces = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.unshift(n);
    let bases = [{ r: 16, g: 20, b: 29, a: 1 }];            // the #10141D canvas
    for (const node of chain) {
      const cs = getComputedStyle(node);
      const stops = [];
      const bgc = rgba(cs.backgroundColor);
      if (bgc && bgc.a > 0) stops.push(bgc);
      const img = cs.backgroundImage;
      if (img && img !== 'none') {
        const re = /(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi;
        let m;
        while ((m = re.exec(img))) {
          const c = rgba(m[1]);
          if (c && c.a > 0) stops.push(c);
        }
      }
      if (!stops.length) continue;
      const next = [];
      for (const base of bases) for (const s of stops) next.push(over(s, base));
      bases = next.slice(0, 16);                            // keep the worst case, cap the cost
      if (bases.length === 1 && bases[0].a >= 0.999) break;
    }
    return bases;
  };
  const isDisabled = (el) => !!el.closest('[disabled], [aria-disabled="true"]');
  const cumulativeOpacity = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 1;
    return o;
  };
  const checkContrast = (el, color, label) => {
    const fg = rgba(color);
    if (!fg || fg.a === 0) return;
    const op = cumulativeOpacity(el);
    let worst = Infinity;
    for (const bg of surfaces(el)) {
      const flat = { ...bg, a: 1 };
      const eff = op >= 0.999 ? { ...fg, a: 1 } : over({ ...fg, a: fg.a * op }, flat);
      worst = Math.min(worst, ratio(eff, flat));
    }
    if (worst < 4.5) fails.push(`contrast ${worst.toFixed(2)}:1 < 4.5:1 — ${label}`);
  };
  for (const el of [].slice.call(sheet.querySelectorAll('*'))) {
    if (isDisabled(el)) continue;                           // WCAG exempts disabled controls
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const own = [].slice.call(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (own) checkContrast(el, cs.color, `${name(el)} "${own.slice(0, 32)}"`);
    if (el.tagName === 'INPUT') {
      if (el.placeholder) checkContrast(el, getComputedStyle(el, '::placeholder').color, `placeholder "${el.placeholder}"`);
      if (el.value) checkContrast(el, cs.color, `input value "${el.value}"`);
    }
  }

  return { pass: fails.length === 0, fails };
}

/* Browser-console usage */
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('gm-assert')) {
  const r = checkGmSheet('modes');
  if (!r.pass) throw new Error(`game mode sheet:\n- ${r.fails.join('\n- ')}`);
}
