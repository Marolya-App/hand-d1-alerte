'use strict';

/**
 * Boucle principale.
 *
 * Deux regimes, dans un seul process :
 *   - veille  : toutes les 10 min, "y a-t-il un match StarLigue en cours ou imminent ?"
 *   - direct  : toutes les 30 s tant qu'un match tourne, pour detecter les buts.
 *
 * On ne se contente pas de la sonde /ajaxheader (qui dit juste "un live tourne
 * quelque part", toutes competitions confondues) : c'est le calendrier filtre
 * sur univers=d1-26623 qui donne le score, et lui seul est limite a la D1.
 */

const lnh = require('./lnh');
const { messages } = require('./ntfy');
const state = require('./state');
const config = require('../config');

const ONCE = process.argv.includes('--once');

function heure() {
  return new Date().toLocaleTimeString('fr-FR');
}

function log(...args) {
  console.log(`[${heure()}]`, ...args);
}

/** Un match est "a suivre" s'il tourne, ou si le coup d'envoi est imminent. */
function aSuivre(m, maintenant) {
  if (m.statut === 'en-cours') return true;
  if (m.statut === 'a-venir' && m.coupEnvoi) {
    const delta = m.coupEnvoi.getTime() - maintenant;
    return delta <= config.timing.avantCoupEnvoiMs && delta > -config.timing.dureeMaxMatchMs;
  }
  return false;
}

async function tick() {
  const maintenant = Date.now();
  const s = state.purger(state.charger(), maintenant);

  let matchs;
  try {
    matchs = await lnh.matchsPertinents(new Date());
  } catch (e) {
    log(`erreur LNH : ${e.message}`);
    return config.timing.veilleMs; // on retente au rythme de veille
  }

  const actifs = matchs.filter((m) => aSuivre(m, maintenant));

  for (const m of matchs) {
    const connu = s.matchs[m.id];

    // On n'ouvre un suivi que sur un match en cours ou imminent : sinon, au
    // premier lancement, tous les matchs deja joues du mois declencheraient
    // une notification de fin.
    if (!connu && !aSuivre(m, maintenant)) continue;

    const e = connu || {
      home: m.home,
      away: m.away,
      homeScore: null,
      awayScore: null,
      debutNotifie: false,
      termine: false,
      vuAvantMatch: false,
    };

    // On a vu ce match AVANT son coup d'envoi : on sait donc qu'il part de 0-0,
    // et le premier score releve pourra etre attribue but par but.
    if (m.statut === 'a-venir') e.vuAvantMatch = true;

    // --- coup d'envoi ---
    if (!e.debutNotifie && m.statut === 'en-cours') {
      log(`coup d'envoi : ${m.home} vs ${m.away}`);
      await messages.coupEnvoi(m);
      e.debutNotifie = true;
    }

    // --- buts ---
    if (m.homeScore !== null && m.awayScore !== null) {
      if (e.homeScore === null && e.vuAvantMatch) {
        // On suivait deja ce match avant le coup d'envoi : le score de depart
        // est forcement 0-0, donc rien n'est perdu si le premier releve arrive
        // deja a 1-0.
        e.homeScore = 0;
        e.awayScore = 0;
      }

      if (e.homeScore === null) {
        // Premiere observation d'un match deja engage (process demarre en cours
        // de match) : on enregistre le score sans notifier, pour ne pas partir
        // en rafale sur des buts qu'on n'a pas vus.
        log(`prise en marche : ${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}`);
      } else {
        const dHome = m.homeScore - e.homeScore;
        const dAway = m.awayScore - e.awayScore;

        // Un but = une notification, meme si le polling en a rate plusieurs.
        // On reconstitue les scores intermediaires pour rester fidele.
        for (let i = 1; i <= Math.max(0, dHome); i++) {
          const etape = { ...m, homeScore: e.homeScore + i, awayScore: e.awayScore };
          log(`BUT ${m.home} : ${etape.homeScore} - ${etape.awayScore}`);
          await messages.but(etape, m.home);
        }
        for (let i = 1; i <= Math.max(0, dAway); i++) {
          const etape = { ...m, homeScore: m.homeScore, awayScore: e.awayScore + i };
          log(`BUT ${m.away} : ${etape.homeScore} - ${etape.awayScore}`);
          await messages.but(etape, m.away);
        }
        if (dHome < 0 || dAway < 0) {
          log(`score corrige a la baisse (${e.homeScore}-${e.awayScore} -> ${m.homeScore}-${m.awayScore})`);
        }
      }
      e.homeScore = m.homeScore;
      e.awayScore = m.awayScore;
    }

    // --- fin de match ---
    if (m.statut === 'termine' && !e.termine) {
      if (e.debutNotifie || e.homeScore !== null) {
        log(`fin : ${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}`);
        await messages.fin(m);
      }
      e.termine = true;
    }

    e.majLe = maintenant;
    s.matchs[m.id] = e;
  }

  state.sauver(s);

  if (actifs.length) {
    log(
      `${actifs.length} match(s) suivi(s) : ` +
        actifs.map((m) => `${m.home}-${m.away} [${m.statut}] ${m.scoreTexte}`).join(' | ')
    );
    return config.timing.matchMs;
  }

  const prochain = matchs
    .filter((m) => m.statut === 'a-venir' && m.coupEnvoi && m.coupEnvoi.getTime() > maintenant)
    .sort((a, b) => a.coupEnvoi - b.coupEnvoi)[0];
  log(
    `veille — rien en cours.` +
      (prochain ? ` Prochain : ${prochain.home} vs ${prochain.away}, ${prochain.dateTexte}` : '')
  );
  return config.timing.veilleMs;
}

async function boucle() {
  const attente = await tick();
  if (ONCE) return;
  setTimeout(boucle, attente);
}

module.exports = { tick, aSuivre };

if (require.main === module) {
  boucle().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
