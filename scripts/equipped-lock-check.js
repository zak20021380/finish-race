/**
 * equipped-lock-check.js — DOM check for the LOCKED "Equipped" section on Profile.
 * Paste into the browser console while Profile is showing, or run via
 * scripts/verify-equipped-lock.mjs which drives it with Playwright.
 *
 * Fails when:
 *  - the document scrolls (scrollHeight > innerHeight) at the checked viewport,
 *  - #pf-eq-lock / the row / the 3 cards / the scrim / the crest / the pod / the chip are missing,
 *  - any card is still hit-testable (pointer-events must be none) or the row lost its frost
 *    (opacity .45, saturate(.6) blur(1.5px)),
 *  - the scrim is not an absolute, 20px-rounded radial-gradient with the exact obsidian stops,
 *  - the crest is not centered on the slab (dx/dy more than 1px) or the pod is not 44x44,
 *  - the chip is not "COMING SOON" at 9px / 1.2px tracking,
 *  - the scrim or crest bleeds outside the slab, or the slab changes the row's height,
 *  - anything inside the lock is focusable,
 *  - a tap does not surface the clay toast, or it mutates the save.
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
    if (Math.abs(p.width - 44) > 0.5 || Math.abs(p.height - 44) > 0.5) {
      fails.push(`lock pod ${p.width.toFixed(1)}x${p.height.toFixed(1)} — want 44x44`);
    }
  }
  if (chip) {
    const cs = getComputedStyle(chip);
    if (!/^coming soon$/i.test((chip.textContent || '').trim())) fails.push(`chip label "${chip.textContent.trim()}" — want "COMING SOON"`);
    if (cs.fontSize !== '9px') fails.push(`chip font-size ${cs.fontSize} — want 9px`);
    if (cs.letterSpacing !== '1.2px') fails.push(`chip letter-spacing ${cs.letterSpacing} — want 1.2px`);
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

// Browser-console usage
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('assert')) {
  const r = checkEquippedLock();
  if (!r.pass) throw new Error(`equipped lock:\n- ${r.fails.join('\n- ')}`);
}
