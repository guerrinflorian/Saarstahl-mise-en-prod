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

Produit `dist\MEPFront.exe` : un fichier unique, sans installeur ni droits
administrateur. À lancer depuis n'importe quel poste ayant accès à `Z:\`.

L'application embarque **Electron 22** (Chromium 108), dernière lignée compatible avec
**Windows Server 2012 R2**, où tourne le serveur de développement. Ne pas monter la version
d'Electron sans vérifier que ce serveur a été mis à niveau : Electron 23 et suivants exigent
Windows 10 / Server 2016. Conséquence dans le code : pas de fonctionnalités CSS ou JS
postérieures à Chromium 108 (par exemple `color-mix`, remplacé par des valeurs `rgba` calculées
depuis la palette).

L'exécutable portable s'auto-extrait dans `%TEMP%` au lancement. Sur les serveurs où l'exécution
depuis `%TEMP%` est bloquée (stratégie de groupe, antivirus), utiliser la variante
`MEPFront-dossier.zip` de la release : décompresser le dossier où l'on veut et
lancer `AVMDF Mise en production.exe` sur place.

---

## Organisation du code

```
electron/
  main.js       fenêtre et handlers IPC - aucune logique métier
  preload.js    pont contextBridge ; le renderer n'a aucun accès direct au disque
  core/         logique métier en modules Node purs (aucun require('electron'))
    config.js   réglages : défauts, normalisation, contrôle de cohérence, écriture atomique
    acces.js    existence et lisibilité réelles d'une racine, avant de s'en servir
    fsindex.js  parcours récursif, empreintes SHA-256, cache, concurrence bornée
    compare.js  appariement des deux arbres, statuts, compteurs agrégés,
                diagnostic de correspondance des deux dossiers
    search.js   recherche et filtrage, occurrences dans le contenu
    textdiff.js encodage (BOM → UTF-8 strict → Windows-1252) et diff ligne à ligne
    avmdf.js    demandes, conventions de sprint, résolution de destination
    deploy.js   préflight, archivage, copie, manifeste, récapitulatif, retour arrière
    journal.js  journal quotidien en texte
renderer/
  index.html    page unique
  theme-initial.js  pose le thème avant le premier affichage (script classique)
  styles.css    deux thèmes en variables, jeu de couleurs des statuts et du diff
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

## Premier démarrage

Rien n'est prérempli avec les habitudes d'un autre poste : depuis la 2.0, l'application ne crée
**aucun projet d'office** (les versions précédentes livraient GPNet et WebService à tout le monde ;
un WebService resté exactement d'origine est retiré à la migration). L'écran de premier démarrage
demande le minimum pour que l'outil soit celui de la personne qui s'installe :

1. **son nom d'auteur**, celui qui signera les manifestes ;
2. **la racine de ses sources locales** ;
3. **la racine de production** ;
4. **la racine des archives**, préremplie à `Z:\AvMdf` (celle-là est la même pour tout le monde) ;
5. **son premier projet** (nom, dossier local, dossier production), avec la possibilité d'en
   décrire plusieurs d'emblée.

Une valeur inventée serait pire que rien - elle donnerait l'illusion d'un outil déjà réglé. Tant
que ce minimum n'est pas renseigné, l'application affiche cet écran, et rien d'autre.

Chaque chemin saisi est contrôlé pour de vrai - existence, nature, lecture - et le résultat
s'affiche sous le champ. Un dossier introuvable n'interdit pas de continuer (un partage réseau peut
être arrêté au moment de l'installation), mais il est dit.

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

Chaque déploiement réel écrit un `_deploiement_<horodatage>.json` (horodatage à la milliseconde,
pour que deux passages rapprochés ne se marchent pas dessus) dans le sous-dossier `_donnees-outil`
du sprint. Depuis la 2.0, tout ce que l'outil dépose pour lui-même - manifestes, restaurations,
`recapitulatif.md`, un `LISEZMOI.txt` qui l'explique sur place - vit dans ce sous-dossier : les
versions archivées de la demande restent seules à la racine du sprint, et quiconque parcourt les
archives distingue d'un coup d'œil la demande de l'outillage. Les traces écrites avant la 2.0,
restées à la racine du sprint, sont toujours lues (historique, versions d'un fichier, tableau de
bord).

```json
{
  "demande": "AVMDF4611",
  "sprint": "AVMDF4611_3",
  "auteur": "durand-p",
  "date": "2026-08-06T14:52:10.000Z",
  "projet": "GPNet",
  "racineLocale": "E:\\Sources\\GPNET",
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

Champs propres à l'outil : `commentaire` porte la phrase saisie à la confirmation (« pourquoi ce
passage part »), ou `null` ; `operation` vaut `deploiement`, `suppression` ou `restauration` ;
`archivage` à `false` marque un passage fait sans archivage AVMDF, donc non réversible - les
versions ≤ 0.6 pouvaient écrire un manifeste dans ce cas, ce n'est plus possible depuis (sans
archivage, rien n'est écrit du tout), mais ces manifestes-là restent lus et marqués comme tels ;
`archiveNonRemplace` signale un fichier archivé dont la copie a échoué ; `sauvegardeConservee`
signale une archive héritée d'un passage précédent dans le même sprint ; `sansArchive` marque une
entrée dont la version de production a été écrasée sans copie de sauvegarde.

Depuis la 1.6.0, un champ `appOffline` (ou `null`) consigne le sort du fichier d'attente quand
l'option est active : `depose`, `erreurDepot`, `retire`, `erreurRetrait`. Un retrait en échec est
signalé en rouge dans le rapport et en ERREUR au journal : le site resté hors service ne passe
plus inaperçu.

Le manifeste s'écrit en deux temps (fichier temporaire puis renommage) : il ne peut pas exister
tronqué. Si le partage refuse l'écriture alors que les fichiers sont déjà partis, une copie de
secours part dans `%APPDATA%\avmdf-deploy\manifestes-secours` et le rapport le dit : le
déroulé d'un passage réussi ne se perd jamais en silence.

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
| Fond, panneaux, séparateurs (thème sombre) | `#16191C`, `#1D2126`, `#2E343B` |
| Fond, panneaux, séparateurs (thème clair) | `#E9EDF1`, `#F4F6F9`, `#D5DCE2` |

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

La 2.0 le pousse plus loin : volume réellement écrit en production et cadence moyenne entre deux
passages, rythme de la semaine (à quels jours partent les livraisons), répartition par type de
fichier, demandes revisitées (plusieurs passages sous le même numéro AVMDF). Un clic sur un
fichier chaud ouvre sa frise chronologique. Et depuis la tuile « dernière mise en production »,
le bouton « La production est-elle toujours conforme ? » re-hashe chaque fichier du dernier
passage et confronte la production au manifeste : conforme, ou dérive détaillée (modifiés depuis,
absents, réapparus), sans rien écrire.

Les manifestes sont lus une fois, en lectures parallèles bornées, et partagés entre l'historique
et le tableau de bord (cache de 30 secondes, invalidé après chaque passage réel) : passer d'un
écran à l'autre ne relit plus tout le partage à chaque fois.

## Contrôles préalables : ce qui a changé en 1.6.0

- Un fichier donné pour « nouveau » qui existe désormais en production est **bloquant** :
  quelqu'un l'y a déposé depuis l'analyse, il faut recomparer avant d'écraser.
- Quand la mesure d'espace disque est impossible (Electron 22 embarque Node 16, qui ne sait pas
  interroger le volume), l'avertissement le **dit**, avec le volume à écrire, au lieu de se
  taire ; quand elle est possible, la racine des archives est mesurée en plus de la production.
- Le préflight montré à la confirmation vaut pour l'exécution : si le plan et l'analyse n'ont pas
  bougé (et moins de cinq minutes ont passé), l'exécution réutilise ses empreintes au lieu de
  relire toute la production une deuxième puis une troisième fois. « Rejouer les contrôles » ou
  toute attente prolongée refait un préflight complet.

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

## Éditeur intégré

Le bouton « ✎ Modifier » du comparateur - ou « Modifier la version locale » au clic droit - ouvre
la version **locale** d'un fichier dans un éditeur plein écran : numéros de ligne, coloration
syntaxique (les mêmes teintes que le comparateur), `Ctrl+S` pour enregistrer. C'est fait pour la
retouche de dernière minute, pas pour remplacer Visual Studio. La production et les archives ne
s'éditent jamais.

Ce qui rend l'éditeur sûr dans un projet .NET français aux encodages mélangés :

- **le fichier ressort dans son enveloppe d'origine** : encodage, BOM et fins de ligne sont
  redétectés sur l'état réel du disque au moment d'écrire (`textdiff.encoder`, la réciproque de
  `decoder`), et conservés à l'identique ;
- en Windows-1252, un caractère hors du jeu (flèche, émoji…) **bloque l'enregistrement** et les
  caractères fautifs sont nommés : l'outil n'écrit jamais de « ? » à leur place et ne change
  jamais l'encodage d'un fichier en douce ;
- une modification concurrente (empreinte du disque différente de celle relevée à l'ouverture)
  bloque l'enregistrement au lieu de l'écraser ;
- l'écriture est atomique (fichier temporaire puis renommage), et l'analyse en mémoire est mise à
  jour dans la foulée : statut recalculé, comparaison rechargée, cache d'empreintes invalidé.

Seule normalisation, annoncée à l'avance dans l'éditeur : un fichier aux fins de ligne mixtes
ressort uniformisé en CRLF.

Techniquement, l'éditeur superpose un `textarea` au texte transparent sur un `pre` colorié aux
mêmes métriques ; la tokenisation est synchrone (Prism) pour que le calque ne soit jamais en
retard d'une frappe, et se coupe au-delà de 150 Ko pour préserver la fluidité.

`Ctrl+F` cherche dans le fichier (occurrences surlignées dans un calque dédié, la courante
encadrée), `Ctrl+H` ouvre le remplacement : « Remplacer » traite l'occurrence courante en une
étape d'annulation, « Tout » remplace en un seul `Ctrl+Z`. À l'Entrée, la nouvelle ligne hérite
du retrait de la précédente.

## Palette « Aller au fichier »

`Ctrl+P` après une analyse : un champ, la liste des fichiers, et une recherche insensible à la
casse et aux accents qui tolère les trous (`rchaspx` trouve `Principal\Recherche.aspx`). Les
correspondances exactes passent devant les correspondances à trous, le nom du fichier pèse plus
lourd que le chemin, et `Entrée` ouvre la comparaison. Palette vide, les écarts s'affichent
d'abord.

## Références : qui utilise ce fichier

Le bouton **Références** en tête du panneau de gauche (ou clic droit sur un fichier, « Voir les
références ») lit le contenu des fichiers texte de l'analyse, des deux côtés, et compte où chaque
fichier est mentionné. Le nombre d'utilisations s'affiche alors à côté de chaque fichier, et le
détail se consulte ligne par ligne : qui l'utilise, et ce qu'il utilise lui-même.

Le principe est textuel et assumé comme tel : un fichier est « utilisé » là où son **nom** apparaît.
Cela couvre d'un même geste les `<script src=…>`, les `<%@ Register Src=…>`, les `CodeFile=` et
`MasterPageFile=`, les `url(…)` de CSS, les `Response.Redirect`, les appels AJAX, les images - toute
syntaxe qui désigne un fichier par son nom. Pour les noms de composant (tirets ou camelCase), la
forme balise est cherchée aussi : `vjc-Gestion-Code-Acier.js` est retrouvé dans un gabarit qui
écrit `<vjc-gestion-code-acier>`, et `GestionCodeAcier.js` dans `<gestion-code-acier>`. Les
frontières de nom sont respectées : `form.js` ne compte pas dans `platform.js`, ni
`Recherche.aspx` dans `Recherche.aspx.vb`.

Tous les noms sont cherchés en une seule passe par fichier (automate de correspondance multiple) :
le coût est une lecture de chaque fichier texte, la même qu'une recherche dans le contenu. Un
fichier « identique » n'est lu qu'une fois, un « modifié » l'est des deux côtés, et chaque mention
porte son côté (local, production, ou les deux).

Un fichier à **zéro référence** porte une pastille distincte : c'est le candidat au ménage, à
rapprocher de la suppression d'orphelins. La limite est dite dans l'écran même : un nom construit
dynamiquement par le code (chaîne concaténée, configuration IIS, rewrite) ne peut pas être vu ;
zéro mention n'est pas une preuve, c'est une forte présomption. L'index se périme tout seul dès
qu'un contenu change (analyse, éditeur, mise en production) et se reconstruit d'un clic.

## Frise chronologique d'un fichier

Clic droit sur un fichier, « Frise chronologique » (aussi depuis l'en-tête de la comparaison, et
d'un clic sur les fichiers chauds du tableau de bord) : l'histoire du fichier se déroule sur un
rail vertical, du plus récent au plus ancien. Chaque événement est un fait écrit sur le disque :

- un **passage en production** lu dans un manifeste : demande de travaux, sprint, auteur, action
  (créé, remplacé, supprimé, restauré), lignes ajoutées et supprimées, commentaire du passage, et
  le chemin de la copie conservée ;
- une **version archivée** dont aucun manifeste ne parle (ancienne organisation) : elle figure
  quand même, datée du fichier.

En tête, le résumé : combien de passages, combien de versions conservées, premier et dernier
mouvement. Le point de chaque événement porte sa couleur (vert : déploiement ; rouge :
suppression ou échec ; gris : archive sans manifeste). Depuis l'analyse, un bouton enchaîne sur
« Versions archivées » pour comparer ou restaurer. La frise ne devine rien : ce que l'outil n'a
pas écrit (copie à la main, autre outil) ne peut pas y figurer, et l'écran le dit.

## Aperçu des binaires : icônes, images, sons, polices

Un fichier qui ne se lit pas se regarde. Depuis la 1.9.0, la comparaison d'un binaire commence par
un **verdict net** : « identiques octet pour octet » ou « les deux versions diffèrent » (même
taille ou pas, position du premier écart). Le tampon des deux côtés est comparé réellement, pas au
travers des dates.

Selon le type de fichier, le verdict s'accompagne d'un aperçu :

- **Images et icônes** (`png`, `jpg`, `gif`, `bmp`, `webp`, `avif`, `ico`, `cur`, `svg`) : les deux
  versions côte à côte sur un damier qui révèle les transparences, avec leurs dimensions en pixels.
  Trois modes : **côte à côte**, **superposer** (les deux images l'une sur l'autre, un curseur dose
  la version visible) et **différence** (chaque pixel qui change est peint en rouge vif, le reste
  en gris estompé, avec le compte exact - « 1 pixel diffère sur 576 (0.2 %) »). Une différence sur
  une petite icône est grossie d'office, en pixels nets. Fond damier, clair ou sombre ; zoom ×1,
  ×2, ×4. Cas parlant : deux fichiers au contenu différent mais au rendu identique (métadonnées,
  ré-enregistrement) affichent « aucun pixel ne diffère » - inutile de les livrer.
- **SVG** : son code se compare (diff texte normal), son rendu se regarde - le bouton **Aperçu**
  de l'en-tête bascule entre les deux.
- **Sons et vidéos** (`mp3`, `wav`, `ogg`, `m4a`, `mp4`, `webm`) : un lecteur par version.
- **Polices** (`woff`, `woff2`, `ttf`, `otf`) : le même pangramme composé dans chaque version,
  chiffres et accents compris - une graisse ou un dessin qui change se voit immédiatement.
- **Tout le reste** (`dll`, `pdf`, archives…) : le tableau taille / date / SHA-256, et le
  **premier octet qui diffère** montré en hexadécimal, fenêtre d'octets autour et octet fautif
  surligné de chaque côté. Quand un fichier est exactement le début de l'autre, c'est dit tel quel.

Ces aperçus valent partout où l'on compare : l'analyse, les versions archivées d'un fichier et
l'historique d'une mise en production. Une image trop volumineuse pour le diff texte n'est plus
refusée : elle se juge à l'œil. Au-delà de 20 Mo par côté, pas d'aperçu - la fiche et les
empreintes restent. Rien n'est jamais modifié : ces vues ne font que lire.

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
  restent accessibles en permanence. L'historique se filtre (demande, fichier, commentaire, et une
  case « Masquer les simulations »), le journal se filtre par niveau (Tout / Alertes / Erreurs).
- « Copier le diff » copie la comparaison affichée au format patch, prête à coller dans un
  message ; `A−` / `A+` règlent le corps de texte du comparateur, préférence mémorisée. Le bouton
  « Suivant (F8) » affiche la position courante (« 3/14 »), la mini-carte porte aussi les
  occurrences de la recherche `Ctrl+F`, et le bandeau d'alerte propose de **recomparer sans les
  blancs** pour un fichier (aller-retour libre, sans toucher au réglage global).
- À la confirmation d'une mise en production, un champ **Commentaire** facultatif permet de dire
  en une phrase pourquoi le passage part ; la phrase suit le manifeste partout (récapitulatif,
  historique, rapport, tableau de bord). Un point bloquant corrigé (pool recyclé, fichier
  déverrouillé) se revérifie sur place avec « Rejouer les contrôles », sans refermer la fenêtre.
- Les filtres composent la sélection : « ☑ Cocher les affichés » coche d'un coup tout ce que les
  filtres laissent voir (sans jamais mélanger déploiement et suppression), « Tout décocher » vide
  la sélection.
- Le compteur du bandeau s'ouvre en **plan de vol** : la liste exacte de ce qui part (statut,
  chemin, taille, volume total), retrait fichier par fichier, et « Copier la liste » pour
  l'annonce du passage.
- Clic droit → **Réanalyser ce fichier** : re-stat et re-hash de ce seul fichier, des deux côtés,
  sans relire le partage ; le statut se recale immédiatement (même règles que l'analyse : taille,
  puis empreinte, jamais la date).
- Clic droit → **Masquer pour cette analyse** (fichier ou branche) : écarte de la vue sans toucher
  aux réglages ; la barre de filtres affiche « N masqués · Rétablir », la prochaine analyse repart
  au complet.
- `Maj+clic` sur une case coche toute la plage depuis la dernière case cochée (toujours cocher,
  jamais basculer ; même règle de non-mélange que le reste).
- La règle « jamais mélanger mise en production et suppression d'orphelins » se **voit** au lieu
  de se subir : dès qu'une sélection engage une nature, les cases de l'autre nature sont grisées
  avec l'explication au survol, l'état de coche d'un dossier se juge sur la nature engagée (un
  dossier mixte dont tous les orphelins sont cochés pendant une suppression est bien coché, pas
  « à moitié »), et un clic qui ne peut rien cocher le dit en notification au lieu de ne rien
  faire. Cocher un fichier seul suit la même règle : plus de sélection « mixte » fabriquée sans
  s'en rendre compte, que le bandeau refusait ensuite sans explication.
- Le comparateur porte une **mini-carte des changements** le long du bord droit : la silhouette du
  fichier, un trait coloré par bloc changé, un clic pour y sauter. À l'ouverture d'un fichier, la
  vue se place d'elle-même sur le premier changement.

## Vérifier la production après coup

Dans l'historique - et dans le rapport, juste après un passage réel - **« Vérifier l'état en
production »** re-hashe chaque fichier d'un manifeste sur le serveur et le confronte à l'empreinte
`hashApres` enregistrée au moment du passage (`deploy.verifierManifeste`). Verdicts par fichier :
**intact**, **modifié depuis**, **absent de la production**, **réapparu** (un fichier supprimé qui
est revenu), **invérifiable**. Rien n'est écrit, nulle part : ce contrôle lit. C'est la réponse
outillée à « ma production est-elle toujours celle que j'ai livrée ? », et le résultat est
consigné dans le journal (ALERTE dès qu'un fichier n'est plus intact).
- Le clic droit sur un fichier propose **les deux côtés séparément** : ouvrir la version locale ou
  la version production, et afficher l'une ou l'autre dans l'explorateur Windows. Aucune entrée ne
  se rabat sur l'autre côté quand le fichier n'existe que d'un seul : elle est grisée. Ouvrir « la
  production » et se retrouver devant le fichier local ferait mal lire tout ce qui suit.
- Le clic droit sur un **dossier** a son propre menu : montrer le dossier réel de chaque côté,
  copier son chemin, et l'écarter entièrement de la comparaison. L'exclusion se pose de deux façons,
  et la différence compte :

  | Entrée | Motif ajouté | Portée |
  |---|---|---|
  | Exclure ce dossier seulement ici | `Controles\Images` | ce dossier-là, à cet endroit-là |
  | Exclure tous les dossiers « Images » | `Images` | tout dossier de ce nom, à n'importe quelle profondeur |

  Sur un dossier de premier niveau les deux motifs seraient identiques : une seule entrée est alors
  proposée. Le motif exact est rappelé au survol puis dans la notification, parce que c'est lui
  qu'on retrouvera dans **Dossiers exclus** et de là qu'on le retirera. Un dossier exclu n'est
  jamais parcouru, d'aucun côté : son contenu ne peut ni apparaître, ni partir en production, ni
  être supprimé. L'analyse en cours ne bouge pas, `F5` la refait.

## Petites attentions

- Une notification survolée ne disparaît pas : le minuteur s'arrête sous la souris et repart de
  zéro à son départ, jauge comprise.
- Les contrôles préalables affichent une vraie jauge de progression.
- Les états vides (aucune analyse, aucun fichier sélectionné, historique vide) portent leur icône
  au trait et le motif du rail : un écran vide dit quand même où l'on est.
- Le titre de la fenêtre suit le travail : `AVMDF - Mise en production · GPNet · 23 sélectionnés`
  se lit depuis la barre des tâches.

## Thèmes

Un bouton en haut à droite bascule entre **sombre** (par défaut) et **clair**. L'icône montre le
thème vers lequel elle emmène : soleil en sombre, lune en clair.

Le thème n'est qu'un attribut `data-theme` posé sur `<html>` : la feuille de style redéfinit ses
variables, **aucune règle ne change**. Toutes les couleurs de l'application vivent dans les deux
blocs en tête de `styles.css` ; une couleur écrite en dur ailleurs serait invisible en sombre et
fausse en clair, donc il n'y en a plus.

Le thème clair n'est pas le thème sombre éclairci. Sur fond blanc, une couleur claire disparaît :
tout ce qui porte du sens - statuts, marqueurs, coloration syntaxique - est redescendu en clarté
jusqu'à passer 4,5:1 sur blanc, en gardant teinte et saturation d'origine. Le vert du logo
(`#ABD083`, teinte 89°, saturation 41 %) devient `#6F9C3F` pour les surfaces et `#4A6B28` pour le
texte : même teinte, même saturation, clarté descendue. Le relief s'inverse aussi - en sombre une
surface monte en s'éclaircissant, en clair elle monte vers le blanc.

Le choix est mémorisé dans le stockage local du poste (`avmdf.theme`), pas dans les réglages : c'est
un confort de lecture, pas un paramètre de déploiement. Il est appliqué par `theme-initial.js`, un
script classique chargé dans l'en-tête et donc exécuté **avant le premier affichage** - `app.js`
étant un module différé, poser le thème depuis lui ferait clignoter du sombre à chaque démarrage en
thème clair. Le fond de la fenêtre Electron suit par IPC (`systeme:fondFenetre`) : c'est lui qu'on
voit pendant un redimensionnement, avant que la page ne soit repeinte.

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
de statut change, l'aide change avec elle - et comme tout passe par les variables de thème, l'aide
se lit dans le thème en cours sans une ligne de plus. Les reproductions sont inertes
(`.aide-demo`), seule la navigation clique.

## Versions archivées d'un fichier

Chaque dossier de sprint contient la version « avant modification » des fichiers touchés. L'outil
sait les retrouver : sur un fichier, `Versions archivées` (bouton de la comparaison ou clic droit
dans l'arborescence) liste **toutes** ses versions, toutes demandes et tous sprints confondus, avec
leur date, leur auteur et l'action d'origine, lus dans les manifestes présents sur place.

Chaque version se compare à la version actuellement en production, et se remet en place en un
geste. La remise en production archive d'abord la version actuelle dans le sprint choisi, puis
écrit son propre manifeste de restauration : revenir à une version ancienne ne fait jamais perdre
l'état courant, et l'opération est elle-même réversible depuis l'écran Historique.

## Ce qui est refusé avant de commencer

Une analyse lancée sur un dossier illisible ne plante pas : elle réussit à moitié. Le côté
inaccessible rend zéro fichier, et tout ce qui existe de l'autre côté ressort en « nouveau » ou en
« orphelin ». L'écran se remplit alors de milliers de lignes qui décrivent un problème de droits,
pas un écart de contenu - et une sélection large y effacerait une production entière.

`core/acces.js` contrôle donc les deux racines **avant le premier parcours** : existence, nature,
et lecture réelle du contenu (`readdir`, pas seulement `stat` - sur un partage, un dossier peut se
laisser interroger sans se laisser lister). Les deux côtés sont toujours testés, même quand le
premier échoue : celui qui corrige veut connaître les deux problèmes d'un coup. L'analyse est
refusée, et le panneau de gauche montre les deux racines, celle qui va comme celle qui bloque,
avec la cause et le remède.

| Code | Ce que dit le message |
|---|---|
| `ENOENT` | est introuvable - et, sur un chemin UNC, que le partage est peut-être arrêté ou la session non authentifiée |
| `EACCES` / `EPERM` | refuse l'accès : droits Windows insuffisants sur le dossier |
| `ENOTDIR`, fichier | n'est pas un dossier : indiquer le dossier qui le contient |
| `EBUSY`, `ENAMETOOLONG`, `ELOOP` | verrouillé, chemin trop long, boucle de liens |

## Quand les deux dossiers n'ont rien à voir

Deux dossiers sans rapport ne produisent aucune erreur : ils produisent une liste énorme où tout le
local est « nouveau » et toute la production « orpheline ». Parfaitement lisible, parfaitement
fausse. Le seul moyen de s'en apercevoir est de regarder la proportion de chemins présents des deux
côtés, ce que fait `compare.diagnostiquerCorrespondance()` :

| Constat | Niveau |
|---|---|
| aucun fichier local | alerte : tout ressort en orphelin, vérifier avant de supprimer |
| production vide | attention : normal pour un tout premier déploiement, suspect sinon |
| aucun chemin commun | alerte, avec le compte de chaque côté et l'absence de dossier de premier niveau commun |
| moins de 20 % de chemins communs (à partir de 8 fichiers) | alerte, avec la proportion exacte |

Le constat est affiché en haut du panneau de gauche et repris en notification. Il ne bloque rien :
un premier déploiement ressemble légitimement à ça. Il est recalculé à chaque envoi vers
l'interface plutôt que mémorisé, parce qu'une mise en production rapproche les deux côtés.

## Décisions prises

Deux points laissés ouverts par la spécification ont été tranchés ainsi. Ils se changent sans
difficulté si vous préférez l'inverse.

**Fichiers orphelins.** Présents en production seulement, ils ne partent jamais avec une mise en
production : c'est une opération distincte. On les coche seuls, le bouton du bandeau devient
« Supprimer en production », la version supprimée est archivée dans le sprint **avant** d'être
retirée, et l'opération produit son propre manifeste - donc elle est réversible comme les autres.
Cocher un dossier ne mélange jamais les deux natures. Comme pour une mise en production, la case
« Archiver » peut être décochée pour un passage : la suppression est alors définitive (voir
« Mise en production sans archivage »).

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

## Dates des fichiers

Deux copies, deux règles, et ce n'est pas un détail :

| Copie | Date portée | Pourquoi |
|---|---|---|
| local → **production** | celle de la **mise en production** | Dans l'explorateur du serveur, la date d'un fichier répond à « quand est-ce que ça a été mis en prod ? ». Reprendre la date du poste de développement afficherait une date sans rapport, souvent bien plus ancienne. |
| production → **archive AVMDF** | celle que le fichier **avait en production** | C'est tout l'intérêt d'une archive : dire de quand datait la version remplacée. |

Ce sont deux fonctions distinctes dans `deploy.js`, `copierVersProduction` et `copierAvecDate`. La
comparaison ne s'en trouve pas faussée : elle se décide sur la taille puis sur l'empreinte SHA-256,
jamais sur la date.

## Mise à jour de l'arborescence après une mise en production

L'analyse en mémoire est mise à jour depuis le manifeste, sans relire le partage : les fichiers
partis passent en « identique » et quittent donc la liste, les orphelins supprimés en sont retirés,
et les fichiers en échec gardent leur statut. Les compteurs et l'arbre sont recalculés, et le
renderer reçoit le résultat dans la réponse de `deploiement:executer`.

Ce n'est pas une supposition sur l'état du disque : après une copie réussie, le fichier de
production a exactement le contenu du fichier local, et le manifeste en garde l'empreinte.
Reparcourir des milliers de fichiers sur un partage SMB pour réapprendre ce qu'on vient d'écrire
soi-même n'aurait aucun intérêt. `F5` reste là pour repartir vraiment du disque.

Une **restauration** est exclue de ce mécanisme : elle remet en production un contenu venu des
archives, pas des sources locales, donc conclure « identique » serait faux.

## Mise en production sans archivage

Toutes les mises en production ne méritent pas leur dossier d'archives : une feuille de style, une
correction d'affichage, une retouche sans enjeu. La case **Archiver** du bandeau, cochée par
défaut, se décoche pour un passage.

**La case gouverne tout le versant AVMDF.** Décochée, la demande n'est plus exigée, plus lue, et
plus rien ne s'écrit sous la racine des archives : ni les versions remplacées, ni le manifeste qui
les recense. Personne ne devrait avoir à ouvrir une demande de travaux pour pousser une feuille de
style. Le dossier d'archives n'est même pas consulté, et le lecteur réseau peut être déconnecté sans
que cela empêche quoi que ce soit.

Une destination choisie **avant** de décocher est mise de côté, pas utilisée : le bandeau affiche
« aucun archivage » à sa place, et elle revient si la case est recochée. C'est le point qui avait
été mal tranché au départ - la demande était encore transmise, donc la confirmation réclamait
toujours son numéro et parlait encore d'AVMDF alors que la case était décochée. Un passage à moitié
archivé est plus difficile à expliquer qu'un passage qui ne l'est pas du tout.

Depuis la 1.7.0, la case s'applique aussi aux **suppressions d'orphelins**, et le renoncement y
pèse plus lourd : un orphelin n'existe qu'en production, donc sans archive son contenu n'est
conservé **nulle part** et ne pourra jamais être restauré. Les contrôles préalables listent les
fichiers concernés, la confirmation l'affiche en rouge (« Suppression définitive ») et se fait en
recopiant le nombre de fichiers, et le journal garde la ligne en ALERTE. Supprimer de vieux
fichiers morts ne demande plus d'ouvrir une demande de travaux ; en garder une trace reste le
comportement par défaut, la case se recochant d'elle-même après chaque passage réel.

Sans archivage, la confirmation se fait en recopiant le **nombre de fichiers** au lieu du numéro de
demande : le geste reste le même, et il oblige à relire ce qui part. Ce qu'il ne faut surtout pas,
c'est un champ vide qui se valide seul.

Le choix se voit à chaque étape : « aucun archivage » à la place de la destination dans le bandeau,
un pavé `SANS AVMDF` à côté, un avertissement dans les contrôles préalables avec la liste des
fichiers concernés, un encart rouge dans la confirmation, et une ligne `ALERTE` au journal.

Conséquence assumée : **le passage ne laisse aucune trace écrite dans les archives**. Il n'apparaît
ni dans l'historique ni dans le tableau de bord, il n'y a rien à restaurer, et seul le journal en
garde la ligne. La case revient d'elle-même à « cochée » après chaque mise en production réelle :
le choix se refait à chaque passage, il ne se subit pas. Un lot mélangeant fichiers sans enjeu et
fichiers à conserver se traite en deux passages.

## Ce que l'outil ne fait jamais

- déployer sans avoir archivé la version écrasée, hors renoncement explicite tracé dans le
  manifeste (voir ci-dessus) ;
- prendre un partage injoignable pour un fichier absent : seule une vraie absence (`ENOENT`)
  autorise à conclure, toute autre erreur met le fichier en échec - un `Z:\` qui vacille ne peut
  plus faire sauter l'archivage ;
- laisser un fichier à moitié écrit : copies vers la production, archives et manifestes passent
  par un fichier temporaire puis un renommage, une copie interrompue ne laisse rien qui puisse
  passer pour complet ;
- écraser un fichier donné pour « nouveau » qui existe désormais en production : quelqu'un l'y a
  déposé depuis l'analyse, les contrôles préalables bloquent et demandent une nouvelle analyse ;
- mener deux opérations lourdes en même temps : une analyse pendant une mise en production (ou
  l'inverse) est refusée avec un message, pas subie ;
- restaurer d'après un manifeste dont les racines sortent du périmètre configuré, ni d'après un
  manifeste sans dossier de sauvegarde ou issu d'une simulation ;
- écraser une archive déjà présente dans un sprint - la version « avant modification » d'origine
  gagne toujours, un second passage la conserve ;
- ré-encoder, reformater ou normaliser les fins de ligne : la copie est binaire, octet pour octet ;
- obliger à relancer une analyse après une mise en production : l'arborescence se met à jour toute
  seule (voir ci-dessous) ;
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
| `manifestes-secours\` | copies de secours des manifestes que le partage a refusé d'écrire |
| `logs\journal-AAAA-MM-JJ.log` | une ligne par événement horodaté |
