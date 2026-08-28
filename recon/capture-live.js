#!/usr/bin/env node
/**
 * Phase 0 - capture du payload live LNH.
 * A lancer pendant un match (ex. Trophee des Champions, sam. 29/08/2026 20h00).
 *
 *   node capture-live.js                 # capture 150 min, toutes les 20s
 *   node capture-live.js --once          # un seul passage
 *   node capture-live.js --minutes 90    # duree personnalisee
 *
 * Ecrit les reponses brutes dans ./captures/<timestamp>-<nom>.txt,
 * le journal complet dans ./captures/session-<timestamp>.log,
 * et signale en console tout ce qui change (statut, score detecte).
 *
 * Le process s'arrete tout seul au bout de --minutes.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'captures');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const INTERVAL_MS = 20000;
const ONCE = process.argv.includes('--once');
const MINUTES = (() => {
  const i = process.argv.indexOf('--minutes');
  return i !== -1 ? Number(process.argv[i + 1]) : 150;
})();

fs.mkdirSync(OUT, { recursive: true });

const startedAt = new Date();
const LOG = path.join(
  OUT,
  `session-${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`
);

function log(msg) {
  console.log(msg);
  fs.appendFileSync(LOG, msg + '\n', 'utf8');
}

let cookie = '';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function save(name, body) {
  fs.writeFileSync(path.join(OUT, `${stamp()}-${name}.txt`), body, 'utf8');
}

async function call(url, { body = null, referer = 'https://www.lnh.fr/matchs/lives' } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

  const res = await fetch(url, { method: body === null ? 'GET' : 'POST', headers, body });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/PHPSESSID=[^;]+/);
    if (m) cookie = m[0];
  }
  return { status: res.status, text: await res.text() };
}

// Ce que la page /matchs/lives envoie reellement (cf. apps.js makeRefreshLivesIndexLarge)
const LIVES_INDEX_BODY =
  '&contents_controller=eStatsChannels&contents_action=index_ajax' +
  '&univers=matchs-6892&competitions_id=';

// Calendrier global du jour (cf. apps.initPluginFilter de /matchs/calendrier)
const CAL_BODY =
  'seasons_id=40&days_id=all&teams_id=all&univers=matchs-6892&key=701113370' +
  '&current_month=08&type=all&type_id=all' +
  '&contents_controller=sportsCalendars&contents_action=index_ajax' +
  '&cache=yes&cacheKeys=univers,contents_controller,contents_action,type,seasons_id,days_id,teams_id,current_month';

function scoresFromCalendar(html) {
  const re =
    /<div class="calendars-listing-item\s+([^"]*)"\s*id="(\d+)">([\s\S]*?)(?=<div class="calendars-listing-item|$)/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const [, cls, id, block] = m;
    const status = (cls.trim().split(/\s+/)[1] || '').trim(); // waiting | finish | live | ?
    const teams = [...block.matchAll(/<div class="team-name">\s*([\s\S]*?)\s*<\/div>/g)].map((t) =>
      t[1].replace(/\s+/g, ' ').trim()
    );
    const sc = block.match(/<div class="scores([^"]*)">\s*([\s\S]*?)\s*<\/div>/);
    rows.push({
      id,
      status,
      scoreClass: sc ? sc[1].trim() : '',
      score: sc ? sc[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      teams: teams.join(' vs '),
    });
  }
  return rows;
}

// Les deux matchs du Trophee des Champions du 29/08/2026
const WATCHED = new Set(['11740', '11741']);

let previous = '';

async function tick() {
  const now = new Date().toLocaleTimeString('fr-FR');
  const lines = [`\n===== ${now} =====`];

  if (!cookie) await call('https://www.lnh.fr/matchs/lives');

  // 1. ajaxheader -> JSON, champ live_shortcut = signal "un live tourne"
  try {
    const h = await call('https://www.lnh.fr/ajaxheader', { body: '' });
    save('ajaxheader', h.text);
    let shortcut = '(illisible)';
    try {
      shortcut = JSON.parse(h.text).live_shortcut || '(vide)';
    } catch {}
    lines.push(`ajaxheader        HTTP ${h.status}  live_shortcut=${shortcut.slice(0, 300)}`);
  } catch (e) {
    lines.push(`ajaxheader        ERREUR ${e.message}`);
  }

  // 2. liste des lives (500 hors match -> c'est l'hypothese a valider)
  try {
    const l = await call('https://www.lnh.fr/ajaxpost1', { body: LIVES_INDEX_BODY });
    save('lives-index', l.text);
    lines.push(`lives index_ajax  HTTP ${l.status}  ${l.text.length} octets`);
    if (l.status === 200 && l.text.length > 0) {
      lines.push('  >>> PAYLOAD LIVE CAPTURE <<<');
      const ids = [...l.text.matchAll(/id="(\d+)"/g)].map((x) => x[1]);
      if (ids.length) lines.push(`  ids vus: ${[...new Set(ids)].join(', ')}`);
    }
  } catch (e) {
    lines.push(`lives index_ajax  ERREUR ${e.message}`);
  }

  // 3. calendrier : est-ce que le score y bouge en direct ?
  try {
    const c = await call('https://www.lnh.fr/ajaxpost1', {
      body: CAL_BODY,
      referer: 'https://www.lnh.fr/matchs/calendrier',
    });
    save('calendrier', c.text);
    const rows = scoresFromCalendar(c.text);
    const watched = rows.filter((r) => WATCHED.has(r.id));
    const others = rows.filter((r) => !WATCHED.has(r.id) && r.status !== 'waiting' && r.status !== 'finish');
    lines.push(`calendrier        HTTP ${c.status}  ${c.text.length} octets, ${rows.length} matchs`);
    for (const r of watched) {
      lines.push(`  >> [${r.status}/${r.scoreClass}] ${r.id} ${r.teams} : ${r.score}`);
    }
    for (const r of others) {
      lines.push(`  ?? statut inconnu [${r.status}/${r.scoreClass}] ${r.id} ${r.teams} : ${r.score}`);
    }
  } catch (e) {
    lines.push(`calendrier        ERREUR ${e.message}`);
  }

  const out = lines.join('\n');
  if (out !== previous) log(out);
  previous = out;
}

(async () => {
  log(`# capture demarree ${startedAt.toLocaleString('fr-FR')} - duree ${MINUTES} min - intervalle ${INTERVAL_MS / 1000}s`);
  await tick();
  if (ONCE) return;
  const timer = setInterval(tick, INTERVAL_MS);
  setTimeout(() => {
    clearInterval(timer);
    log(`\n# capture terminee ${new Date().toLocaleString('fr-FR')}`);
    process.exit(0);
  }, MINUTES * 60 * 1000);
})();
