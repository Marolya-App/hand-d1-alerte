'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Le topic ntfy n'est pas versionne : sur l'instance publique ntfy.sh, quiconque
 * connait le nom exact du topic peut s'y abonner ET y publier. Le nom EST le secret.
 * Ordre de lecture : variable d'environnement, puis fichier .ntfy-topic (gitignore).
 */
function readTopic() {
  if (process.env.NTFY_TOPIC) return process.env.NTFY_TOPIC.trim();
  const file = path.join(__dirname, '.ntfy-topic');
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  throw new Error(
    'Aucun topic ntfy configure. Cree un fichier .ntfy-topic ou definis NTFY_TOPIC.'
  );
}

module.exports = {
  ntfy: {
    server: 'https://ntfy.sh',
    get topic() {
      return readTopic();
    },
  },

  lnh: {
    // Dispatcher AJAX unique du site (cf. recon/PHASE0-RECON.md)
    endpoint: 'https://www.lnh.fr/ajaxpost1',
    headerEndpoint: 'https://www.lnh.fr/ajaxheader',
    referer: 'https://www.lnh.fr/matchs/calendrier',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',

    // univers = filtre de competition. d1-26623 -> Daikin StarLigue seule.
    universStarligue: 'd1-26623',
    universTous: 'matchs-6892',

    seasonId: '40', // 2026/2027
    formKey: '701113370',
  },

  // Perimetre : uniquement la D1 masculine.
  competitionPattern: /Daikin StarLigue/i,

  clubs: [
    'Aix', 'Caen', 'Cesson-Rennes', 'Chambéry', 'Chartres', 'Dunkerque',
    'Limoges', 'Montpellier', 'Nantes', 'Nîmes', 'Paris', 'Saint-Raphaël',
    'Saran', 'Sélestat', 'Toulouse', 'Tremblay',
  ],

  timing: {
    // Veille : y a-t-il un match en cours ?
    veilleMs: 10 * 60 * 1000,
    // Match en cours : detection des buts. La page LNH se rafraichit toutes
    // les 11 s d'elle-meme, 30 s reste tres conservateur.
    matchMs: 30 * 1000,
    // On passe en polling rapide ce delai avant le coup d'envoi prevu.
    avantCoupEnvoiMs: 10 * 60 * 1000,
    // Filet de securite : si un match reste "en cours" au-dela, on le laisse tomber.
    dureeMaxMatchMs: 3 * 60 * 60 * 1000,
    // Au-dela de ce nombre de buts entre deux releves, on considere que la
    // source a saute (et non qu'il y a eu 20 buts en 30 s) : on n'enumere pas.
    butsMaxParReleve: 8,
  },

  stateFile: path.join(__dirname, 'state.json'),
};
