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
(`nicolas-hand-d1-` + 16 caractères tirés au sort) et non un nom devinable comme
`hand-alertes`, qui serait trouvé en quelques minutes par n'importe qui.

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
node -e "console.log('nicolas-hand-d1-'+require('crypto').randomBytes(12).toString('base64url').replace(/[-_]/g,'').slice(0,16).toLowerCase())" > .ntfy-topic
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
npm test         # 9 scénarios de match rejoués hors ligne
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

### Détection des buts

Le score est lu dans `.scores` (`"27 - 25"`). À chaque relevé on compare au précédent :

- une équipe a marqué → une notification ;
- plusieurs buts entre deux relevés → **une notification par but**, pas un résumé
  groupé, conformément à « une alerte par but » ;
- le suivi démarre 10 min avant le coup d'envoi, donc le score de départ est connu
  (0-0) et le premier but n'est jamais perdu ;
- si le processus démarre alors qu'un match est déjà à 12-10, le score est enregistré
  en silence — pas de rafale de 22 notifications.

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
| 3 — Polling et buts | Fait, validé sur 9 scénarios hors ligne |
| 4 — ntfy | Fait, envoi réel vérifié |
| 5 — Hébergement | **Non tranché** |
| 6 — Test réel | Prévu |

### Ce qui reste ouvert

**Le comportement en direct n'a jamais été observé.** La saison n'a pas commencé, il
n'y avait aucun match en France au moment du développement. Trois inconnues :

1. la classe CSS d'un match en cours dans le calendrier ;
2. le score du calendrier bouge-t-il vraiment en direct, ou seulement à la fin ?
   **Si le score n'est pas rafraîchi en direct, tout l'édifice tombe** et il faudra
   basculer sur l'endpoint `eStatsChannels` (aujourd'hui en erreur 500 hors saison) ;
3. la latence réelle entre le but et sa publication sur lnh.fr.

Une capture automatique est programmée sur ce PC (tâche Windows
`HandD1-CaptureLive-TDC`) pour le **samedi 29 août 2026 à 19h55**, pendant
Paris – Montpellier (Trophée des Champions). Elle enregistre les réponses brutes dans
`recon/captures/` et répond aux trois questions.

**L'hébergement n'est pas décidé** — à trancher après cette capture, car le choix
dépend de la réponse à la question 2 :

- si le calendrier suffit, un cron toutes les 30 s pendant les fenêtres de match
  convient, et GitHub Actions (granularité ~5 min) reste trop lent pour le direct ;
- un petit process continu (VM gratuite, ou ce PC allumé les soirs de match) reste
  l'option la plus simple et la plus fiable.

### Fenêtres de match réelles (saison 2026-27)

Vendredi 20h00 et 20h30, samedi 19h00 et 20h00, **dimanche 17h00**. Les dimanches
sont bien utilisés — une planification limitée au vendredi/samedi raterait des matchs.

## Fragilité assumée

C'est du scraping. Si la LNH change la structure de son site — ce qui vient d'arriver
avec le rebranding Daikin — le script cesse de fonctionner et il faut refaire la
reconnaissance (`recon/PHASE0-RECON.md` décrit la méthode). C'est le prix du gratuit.

Signes d'alerte : plus aucune notification un soir de match, ou `npm run check` qui
renvoie « erreur LNH » ou zéro match.
