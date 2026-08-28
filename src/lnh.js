'use strict';

/**
 * Client lnh.fr.
 *
 * Le site ne sert PAS de JSON : les pages sont vides et se remplissent via des
 * appels AJAX qui renvoient des fragments HTML rendus cote serveur. On rejoue
 * donc exactement les appels que fait la page, et on parse le HTML.
 * Detail des endpoints : recon/PHASE0-RECON.md
 */

const config = require('../config');

const MOIS = {
  janv: 1, fev: 2, 'fév': 2, mars: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, aout: 8, 'aoû': 8, sept: 9, oct: 10, nov: 11, dec: 12, 'déc': 12,
};

let cookie = '';

async function post(url, body, referer = config.lnh.referer) {
  const headers = {
    'User-Agent': config.lnh.userAgent,
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { method: 'POST', headers, body });
  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = sc.match(/PHPSESSID=[^;]+/);
    if (m) cookie = m[0];
  }
  return { status: res.status, text: await res.text() };
}

/** Corps du POST reproduisant apps.initPluginFilter() de la page calendrier. */
function calendarBody({ univers, month }) {
  const params = [
    ['seasons_id', config.lnh.seasonId],
    ['days_id', 'all'],
    ['teams_id', 'all'],
    ['univers', univers],
    ['key', config.lnh.formKey],
    ['current_month', month],
    ['type', 'all'],
    ['type_id', 'all'],
    ['contents_controller', 'sportsCalendars'],
    ['contents_action', 'index_ajax'],
    ['cache', 'yes'],
    [
      'cacheKeys',
      'univers,contents_controller,contents_action,type,seasons_id,days_id,teams_id,current_month',
    ],
  ];
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function texte(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convertit "ven. 04 sept. 20h00" en Date.
 * La saison court de aout a juin : un mois <= 7 appartient a l'annee civile suivante.
 */
function parseCoupEnvoi(libelle, saisonDebut) {
  const m = libelle.match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{1,2})h(\d{2})/i);
  if (!m) return null;
  const jour = Number(m[1]);
  const cle = m[2].toLowerCase().slice(0, 4);
  const mois = Object.entries(MOIS).find(([k]) => cle.startsWith(k.slice(0, 3)));
  if (!mois) return null;
  const moisNum = mois[1];
  const annee = moisNum >= 8 ? saisonDebut : saisonDebut + 1;
  return new Date(annee, moisNum - 1, jour, Number(m[3]), Number(m[4]), 0, 0);
}

/**
 * Statut d'un match a partir du fragment.
 *
 * Connu (mesure) : classe "waiting" + .scores.is-coming avant le match,
 *                  classe "finish"  + .scores.is-finish "34 - 34" apres.
 * Inconnu : la classe exacte pendant un match (capture prevue le 29/08/2026).
 * D'ou la regle tolerante : termine seulement si la classe dit "finish" ;
 * en cours des que le score est chiffre sans etre termine. Elle marche quelle
 * que soit la classe que la LNH utilise pour le direct.
 */
function statut(m) {
  if (m.statusClass === 'finish' || /is-finish/.test(m.scoreClass)) return 'termine';
  if (m.homeScore !== null) return 'en-cours';
  return 'a-venir';
}

function parseCalendrier(html, saisonDebut) {
  const re =
    /<div class="calendars-listing-item\s+([^"]*)"\s*id="(\d+)">([\s\S]*?)(?=<div class="calendars-listing-item|$)/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const [, classes, id, bloc] = m;
    const parts = classes.trim().split(/\s+/);

    const infos = bloc.match(
      /<span class="competition">\s*([\s\S]*?)\s*<\/span>\s*<br>\s*([\s\S]*?)\s*<\/div>/
    );
    const equipes = [...bloc.matchAll(/<div class="team-name">\s*([\s\S]*?)\s*<\/div>/g)].map(
      (t) => texte(t[1])
    );
    const sc = bloc.match(/<div class="scores([^"]*)">\s*([\s\S]*?)\s*<\/div>/);
    const scoreTexte = sc ? texte(sc[2]) : '';
    const chiffres = scoreTexte.match(/^(\d+)\s*-\s*(\d+)$/);

    const match = {
      id,
      statusClass: parts[1] || '',
      scoreClass: sc ? sc[1].trim() : '',
      competition: infos ? texte(infos[1]) : '',
      dateTexte: infos ? texte(infos[2]) : '',
      home: equipes[0] || '?',
      away: equipes[1] || '?',
      homeScore: chiffres ? Number(chiffres[1]) : null,
      awayScore: chiffres ? Number(chiffres[2]) : null,
      scoreTexte,
    };
    match.coupEnvoi = parseCoupEnvoi(match.dateTexte, saisonDebut);
    match.statut = statut(match);
    out.push(match);
  }
  return out;
}

/** Matchs de Daikin StarLigue d'un mois donne ('09', '10'...). ~45-110 Ko. */
async function matchsStarligue(mois, saisonDebut) {
  const res = await post(
    config.lnh.endpoint,
    calendarBody({ univers: config.lnh.universStarligue, month: mois })
  );
  if (res.status !== 200) {
    throw new Error(`calendrier LNH : HTTP ${res.status}`);
  }
  return parseCalendrier(res.text, saisonDebut).filter((m) =>
    config.competitionPattern.test(m.competition)
  );
}

/**
 * Matchs du mois en cours, plus ceux du mois suivant si le mois en cours ne
 * contient aucun match a venir (fin de mois, intersaison, treve).
 *
 * A noter : interroge sur un mois vide, le site renvoie spontanement le mois
 * utile suivant. C'est pratique mais non documente, donc on ne s'y fie pas.
 */
async function matchsPertinents(date = new Date()) {
  const saisonDebut = date.getMonth() + 1 >= 8 ? date.getFullYear() : date.getFullYear() - 1;
  const mois = String(date.getMonth() + 1).padStart(2, '0');

  const matchs = await matchsStarligue(mois, saisonDebut);
  const aVenir = matchs.some((m) => m.coupEnvoi && m.coupEnvoi.getTime() > date.getTime());

  if (!aVenir) {
    const suivant = String((date.getMonth() + 1) % 12 + 1).padStart(2, '0');
    try {
      const extra = await matchsStarligue(suivant, saisonDebut);
      const vus = new Set(matchs.map((m) => m.id));
      for (const m of extra) if (!vus.has(m.id)) matchs.push(m);
    } catch {
      /* le mois en cours suffit */
    }
  }
  return matchs;
}

/**
 * Sonde legere (467 octets, seul vrai JSON du site) : le header du site affiche
 * un raccourci "live" des qu'un match tourne, toutes competitions confondues.
 * Utile pour ne pas taper le calendrier pour rien, mais ne dit pas QUEL match.
 */
async function liveEnCours() {
  const res = await post(config.lnh.headerEndpoint, '', 'https://www.lnh.fr/matchs/lives');
  if (res.status !== 200) return null;
  try {
    return Boolean(JSON.parse(res.text).live_shortcut);
  } catch {
    return null;
  }
}

module.exports = { matchsStarligue, matchsPertinents, liveEnCours, parseCalendrier, parseCoupEnvoi, post };
