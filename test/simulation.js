'use strict';

/**
 * Simulation d'un match, hors ligne.
 *
 * On ne peut pas tester la detection des buts sur un vrai match tant que la
 * saison n'a pas commence. On rejoue donc un match a partir de vrais fragments
 * HTML lnh.fr (structure capturee en Phase 0), en faisant varier le score.
 *
 *   node test/simulation.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Etat isole : on ne touche pas au state.json reel.
const tmpState = path.join(os.tmpdir(), `hand-d1-sim-${process.pid}.json`);
const config = require('../config');
config.stateFile = tmpState;

const lnh = require('../src/lnh');
const ntfy = require('../src/ntfy');

// --- on intercepte les notifications au lieu de les envoyer ---
const envoyees = [];
ntfy.messages.coupEnvoi = async (m) => {
  envoyees.push(`DEBUT ${m.home} vs ${m.away}`);
  return true;
};
ntfy.messages.but = async (m, equipe) => {
  envoyees.push(`BUT ${equipe} ${m.homeScore}-${m.awayScore}`);
  return true;
};
ntfy.messages.fin = async (m) => {
  envoyees.push(`FIN ${m.homeScore}-${m.awayScore}`);
  return true;
};

const watch = require('../src/watch');

/**
 * Fabrique un fragment identique a celui que renvoie sportsCalendars/index_ajax.
 * `statusClass` : 'waiting' avant le match, 'finish' apres. Pendant le match la
 * valeur reelle est encore inconnue -> on la parametre pour verifier que la
 * detection ne depend PAS d'elle.
 */
function fragment({ id, statusClass, scoreClass, score, date }) {
  return `<div class="listing-items by3"><div class="calendars-listing-item listing-item ${statusClass}  lmsl" id="${id}">
    <div class="row"><div class="col-infos"><div class="col-competitions">
      <span class="competition">Daikin StarLigue - J01</span><br>${date}
    </div></div></div>
    <div class="row"><div class="col-teams"><div class="teams-logos">
      <div class="team-logo"><div class="team-name">Chambéry</div></div>
      <div class="scores ${scoreClass}">${score}</div>
      <div class="team-logo"><div class="team-name">Paris</div></div>
    </div></div></div>
  </div></div>`;
}

const ID = '99001';
const DATE = 'ven. 04 sept. 20h00';

const ABBR = ['janv.', 'fev.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Formate une Date comme le fait lnh.fr : "ven. 04 sept. 20h00". */
function dateLNH(d) {
  const jj = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `lun. ${jj} ${ABBR[d.getMonth()]} ${hh}h${mm}`;
}

let scenario = [];
let etape = 0;
let dateCourante = DATE;

// On court-circuite le reseau : matchsPertinents renvoie l'etape courante.
lnh.matchsPertinents = async () => {
  const e = scenario[Math.min(etape, scenario.length - 1)];
  const saison = new Date().getMonth() + 1 >= 8 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  return lnh
    .parseCalendrier(fragment({ id: ID, date: e.date || dateCourante, ...e }), saison)
    .filter((m) => config.competitionPattern.test(m.competition));
};

function nettoyer() {
  try {
    fs.unlinkSync(tmpState);
  } catch {}
}

async function rejouer(etapes) {
  nettoyer();
  envoyees.length = 0;
  scenario = etapes;
  for (etape = 0; etape < scenario.length; etape++) {
    await watch.tick();
  }
  return envoyees.slice();
}

(async () => {
  // --- Scenario 1 : deroule nominal ---------------------------------------
  // Le coup d'envoi est dans la fenetre "imminent" grace a une date figee ?
  // Non : on force le match a l'etat "en cours" des l'etape 2, ce qui suffit
  // a ouvrir le suivi (aSuivre() accepte tout match en cours).
  let res = await rejouer([
    { statusClass: 'waiting', scoreClass: 'is-coming', score: 'vs' },
    { statusClass: 'live', scoreClass: 'is-live', score: '0 - 0' },
    { statusClass: 'live', scoreClass: 'is-live', score: '1 - 0' },
    { statusClass: 'live', scoreClass: 'is-live', score: '1 - 1' },
    { statusClass: 'live', scoreClass: 'is-live', score: '2 - 1' },
    { statusClass: 'finish', scoreClass: 'is-finish', score: '2 - 1' },
  ]);

  assert.deepStrictEqual(res, [
    'DEBUT Chambéry vs Paris',
    'BUT Chambéry 1-0',
    'BUT Paris 1-1',
    'BUT Chambéry 2-1',
    'FIN 2-1',
  ]);
  console.log('ok  deroule nominal : 1 notif par but, debut et fin compris');

  // --- Scenario 2 : plusieurs buts entre deux polls ------------------------
  res = await rejouer([
    { statusClass: 'live', scoreClass: 'is-live', score: '5 - 5' },
    { statusClass: 'live', scoreClass: 'is-live', score: '7 - 6' },
  ]);
  assert.deepStrictEqual(res, [
    'DEBUT Chambéry vs Paris',
    'BUT Chambéry 6-5',
    'BUT Chambéry 7-5',
    'BUT Paris 7-6',
  ]);
  console.log('ok  3 buts rates entre 2 polls -> 3 notifications, pas une seule groupee');

  // --- Scenario 3 : classe de statut inconnue pendant le direct ------------
  // La LNH peut nommer sa classe autrement (in-progress, running...).
  res = await rejouer([
    { statusClass: 'peu-importe', scoreClass: 'quelconque', score: '3 - 3' },
    { statusClass: 'peu-importe', scoreClass: 'quelconque', score: '4 - 3' },
  ]);
  assert.deepStrictEqual(res, ['DEBUT Chambéry vs Paris', 'BUT Chambéry 4-3']);
  console.log('ok  detection independante du nom de la classe CSS du direct');

  // --- Scenario 4 : demarrage en cours de match ----------------------------
  // Le process demarre alors que le score est deja 12-10 : surtout pas 22 notifs.
  res = await rejouer([
    { statusClass: 'live', scoreClass: 'is-live', score: '12 - 10' },
    { statusClass: 'live', scoreClass: 'is-live', score: '13 - 10' },
  ]);
  assert.deepStrictEqual(res, ['DEBUT Chambéry vs Paris', 'BUT Chambéry 13-10']);
  console.log('ok  prise en marche : aucune rafale de rattrapage');

  // --- Scenario 5 : match deja termine au demarrage ------------------------
  // Au premier lancement, les matchs deja joues du mois ne doivent rien envoyer.
  res = await rejouer([{ statusClass: 'finish', scoreClass: 'is-finish', score: '30 - 28' }]);
  assert.deepStrictEqual(res, []);
  console.log('ok  match deja joue au demarrage : silence');

  // --- Scenario 6 : idempotence -------------------------------------------
  // Deux polls identiques ne doivent pas doubler les notifications.
  res = await rejouer([
    { statusClass: 'live', scoreClass: 'is-live', score: '8 - 8' },
    { statusClass: 'live', scoreClass: 'is-live', score: '9 - 8' },
    { statusClass: 'live', scoreClass: 'is-live', score: '9 - 8' },
    { statusClass: 'finish', scoreClass: 'is-finish', score: '9 - 8' },
    { statusClass: 'finish', scoreClass: 'is-finish', score: '9 - 8' },
  ]);
  assert.deepStrictEqual(res, ['DEBUT Chambéry vs Paris', 'BUT Chambéry 9-8', 'FIN 9-8']);
  console.log('ok  polls redondants : pas de doublon');

  // --- Scenario 7 : perimetre ---------------------------------------------
  // Un match de ProLigue ne doit jamais franchir le filtre.
  const proligue = lnh
    .parseCalendrier(
      fragment({ id: '1', date: DATE, statusClass: 'live', scoreClass: 'is-live', score: '4 - 2' })
        .replace('Daikin StarLigue - J01', 'ProLigue - J01'),
      2026
    )
    .filter((m) => config.competitionPattern.test(m.competition));
  assert.strictEqual(proligue.length, 0);
  console.log('ok  perimetre : ProLigue exclue');

  // --- Scenario 8 : dates interpretees en heure de Paris --------------------
  // Les assertions portent sur l'instant absolu (ISO/UTC), pas sur l'heure
  // locale : le test doit passer aussi bien sur le PC (UTC+2) que sur un
  // runner GitHub (UTC). C'est precisement le bug que ces lignes verrouillent.
  const cas = [
    // libelle,               saison, instant UTC attendu,      decalage Paris
    ['ven. 04 sept. 20h00', 2026, '2026-09-04T18:00:00.000Z', 2], // CEST
    ['dim. 25 oct. 17h00', 2026, '2026-10-25T16:00:00.000Z', 1], // bascule CET
    ['sam. 10 janv. 18h30', 2026, '2027-01-10T17:30:00.000Z', 1], // CET
    ['ven. 03 avr. 20h30', 2026, '2027-04-03T18:30:00.000Z', 2], // retour CEST
  ];
  for (const [libelle, saison, attendu, decalage] of cas) {
    const d = lnh.parseCoupEnvoi(libelle, saison);
    assert.strictEqual(d.toISOString(), attendu, `instant faux pour "${libelle}"`);
    assert.strictEqual(
      lnh.decalageParis(d) / 3600000,
      decalage,
      `decalage faux pour "${libelle}"`
    );
  }
  console.log('ok  dates : heure de Paris, bascules ete/hiver comprises');

  // L'annee civile change en cours de saison : janvier appartient a l'annee+1.
  assert.strictEqual(lnh.parseCoupEnvoi('sam. 10 janv. 18h30', 2026).getUTCFullYear(), 2027);
  console.log('ok  dates : bascule d annee civile en cours de saison');

  // --- Scenarios 14 a 16 : le portier (mode GitHub Actions) ----------------
  // C'est la piece qui remplace un cron precis. Sa regle : ne sortir que si
  // rien ne tourne ET que rien n'approche.
  {
    const t = config.timing;
    const sauvegarde = { ...t };
    t.veilleMs = 1;
    t.matchMs = 1;
    t.dureeMaxJobMs = 10000;

    const dansNMin = (n) => dateLNH(new Date(Date.now() + n * 60000));

    // Chaque appel consomme une etape ; la derniere se repete.
    function scenarioPortier(etapes) {
      let i = 0;
      lnh.matchsPertinents = async () => {
        const e = etapes[Math.min(i++, etapes.length - 1)];
        const html = e
          .map((m, k) =>
            fragment({
              id: String(90000 + k),
              date: m.date,
              statusClass: m.cls,
              scoreClass: m.sc,
              score: m.score,
            })
          )
          .join('');
        return lnh
          .parseCalendrier(html, new Date().getFullYear())
          .filter((m) => config.competitionPattern.test(m.competition));
      };
      return () => i;
    }

    // 14 : rien en cours, prochain match dans 8 jours -> sortie immediate.
    nettoyer();
    envoyees.length = 0;
    let compteur = scenarioPortier([
      [{ date: dansNMin(8 * 24 * 60), cls: 'waiting', sc: 'is-coming', score: 'vs' }],
    ]);
    await watch.portier();
    assert.strictEqual(compteur(), 1, 'le portier doit sortir apres un seul releve');
    console.log('ok  portier : hors fenetre, sortie apres 1 releve');

    // 15 : match dans 60 min -> il reste, suit le match, puis sort.
    nettoyer();
    envoyees.length = 0;
    compteur = scenarioPortier([
      [{ date: dansNMin(60), cls: 'waiting', sc: 'is-coming', score: 'vs' }],
      [{ date: dansNMin(-5), cls: 'live', sc: 'is-live', score: '1 - 0' }],
      [{ date: dansNMin(-5), cls: 'live', sc: 'is-live', score: '2 - 0' }],
      [{ date: dansNMin(-120), cls: 'finish', sc: 'is-finish', score: '30 - 28' }],
    ]);
    await watch.portier();
    assert.ok(compteur() >= 4, 'le portier doit avoir suivi le match jusqu au bout');
    assert.ok(
      envoyees.includes('BUT Chambéry 2-0'),
      'le but marque pendant le suivi doit avoir ete notifie'
    );
    assert.ok(envoyees.some((x) => x.startsWith('FIN ')), 'la fin doit etre notifiee');
    console.log('ok  portier : entre dans la fenetre, suit le match, puis sort');

    // 16 : creux entre deux matchs d'une meme soiree -> il ne doit PAS sortir.
    // C'est le cas reel du 29/08 : match a 17h, finale a 20h.
    nettoyer();
    envoyees.length = 0;
    compteur = scenarioPortier([
      [
        { date: dansNMin(-120), cls: 'finish', sc: 'is-finish', score: '30 - 28' },
        { date: dansNMin(70), cls: 'waiting', sc: 'is-coming', score: 'vs' },
      ],
      [
        { date: dansNMin(-120), cls: 'finish', sc: 'is-finish', score: '30 - 28' },
        { date: dansNMin(-1), cls: 'live', sc: 'is-live', score: '1 - 0' },
      ],
      [
        { date: dansNMin(-120), cls: 'finish', sc: 'is-finish', score: '30 - 28' },
        { date: dansNMin(-130), cls: 'finish', sc: 'is-finish', score: '25 - 24' },
      ],
      [{ date: dansNMin(8 * 24 * 60), cls: 'waiting', sc: 'is-coming', score: 'vs' }],
    ]);
    await watch.portier();
    assert.ok(compteur() >= 3, 'le portier ne doit pas sortir dans le creux entre deux matchs');
    console.log('ok  portier : ne decroche pas entre deux matchs de la meme soiree');

    Object.assign(t, sauvegarde);
  }

  nettoyer();
  console.log('\n16 scenarios passes.');
})().catch((e) => {
  nettoyer();
  console.error(e);
  process.exit(1);
});
