'use strict';

const fs = require('fs');
const config = require('../config');

/**
 * Etat minimal persiste sur disque : le dernier score connu par match.
 * Un fichier JSON suffit et survit a un redemarrage du process en plein match,
 * ce qu'une variable en memoire ne ferait pas.
 */
function charger() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch {
    return { matchs: {} };
  }
}

function sauver(state) {
  const tmp = config.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, config.stateFile); // ecriture atomique
}

/** Purge les matchs termines depuis plus de 24 h pour que le fichier ne gonfle pas. */
function purger(state, maintenant = Date.now()) {
  for (const [id, m] of Object.entries(state.matchs)) {
    if (m.termine && maintenant - (m.majLe || 0) > 24 * 60 * 60 * 1000) {
      delete state.matchs[id];
    }
  }
  return state;
}

module.exports = { charger, sauver, purger };
