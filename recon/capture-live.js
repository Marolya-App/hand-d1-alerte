#!/usr/bin/env node
/**
 * Phase 0 - capture du comportement de lnh.fr PENDANT un match.
 *
 * Trois questions auxquelles cette capture doit repondre :
 *   1. quelle classe CSS porte un match en cours dans le calendrier ?
 *   2. le score du calendrier bouge-t-il en direct, ou seulement a la fin ?
 *   3. l'endpoint eStatsChannels (500 hors saison) repond-il pendant un match ?
 *
 *   node capture-live.js --minutes 340
 *   node capture-live.js --once
 *
 * Economie de place : on enregistre une fois la reponse brute complete de chaque
 * endpoint (baseline), puis uniquement ce qui CHANGE. Sans ca, 6 heures a 20 s
 * d'intervalle produiraient ~350 Mo de HTML quasi identique.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// Les deux matchs du Trophee des Champions du 29/08/2026.
const SUIVIS = new Set(['11740', '11741']);

fs.mkdirSync(OUT, { recursive: true });

const debut = new Date();
const SLUG = debut.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG = path.join(OUT, `session-${SLUG}.log`);
const CHANGES = path.join(OUT, `changements-${SLUG}.jsonl`);

function log(msg) {
  console.log(msg);
  fs.appendFileSync(LOG, msg + '\n', 'utf8');
}

function horodatage() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

const baselines = new Set(); // endpoints dont la reponse complete est deja archivee
const empreintes = new Map(); // endpoint -> hash de la derniere reponse retenue

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * Archive la reponse : integralement la premiere fois, puis seulement si elle a
 * change - et dans ce cas en gardant le fichier complet, car c'est exactement le
 * moment interessant (passage a "en cours", changement de score).
 */
function archiver(nom, corps) {
  const h = hash(corps);
  if (!baselines.has(nom)) {
    baselines.add(nom);
    empreintes.set(nom, h);
    fs.writeFileSync(path.join(OUT, `${horodatage()}-${nom}-baseline.txt`), corps, 'utf8');
    return true;
  }
  if (empreintes.get(nom) === h) return false;
  empreintes.set(nom, h);
  fs.writeFileSync(path.join(OUT, `${horodatage()}-${nom}-change.txt`), corps, 'utf8');
  return true;
}

/** Journal compact et exploitable de tout ce qui bouge. */
function noterChangement(objet) {
  fs.appendFileSync(
    CHANGES,
    JSON.stringify({ t: new Date().toISOString(), ...objet }) + '\n',
    'utf8'
  );
}

let cookie = '';

async function call(url, { body = null, referer = 'https://www.lnh.fr/matchs/lives' } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

  const res = await fetch(url, { method: body === null ? 'GET' : 'POST', headers, body });
  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = sc.match(/PHPSESSID=[^;]+/);
    if (m) cookie = m[0];
  }
  return { status: res.status, text: await res.text() };
}

// Ce que la page /matchs/lives envoie reellement (cf. apps.js).
const LIVES_INDEX_BODY =
  '&contents_controller=eStatsChannels&contents_action=index_ajax' +
  '&univers=matchs-6892&competitions_id=';

// Calendrier toutes competitions du mois d'aout (cf. apps.initPluginFilter).
const CAL_BODY =
  'seasons_id=40&days_id=all&teams_id=all&univers=matchs-6892&key=701113370' +
  '&current_month=08&type=all&type_id=all' +
  '&contents_controller=sportsCalendars&contents_action=index_ajax' +
  '&cache=yes&cacheKeys=univers,contents_controller,contents_action,type,seasons_id,days_id,teams_id,current_month';

function extraireMatchs(html) {
  const re =
    /<div class="calendars-listing-item\s+([^"]*)"\s*id="(\d+)">([\s\S]*?)(?=<div class="calendars-listing-item|$)/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const [bloc, classes, id, corps] = [m[0], m[1], m[2], m[3]];
    const equipes = [...corps.matchAll(/<div class="team-name">\s*([\s\S]*?)\s*<\/div>/g)].map((t) =>
      t[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    );
    const sc = corps.match(/<div class="scores([^"]*)">\s*([\s\S]*?)\s*<\/div>/);
    rows.push({
      id,
      classes: classes.trim(),
      statut: (classes.trim().split(/\s+/)[1] || ''),
      scoreClass: sc ? sc[1].trim() : '',
      score: sc ? sc[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      equipes: equipes.join(' vs '),
      bloc,
    });
  }
  return rows;
}

const dernierEtat = new Map(); // id -> signature du match

let precedent = '';

async function tick() {
  const maintenant = new Date().toLocaleTimeString('fr-FR');
  const lignes = [`\n===== ${maintenant} =====`];

  if (!cookie) {
    try {
      await call('https://www.lnh.fr/matchs/lives');
    } catch {}
  }

  // 1. Sonde JSON du header : y a-t-il un live quelque part ?
  try {
    const h = await call('https://www.lnh.fr/ajaxheader', { body: '' });
    let raccourci = '(illisible)';
    try {
      raccourci = JSON.parse(h.text).live_shortcut || '(vide)';
    } catch {}
    if (raccourci !== '(vide)' && raccourci !== '(illisible)') archiver('ajaxheader', h.text);
    lignes.push(`ajaxheader        HTTP ${h.status}  live_shortcut=${raccourci.slice(0, 300)}`);
  } catch (e) {
    lignes.push(`ajaxheader        ERREUR ${e.message}`);
  }

  // 2. eStatsChannels : 500 hors saison. Repond-il pendant un match ?
  try {
    const l = await call('https://www.lnh.fr/ajaxpost1', { body: LIVES_INDEX_BODY });
    lignes.push(`lives index_ajax  HTTP ${l.status}  ${l.text.length} octets`);
    if (l.status === 200 && l.text.length > 0) {
      const neuf = archiver('lives-index', l.text);
      lignes.push(`  >>> REPOND ! ${neuf ? 'archive' : 'inchange'} <<<`);
      noterChangement({ quoi: 'lives-index', status: l.status, taille: l.text.length });
    }
  } catch (e) {
    lignes.push(`lives index_ajax  ERREUR ${e.message}`);
  }

  // 3. Calendrier : c'est LA question. Le score bouge-t-il en direct ?
  try {
    const c = await call('https://www.lnh.fr/ajaxpost1', {
      body: CAL_BODY,
      referer: 'https://www.lnh.fr/matchs/calendrier',
    });
    lignes.push(`calendrier        HTTP ${c.status}  ${c.text.length} octets`);

    const matchs = extraireMatchs(c.text);
    for (const m of matchs) {
      const signature = `${m.classes}|${m.scoreClass}|${m.score}`;
      const avant = dernierEtat.get(m.id);
      if (avant === signature) continue;
      dernierEtat.set(m.id, signature);

      const interessant = SUIVIS.has(m.id) || (m.statut !== 'waiting' && m.statut !== 'finish');
      if (avant === undefined && !SUIVIS.has(m.id)) continue; // bruit du 1er passage

      lignes.push(
        `  ${SUIVIS.has(m.id) ? '>>' : '??'} ${m.id} ${m.equipes} : [${m.classes}] ` +
          `[${m.scoreClass}] "${m.score}"` +
          (avant !== undefined ? `   (avant: ${avant})` : '')
      );
      noterChangement({
        quoi: 'match',
        id: m.id,
        equipes: m.equipes,
        classes: m.classes,
        scoreClass: m.scoreClass,
        score: m.score,
        avant: avant || null,
      });
      if (interessant) {
        fs.writeFileSync(
          path.join(OUT, `${horodatage()}-match-${m.id}.html`),
          m.bloc,
          'utf8'
        );
      }
    }

    // Le calendrier complet n'est archive qu'a la premiere passe et a chaque
    // changement reel de son contenu.
    archiver('calendrier', c.text);
  } catch (e) {
    lignes.push(`calendrier        ERREUR ${e.message}`);
  }

  const sortie = lignes.join('\n');
  // On evite de repeter a l'identique un etat immobile, mais on garde une trace
  // horaire toutes les 5 minutes pour prouver que la capture tournait bien.
  const immobile = sortie.split('\n').length === precedent.split('\n').length;
  if (!immobile || new Date().getMinutes() % 5 === 0) log(sortie);
  precedent = sortie;
}

(async () => {
  log(
    `# capture demarree ${debut.toLocaleString('fr-FR')} — duree ${MINUTES} min — ` +
      `intervalle ${INTERVAL_MS / 1000}s — matchs suivis ${[...SUIVIS].join(', ')}`
  );
  await tick();
  if (ONCE) return;

  const timer = setInterval(() => {
    tick().catch((e) => log(`tick en erreur : ${e.message}`));
  }, INTERVAL_MS);

  setTimeout(() => {
    clearInterval(timer);
    log(`\n# capture terminee ${new Date().toLocaleString('fr-FR')}`);
    process.exit(0);
  }, MINUTES * 60 * 1000);
})();
