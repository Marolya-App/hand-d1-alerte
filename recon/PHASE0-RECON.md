# Phase 0 — Reconnaissance technique lnh.fr

Date : 28/08/2026. Aucun match en cours au moment de la recherche (intersaison).

## Résultat principal : ce n'est pas du JSON, c'est du HTML

L'hypothèse du brief (« trouver l'endpoint JSON interne ») est **fausse**. lnh.fr n'est
pas une SPA moderne : c'est un site PHP/jQuery classique. Le contenu est rendu **côté
serveur** et injecté dans la page par des appels AJAX qui renvoient des **fragments
HTML**, pas du JSON.

C'est une bonne nouvelle : pas de token, pas d'auth, pas d'API privée. Un simple
`fetch` + regex suffit. C'est aussi le point faible : le parsing dépend des classes CSS.

## L'endpoint unique : `POST https://www.lnh.fr/ajaxpost1`

Tout passe par un dispatcher unique. Il route via deux paramètres POST obligatoires
(`contents_controller` + `contents_action`) ; sans les deux il répond `Manque paramètres`.

- Base URL confirmée par `<base href="https://www.lnh.fr/">` dans le HTML.
- Pas de cookie ni de header obligatoire (`PHPSESSID` est posé mais non requis).
- Content-Type : `application/x-www-form-urlencoded`.

### A. Calendrier + scores — `sportsCalendars` / `index_ajax` — VALIDÉ

```
POST https://www.lnh.fr/ajaxpost1
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

seasons_id=40&days_id=all&teams_id=all&univers=d1-26623&key=701113370
&current_month=09&type=all&type_id=all
&contents_controller=sportsCalendars&contents_action=index_ajax
&cache=yes&cacheKeys=univers,contents_controller,contents_action,type,seasons_id,days_id,teams_id,current_month
```

Paramètres utiles :

| Param | Valeur | Effet |
|---|---|---|
| `univers` | `d1-26623` | **Daikin StarLigue uniquement** (le filtrage périmètre est gratuit) |
| `univers` | `matchs-6892` | toutes compétitions (StarLigue + ProLigue + Coupe + Warm Up…) |
| `seasons_id` | `40` | saison 2026/2027 (39 = 2025/26) |
| `current_month` | `09`, `10`… ou `all` | réduit fortement la charge |

Volumétrie mesurée : `d1-26623` + `current_month=all` → 340 Ko / 240 matchs.
`current_month=09` → **45 Ko / 32 matchs**. C'est cette variante qu'il faut poller.

### B. Détecteur de live bon marché — `POST https://www.lnh.fr/ajaxheader` — VALIDÉ

Seul endpoint qui renvoie du **vrai JSON**. Réponse réelle capturée aujourd'hui :

```json
{
  "favorite": "<a class=\"head-icons-bt favoris\" href=\"https://www.lnh.fr/centre-preferences\" aria-label=\"Mon club favori\"></a>",
  "desktop_account": "<a class=\"head-mylnh-bt\" id=\"open_box_connect\">…</a>",
  "mobile_account": "<a class=\"head-mobile-bt\" id=\"open_box_connect\">…</a>",
  "live_shortcut": ""
}
```

`live_shortcut` est **vide hors match** et contient un lien vers le live quand un match
tourne (c'est ce qui affiche le bandeau rouge « live » du header). 467 octets, sans
paramètre : c'est le candidat idéal pour la veille Phase 2, bien plus léger que le
calendrier. **Reste à confirmer son contenu exact pendant un match.**

### C. Liste des lives — `eStatsChannels` / `index_ajax` — NON VALIDÉ

C'est ce qu'appelle `/matchs/lives` (via `apps.cronRefreshLivesIndexLarge()` dans
`https://www.lnh.fr/scripts/apps.js`, rafraîchi **toutes les 11 secondes** par la page
elle-même — donc un polling à 30-60s est très conservateur).

```
contents_controller=eStatsChannels&contents_action=index_ajax&univers=matchs-6892&competitions_id=
```

→ **HTTP 500, 0 octet**, quelle que soit la variante testée (avec/sans cookie, multipart,
`no_render`, `lives_state`, `cache`…).

Hypothèse : le contrôleur plante sur une liste vide, il n'y a aucun live sur toute la
France en intersaison. Deux éléments l'appuient :

- `contents_action=index` (la page enveloppe) répond 200 normalement ;
- `contents_action=view_ajax` répond 500 mais **après avoir émis 535 octets** du gabarit
  de la vue live (avec le compteur « Prochain rechargement / 10 seconde(s) ») — le
  template existe, il meurt sur des données absentes.

Non prouvé. À trancher pendant un vrai match.

### D. Vue d'un live — `POST https://www.lnh.fr/ajaxlive`

Appelé par `apps.cronRefreshLivesViewLarge()` toutes les 11 s avec `#live-form` sérialisé.
Répond `400` à vide. Le formulaire `#live-form` n'existe que sur la page d'un match en
cours — impossible à inspecter aujourd'hui.

### E. Stats d'un match — `sportsCalendars` / `view_tab_stats` — VALIDÉ

Clé : `calendars_id`. Renvoie 65 Ko de stats détaillées (buts/tirs, etc.) pour un match
donné. Utile plus tard si on veut savoir *qui* a marqué, pas seulement le score.

## Fixture « match à venir » (réel, capturé aujourd'hui)

Fragment HTML retourné par l'endpoint A, un match :

```html
<div class="calendars-listing-item listing-item waiting  lmsl" id="12004">
  <div class="row"><div class="col-infos"><div class="col-competitions">
    <span class="competition">Daikin StarLigue - J01</span><br>ven. 04 sept. 20h00
  </div></div></div>
  <div class="row"><div class="col-teams"><div class="teams-logos">
    <div class="team-logo">
      <a href="https://www.lnh.fr/daikin-starligue/equipes/chambery-savoie-mt-blanc-handball" title="Chambéry">…</a>
      <div class="team-name">Chambéry</div>
    </div>
    <div class="scores is-coming">vs</div>
    <div class="team-logo">
      <a href="https://www.lnh.fr/daikin-starligue/equipes/paris-saint-germain-handball" title="Paris">…</a>
      <div class="team-name">Paris</div>
    </div>
  </div></div></div>
</div>
```

Fixture « match terminé » (saison 39) — même structure, deux classes changent :

```html
<div class="calendars-listing-item listing-item finish  lmsl" id="10998">
  … <span class="competition">Daikin StarLigue - J01</span><br>ven. 05 sept. 20h00 …
  <div class="team-name">Chambéry</div>
  <div class="scores is-finish">34 - 34</div>
  <div class="team-name">Nantes</div>
</div>
```

Ce qu'on sait donc extraire de façon fiable :

| Donnée | Où |
|---|---|
| id du match | `id="12004"` sur `.calendars-listing-item` |
| statut | 2e classe : `waiting` / `finish` / **`?` (live inconnu)** |
| compétition + journée | `.competition` |
| date/heure | texte après le `<br>` |
| équipes | les deux `.team-name` |
| score | `.scores` — `is-coming` → « vs », `is-finish` → « 34 - 34 » |

**Le trou : la classe de statut et le format du score pendant un match en cours.**

## Données de config déjà récupérées

16 clubs Daikin StarLigue 2026-27 : Aix, Caen, Cesson-Rennes, Chambéry, Chartres,
Dunkerque, Limoges, Montpellier, Nantes, Nîmes, Paris, Saint-Raphaël, Saran, Sélestat,
Toulouse, Tremblay.

J01 : ven. 04/09 20h00 (Limoges–Saint-Raphaël, Chambéry–Paris, Montpellier–Chartres),
20h30 Cesson-Rennes–Nîmes, sam. 05/09 19h00 Tremblay–Nantes, 20h00 Aix–Sélestat et
Saran–Toulouse, dim. 06/09 17h00 Caen–Dunkerque.

Le rythme réel de la saison est donc **vendredi 20h/20h30, samedi 19h/20h, dimanche
17h** — un peu plus large que la fenêtre supposée dans le brief.

## Ce qui bloque, et comment le débloquer

Impossible de capturer un match en cours aujourd'hui : il n'y en a aucun.

**Fenêtre de tir : samedi 29 août 2026, 20h00 — Trophée des Champions, Paris vs
Montpellier** (id `11740`). Il y a aussi un match à 17h00 (Aix vs Toyoda Gosei, id
`11741`).

Lancer pendant le match :

```
node hand-d1-alerte/recon/capture-live.js
```

Le script interroge toutes les 20 s les endpoints A, B et C, écrit les réponses brutes
horodatées dans `recon/captures/`, et affiche en direct le statut et le score détectés.
Il répond aux trois questions ouvertes : (1) `eStatsChannels/index_ajax` sort-il du 200
pendant un match, (2) que contient `live_shortcut`, (3) le score bouge-t-il en direct
dans le calendrier — auquel cas l'endpoint A suffit à tout faire.
