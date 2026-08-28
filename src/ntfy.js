'use strict';

const config = require('../config');

const DRY = process.argv.includes('--dry-run');

/**
 * Envoi d'une notification.
 *
 * On utilise le mode "publication JSON" de ntfy (POST sur la racine, le topic
 * est dans le corps) plutot que le mode POST /<topic> avec en-tetes : les
 * en-tetes HTTP sont limites a l'ASCII, or nos titres et nos noms de clubs
 * ont des accents (Chambéry, Nîmes, Terminé...).
 */
async function notifier(message, { titre, tags, priorite } = {}) {
  if (DRY) {
    console.log(`[dry-run] ${titre ? titre + ' | ' : ''}${message}`);
    return true;
  }

  const payload = { topic: config.ntfy.topic, message };
  if (titre) payload.title = titre;
  if (tags) payload.tags = tags;
  if (priorite) payload.priority = priorite;

  try {
    const res = await fetch(config.ntfy.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`ntfy : HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`ntfy injoignable : ${e.message}`);
    return false;
  }
}

const messages = {
  coupEnvoi: (m) =>
    notifier(`${m.home} vs ${m.away}`, {
      titre: 'Ça commence !',
      tags: ['handball'],
      priorite: 4,
    }),

  but: (m, equipe) =>
    notifier(`${equipe} — ${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}`, {
      titre: 'BUT !',
      tags: ['zap'],
      priorite: 4,
    }),

  fin: (m) =>
    notifier(`${m.home} ${m.homeScore} - ${m.awayScore} ${m.away}`, {
      titre: 'Terminé',
      tags: ['checkered_flag'],
      priorite: 3,
    }),
};

module.exports = { notifier, messages };

if (require.main === module && process.argv.includes('--test')) {
  notifier('Test depuis hand-d1-alerte. Si tu lis ça, le topic fonctionne.', {
    titre: 'Test',
    tags: ['white_check_mark'],
  }).then((ok) => {
    console.log(ok ? `Envoyé sur ${config.ntfy.server}/${config.ntfy.topic}` : 'Échec');
    process.exit(ok ? 0 : 1);
  });
}
