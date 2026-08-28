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

// lnh.fr renvoie des 500 sporadiques. Si l'un tombe pendant un match, il ne faut
// surtout pas retomber a la cadence de veille : ce serait 10 minutes de trou,
// donc une vingtaine de buts manques. On memorise le regime en cours.
let enDirect = false;

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
    // En plein match on reessaie tout de suite, pas dans 10 minutes.
    return {
      attente: enDirect ? config.timing.matchMs : config.timing.veilleMs,
      actifs: enDirect ? 1 : 0,
      prochain: null,
      erreur: true,
    };
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
    // Deux declencheurs, dont un qui ne depend pas de la source : l'horloge.
    // Si lnh.fr n'affichait le score qu'a la fin du match, attendre qu'un score
    // chiffre apparaisse ne notifierait jamais le debut - alors que l'heure du
    // coup d'envoi est connue d'avance. On se fie donc a elle, et le score
    // n'est plus qu'un declencheur de secours s'il arrive en avance.
    const coupEnvoiPasse = m.coupEnvoi ? maintenant >= m.coupEnvoi.getTime() : false;

    if (!e.debutNotifie && m.statut !== 'termine' && (m.statut === 'en-cours' || coupEnvoiPasse)) {
      log(`coup d'envoi : ${m.home} vs ${m.away}`);
      await messages.coupEnvoi(m);
      e.debutNotifie = true;
    }

    // --- buts ---
    if (m.homeScore !== null && m.awayScore !== null) {
      // Garde-fou n°1 : on ne suppose un depart a 0-0 que si le match est
      // effectivement EN COURS. Si le score apparait d'un bloc alors que le
      // match est deja termine (cas ou la source ne se rafraichit pas en
      // direct), supposer 0-0 declencherait une rafale de ~58 notifications.
      if (e.homeScore === null && e.vuAvantMatch && m.statut === 'en-cours') {
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

        // Garde-fou : un bond invraisemblable entre deux releves n'est pas une
        // avalanche de buts, c'est une anomalie de la source. On enregistre le
        // nouveau score sans spammer - mais on ne saute PAS la suite, sinon un
        // match dont le score final arrive d'un bloc n'aurait aucune
        // notification de fin.
        if (dHome + dAway > config.timing.butsMaxParReleve) {
          log(
            `bond anormal ignore : ${e.homeScore}-${e.awayScore} -> ` +
              `${m.homeScore}-${m.awayScore} (${dHome + dAway} buts d'un coup)`
          );
        } else {
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
            log(
              `score corrige a la baisse (${e.homeScore}-${e.awayScore} -> ` +
                `${m.homeScore}-${m.awayScore})`
            );
          }
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
  enDirect = actifs.length > 0;

  const prochain = matchs
    .filter((m) => m.statut === 'a-venir' && m.coupEnvoi && m.coupEnvoi.getTime() > maintenant)
    .sort((a, b) => a.coupEnvoi - b.coupEnvoi)[0];

  if (actifs.length) {
    log(
      `${actifs.length} match(s) suivi(s) : ` +
        actifs.map((m) => `${m.home}-${m.away} [${m.statut}] ${m.scoreTexte}`).join(' | ')
    );
    return { attente: config.timing.matchMs, actifs: actifs.length, prochain };
  }

  log(
    `veille — rien en cours.` +
      (prochain ? ` Prochain : ${prochain.home} vs ${prochain.away}, ${prochain.dateTexte}` : '')
  );
  return { attente: config.timing.veilleMs, actifs: 0, prochain };
}

const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boucle sans fin, pour un process qui tourne en continu. */
async function boucle() {
  for (;;) {
    const r = await tick();
    if (ONCE) return;
    await dors(r.attente);
  }
}

/**
 * Mode portier, pour GitHub Actions.
 *
 * Le cron ne sait pas etre precis : il est fige en UTC, donc faux six mois par
 * an, et les coups d'envoi varient (17h, 19h, 20h, 20h30). On le declenche donc
 * souvent et betement, et c'est ici qu'on decide s'il y a lieu d'agir - a partir
 * de l'heure de Paris, qui est juste toute l'annee.
 *
 *   - aucun match dans la fenetre  -> on ressort en quelques secondes
 *   - un match approche ou tourne  -> on reste jusqu'a la fin des matchs
 */
async function portier() {
  const debut = Date.now();

  for (;;) {
    const r = await tick();

    // On ne sort que si RIEN ne tourne et que rien n'approche. Un creux entre
    // deux matchs d'une meme soiree (fin du match de 17h, finale a 20h) ne doit
    // pas faire tomber le job : sinon le second match ne serait jamais suivi.
    if (r.actifs === 0) {
      const delta = r.prochain ? r.prochain.coupEnvoi.getTime() - Date.now() : Infinity;
      if (delta > config.timing.fenetrePortierMs) {
        log(
          Number.isFinite(delta)
            ? `portier : prochain match dans ${Math.round(delta / 60000)} min — sortie`
            : 'portier : aucun match a venir — sortie'
        );
        return;
      }
      log(`portier : match dans ${Math.round(delta / 60000)} min — on reste en veille`);
    }

    if (Date.now() - debut > config.timing.dureeMaxJobMs) {
      log('duree maximale du job atteinte — sortie');
      return;
    }
    await dors(r.attente);
  }
}

module.exports = { tick, aSuivre, portier, boucle };

if (require.main === module) {
  const lancer = process.argv.includes('--portier') ? portier : boucle;
  lancer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
