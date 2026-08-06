# AVMDF — Mise en production

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
  main.js       fenêtre et handlers IPC — aucune logique métier
  preload.js    pont contextBridge ; le renderer n'a aucun accès direct au disque
  core/         logique métier en modules Node purs (aucun require('electron'))
    config.js   réglages : valeurs par défaut, contrôle de cohérence, lecture/écriture
renderer/
  index.html    page unique
  styles.css    thème sombre, jeu de couleurs des statuts et du diff
  app.js        montage racine et état global
  components/   un fichier par composant
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

À venir avec l'étape 6. Chaque déploiement réel écrira dans le dossier de sprint un fichier
`_deploiement_<horodatage>.json` :

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

C'est ce fichier que relit l'écran Historique pour proposer le retour arrière. Un
`_recapitulatif.md` lisible est écrit dans le même dossier pour la traçabilité.

---

## Avancement

| # | Étape | État |
|---|-------|------|
| 1 | Squelette : fenêtre, preload, `config.js`, écran Réglages | **fait** |
| 2 | Scan et comparaison : `fsindex.js`, `compare.js`, arbre et statuts | à faire |
| 3 | Recherche et filtres : `search.js` | à faire |
| 4 | Diff : `textdiff.js`, vue côte à côte, encodage | à faire |
| 5 | AVMDF : `avmdf.js`, tickets, conventions de sprint | à faire |
| 6 | Déploiement : `deploy.js`, préflight, simulation, manifeste | à faire |
| 7 | Historique et retour arrière | à faire |
| 8 | Journal, packaging, documentation | à faire |

Les emplacements encore vides portent une pastille « Étape N » dans l'interface (classe CSS
`note-chantier`) : elles disparaissent au fur et à mesure.
