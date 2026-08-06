1. Contexte

Je suis développeur .NET dans une PME. Je fais les mises en production à la main, en copiant des fichiers depuis mon poste de dev vers un partage réseau qui héberge le site IIS. C'est lent, et surtout risqué : rien ne garantit que je n'écrase pas quelque chose sans sauvegarde.

Environnement réel :

Élément	Chemin	Détail
Sources locales	E:\F Guerrin\Process	[À ADAPTER]
Serveur de prod	Z:\ → \\VMSVRIIS01.PROCESS.LO	lecteur réseau mappé [À ADAPTER]
Archives « avant modif »	Z:\AvMdf	[À ADAPTER]

Contenu côté local : GPNET, WebService, Outils, Traçabilité, Stf, .vs Contenu côté prod (Z:\) : AvMdf, ClientMobile, GPNet, WebService

Les noms ne correspondent pas un pour un (GPNET en local ↔ GPNet en prod ; Outils, Traçabilité et Stf ne sont pas déployés ; ClientMobile n'existe pas en local). L'appariement local ↔ prod doit donc être une configuration éditable, pas une comparaison brute des deux racines.

Ce que je déploie : les sources telles quelles. C'est un projet ASP.NET WebForms : GPNET\GPNET.sln avec des sous-dossiers (Principal\, etc.) contenant des .aspx, .ascx, .master, .js, .css, .cs. Les fichiers déployés sont les fichiers sources — pas de résultat de publication.

Organisation de Z:\AvMdf : un dossier par ticket, nommé AVMDF + numéro (AVMDF4611). À l'intérieur, trois conventions coexistent selon l'ancienneté :

Z:\AvMdf\
├── AVMDF4590\                     ← ancienne façon : fichiers directement à la racine
│   ├── Default.aspx
│   └── Principal\Recherche.aspx
├── AVMDF4602\
│   ├── Sprint1\                   ← convention "Sprint N"
│   └── Sprint2\
└── AVMDF4611\
    ├── AVMDF4611_1\               ← convention "<Ticket>_N"
    └── AVMDF4611_2\

Dans un dossier de sprint, on retrouve la version d'avant modification des fichiers touchés, avec leur arborescence relative conservée.

2. Objectif

Une application de bureau Windows qui me permet de :

Comparer récursivement mon arborescence locale et celle de prod, sur la totalité du répertoire et de tous ses sous-dossiers, à n'importe quelle profondeur.
Voir, fichier par fichier, les lignes ajoutées / supprimées / modifiées.
Chercher et filtrer les fichiers candidats à la mise en production.
Sélectionner ce que je veux déployer et le mettre en prod en archivant automatiquement la version écrasée dans le bon AVMDF<numéro>\<sprint>, en créant le sprint s'il n'existe pas.
Revenir en arrière en un clic si la mise en prod se passe mal.
## 3. Stack imposée

- Electron (dernière version stable) + Node.js.
- Front en **Preact + htm**, chargés en modules ESM depuis `renderer/vendor/`
  (fichiers vendorisés en local, aucun CDN, aucun bundler, aucune étape de build).
  Vendorise `preact.module.js`, `hooks.module.js` et `htm.module.js`.
  Usage : `const html = htm.bind(h);` puis composants fonctionnels + hooks.
- `contextIsolation: true`, `nodeIntegration: false`. Tout le filesystem passe par des
  handlers IPC dans le processus principal, exposés via `preload.js`.
- Dépendances npm côté main au strict minimum : `diff` et `iconv-lite`.
- Packaging : `electron-builder`, cible `portable` Windows (un .exe unique, sans installeur).
4. Arborescence du projet à produire
avmdf-deploy/
├── package.json
├── README.md                    ← installation, lancement, build, format du manifeste
├── electron/
│   ├── main.js                  ← fenêtre + handlers IPC uniquement
│   ├── preload.js               ← pont contextBridge
│   └── core/                    ← logique métier, testable sans Electron
│       ├── config.js            ← chargement/sauvegarde des réglages
│       ├── fsindex.js           ← parcours récursif, hash, cache, concurrence
│       ├── compare.js           ← appariement des deux arbres et statuts
│       ├── search.js            ← moteur de recherche/filtrage
│       ├── textdiff.js          ← encodage + diff ligne à ligne
│       ├── avmdf.js             ← détection tickets et conventions de sprint
│       └── deploy.js            ← préflight, sauvegarde, copie, manifeste, rollback
└── renderer/
    ├── index.html
    ├── styles.css
    ├── app.js                   ← montage racine
    ├── components/              ← un fichier par composant (Arbre, Diff, Filtres, Deploiement…)
    └── vendor/                  ← preact / hooks / htm en ESM

Chaque module de core/ doit être un module Node pur (aucun require('electron')), pour que je puisse l'appeler depuis un script en ligne de commande si besoin.

5. Fonctionnalités détaillées
5.1 Configuration — tout doit être modifiable depuis l'interface

Un écran Réglages accessible en permanence, persisté en JSON dans app.getPath('userData')/config.json. Champs :

Racine locale, racine de prod, racine AVMDF (avec bouton « Parcourir »).
Liste des projets : tableau éditable { nom, dossier local, dossier prod, actif }. Ajout / suppression / réordonnancement. Valeurs par défaut : GPNet (GPNET ↔ GPNet) et WebService (WebService ↔ WebService).
Dossiers exclus (jamais parcourus), liste éditable, glob accepté. Défaut : .vs, .git, .svn, bin, obj, packages, node_modules, App_Data, TestResults, _ReSharper*.
Fichiers exclus (jamais comparés ni déployés), liste éditable, glob accepté. Défaut : web.config, *.user, *.suo, *.pdb, *.cache, *.sln.docstates, Thumbs.db, desktop.ini, *.tmp.
Extensions considérées comme du texte (pour le diff), liste éditable.
Options : ignorer les espaces dans le diff, ignorer les différences CRLF/LF, nom de l'auteur (préremplir avec %USERNAME%).
Un bouton « Comparer deux dossiers libres » qui court-circuite la config projets et laisse choisir n'importe quels dossier A et dossier B. L'outil doit rester utilisable hors du cadre GPNet.

web.config est exclu par défaut et l'interface doit expliquer pourquoi (chaîne de connexion et réglages différents entre dev et prod). Si je le retire de la liste d'exclusion, afficher un avertissement rouge à chaque déploiement qui le concerne.

5.2 Scan et comparaison récursive

Parcours récursif complet, à profondeur illimitée, des deux côtés. Appariement par chemin relatif normalisé en minuscules (Windows est insensible à la casse : GPNET et GPNet, Default.aspx et default.aspx doivent s'apparier).

Quatre statuts :

Statut	Signification	Déployable
modifié	présent des deux côtés, contenu différent	oui
nouveau	présent en local seulement	oui
orphelin	présent en prod seulement	non (info + suppression manuelle possible)
identique	contenus identiques	non

Règles de comparaison, à respecter strictement :

Une taille différente suffit à conclure « modifié » : pas de lecture du contenu.
Si les tailles sont égales, calculer un SHA-256 des deux côtés pour trancher.
Ne jamais utiliser la date de modification comme preuve d'égalité. Une copie réseau, un git checkout ou un rebuild la réécrivent sans que le contenu change (et inversement). La date sert uniquement d'information affichée.
Cache des hash indexé sur chemin + taille + date, persisté dans userData, pour que le second scan soit rapide.
Concurrence bornée (≈ 6 lectures simultanées) : Z:\ est un partage SMB, 500 lectures parallèles le mettent à genoux.
Un dossier illisible ou un fichier verrouillé ne doit jamais interrompre le scan : on l'ignore et on le liste dans un panneau « Éléments ignorés » à la fin.
Barre de progression avec phase en cours (Analyse locale / Analyse prod / Vérification du contenu — 340 / 1 220) et bouton Annuler réellement fonctionnel.
5.3 Recherche et filtrage

C'est central : les projets font plusieurs milliers de fichiers, je dois retrouver rapidement ce que je veux mettre en prod.

Champ de recherche filtrant en direct sur le chemin relatif complet (Principal\Recherche doit matcher). Insensible à la casse et aux accents.
Modes : contient (défaut), expression régulière (avec indication visuelle si la regex est invalide), glob (Principal\**\*.aspx).
Recherche dans le contenu : option « chercher aussi dans le contenu des fichiers » qui grep le texte des fichiers texte des deux côtés et remonte les fichiers contenant la chaîne, avec le nombre d'occurrences. Doit rester réactive (concurrence bornée, annulable).
Filtres par statut : quatre bascules Modifiés / Nouveaux / Orphelins / Identiques, avec le compteur dans le libellé. Par défaut, Identiques est masqué.
Filtre par extension : liste des extensions présentes avec leur nombre, cochables.
Filtre par date : « modifiés localement depuis » → aujourd'hui / 7 jours / 30 jours / date choisie. C'est le filtre que j'utiliserai le plus pour retrouver le travail d'un sprint.
Filtre par dossier : restreindre l'affichage à une branche de l'arborescence.
Les filtres se combinent (ET logique). Un bandeau affiche 142 fichiers affichés sur 3 480 avec un bouton « Réinitialiser les filtres ».
5.4 Vue arborescente
Vraie arborescence pliable/dépliable reflétant la hiérarchie réelle des dossiers, pas une liste plate. Boutons Tout déplier / Tout replier.
Chaque dossier affiche un compteur agrégé de ses descendants par statut, et hérite du statut le plus « chaud » de ses enfants pour sa pastille.
Marqueur d'une seule lettre par fichier, dans une colonne dédiée à gauche : M modifié, + nouveau, − orphelin, = identique. Couleur et lettre — je ne veux pas dépendre uniquement de la couleur.
Case à cocher par fichier et par dossier (cocher un dossier coche récursivement tous ses descendants déployables ; état indéterminé si sélection partielle).
Quand un filtre est actif, seuls les nœuds correspondants sont visibles, mais les dossiers parents restent affichés pour garder le contexte.
La liste doit rester fluide à 5 000+ fichiers (rendu virtualisé ou rendu par lots).
Clic droit sur un fichier : Ouvrir la version locale, Ouvrir la version prod, Afficher dans l'explorateur, Copier le chemin relatif, Exclure ce fichier.
5.5 Comparaison ligne à ligne

Vue côte à côte, prod à gauche (l'existant), local à droite (ce qui va partir).

Numéros de ligne des deux côtés, police à chasse fixe.
Lignes inchangées neutres ; ajoutées, supprimées et modifiées différenciées par fond coloré et par un signe en marge (+, −, ~).
Sur une ligne modifiée, surligner le mot ou le fragment qui change, pas seulement la ligne entière. C'est le point qui fait la différence à la relecture.
Compteur en en-tête : +18 −7 lignes et nom du fichier.
Repliage des blocs inchangés au-delà de 6 lignes consécutives, avec un séparateur cliquable ⋯ 42 lignes identiques qui déplie.
Navigation clavier : F8 / Maj+F8 pour sauter au changement suivant / précédent ; Ctrl+F pour chercher dans le diff affiché.
Défilement synchronisé entre les deux panneaux, désactivable.
Bascule côte à côte / unifié.
Cas particuliers à gérer explicitement, avec un message clair au lieu d'un plantage :
Fichier binaire (image, .dll) → pas de diff : afficher taille, date, SHA-256 des deux côtés.
Fichier > 4 Mo → proposer d'ouvrir dans l'éditeur externe plutôt que d'afficher.
Fichier nouveau → tout le contenu en « ajouté », colonne gauche vide.
Fichier orphelin → tout en « supprimé », colonne droite vide.

Encodage — critique. Les fichiers d'un projet .NET français mélangent UTF-8 (avec ou sans BOM) et Windows-1252. Détecter par fichier : BOM d'abord, puis tentative de décodage UTF-8 strict, puis repli sur Windows-1252. Sans ça les accents partent en mojibake et le diff devient illisible. Afficher l'encodage détecté de chaque côté et signaler visuellement une différence d'encodage ou de fins de ligne entre local et prod.

Lors de la copie, ne jamais ré-encoder ni normaliser quoi que ce soit : copie binaire octet pour octet. Le décodage sert uniquement à l'affichage.

5.6 Ciblage AVMDF et sprint

Panneau de destination, alimenté par la lecture réelle de Z:\AvMdf :

Liste déroulante des tickets existants, triée par numéro décroissant, avec recherche par numéro. Plus un champ libre pour saisir un nouveau numéro.
Si je saisis un numéro qui n'existe pas : proposer explicitement de créer AVMDF<numéro>, avec confirmation.
Une fois le ticket choisi, inspecter son contenu et détecter la convention en place :
sous-dossiers Sprint1, Sprint2… → convention sprint, proposer Sprint<max+1> ;
sous-dossiers AVMDF4611_1, _2… → convention suffixe, proposer AVMDF4611_<max+1> ;
fichiers directement à la racine, aucun sous-dossier → convention historique, signaler « ce ticket utilise l'ancienne organisation » et proposer de démarrer avec AVMDF4611_1 sans toucher aux fichiers déjà en place ;
dossier vide → proposer AVMDF<numéro>_1.
Le nom proposé est toujours modifiable dans un champ texte. On peut aussi choisir un sprint existant dans la liste (utile pour compléter un sprint en cours).
Ne jamais mélanger deux conventions dans un même ticket : si le ticket est en Sprint N, ne pas proposer _N, et inversement.
Afficher le chemin de destination complet résolu, en clair, avant toute action : Z:\AvMdf\AVMDF4611\AVMDF4611_3
Si le dossier de sprint visé existe déjà et contient des fichiers, avertir : est-ce que je complète ce sprint ou est-ce que je me suis trompé de numéro ?
5.7 Mise en production

Un bandeau bas persistant, toujours visible : 23 fichiers sélectionnés → Z:\AvMdf\AVMDF4611\AVMDF4611_3 + bouton principal.

Contrôles préalables (préflight), avant la moindre écriture. Mieux vaut échouer ici qu'à mi-parcours avec la moitié des fichiers déployés :

Racines locale et prod accessibles.
Écriture possible dans le dossier de sauvegarde (test réel : créer puis supprimer un fichier témoin).
Aucun fichier source disparu depuis le scan.
Aucun fichier de destination verrouillé. Tenter une ouverture en r+ : EBUSY, EPERM ou EACCES signifient qu'IIS tient le fichier. Message explicite : « Fichier verrouillé en production — recyclez le pool IIS ou déposez un app_offline.htm avant de continuer. »
Détection de modification concurrente : re-hasher chaque fichier de destination et comparer au hash relevé pendant le scan. S'il a changé entre-temps, quelqu'un d'autre est passé par là → bloquer et demander une nouvelle analyse.
Espace disque suffisant sur la destination.

Les problèmes sont listés dans une fenêtre récapitulative, séparés en bloquants et avertissements. Un bloquant empêche le déploiement, point.

Écran de confirmation avant exécution, listant : le projet, le nombre de fichiers par statut, le dossier de sauvegarde cible, et le détail intégral des fichiers concernés. Pour valider, je dois saisir le numéro du ticket (4611) dans un champ. Pas de simple bouton « OK » : c'est une mise en prod.

Mode simulation obligatoire, coché par défaut au premier lancement : exécute tout le processus, produit le rapport complet, mais n'écrit aucun octet.

Séquence par fichier :

Si le fichier existe déjà en prod → calculer son SHA-256, puis le copier vers <dossier de sauvegarde>\<chemin relatif> en recréant l'arborescence relative, et en conservant sa date de modification d'origine.
Copier la version locale vers la prod, en conservant la date locale.
Consigner l'opération.

Si un fichier échoue, poursuivre les autres et faire remonter l'échec dans le rapport final. Un fichier archivé mais non copié doit être signalé explicitement comme tel.

Optionnel, à mettre derrière une case à cocher désactivée par défaut : déposer un app_offline.htm dans la racine du site avant la copie et le retirer après, avec un contenu personnalisable dans les réglages.

5.8 Manifeste et retour arrière

À chaque déploiement réel, écrire dans le dossier de sprint un _deploiement_<horodatage>.json :

json
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

Écrire aussi un _recapitulatif.md lisible dans le même dossier : date, auteur, liste des fichiers, nombre de lignes modifiées. C'est ce que je transmets pour la traçabilité.

Écran Historique listant tous les manifestes trouvés sous Z:\AvMdf (tous tickets confondus), triés par date, avec pour chacun : le détail des fichiers, un bouton « Voir ce qui a changé » (diff entre la sauvegarde et la version actuellement en prod) et un bouton « Revenir en arrière ».

Le retour arrière restaure les fichiers remplacement depuis la sauvegarde et supprime les fichiers creation. Même exigence de confirmation que pour un déploiement, mêmes contrôles de verrouillage, et il produit lui-même un manifeste de restauration. Avertir si un fichier a été modifié en prod après le déploiement d'origine (hash actuel ≠ hashApres) : le retour arrière écraserait ces modifications.

5.9 Journal

Fichier journal quotidien dans userData/logs/, en texte, une ligne par événement horodaté (scan lancé, scan terminé, déploiement, échec, retour arrière). Consultable depuis l'interface, avec un bouton pour ouvrir le dossier.

6. Interface

L'application doit ressembler à un outil d'exploitation, pas à une page marketing : dense, lisible, sans animation superflue.

Disposition :

┌──────────────────────────────────────────────────────────────────────────────┐
│ Projet [GPNet ▾]   E:\…\GPNET → Z:\GPNet      [Analyser]  ⚙ Réglages         │
├────────────────────────────────┬─────────────────────────────────────────────┤
│ 🔍 recherche          [regex]  │  Principal\Recherche.aspx        +18 −7     │
│ ☑M 142  ☑+ 31  ☑− 4  ☐= 3303  │  Prod (UTF-8)        │  Local (UTF-8)       │
│ ext ▾   depuis ▾   [Réinit.]   │ ─────────────────────┼──────────────────────│
│                                │  118  <asp:Label…    │ 118  <asp:Label…     │
│  ▾ 📁 Principal          M 12  │  119 −var x = 1;     │ 119 +var x = 2;      │
│      M  Recherche.aspx         │      ⋯ 42 lignes identiques                 │
│      +  Export.js              │                                             │
├────────────────────────────────┴─────────────────────────────────────────────┤
│ 23 fichiers → Z:\AvMdf\AVMDF4611\AVMDF4611_3   ☑ Simulation  [Mettre en prod] │
└──────────────────────────────────────────────────────────────────────────────┘

Direction visuelle : thème sombre froid (fond proche de 
#16191d, panneaux 
#1c2026, séparateurs 
#2e353f, texte 
#d5dae1). Accent laiton/ambre (
#c9963f) réservé aux actions de production — ni bleu générique, ni terracotta. Statuts : modifié bleu (
#4f8cc9), nouveau vert (
#5aa96b), orphelin rouille (
#b56a5a), identique atténué. Diff : ajout sur 
#1e3326, suppression sur 
#3a2226.

Typographie : Segoe UI Variable pour l'interface, Cascadia Mono puis Consolas en repli pour tous les chemins, numéros de ligne et contenus de fichiers. Aucune police web : l'outil doit fonctionner sur un poste sans accès Internet.

Élément signature : le bandeau de mise en production en bas, qui se comporte comme un plan de vol — il affiche en permanence l'état exact de ce qui va partir et où, et change de teinte quand la simulation est désactivée.

Exigences de qualité : focus clavier visible partout ; raccourcis F5 analyser, Ctrl+F rechercher, F8 changement suivant, Ctrl+Entrée déployer ; prefers-reduced-motion respecté ; état vide utile (« Aucun écart détecté entre local et prod. » plutôt qu'un écran blanc) ; messages d'erreur qui disent ce qui s'est passé et quoi faire, jamais « Une erreur est survenue ».

Rédaction des libellés : infinitif ou impératif, phrases courtes, vocabulaire constant. Le bouton dit « Mettre en production », le message de fin dit « Mise en production terminée ». Pas de jargon technique dans l'interface visible.

7. Contraintes techniques à respecter
Toute écriture passe par le processus principal. Le renderer n'a aucun accès direct au filesystem.
Aucune écriture hors des racines configurées. Valider chaque chemin de destination : résoudre en absolu et vérifier qu'il est bien sous la racine prod ou la racine AVMDF. Refuser tout .. qui sortirait du périmètre.
Séparateurs Windows (\) partout dans les chemins relatifs manipulés et affichés.
Comparaison de chemins insensible à la casse, affichage respectant la casse réelle.
Gérer les chemins longs (> 260 caractères) : préfixe \\?\ sur les opérations filesystem, sinon les copies échoueront silencieusement sur les arborescences profondes.
Aucune opération bloquante sur le thread principal : le scan, le diff et le déploiement doivent tous être annulables et laisser l'interface réactive.
Le code métier de core/ ne doit dépendre ni d'Electron ni du DOM.
8. Plan de développement

Procède par étapes et arrête-toi après chacune pour que je valide. Ne saute pas d'étape et ne construis pas tout d'un coup.

Squelette — package.json, fenêtre Electron, preload.js, config.js avec l'écran Réglages complet et fonctionnel. Vérifiable : je modifie une racine, je redémarre, elle est conservée.
Scan et comparaison — fsindex.js, compare.js, arbre affiché avec statuts et compteurs, progression et annulation. Vérifiable sur le vrai E:\ / Z:\.
Recherche et filtres — search.js et toute la barre de filtres.
Diff — textdiff.js et la vue côte à côte complète, y compris encodage, repliage et surlignage intra-ligne.
AVMDF — avmdf.js, détection des tickets et des conventions, panneau de destination.
Déploiement — deploy.js, préflight, confirmation, simulation, exécution, manifeste, récapitulatif.
Historique et retour arrière.
Journal, packaging electron-builder, README.

Après chaque étape : dis-moi ce qui est fait, ce qui reste, et comment je peux le tester manuellement.

9. Ce qu'il ne faut pas faire
Ne pas comparer sur la date ou la taille seules pour conclure à l'égalité.
Ne pas ré-encoder, reformater ou normaliser les fins de ligne lors de la copie.
Ne pas écraser web.config sans avertissement explicite.
Ne pas déployer sans avoir archivé la version précédente. Aucune exception.
Ne pas interrompre un scan parce qu'un dossier est inaccessible.
Ne pas mélanger Sprint N et <Ticket>_N dans un même ticket.
Ne pas introduire de bundler, d'étape de build ou de dépendance lourde. Le front se limite à Preact + htm vendorisés en ESM : pas d'autre framework, pas de transpilation, pas de JSX.
Ne pas masquer une erreur derrière un catch vide.
Ne pas écrire de tests unitaires pour l'instant — je veux d'abord quelque chose que je peux lancer et essayer sur mes vrais dossiers.
10. Questions à me poser

Si un point te semble ambigu ou si tu penses qu'une décision aurait un impact important sur l'architecture, pose-moi la question avant de coder plutôt que de deviner. Notamment : le comportement attendu sur les fichiers orphelins, la gestion des pools IIS, et le format exact que doit avoir le récapitulatif de traçabilité.