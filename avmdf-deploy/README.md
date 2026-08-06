# AVMDF - Mise en production

Outil de bureau qui compare les sources locales et le site de production IIS, archive la version
écrasée dans `AvMdf\AVMDF<ticket>\<sprint>` avant toute copie, et permet de revenir en arrière.

Windows, Electron, sans étape de build : le code livré est le code exécuté.

---

## Installation

```
cd avmdf-deploy
npm install
```

`npm install` récupère Electron (développement) ainsi que `diff` et `iconv-lite`, utilisés par la
comparaison ligne à ligne. Aucun autre paquet n'est nécessaire.

## Lancement

```
npm start        # l'application
npm run dev      # idem, avec les outils de développement ouverts
```

## Compilation d'un exécutable portable

```
npm run build
```

Produit `dist\AVMDF-MiseEnProd-<version>.exe` : un fichier unique, sans installeur ni droits
administrateur. À lancer depuis n'importe quel poste ayant accès à `Z:\`.

---

## Organisation du code

```
electron/
  main.js       fenêtre et handlers IPC - aucune logique métier
  preload.js    pont contextBridge ; le renderer n'a aucun accès direct au disque
  core/         logique métier en modules Node purs (aucun require('electron'))
    config.js   réglages : défauts, normalisation, contrôle de cohérence, écriture atomique
    fsindex.js  parcours récursif, empreintes SHA-256, cache, concurrence bornée
    compare.js  appariement des deux arbres, statuts, compteurs agrégés
    search.js   recherche et filtrage, occurrences dans le contenu
    textdiff.js encodage (BOM → UTF-8 strict → Windows-1252) et diff ligne à ligne
    avmdf.js    tickets, conventions de sprint, résolution de destination
    deploy.js   préflight, archivage, copie, manifeste, récapitulatif, retour arrière
    journal.js  journal quotidien en texte
renderer/
  index.html    page unique
  styles.css    thème sombre, jeu de couleurs des statuts et du diff
  app.js        montage racine et état global
  components/   un fichier par composant (arbre, diff, filtres, destination,
                confirmation, rapport, historique, journal, réglages…)
  vendor/       Preact, hooks et htm en ESM, copiés localement
```

Les modules de `core/` sont utilisables en ligne de commande :

```
node -e "const c=require('./electron/core/config'); console.log(c.reglagesParDefaut())"
```

### Front

Preact + htm chargés en modules ESM depuis `renderer/vendor/`. Pas de CDN, pas de bundler, pas de
JSX : les composants s'écrivent avec des gabarits `html\`…\``.

```js
import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
const html = htm.bind(h);
```

Les fichiers de `vendor/` proviennent des paquets npm `preact@10` et `htm@3`. Deux retouches, à
reproduire en cas de mise à jour :

- l'import nu `from "preact"` de `hooks.module.js` est remplacé par `from "./preact.module.js"` ;
- les commentaires `sourceMappingURL` sont retirés (les fichiers `.map` ne sont pas embarqués).

## Réglages

Enregistrés dans `%APPDATA%\avmdf-deploy\config.json`, modifiables entièrement depuis l'écran
Réglages. La version précédente est conservée sous `config.precedent.json`. Un fichier illisible
n'empêche pas le démarrage : il est mis de côté sous `config.json.corrompu-<horodatage>` et les
valeurs par défaut sont rechargées.

`web.config` est exclu par défaut : sa chaîne de connexion et ses réglages diffèrent entre
développement et production. S'il est retiré de la liste d'exclusion, l'interface le signale en
rouge et chaque mise en production qui le concerne affichera un avertissement.

## Format du manifeste

Chaque déploiement réel écrit dans le dossier de sprint un `_deploiement_<horodatage>.json`
(horodatage à la milliseconde, pour que deux passages rapprochés ne se marchent pas dessus) :

```json
{
  "ticket": "AVMDF4611",
  "sprint": "AVMDF4611_3",
  "auteur": "guerrin-f",
  "date": "2026-08-06T14:52:10.000Z",
  "projet": "GPNet",
  "racineLocale": "E:\\F Guerrin\\Process\\GPNET",
  "racineProd": "Z:\\GPNet",
  "dossierSauvegarde": "Z:\\AvMdf\\AVMDF4611\\AVMDF4611_3",
  "simulation": false,
  "fichiers": [
    {
      "chemin": "Principal\\Recherche.aspx",
      "action": "remplacement",
      "sauvegarde": "Principal\\Recherche.aspx",
      "hashAvant": "3f2a…",
      "tailleAvant": 18422,
      "hashApres": "9c81…",
      "tailleApres": 18901,
      "lignesAjoutees": 18,
      "lignesSupprimees": 7,
      "erreur": null
    }
  ]
}
```

Champs propres à l'outil : `operation` vaut `deploiement`, `suppression` ou `restauration` ;
`archiveNonRemplace` signale un fichier archivé dont la copie a échoué ; `sauvegardeConservee`
signale une archive héritée d'un passage précédent dans le même sprint.

C'est ce fichier que relit l'écran Historique pour proposer le retour arrière. Un
`_recapitulatif.md` lisible est complété dans le même dossier à chaque passage : c'est lui qu'on
transmet pour la traçabilité.

---

## Identité

L'interface reprend le logo Saarstahl Rail et ses deux couleurs, relevées au pixel dans le
fichier fourni :

| Rôle | Couleur |
|---|---|
| Vert de marque : logo, actions de production, ajouts, fichiers nouveaux | `#ABD083` |
| Gris de marque : texte secondaire, statut « modifié » | `#8597A5` |
| Fond, panneaux, séparateurs | `#16191C`, `#1D2126`, `#2E343B` |

Tout le reste est construit sur ces deux teintes. Une seule entorse, assumée : un rouge sourd
`#D08B80` pour ce qui casse ou détruit (suppressions dans la comparaison, fichiers orphelins,
échecs, boutons destructeurs). Les avertissements, eux, restent dans le gris de marque. Dites-le
si vous voulez que le rouge disparaisse aussi : la bascule tient dans une variable CSS.

Déclinaisons produites depuis `logo-Saarstahl-Rail.jpg`, fond blanc rendu transparent :

| Fichier | Usage |
|---|---|
| `renderer/assets/marque.png` | symbole seul, en-tête de l'application |
| `renderer/assets/logo.png` | logo complet, écran de démarrage |
| `build/icon.ico` et `build/icon.png` | icône de l'exécutable et de la fenêtre |

Aucun tiret cadratin dans l'application : ni dans l'interface, ni dans les messages, ni dans le
code.

## Versions archivées d'un fichier

Chaque dossier de sprint contient la version « avant modification » des fichiers touchés. L'outil
sait les retrouver : sur un fichier, `Versions archivées` (bouton de la comparaison ou clic droit
dans l'arborescence) liste **toutes** ses versions, tous tickets et tous sprints confondus, avec
leur date, leur auteur et l'action d'origine, lus dans les manifestes présents sur place.

Chaque version se compare à la version actuellement en production, et se remet en place en un
geste. La remise en production archive d'abord la version actuelle dans le sprint choisi, puis
écrit son propre manifeste de restauration : revenir à une version ancienne ne fait jamais perdre
l'état courant, et l'opération est elle-même réversible depuis l'écran Historique.

## Décisions prises

Deux points laissés ouverts par la spécification ont été tranchés ainsi. Ils se changent sans
difficulté si vous préférez l'inverse.

**Fichiers orphelins.** Présents en production seulement, ils ne partent jamais avec une mise en
production : c'est une opération distincte. On les coche seuls, le bouton du bandeau devient
« Supprimer en production », la version supprimée est archivée dans le sprint **avant** d'être
retirée, et l'opération produit son propre manifeste - donc elle est réversible comme les autres.
Cocher un dossier ne mélange jamais les deux natures.

**Pools IIS.** L'outil ne pilote pas le serveur. S'il détecte un fichier verrouillé, il bloque
avant la première écriture et dit quoi faire : recycler le pool ou déposer un `app_offline.htm`.
Le dépôt automatique de `app_offline.htm` reste disponible en option dans les réglages, désactivé
par défaut.

## Ce que l'outil ne fait jamais

- déployer sans avoir archivé la version écrasée ;
- écraser une archive déjà présente dans un sprint - la version « avant modification » d'origine
  gagne toujours, un second passage la conserve ;
- ré-encoder, reformater ou normaliser les fins de ligne : la copie est binaire, octet pour octet ;
- écrire hors des racines configurées : chaque destination est résolue en absolu et vérifiée ;
- conclure à l'égalité sur la date ou la taille seules ;
- interrompre un scan parce qu'un dossier est inaccessible.

## Raccourcis

| Touche | Action |
|---|---|
| `F5` | Analyser |
| `F8` / `Maj+F8` | Changement suivant / précédent dans la comparaison |
| `Ctrl+F` | Chercher dans la comparaison affichée |
| `Ctrl+Entrée` | Mettre en production |
| `Échap` | Fermer l'écran ouvert |
| `↑` `↓` `←` `→` `Espace` `Entrée` | Naviguer, plier, cocher, ouvrir dans l'arborescence |

## Fichiers produits dans `%APPDATA%\avmdf-deploy`

| Fichier | Rôle |
|---|---|
| `config.json` | réglages ; `config.precedent.json` garde la version d'avant |
| `cache-hash.json` | empreintes connues, indexées sur chemin + taille + date |
| `logs\journal-AAAA-MM-JJ.log` | une ligne par événement horodaté |
