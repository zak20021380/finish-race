/**
 * verify-command-bar.mjs — Playwright audit for the top player command bar.
 *
 * Run against a fresh build (npm run build) with:
 *   node scripts/verify-command-bar.mjs
 *
 * Seeds a level-6 profile (country IR, 4,390 coins, @DogeSquad bound) and, at
 * 360x640, 390x844 and 430x932, asserts:
 *   - the 58px chassis fits with zero horizontal overflow,
 *   - the country flag is a real inline <svg> (paths/polygons, never text),
 *   - the XP arc is a visible SVG stroke with the gradient paint,
 *   - the gold-lit coin vault keeps warm cream text at high contrast,
 *   - the shield crest, 20px squad pill, 38px bell and 7px unread dot hold size.
 * Saves .shots/command-bar-<width>.png. Exits 1 on any broken expectation.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const SHOTS = path.resolve(here, '..', '.shots');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core not found — install it or run with NODE_PATH pointing at a temp install.');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url).split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(DIST, p.slice(1));
      fs.readFile(fp, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const EXE = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!EXE) {
  console.error('No Chrome binary found — set CHROME_PATH.');
  process.exit(2);
}

let failed = 0;
const expect = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SAVE = {
  v: 2,
  coins: 4390,
  country: 'IR',
  stats: { games: 48, wins: 24, losses: 24, streak: 3, best: 6, modes: { bot: 48 } },
};
const SQUADS = { boundId: 'sq-doge', custom: [], bonus: {} };

const srgb = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => {
  const la = lum(a); const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const srv = await serve();
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

try {
  fs.mkdirSync(SHOTS, { recursive: true });

  for (const [width, height] of [[360, 640], [390, 844], [430, 932]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await ctx.addInitScript(([save, squads]) => {
      localStorage.setItem('detour.save.v2', JSON.stringify(save));
      localStorage.setItem('detour.squads.v1', JSON.stringify(squads));
    }, [SAVE, SQUADS]);
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(3200);            // let the one-shot bell wiggle settle

    const m = await pg.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const card = document.getElementById('home-id-card');
      const ring = document.getElementById('p-ring');
      const flag = q('#home-flag .flag-vector');
      const flagCode = document.getElementById('home-flag-code');
      const coin = card.querySelector('.id-coin');
      const coinSvg = coin.querySelector('svg.coin');
      const crest = card.querySelector('.id-lvl');
      const squad = document.getElementById('team-chip');
      const bell = document.getElementById('home-notifs');
      const badge = document.getElementById('notif-badge');
      const r = (el) => el.getBoundingClientRect();
      const cs = (el) => getComputedStyle(el);
      const ringCS = getComputedStyle(ring);
      const cardR = r(card);
      const font = q('#home-flag');

      return {
        vw: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        card: { left: cardR.left, right: cardR.right, width: cardR.width, height: cardR.height },
        flag: flag
          ? {
              tag: flag.tagName.toLowerCase(),
              cls: flag.getAttribute('class'),
              width: r(flag).width,
              height: r(flag).height,
              shapes: flag.querySelectorAll('rect, path, circle, polygon').length,
              text: (flag.textContent || '').trim(),
              codeHidden: flagCode ? cs(flagCode).display === 'none' : true,
              ariaHidden: flag.getAttribute('aria-hidden'),
              container: font ? { w: r(font).width, h: r(font).height } : null,
            }
          : null,
        ring: {
          dash: parseFloat(ringCS.strokeDasharray) || 0,
          offset: parseFloat(ringCS.strokeDashoffset) || 0,
          stroke: ringCS.stroke,
          width: r(ring).width,
          filter: ringCS.filter,
        },
        level: (document.getElementById('p-level')?.textContent || '').trim(),
        crest: crest ? { w: r(crest).width, h: r(crest).height, face: !!document.getElementById('lvlFace') } : null,
        coin: {
          w: r(coin).width,
          h: r(coin).height,
          bg: cs(coin).backgroundImage,
          border: cs(coin).borderTopColor,
          color: cs(coin).color,
          balance: (document.getElementById('p-coins')?.textContent || '').trim(),
          svgW: coinSvg ? r(coinSvg).width : 0,
          svgH: coinSvg ? r(coinSvg).height : 0,
          notched: coinSvg ? coinSvg.querySelectorAll('[stroke-dasharray]').length : 0,
        },
        squad: {
          h: r(squad).height,
          text: (document.getElementById('team-name')?.textContent || '').trim(),
          rank: (document.getElementById('team-count')?.textContent || '').trim(),
          rankColor: cs(document.getElementById('team-count')).color,
          badgeColor: cs(document.getElementById('team-count')).backgroundColor,
        },
        bell: {
          w: r(bell).width,
          h: r(bell).height,
          radius: cs(bell).borderTopLeftRadius,
          ico: (() => { const s = bell.querySelector('svg.ico'); return s ? r(s).width : 0; })(),
          badgeW: badge && !badge.hidden ? r(badge).width : 0,
          badgeH: badge && !badge.hidden ? r(badge).height : 0,
          badgeCssW: badge && !badge.hidden ? parseFloat(cs(badge).width) : 0,
          badgeCssH: badge && !badge.hidden ? parseFloat(cs(badge).height) : 0,
          badgeBg: badge ? cs(badge).backgroundColor : '',
          badgeBorder: badge ? cs(badge).borderTopWidth : '',
        },
        geom: (() => {
          const av = card.querySelector('.id-avatar-btn');
          const well = document.getElementById('avatar');
          const ring = card.querySelector('.id-ring');
          const cr = card.querySelector('.id-lvl');
          const nm = document.getElementById('p-name');
          const fl = document.getElementById('home-flag');
          const sq = document.getElementById('team-chip');
          const co = card.querySelector('.id-coin');
          const bl = document.getElementById('home-notifs');
          const R = (el) => r(el);
          return {
            avatar: R(av), well: R(well), ring: R(ring), crest: R(cr),
            name: R(nm), flag: R(fl), squad: R(sq), coin: R(co), bell: R(bl),
            badge: R(document.getElementById('notif-badge')),
            card: R(card),
            mid: R(card.querySelector('.id-mid')),
          };
        })(),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        overlaps: (() => {
          const a = r(card.querySelector('.id-avatar-btn'));
          const mid = r(card.querySelector('.id-mid'));
          const side = r(card.querySelector('.id-side'));
          return mid.left < a.right - 0.5 || side.left < mid.right - 0.5;
        })(),
        nameClipped: (() => {
          const n = document.getElementById('p-name');
          return n.scrollWidth > n.clientWidth + 1;
        })(),
      };
    });

    if (process.env.DUMP) console.log(JSON.stringify({ width, geom: m.geom }));
    console.log(`\n--- ${width}x${height} ---`);
    expect(`${width}px: no horizontal overflow`, !m.overflow, `scrollWidth=${m.scrollWidth}`);
    expect(`${width}px: chassis is 58px tall and inside the viewport`,
      Math.abs(m.card.height - 58) < 0.6 && m.card.left >= -0.5 && m.card.right <= width + 0.5,
      `h=${m.card.height.toFixed(1)} l=${m.card.left.toFixed(1)} r=${m.card.right.toFixed(1)}`);
    expect(`${width}px: flag is a real vector SVG`, !!m.flag && m.flag.tag === 'svg'
      && /flag-vector/.test(m.flag.cls) && m.flag.shapes >= 3 && m.flag.text === ''
      && m.flag.ariaHidden === 'true',
      m.flag ? `${m.flag.tag}/${m.flag.shapes} shapes/${m.flag.width}x${m.flag.height}` : 'missing');
    expect(`${width}px: flag plate is 22x15 with the code text hidden`,
      !!m.flag && Math.abs(m.flag.width - 22) < 0.6 && Math.abs(m.flag.height - 15) < 0.6 && m.flag.codeHidden,
      m.flag ? `${m.flag.width.toFixed(1)}x${m.flag.height.toFixed(1)}` : 'missing');
    expect(`${width}px: Windows no-flags rule never hides the vector plate`,
      !!m.flag && m.flag.width > 0 && !!m.flag.container && m.flag.container.w > 0,
      m.flag?.container ? `container ${m.flag.container.w.toFixed(1)}px` : 'hidden');
    expect(`${width}px: XP arc paints a visible gradient stroke`,
      m.ring.dash > 0 && m.ring.offset > 0 && m.ring.offset < m.ring.dash
      && /xpGrad/.test(m.ring.stroke) && /drop-shadow/.test(m.ring.filter),
      `offset=${m.ring.offset.toFixed(1)}/${m.ring.dash.toFixed(1)} stroke=${m.ring.stroke}`);
    expect(`${width}px: shield crest wears the level number`, !!m.crest
      && Math.abs(m.crest.w - 20) < 0.6 && Math.abs(m.crest.h - 22) < 0.6 && m.crest.face && /^\d+$/.test(m.level),
      m.crest ? `${m.crest.w}x${m.crest.h} L${m.level}` : 'missing');
    expect(`${width}px: coin vault is the gold-lit obsidian capsule`,
      Math.abs(m.coin.h - 38) < 0.6 && /radial-gradient/.test(m.coin.bg)
      && /rgba\(251, 191, 36/.test(m.coin.border) && m.coin.balance === '4,390',
      `h=${m.coin.h} border=${m.coin.border} bal=${m.coin.balance}`);
    expect(`${width}px: 3D coin is 26px with a milled rim`,
      Math.abs(m.coin.svgW - 26) < 0.6 && Math.abs(m.coin.svgH - 26) < 0.6 && m.coin.notched >= 1,
      `${m.coin.svgW}x${m.coin.svgH} notch=${m.coin.notched}`);
    const [cr, cg, cb] = m.coin.color.match(/\d+/g).map(Number);
    const ratio = contrast([cr, cg, cb], [13, 18, 29]);
    expect(`${width}px: balance ink keeps AAA contrast on obsidian`, ratio >= 7,
      `${m.coin.color} → ${ratio.toFixed(2)}:1`);
    expect(`${width}px: squad pill is a 20px recessed capsule with a gold rank`,
      Math.abs(m.squad.h - 20) < 0.6 && m.squad.text === '@DogeSquad' && m.squad.rank === '#1'
      && /rgb\(251, 191, 36\)/.test(m.squad.rankColor),
      `h=${m.squad.h} ${m.squad.text} ${m.squad.rank}`);
    expect(`${width}px: bell is a 38px squircle with an 18px icon and 7px dot`,
      Math.abs(m.bell.w - 38) < 0.6 && Math.abs(m.bell.h - 38) < 0.6 && m.bell.radius === '12px'
      && Math.abs(m.bell.ico - 18) < 0.6
      && Math.abs(m.bell.badgeCssW - 7) < 0.6 && Math.abs(m.bell.badgeCssH - 7) < 0.6
      && /rgb\(249, 115, 22\)/.test(m.bell.badgeBg) && parseFloat(m.bell.badgeBorder) === 2,
      `${m.bell.w}x${m.bell.h} ico=${m.bell.ico} dot=${m.bell.badgeCssW}+2px ring`);
    expect(`${width}px: columns never overlap, name never clips`, !m.overlaps && !m.nameClipped,
      `overlaps=${m.overlaps} clipped=${m.nameClipped}`);

    const g = m.geom;
    expect(`${width}px: 44px orb holds a centred 36px well inside the arc`,
      Math.abs(g.ring.width - 44) < 0.6 && Math.abs(g.ring.height - 44) < 0.6
      && Math.abs(g.well.width - 36) < 0.6 && Math.abs(g.well.height - 36) < 0.6
      && Math.abs((g.well.left + g.well.right) / 2 - (g.ring.left + g.ring.right) / 2) < 1,
      `ring=${g.ring.width} well=${g.well.width}`);
    expect(`${width}px: crest overhangs the orb but stays inside the chassis`,
      g.crest.right <= g.card.right + 0.5 && g.crest.bottom <= g.card.bottom + 0.5
      && g.crest.right > g.ring.right - 4 && g.crest.bottom > g.ring.bottom - 4,
      `crest r=${g.crest.right.toFixed(1)} b=${g.crest.bottom.toFixed(1)} card r=${g.card.right.toFixed(1)} b=${g.card.bottom.toFixed(1)}`);
    expect(`${width}px: name and flag share a baseline`, Math.abs((g.name.top + g.name.bottom) / 2 - (g.flag.top + g.flag.bottom) / 2) < 2,
      `name=${g.name.top.toFixed(1)} flag=${g.flag.top.toFixed(1)}`);
    expect(`${width}px: squad pill stacks under the name, inside the middle column`,
      g.squad.top >= g.name.bottom - 1 && g.squad.width <= g.mid.width + 0.5 && g.squad.left >= g.mid.left - 0.5,
      `squad w=${g.squad.width.toFixed(1)} mid w=${g.mid.width.toFixed(1)}`);
    expect(`${width}px: wallet and bell sit above the fold with even gaps`,
      Math.abs(g.bell.left - g.coin.right - 6) < 1.5
      && g.coin.left - g.mid.right >= 6 && g.coin.left - g.mid.right <= 11
      && g.coin.top >= g.card.top && g.coin.bottom <= g.card.bottom,
      `coin-bell=${(g.bell.left - g.coin.right).toFixed(1)} mid-coin=${(g.coin.left - g.mid.right).toFixed(1)}`);

    await pg.screenshot({ path: path.join(SHOTS, `command-bar-${width}.png`) });
    console.log(`shot command-bar-${width}.png`);
    await ctx.close();
  }

  /* ---- the flag table: common ISO codes all paint real vector shapes ---- */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  const codes = ['US', 'GB', 'DE', 'TR', 'BR', 'FR', 'RU', 'AE', 'JP', 'IN', 'SA', 'KR'];
  const broken = [];
  for (const code of codes) {
    await pg.evaluate((c) => {
      localStorage.setItem('detour.save.v2', JSON.stringify({ v: 2, coins: 4390, country: c, stats: { games: 48, wins: 24 } }));
    }, code);
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForSelector('#home-flag svg.flag-vector', { timeout: 5000 }).catch(() => {});
    const ok = await pg.evaluate(() => {
      const svg = document.querySelector('#home-flag svg.flag-vector');
      const box = svg?.getBoundingClientRect();
      return !!svg && svg.tagName.toLowerCase() === 'svg' && svg.textContent.trim() === ''
        && svg.querySelectorAll('rect, path, circle, polygon').length >= 4
        && Math.abs((box?.width ?? 0) - 22) < 0.6 && Math.abs((box?.height ?? 0) - 15) < 0.6;
    });
    if (!ok) broken.push(code);
  }
  expect(`flag table: ${codes.length} common codes render as 22x15 vector plates`, broken.length === 0,
    broken.length ? `broken: ${broken.join(', ')}` : codes.join(' '));
  await ctx.close();
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n${failed === 0 ? 'command bar OK' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
