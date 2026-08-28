# hand-d1-alerte

Notification push sur téléphone au coup d'envoi de chaque match de **Daikin StarLigue**
(D1 masculine française), puis **à chaque but**.

Projet perso, zéro euro, zéro dépendance npm. Source des données : scraping de lnh.fr.

---

## ⚠️ À lire avant de partager le topic

Les notifications passent par [ntfy.sh](https://ntfy.sh), gratuit et sans compte.
Contrepartie : sur l'instance publique, **toute personne connaissant le nom exact du
topic peut s'y abonner *et* y publier**. Il n'y a ni mot de passe ni liste d'accès.

**Le nom du topic est le seul secret.** C'est pourquoi il est aléatoire
(`handball-live-` + 14 caractères tirés au sort) et non un nom devinable comme
`hand-alertes`, qui serait trouvé en quelques minutes par n'importe qui.

Sur GitHub il est stocké comme **secret Actions** (`NTFY_TOPIC`), jamais dans le
code — le dépôt est public.

Concrètement :

- ne pas le publier sur un forum, un réseau social, un dépôt public ;
- le transmettre à la famille en direct (SMS, messagerie) ;
- le fichier `.ntfy-topic` est **gitignoré** — ne jamais le committer ;
- si le topic fuite : en générer un nouveau, chacun se réabonne. Aucune autre
  conséquence, il n'y a aucune donnée personnelle dessus.

Le risque réel se limite à : quelqu'un lit les scores en même temps que vous, ou vous
envoie des notifications parasites. Pour un usage familial, c'est acceptable.

## Installation

Aucune dépendance à installer. Node 18+ suffit (`fetch` natif).

**1. Le topic** — déjà généré dans `.ntfy-topic`. Pour en créer un autre :

```bash
node -e "console.log('handball-live-'+require('crypto').randomBytes(12).toString('base64url').replace(/[-_]/g,'').slice(0,14).toLowerCase())" > .ntfy-topic
```

**2. Chaque téléphone** — installer l'appli **ntfy** (iOS / Android), puis
« Subscribe to topic » et saisir le nom exact du topic. Aucune inscription.

**3. Vérifier** :

```bash
npm run test-notif      # doit faire sonner tous les téléphones abonnés
```

## Utilisation

```bash
npm start        # lance la surveillance en continu
npm run check    # un seul relevé, puis sortie (utile pour un cron)
npm test         # 17 scénarios de match rejoués hors ligne
```

Ajouter `--dry-run` pour afficher les notifications au lieu de les envoyer :

```bash
node src/watch.js --once --dry-run
```

## Fonctionnement

Un seul processus, deux régimes :

| Régime | Cadence | Rôle |
|---|---|---|
| Veille | 10 min | Y a-t-il un match StarLigue en cours ou dans moins de 10 min ? |
| Direct | 30 s | Comparer le score au relevé précédent, notifier chaque but |

Le passage de l'un à l'autre est automatique. La page live de la LNH se rafraîchit
d'elle-même **toutes les 11 secondes** : à 30 s on reste bien en dessous de ce que le
site encaisse déjà.

### La source

lnh.fr n'est pas une API. C'est un site PHP/jQuery dont les pages arrivent vides et se
remplissent via des appels AJAX renvoyant des **fragments HTML**. On rejoue ces appels.

Tout passe par `POST https://www.lnh.fr/ajaxpost1`, routé par `contents_controller` +
`contents_action`. Le filtre `univers=d1-26623` restreint au périmètre voulu : la
StarLigue seule, sans ProLigue ni D1 féminine.

Le détail complet des endpoints, avec les payloads réels, est dans
[recon/PHASE0-RECON.md](recon/PHASE0-RECON.md).

### Le coup d'envoi

Notifié **à l'horloge**, à partir de l'heure de coup d'envoi lue dans le
calendrier — pas à l'apparition d'un score. C'est délibéré : si lnh.fr laissait
« vs » pendant tout le match, attendre un score chiffré ne notifierait jamais le
début, alors que l'heure est connue d'avance. Un score qui apparaît plus tôt sert
de déclencheur de secours.

Conséquence utile : **même si la source reste muette pendant 60 minutes, le début
et la fin arrivent quand même.** Seuls les buts seraient perdus.

### Détection des buts

Le score est lu dans `.scores` (`"27 - 25"`). À chaque relevé on compare au précédent :

- une équipe a marqué → une notification ;
- plusieurs buts entre deux relevés → **une notification par but**, pas un résumé
  groupé, conformément à « une alerte par but » ;
- le suivi démarre 10 min avant le coup d'envoi, donc le score de départ est connu
  (0-0) et le premier but n'est jamais perdu ;
- si le processus démarre alors qu'un match est déjà à 12-10, le score est enregistré
  en silence — pas de rafale de 22 notifications ;
- **garde-fou** : le départ à 0-0 n'est supposé que sur un match effectivement en
  cours. Si la source ne publiait le score qu'au coup de sifflet final, en déduire
  les buts enverrait ~58 notifications d'un coup ;
- **garde-fou** : au-delà de 8 buts entre deux relevés, on considère que la source
  a sauté, pas qu'il y a eu 20 buts en 30 secondes. Le bond est journalisé, pas
  notifié.

La classe CSS utilisée par la LNH **pendant** un match est encore inconnue (voir plus
bas). La détection ne s'y fie donc pas : est « en cours » tout match dont le score est
chiffré sans porter la classe `finish`. Un scénario de test vérifie que la logique
tient quel que soit le nom de cette classe.

## État d'avancement

| Phase | État |
|---|---|
| 0 — Reconnaissance | Faite, sauf le payload d'un match en direct |
| 1 — Squelette | Fait |
| 2 — Détection des matchs | Fait |
| 3 — Polling et buts | Fait, validé sur 17 scénarios hors ligne |
| 4 — ntfy | Fait, envoi réel vérifié |
| 5 — Hébergement | GitHub Actions, portier + `concurrency` vérifiés |
| 6 — Test réel | Capture **et** watcher réel sur le Trophée des Champions, 29/08/2026 |

### Ce qui reste ouvert

**Le comportement en direct n'a jamais été observé.** La saison n'a pas commencé, il
n'y avait aucun match en France au moment du développement. Trois inconnues :

1. la classe CSS d'un match en cours dans le calendrier ;
2. le score du calendrier bouge-t-il vraiment en direct, ou seulement à la fin ?
   **Si le score n'est pas rafraîchi en direct, tout l'édifice tombe** et il faudra
   basculer sur l'endpoint `eStatsChannels` (aujourd'hui en erreur 500 hors saison) ;
3. la latence réelle entre le but et sa publication sur lnh.fr.

Le workflow [`capture-live.yml`](.github/workflows/capture-live.yml) répond à ces
trois questions. Il tourne le **samedi 29 août 2026**, un job par match du Trophée
des Champions : 16h35 pour Aix – Toyoda Gosei (17h00), 19h35 pour la finale
Paris – Montpellier (20h00). Les réponses brutes partent en artefact.

Le job de la finale court jusqu'à 01h30 : une finale ne peut pas finir sur un nul,
et le pire cas réglementaire — temps plein, deux prolongations de 2×5 min avec
leurs pauses, puis tirs au but — repousse la fin vers 22h25.

En parallèle, [`test-tdc.yml`](.github/workflows/test-tdc.yml) fait tourner le
**vrai watcher** sur ces deux matchs, avec de vraies notifications : c'est le seul
match avant la première journée du 4 septembre. Le périmètre est élargi au Trophée
des Champions par variables d'environnement, sans toucher au code.

**L'hébergement est tranché : GitHub Actions**, via
[`suivi-live.yml`](.github/workflows/suivi-live.yml). Le cron ne sert qu'à
*allumer* le job, avec sa granularité approximative ; c'est le job lui-même, qui
peut durer 6 heures, qui boucle ensuite toutes les 30 secondes. L'imprécision du
cron décale l'allumage, pas la détection des buts. Sur un dépôt public les minutes
sont illimitées.

### Le portier

Le cron ne vise pas l'heure du coup d'envoi. Il ne peut pas : il est figé en UTC,
donc faux six mois par an, et les coups d'envoi varient déjà d'un jour à l'autre.
Il frappe donc **toutes les 30 minutes, vendredi/samedi/dimanche de 13h à 21h
UTC** — une fenêtre qui couvre tous les coups d'envoi en heure d'été comme en
heure d'hiver — et c'est le script qui décide, à partir de l'heure de Paris :

- **aucun match dans les 90 minutes** → le job ressort en une dizaine de
  secondes. C'est le cas de l'écrasante majorité des déclenchements ;
- **un match approche ou tourne** → il reste, et bascule à 30 s au coup d'envoi.

Il ne décroche pas dans le creux entre deux matchs d'une même soirée : il ne sort
que si rien ne tourne **et** que rien n'approche.

Un groupe `concurrency` partagé empêche deux watchers de tourner en parallèle —
sans quoi chaque but serait notifié deux fois, l'état du score vivant dans le job
et non entre les jobs. Vérifié en conditions réelles : un second run créé pendant
qu'un premier tourne reste en attente et ne démarre qu'après sa fin.

Conséquence : **rien à retoucher au passage à l'heure d'hiver**, ni quand la LNH
déplace un match.

### Fenêtres de match réelles (saison 2026-27)

Vendredi 20h00 et 20h30, samedi 19h00 et 20h00, **dimanche 17h00**. Les dimanches
sont bien utilisés — une planification limitée au vendredi/samedi raterait des matchs.

## Heure d'été / heure d'hiver

La StarLigue joue de septembre à juin : chaque saison traverse **les deux
changements d'heure** (dernier dimanche d'octobre, dernier dimanche de mars).
Trois endroits sont concernés, et ils ne se règlent pas de la même façon.

**Les horaires lus sur lnh.fr** — réglé. `parseCoupEnvoi()` interprète
explicitement « 20h00 » dans le fuseau `Europe/Paris` via la base ICU, jamais
dans celui du processus. Sans ça le même code donnerait 20h00 sur un PC français
et 22h00 sur un runner GitHub, qui tourne en UTC — deux heures d'erreur sur la
détection des matchs. Les tests vérifient quatre dates réparties sur la saison,
et la suite passe aussi bien sous `TZ=Europe/Paris` que sous `TZ=UTC`.

**L'horodatage des logs** — réglé. Les workflows posent `TZ: Europe/Paris`.
C'est un *nom de zone*, pas un décalage fixe : la bascule CEST → CET est
appliquée toute seule. Le job affiche `CEST` en août, il affichera `CET` en
novembre.

**Le déclenchement des crons** — réglé, par le portier (voir ci-dessous). Les
crons GitHub sont figés en UTC et ne suivent aucun fuseau : `35 17 * * 5` vaut
19h35 à Paris l'été mais 18h35 l'hiver. Plutôt que de chercher une valeur juste
— il n'y en a pas — on a cessé de demander de la précision au cron.

## Fragilité assumée

C'est du scraping. Si la LNH change la structure de son site — ce qui vient d'arriver
avec le rebranding Daikin — le script cesse de fonctionner et il faut refaire la
reconnaissance (`recon/PHASE0-RECON.md` décrit la méthode). C'est le prix du gratuit.

Signes d'alerte : plus aucune notification un soir de match, ou `npm run check` qui
renvoie « erreur LNH » ou zéro match.
