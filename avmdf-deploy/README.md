# AVMDF - Mise en production

Outil de bureau qui compare les sources locales et le site de production IIS, archive la version
écrasée dans `AvMdf\AVMDF<numéro>\<sprint>` avant toute copie, et permet de revenir en arrière.
Le numéro est celui de la demande de travaux informatique (par exemple AVMDF4789).

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

L'application embarque **Electron 22** (Chromium 108), dernière lignée compatible avec
**Windows Server 2012 R2**, où tourne le serveur de développement. Ne pas monter la version
d'Electron sans vérifier que ce serveur a été mis à niveau : Electron 23 et suivants exigent
Windows 10 / Server 2016. Conséquence dans le code : pas de fonctionnalités CSS ou JS
postérieures à Chromium 108 (par exemple `color-mix`, remplacé par des valeurs `rgba` calculées
depuis la palette).

L'exécutable portable s'auto-extrait dans `%TEMP%` au lancement. Sur les serveurs où l'exécution
depuis `%TEMP%` est bloquée (stratégie de groupe, antivirus), utiliser la variante
`AVMDF-MiseEnProd-<version>-dossier.zip` de la release : décompresser le dossier où l'on veut et
lancer `AVMDF Mise en production.exe` sur place.

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
    avmdf.js    demandes, conventions de sprint, résolution de destination
    deploy.js   préflight, archivage, copie, manifeste, récapitulatif, retour arrière
    journal.js  journal quotidien en texte
renderer/
  index.html    page unique
  styles.css    thème sombre, jeu de couleurs des statuts et du diff
  app.js        montage racine et état global
  components/   un fichier par composant (arbre, diff, filtres, destination,
                confirmation, rapport, historique, journal, réglages…)
  vendor/       Preact, hooks, htm et Prism en ESM, copiés localement
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

`vendor/prism.js` vient du paquet npm `prismjs@1` : concaténation du cœur et des grammaires
markup, css, clike, javascript, csharp, aspnet, sql, basic, vbnet et json, précédée de
`self.Prism = { manual: true, … }` et suivie de `export default Prism;`. Seul `Prism.tokenize`
est utilisé : jamais de HTML généré par Prism, jamais de retouche automatique du DOM.

## Réglages

Enregistrés dans `%APPDATA%\avmdf-deploy\config.json`, modifiables entièrement depuis l'écran
Réglages. La version précédente est conservée sous `config.precedent.json`. Un fichier illisible
n'empêche pas le démarrage : il est mis de côté sous `config.json.corrompu-<horodatage>` et les
valeurs par défaut sont rechargées.

`web.config` est exclu par défaut : sa chaîne de connexion et ses réglages diffèrent entre
développement et production. S'il est retiré de la liste d'exclusion, l'interface le signale en
rouge et chaque mise en production qui le concerne affichera un avertissement.

L'outil compare du code, pas les métadonnées d'atelier. Les exclusions par défaut couvrent donc
aussi, depuis la version 2 des réglages : `$tf` et `My Project` (dossiers), `*.vspscc`, `*.vssscc`,
`*.sln`, `*.vbproj`, `*.csproj`, `*.pubxml`, `*.licx`, `*.cd`, `*.manifest`, `packages.config`,
`libman.json`, `Web.Debug.config` et `Web.Release.config` (fichiers). Une configuration enregistrée
en version 1 reçoit ces motifs à son premier chargement, par union : les motifs ajoutés à la main
sont conservés, et les motifs par défaut retirés volontairement ne reviennent pas.

La version 3 des réglages ajoute le code-behind VB : `*.aspx.vb`, `*.aspx.designer.vb` et
`*.asax.vb`. Dans une application web compilée, ces fichiers ne partent jamais sur le serveur,
c'est la DLL de `bin` qui les remplace : ils existent en local et pas en production, et c'est
normal. Sans exclusion, chaque analyse les remonterait en « nouveaux » alors qu'il n'y a rien à
déployer. Même mécanisme de migration par union. Les code-behind d'autres types de pages
(`*.ascx.vb`, `*.master.vb`…) ne sont pas exclus par défaut : à ajouter à la main si le besoin se
présente.

## Format du manifeste

Chaque déploiement réel écrit dans le dossier de sprint un `_deploiement_<horodatage>.json`
(horodatage à la milliseconde, pour que deux passages rapprochés ne se marchent pas dessus) :

```json
{
  "demande": "AVMDF4611",
  "sprint": "AVMDF4611_3",
  "auteur": "guerrin-f",
  "date": "2026-08-06T14:52:10.000Z",
  "projet": "GPNet",
  "racineLocale": "E:\\F Guerrin\\Process\\GPNET",
  "racineProd": "Z:\\GPNet",
  "dossierSauvegarde": "Z:\\AvMdf\\AVMDF4611\\AVMDF4611_3",
  "archivage": true,
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
`archivage` à `false` marque un passage fait sans archivage AVMDF, donc non réversible ;
`archiveNonRemplace` signale un fichier archivé dont la copie a échoué ; `sauvegardeConservee`
signale une archive héritée d'un passage précédent dans le même sprint ; `sansArchive` marque une
entrée dont la version de production a été écrasée sans copie de sauvegarde.

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

## Tableau de bord

L'onglet « Tableau de bord » agrège tous les manifestes du dossier d'archives : mises en
production, fichiers déployés, lignes de code, retours arrière, échecs, activité des douze
derniers mois, répartition par projet et par auteur, fichiers les plus souvent déployés et
activité récente. Les chiffres viennent du disque, pas d'une base : ce sont les traces réelles.
Les simulations sont comptées à part et n'entrent dans aucun total.

## Précision sur les blancs

La comparaison ligne à ligne est exacte au caractère près, blancs compris :

- une ligne qui ne change que par les espaces, tabulations ou espaces insécables est marquée
  « ␣ » et comptée dans le bandeau d'alerte du fichier ;
- le bouton « ¶ Espaces » rend chaque blanc visible : espace `·`, tabulation `→`, insécable `⍽`,
  avec les blancs en fin de ligne surlignés ;
- le style d'indentation de chaque version (tabulations, espaces, mixte) est détecté et affiché
  dans l'en-tête de colonne, et un écart entre les deux côtés est signalé ;
- l'option « ignorer les espaces dans la comparaison » reste disponible dans les réglages pour
  qui veut au contraire les neutraliser.

## Coloration syntaxique

Le comparateur colore le code comme Visual Studio : C#, ASPX/ASCX/Master (balises serveur
comprises), JavaScript, CSS, HTML/XML, SQL, VB.NET et JSON, selon l'extension du fichier.

- Le texte complet de chaque côté est tokenisé en une passe (Prism, vendorisé dans
  `renderer/vendor/`) : les commentaires multi-lignes restent corrects même repliés.
- La coloration se superpose aux couches existantes sans les remplacer : surlignage mot à mot,
  glyphes de blancs, marques « ␣ ».
- Le bouton « Couleur » la désactive ou la réactive, préférence mémorisée. Au-delà de 1,5 Mo de
  texte, elle se coupe d'elle-même pour ne pas figer l'interface.
- Les teintes restent dans les deux familles de l'identité (vert et gris).

### Gabarits Vue entre accents graves

Dans un fichier JavaScript, un gabarit `` template: `…` `` qui contient du HTML (composants
Vue 2) est tokenisé avec la grammaire markup : balises, attributs et texte colorés comme du vrai
HTML, interpolations `${…}` préservées en JavaScript. Visual Studio affiche tout cela d'une seule
couleur ; ici le gabarit se lit comme une page.

### Guides d'ouverture et de fermeture

Chaque balise ouvrante est appariée à sa fermante et un trait vertical descend de l'une à
l'autre, avec un petit retour horizontal sur la ligne de fermeture. Les traits suivent la
**structure réelle** des balises, pas l'indentation : dans un gabarit indenté au pif, ils
montrent quand même qui ouvre quoi et jusqu'où. Bouton « Guides » pour les couper, préférence
mémorisée. Les fermetures orphelines sont ignorées, les balises vides (`<br/>`, `<img>`…) ne
créent pas de trait.

## Interface

- Les deux panneaux de l'analyse se redimensionnent à la souris (double-clic sur la poignée pour
  revenir à la largeur d'origine). La largeur, le mode côte à côte ou unifié, le défilement lié,
  l'affichage des blancs et l'ordre des deux côtés du comparateur sont mémorisés d'une session à
  l'autre.
- Dans le comparateur, **le local est à gauche et la production à droite** par défaut ; le bouton
  `⇄` intervertit les deux, et le libellé rappelle l'ordre en cours. Intervertir ne change pas le
  sens des signes : le diff se calcule toujours production → local, donc `+` reste ce qui sera
  ajouté en production et `−` ce qui en sera retiré. Le bouton n'apparaît que sur la comparaison
  de l'analyse : celles de l'historique et des versions archivées n'opposent pas du local à de la
  production et gardent leur ordre propre (`inversable={false}`).
- La navigation se fait par onglets : Analyse, Tableau de bord, Aide. Historique et Journal
  restent accessibles en permanence.

### Panneau de gauche

L'arborescence porte une icône par ligne : dossier fermé, dossier ouvert, et **une icône par
famille de fichier**, forme et teinte comprises. Des guides d'indentation verticaux marquent la
profondeur, et le marqueur de statut est rejeté à droite : les noms s'alignent à gauche, les
marqueurs forment une colonne qui se relit d'un seul mouvement. La couleur de l'icône dit le
**type**, le marqueur de droite dit l'**état** : deux informations, deux colonnes.

Les icônes sont des tracés SVG en `currentColor` dans `renderer/components/icones.js` : ni police
d'icônes ni fichier extérieur, la politique de sécurité du contenu interdit les deux. Seize
familles couvrent tout, avec repli sur « inconnu » : pages et balisage (`.aspx`, `.ascx`,
`.master`, `.html`…), code serveur (`.vb`, `.cs`…), scripts navigateur (`.js`, `.ts`…), composants
Vue, feuilles de style, données et configuration, bases de données, scripts de commande, images,
textes, tableurs, documents, archives, binaires, polices, sons et vidéos. Une extension composée
se résout sur sa dernière partie : `Default.aspx.vb` est du code serveur, pas une page.

Les teintes sont celles de la coloration syntaxique du comparateur, donc les deux familles de
l'identité, vert et gris-bleu ; seuls les fichiers qui ne se lisent pas, binaires et archives,
empruntent le rouge sourd. La légende complète, icône par icône et extension par extension, est
dans l'onglet Aide.

La barre de filtres se lit sur trois niveaux, du plus utilisé au moins utilisé : la recherche, les
quatre pastilles de statut (marqueur, mot entier, nombre), puis les filtres avancés - contenu,
extensions, dates, dossier - repliés tant qu'on ne s'en sert pas, avec le nombre de filtres actifs
rappelé sur le repli pour qu'aucun ne se cache.

## Aide intégrée

L'onglet « Aide » documente l'application depuis l'application : à quoi elle sert, un plan
cliquable de l'écran, le parcours complet en neuf étapes, les quatre statuts, la barre de filtres,
l'arborescence, le comparateur, le bandeau, la destination AVMDF, les contrôles préalables, le
rapport, l'historique, le tableau de bord, les réglages, les raccourcis, les garanties, un guide de
dépannage et un glossaire.

Parti pris : **montrer plutôt que décrire**. Les morceaux d'interface y sont reproduits avec leurs
vraies classes CSS, donc avec leurs vraies couleurs et leurs vrais glyphes. Le jour où une teinte
de statut change, l'aide change avec elle. Les reproductions sont inertes (`.aide-demo`), seule la
navigation clique.

## Versions archivées d'un fichier

Chaque dossier de sprint contient la version « avant modification » des fichiers touchés. L'outil
sait les retrouver : sur un fichier, `Versions archivées` (bouton de la comparaison ou clic droit
dans l'arborescence) liste **toutes** ses versions, toutes demandes et tous sprints confondus, avec
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

**Pools IIS.** L'outil ne pilote pas le serveur. S'il ne peut pas remplacer un fichier, il bloque
avant la première écriture et dit quoi faire.

Le test est le seul fiable : ouvrir le fichier de production en écriture (`r+`), sans rien
modifier. Reste à savoir pourquoi le système a dit non, car le remède n'est pas le même, et
« verrouillé » envoie chercher au mauvais endroit :

| Code | Cause | Ce que dit le message |
|---|---|---|
| `EBUSY` | un programme tient le fichier ouvert | où voir qui le tient : Gestion de l'ordinateur, Dossiers partagés, Fichiers ouverts |
| `EPERM` / `EACCES` sans bit d'écriture | attribut « lecture seule » | comment le retirer (Propriétés, ou `attrib -R`) |
| `EPERM` / `EACCES` avec bit d'écriture | droits NTFS insuffisants | faire ouvrir les droits, ou déployer depuis un compte qui les a |
| autre | refus non reconnu | le code brut, pour ne rien inventer |

La distinction lecture seule / droits repose sur le mode renvoyé par `fs.stat` : sous Windows,
Node éteint le bit d'écriture quand l'attribut « lecture seule » est posé.

**Le conseil sur le pool d'applications n'apparaît que s'il sert.** IIS ne tient que ce qu'il a
chargé : la DLL de `bin` et ses satellites (`*.dll`, `*.exe`, `*.pdb`). Une page, une feuille de
style ou une image sont lues, envoyées et refermées. Recycler le pool pour un `.css` bloqué n'aurait
aucun effet, donc l'outil ne le propose pas. Le dépôt automatique de `app_offline.htm` reste
disponible en option dans les réglages, désactivé par défaut.

## Mise en production sans archivage

Toutes les mises en production ne méritent pas leur dossier d'archives : une feuille de style, une
correction d'affichage, une retouche sans enjeu. La case **Archiver** du bandeau, cochée par
défaut, se décoche pour un passage.

**La demande devient alors facultative** : rien n'est rangé, donc il n'y a rien à ranger quelque
part. Personne ne devrait avoir à ouvrir une demande de travaux pour pousser une feuille de style.
Le dossier d'archives n'est même pas consulté, et le lecteur réseau peut être déconnecté sans que
cela empêche quoi que ce soit.

| Sans archivage, la demande est… | Ce qui se passe |
|---|---|
| indiquée quand même | Manifeste et récapitulatif écrits dans le dossier de sprint, avec l'empreinte de chaque version remplacée. Le passage apparaît dans l'historique et le tableau de bord. Seule la copie de sauvegarde n'a pas lieu. |
| laissée vide | Aucune écriture dans les archives. Le passage n'apparaît ni dans l'historique ni dans le tableau de bord ; le journal en garde la ligne et le rapport final reste affiché. |

Sans demande, la confirmation se fait en recopiant le **nombre de fichiers** au lieu du numéro de
demande : le geste reste le même, et il oblige à relire ce qui part. Ce qu'il ne faut surtout pas,
c'est un champ vide qui se valide seul.

Le choix se voit à chaque étape : un pavé `SANS AVMDF` dans le bandeau, un avertissement dans les
contrôles préalables avec la liste des fichiers concernés, un encart rouge dans la confirmation,
une ligne dédiée dans le récapitulatif, une étiquette `sans AVMDF` dans l'historique, et une ligne
`ALERTE` au journal. Le manifeste porte `"archivage": false` et chaque entrée touchée
`"sansArchive": true`.

Conséquence assumée : **le retour arrière est refusé sur ces passages**, avec un message qui
distingue « rien n'a jamais été archivé » de « l'archive a disparu ». La case revient d'elle-même à
« cochée » après chaque mise en production réelle : le choix se refait à chaque passage, il ne se
subit pas. Un lot mélangeant fichiers sans enjeu et fichiers à conserver se traite en deux
passages, faute de quoi le manifeste ne dirait plus s'il est réversible.

## Ce que l'outil ne fait jamais

- déployer sans avoir archivé la version écrasée, hors renoncement explicite tracé dans le
  manifeste (voir ci-dessus) ;
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
