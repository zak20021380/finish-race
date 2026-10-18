/**
 * equipped-lock-check.js — DOM check for the LOCKED "Equipped" section on Profile.
 * Paste into the browser console while Profile is showing, or run via
 * scripts/verify-equipped-lock.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - the document scrolls or overflows horizontally at the checked viewport,
 *  - #pf-eq-lock / the row / the 3 cards / the scrim / the crest / the pod / the chip are missing,
 *  - the old cartoon-bronze #i-lock-3d glyph is still in the document or the titanium
 *    #i-lock-ti glyph is not the pod's icon,
 *  - any card is still hit-testable (pointer-events must be none) or the row lost its frost
 *    (opacity .45, saturate(.6) blur(1.5px)),
 *  - the scrim is not an absolute, 20px-rounded radial-gradient with the exact obsidian stops,
 *  - the crest is not centered on the slab (dx/dy more than 1px) or the pod is not 42x42,
 *  - the chip is not the smoked graphite micro-plate reading "COMING SOON" at 8.5px / 1.8px
 *    tracking, 19px tall, with a hairline bronze border,
 *  - the scrim or crest bleeds outside the slab, or the slab changes the row's height,
 *  - anything inside the lock is focusable,
 *  - a tap does not surface the clay toast, or it mutates the save.
 *
 * `checkProfileSettingsGear()` covers the header Settings key: a 36x36 squircle carrying
 * the #i-gear-3d glyph that opens #s-settings with zero page overflow.
 *
 * Returns { pass, fails[] }.
 */
function checkEquippedLock() {
  const fails = [];
  const lock = document.getElementById('pf-eq-lock');
  if (!lock) return { pass: false, fails: ['missing #pf-eq-lock'] };
  const row = lock.querySelector('.pf-eq-row');
  if (!row) fails.push('missing .pf-eq-row inside the lock');

  if (document.documentElement.scrollHeight > window.innerHeight + 1) {
    fails.push(`doc scrollHeight ${document.documentElement.scrollHeight} > innerHeight ${window.innerHeight}`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    fails.push(`doc scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${window.innerWidth}`);
  }
  if (document.getElementById('i-lock-3d')) fails.push('the cartoon-bronze #i-lock-3d glyph must be gone');
  if (!document.getElementById('i-lock-ti')) fails.push('missing the titanium #i-lock-ti glyph');

  const focusable = lock.querySelectorAll('a, button, input, select, textarea, [tabindex]');
  if (focusable.length > 0) fails.push(`${focusable.length} focusable element(s) inside the lock — the section must be inert`);

  const cards = [...lock.querySelectorAll('.pf-eq')];
  if (cards.length !== 3) fails.push(`want 3 equipped cards, found ${cards.length}`);
  for (const c of cards) {
    if (getComputedStyle(c).pointerEvents !== 'none') fails.push('.pf-eq must be pointer-events: none');
  }
  if (row) {
    const rs = getComputedStyle(row);
    if (Math.abs(Number(rs.opacity) - 0.45) > 0.01) fails.push(`row opacity ${rs.opacity} — want .45`);
    const f = rs.filter || '';
    if (!/saturate\(0?\.6\)/.test(f)) fails.push(`row filter missing saturate(.6): "${f}"`);
    if (!/blur\(1\.5px\)/.test(f)) fails.push(`row filter missing blur(1.5px): "${f}"`);
  }

  const scrim = lock.querySelector('.pf-eq-scrim');
  if (!scrim) fails.push('missing .pf-eq-scrim');
  else {
    const ss = getComputedStyle(scrim);
    if (ss.position !== 'absolute') fails.push('scrim must be position: absolute');
    const bg = ss.backgroundImage || '';
    if (!/radial-gradient/.test(bg)) fails.push('scrim background must be a radial-gradient');
    else if (!/rgba\(17,\s*24,\s*39,\s*0?\.75\)/.test(bg) || !/rgba\(10,\s*14,\s*23,\s*0?\.92\)/.test(bg)) {
      fails.push(`scrim gradient stops drifted: ${bg}`);
    }
    if (parseFloat(ss.borderTopLeftRadius) < 19) fails.push('scrim must inherit the 20px slab radius');
    if (ss.pointerEvents !== 'none') fails.push('scrim must be pointer-events: none');
  }

  const crest = lock.querySelector('.pf-eq-crest');
  const pod = lock.querySelector('.pf-eq-pod');
  const chip = lock.querySelector('.pf-eq-chip');
  if (!crest) fails.push('missing .pf-eq-crest');
  if (!pod) fails.push('missing .pf-eq-pod');
  if (!chip) fails.push('missing .pf-eq-chip');

  const rect = (el) => el.getBoundingClientRect();
  const lr = rect(lock);
  if (row) {
    const rr = rect(row);
    if (Math.abs(lr.height - rr.height) > 1) {
      fails.push(`the lock slab adds ${(lr.height - rr.height).toFixed(1)}px of height over the row — overlay must not shift layout`);
    }
  }
  for (const [el, name] of [[scrim, 'scrim'], [crest, 'crest']]) {
    if (!el) continue;
    const b = rect(el);
    if (b.left < lr.left - 1 || b.right > lr.right + 1 || b.top < lr.top - 1 || b.bottom > lr.bottom + 1) {
      fails.push(`${name} bleeds outside the lock slab`);
    }
  }
  if (crest && row) {
    const c = rect(crest);
    const rr = rect(row);
    const dx = (c.left + c.width / 2) - (rr.left + rr.width / 2);
    const dy = (c.top + c.height / 2) - (rr.top + rr.height / 2);
    if (Math.abs(dx) > 1) fails.push(`crest off-centre horizontally by ${dx.toFixed(1)}px`);
    if (Math.abs(dy) > 1) fails.push(`crest off-centre vertically by ${dy.toFixed(1)}px`);
  }
  if (pod) {
    const p = rect(pod);
    if (Math.abs(p.width - 42) > 0.5 || Math.abs(p.height - 42) > 0.5) {
      fails.push(`lock pod ${p.width.toFixed(1)}x${p.height.toFixed(1)} — want 42x42`);
    }
    if (!pod.querySelector('use[href="#i-lock-ti"]')) fails.push('the pod must render the #i-lock-ti glyph');
  }
  if (chip) {
    const cs = getComputedStyle(chip);
    if (!/^coming soon$/i.test((chip.textContent || '').trim())) fails.push(`chip label "${chip.textContent.trim()}" — want "COMING SOON"`);
    if (cs.fontSize !== '8.5px') fails.push(`chip font-size ${cs.fontSize} — want 8.5px`);
    if (cs.letterSpacing !== '1.8px') fails.push(`chip letter-spacing ${cs.letterSpacing} — want 1.8px`);
    if (cs.textTransform !== 'uppercase') fails.push(`chip text-transform ${cs.textTransform} — want uppercase`);
    if (cs.whiteSpace !== 'nowrap') fails.push('chip must not wrap');
    const h = rect(chip).height;
    if (h < 17.5 || h > 20.5) fails.push(`chip height ${h.toFixed(1)}px — want the 18-20px micro-plate`);
    if (cs.backgroundColor !== 'rgba(15, 23, 42, 0.85)') fails.push(`chip background ${cs.backgroundColor} — want rgba(15, 23, 42, 0.85)`);
    if (cs.backgroundImage !== 'none') fails.push('chip must be a flat smoked plate, no gradient');
    if (cs.borderTopWidth !== '1px') fails.push(`chip border ${cs.borderTopWidth} — want the 1px hairline`);
    if (!/rgba\(245,\s*158,\s*11,\s*0?\.35\)/.test(cs.borderTopColor)) fails.push(`chip border colour ${cs.borderTopColor} — want the bronze hairline`);
    if (parseFloat(cs.borderTopLeftRadius) < 5.5 || parseFloat(cs.borderTopLeftRadius) > 6.5) fails.push(`chip radius ${cs.borderTopLeftRadius} — want 6px`);
  }

  const pane = document.querySelector('#s-profile .pf-pane');
  if (pane && row) {
    const pr = rect(pane);
    const rr = rect(row);
    if (rr.left < pr.left - 1 || rr.right > pr.right + 1) fails.push('the equipped row escapes the pane horizontally');
    if (rr.bottom > pr.bottom + 1) fails.push('the equipped row sits under the pane fold — scroll did not settle on it');
  }

  const key = 'detour.save.v2';
  const before = window.localStorage.getItem(key);
  lock.click();
  const toast = document.getElementById('pf-toast');
  const label = document.getElementById('pf-toast-t');
  if (!toast || toast.hidden) fails.push('tapping the lock must surface the toast');
  else if (!/unlock soon/i.test(label?.textContent || '')) fails.push(`toast says "${label?.textContent ?? ''}" — want the unlock-soon nudge`);
  if (window.localStorage.getItem(key) !== before) fails.push('tapping the lock mutated the save');

  return { pass: fails.length === 0, fails };
}

/**
 * checkProfileSettingsGear() — the Profile header's tactile Settings key. Run it AFTER
 * checkEquippedLock(): the click navigates to #s-settings.
 * Returns { pass, fails[] }.
 */
function checkProfileSettingsGear() {
  const fails = [];
  const btn = document.getElementById('profile-settings');
  if (!btn) return { pass: false, fails: ['missing #profile-settings'] };
  if (!btn.querySelector('use[href="#i-gear-3d"]')) fails.push('the settings key must render the #i-gear-3d glyph');
  const r = btn.getBoundingClientRect();
  if (Math.abs(r.width - 36) > 0.5 || Math.abs(r.height - 36) > 0.5) {
    fails.push(`settings key ${r.width.toFixed(1)}x${r.height.toFixed(1)} — want 36x36`);
  }
  const cs = getComputedStyle(btn);
  if (parseFloat(cs.borderTopLeftRadius) < 9 || parseFloat(cs.borderTopLeftRadius) > 11) {
    fails.push(`settings key radius ${cs.borderTopLeftRadius} — want the 10px squircle`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    fails.push(`profile horizontal overflow: scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${window.innerWidth}`);
  }

  btn.click();
  const s = document.getElementById('s-settings');
  if (!s || s.hidden) {
    fails.push('tapping the settings key must open #s-settings');
    return { pass: fails.length === 0, fails };
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    fails.push(`settings horizontal overflow: scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${window.innerWidth}`);
  }
  if (document.documentElement.scrollHeight > window.innerHeight + 1) {
    fails.push(`settings doc scrollHeight ${document.documentElement.scrollHeight} > innerHeight ${window.innerHeight}`);
  }
  return { pass: fails.length === 0, fails };
}

// Browser-console usage
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkEquippedLock();
  const g = checkProfileSettingsGear();
  if (!r.pass) throw new Error(`equipped lock:\n- ${r.fails.join('\n- ')}`);
  if (!g.pass) throw new Error(`profile settings gear:\n- ${g.fails.join('\n- ')}`);
}
