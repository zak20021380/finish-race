/**
 * verify-countries.mjs — permanent guard for the nations registry.
 *
 * `src/data/countries.json` is the single source for the country picker and the
 * Nations IQ ladder, so a malformed row is a data-corruption bug that only shows
 * up on a device. This script fails (exit 1) when the registry:
 *   - holds fewer than 249 entries,
 *   - carries a duplicate `code`,
 *   - uses anything but a 2-letter uppercase ISO-3166-1 alpha-2 code,
 *   - names a code outside the officially assigned ISO set (XK is allowed as the
 *     user-assigned Kosovo code), or
 *   - misses a non-empty `name` string.
 *
 * Run: node scripts/verify-countries.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(here, '..', 'src', 'data', 'countries.json');

/** The 249 officially assigned ISO 3166-1 alpha-2 codes. */
const ISO_CODES = new Set(
  `AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BV BR IO VG BN BG BF BI KH CM CA CV BQ KY CF TD CL CN CX CC CO KM CG CK CR HR CU CW CY CZ DK DJ DM DO CD EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM HN HK HU IS IN ID IR IQ IE IM IL IT CI JM JP JE JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF KP MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS KR SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM VI UY UZ VU VA VE VN WF EH YE ZM ZW`
    .split(/\s+/),
);
/** Kosovo — user-assigned, widely used in pickers, and shipped by the source dataset. */
const USER_ASSIGNED = new Set(['XK']);

const failures = [];
const fail = (message) => failures.push(message);

let raw;
try {
  raw = fs.readFileSync(REGISTRY, 'utf8');
} catch (err) {
  console.error(`✗ cannot read ${path.relative(process.cwd(), REGISTRY)}: ${err.message}`);
  process.exit(1);
}

let countries;
try {
  countries = JSON.parse(raw);
} catch (err) {
  console.error(`✗ ${path.relative(process.cwd(), REGISTRY)} is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(countries)) {
  console.error('✗ countries.json must be an array of { code, name } entries.');
  process.exit(1);
}

if (countries.length < 249) {
  fail(`only ${countries.length} entries — at least 249 ISO-3166 nations are required`);
}

const seen = new Map();
for (let i = 0; i < countries.length; i += 1) {
  const entry = countries[i];
  const where = `entry ${i + 1}`;

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${where} is not an object`);
    continue;
  }

  const { code, name } = entry;
  if (typeof code !== 'string') {
    fail(`${where} has no string code`);
  } else if (!/^[A-Z]{2}$/.test(code)) {
    fail(`${where} code "${code}" is not a 2-letter uppercase ISO code`);
  } else if (!ISO_CODES.has(code) && !USER_ASSIGNED.has(code)) {
    fail(`${where} code "${code}" is not an assigned ISO-3166 alpha-2 code`);
  }

  if (typeof name !== 'string' || name.trim().length === 0) {
    fail(`${where} (${typeof code === 'string' ? code : '?'}) has no name`);
  }

  if (typeof code === 'string') {
    if (seen.has(code)) {
      fail(`duplicate code "${code}" at entries ${seen.get(code)} and ${i + 1}`);
    } else {
      seen.set(code, i + 1);
    }
  }
}

if (failures.length > 0) {
  console.error(`✗ countries registry failed ${failures.length} check${failures.length === 1 ? '' : 's'}:`);
  for (const message of failures.slice(0, 25)) console.error(`  - ${message}`);
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  process.exit(1);
}

console.log(
  `✓ countries registry: ${countries.length} entries, ${seen.size} unique ISO-3166 alpha-2 codes, every entry named`,
);
