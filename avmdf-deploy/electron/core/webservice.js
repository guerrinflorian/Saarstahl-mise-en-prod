'use strict';

/**
 * webservice.js - mise en production des WebServices.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Un WebService ne se déploie pas comme le front. On ne copie pas des
 * sources, on copie le résultat d'une compilation Release. Le déroulé
 * remplace les gestes faits à la main dans Visual Studio :
 *
 *   1. découverte  : chaque projet du dossier local qui a un dossier du même
 *                    nom en production est un WebService ; les autres sont des
 *                    bibliothèques (OutilsWebService, OutilCryptage…) qui
 *                    partent dans le bin des WS qui les utilisent ;
 *   2. version     : celle de `My Project\AssemblyInfo.vb` contre celle de la
 *                    DLL en production. La version locale doit être plus
 *                    récente, sinon le WS ne se coche pas ;
 *   3. compilation : MSBuild en Release, avec `OutDir` vers un dossier
 *                    temporaire. Le bin du projet de développement n'est
 *                    jamais touché : plus besoin de recompiler en Debug après
 *                    coup. Le résultat est le dossier `_PublishedWebsites`,
 *                    celui qu'aurait produit « Publier » ;
 *   4. comparaison : le résultat contre le dossier de production, à
 *                    l'empreinte. Les DLL tierces identiques ne repartent pas ;
 *                    Web.config et Global.asax ne partent jamais sans être
 *                    cochés à la main ;
 *   5. archivage   : le dossier complet de production est copié sous
 *                    `AvMdf\<demande>\<sprint>\<WS>`, comme on le faisait à la
 *                    main, avant la moindre écriture.
 *
 * La copie elle-même, le manifeste et le retour arrière sont ceux du front
 * (deploy.js) : un passage WebService apparaît dans le même historique et se
 * défait de la même façon.
 */

const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');

const iconv = require('iconv-lite');

const { cheminLong, hashFichier, parcourir, pool, raisonLisible } = require('./fsindex');
const { estSousRacine } = require('./avmdf');
const assembly = require('./assembly');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Projet d'application web ASP.NET (ProjectTypeGuids des .vbproj / .csproj). */
const GUID_APPLICATION_WEB = '349c5851-65df-11da-9384-00065b846f21';

/** Dossiers du dossier local qui ne sont jamais des projets. */
const DOSSIERS_IGNORES = new Set(['.vs', '.git', '.svn', '$tf', 'packages', 'node_modules', 'testresults', 'bin', 'obj']);

const ETAT_PRET = 'pret';
const ETAT_VERSION_IDENTIQUE = 'version-identique';
const ETAT_VERSION_ANCIENNE = 'version-ancienne';
const ETAT_VERSION_INCONNUE = 'version-inconnue';
/** Même numéro qu'en production et aucun source modifié depuis : rien à livrer. */
const ETAT_A_JOUR = 'a-jour';

const STATUT_MODIFIE = 'modifie';
const STATUT_NOUVEAU = 'nouveau';
const STATUT_IDENTIQUE = 'identique';

/**
 * Fichiers du résultat de compilation qui ne partent jamais : transformations
 * de configuration et métadonnées de projet, si jamais elles s'y glissent.
 */
const EXCLUS_SORTIE = [
  'Web.Debug.config',
  'Web.Release.config',
  '*.vbproj',
  '*.csproj',
  '*.user',
  '*.vspscc',
  'packages.config',
  'app_offline.htm'
];

/**
 * Fichiers sensibles : ils portent la configuration de production (chaînes
 * de connexion, clés) ou le point d'entrée de l'application. Comparés et
 * montrés, mais décochés par défaut.
 */
const SENSIBLES = /^(web\.config|global\.asax)$/i;

/** Extensions dont l'écart se lit ligne à ligne dans l'interface. */
const EXTENSIONS_TEXTE = new Set([
  '.config', '.asax', '.xml', '.json', '.txt', '.htm', '.html', '.css', '.js', '.cshtml', '.vbhtml', '.aspx', '.ascx', '.asmx', '.svc', '.map'
]);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Compare deux numéros de version (« 1.0.0.43 »). Les parties manquantes
 * valent 0.
 * @returns {number|null} négatif, zéro ou positif ; null si l'un des deux
 *   n'est pas un numéro exploitable (vide, joker `*`).
 */
function comparerVersions(a, b) {
  const decouper = (version) => {
    const propre = String(version || '').trim();
    if (!/^\d+(\.\d+){0,3}$/.test(propre)) return null;
    const parties = propre.split('.').map((p) => Number.parseInt(p, 10));
    while (parties.length < 4) parties.push(0);
    return parties;
  };
  const gauche = decouper(a);
  const droite = decouper(b);
  if (!gauche || !droite) return null;
  for (let i = 0; i < 4; i += 1) {
    if (gauche[i] !== droite[i]) return gauche[i] - droite[i];
  }
  return 0;
}

/**
 * Lit les attributs de version d'un fichier AssemblyInfo (VB ou C#). Les
 * lignes en commentaire sont ignorées.
 * @param {string} contenu
 * @returns {{ assemblyVersion: string|null, fileVersion: string|null }}
 */
function lireAttributsVersion(contenu) {
  const resultat = { assemblyVersion: null, fileVersion: null };
  for (const brute of String(contenu || '').split(/\r?\n/)) {
    const ligne = brute.trim();
    if (!ligne || ligne.startsWith("'") || ligne.startsWith('//') || /^rem\s/i.test(ligne)) continue;
    const trouve = /^[<[]\s*assembly\s*:\s*(AssemblyVersion|AssemblyFileVersion)(?:Attribute)?\s*\(\s*"([^"]*)"\s*\)\s*[>\]]/i.exec(ligne);
    if (!trouve) continue;
    if (/^AssemblyVersion$/i.test(trouve[1])) resultat.assemblyVersion = trouve[2].trim();
    else resultat.fileVersion = trouve[2].trim();
  }
  return resultat;
}

/**
 * Version déclarée dans les sources du projet : `My Project\AssemblyInfo.vb`
 * en VB, `Properties\AssemblyInfo.cs` en C#.
 * @param {string} dossierProjet
 * @returns {Promise<{ assemblyVersion:string|null, fileVersion:string|null, fichier:string|null, erreur:string|null }>}
 */
async function lireVersionLocale(dossierProjet) {
  const candidats = [
    path.join(dossierProjet, 'My Project', 'AssemblyInfo.vb'),
    path.join(dossierProjet, 'Properties', 'AssemblyInfo.cs'),
    path.join(dossierProjet, 'Properties', 'AssemblyInfo.vb'),
    path.join(dossierProjet, 'AssemblyInfo.vb'),
    path.join(dossierProjet, 'AssemblyInfo.cs')
  ];
  for (const fichier of candidats) {
    let contenu;
    try {
      contenu = await fsp.readFile(cheminLong(fichier));
    } catch (err) {
      continue;
    }
    const texte = decoderTexte(contenu);
    return { ...lireAttributsVersion(texte), fichier, erreur: null };
  }
  return {
    assemblyVersion: null,
    fileVersion: null,
    fichier: null,
    erreur: 'AssemblyInfo introuvable (ni My Project\\AssemblyInfo.vb ni Properties\\AssemblyInfo.cs)'
  };
}

/**
 * Cherche dans la ressource de version Win32 d'une DLL .NET la valeur d'une
 * clé (« Assembly Version », « FileVersion »). Les compilateurs VB et C#
 * écrivent cette ressource à partir des attributs d'AssemblyInfo : c'est ce
 * qu'affiche l'onglet Détails des propriétés du fichier dans l'explorateur.
 *
 * La structure (VS_VERSIONINFO → StringTable → String) range chaque clé en
 * UTF-16, suivie d'un remplissage à 32 bits puis de la valeur.
 */
function chercherChaineVersion(tampon, cle) {
  const motif = Buffer.from(cle + '\0', 'utf16le');
  let position = tampon.indexOf(motif);
  while (position !== -1) {
    let i = position + motif.length;
    let sautes = 0;
    while (i + 1 < tampon.length && tampon.readUInt16LE(i) === 0 && sautes < 4) {
      i += 2;
      sautes += 1;
    }
    let valeur = '';
    while (i + 1 < tampon.length && valeur.length < 64) {
      const code = tampon.readUInt16LE(i);
      if (code === 0) break;
      valeur += String.fromCharCode(code);
      i += 2;
    }
    const propre = valeur.trim();
    if (/^\d+(\.\d+){0,3}$/.test(propre)) return propre;
    position = tampon.indexOf(motif, position + 2);
  }
  return null;
}

/**
 * Version d'une DLL compilée.
 * @param {string} chemin
 * @returns {Promise<{ assemblyVersion:string|null, fileVersion:string|null, erreur:string|null }>}
 */
async function lireVersionDll(chemin) {
  let tampon;
  try {
    tampon = await fsp.readFile(cheminLong(chemin));
  } catch (err) {
    return { assemblyVersion: null, fileVersion: null, erreur: raisonLisible(err) };
  }
  const assemblyVersion = chercherChaineVersion(tampon, 'Assembly Version');
  const fileVersion = chercherChaineVersion(tampon, 'FileVersion');
  return {
    assemblyVersion,
    fileVersion,
    erreur: assemblyVersion || fileVersion ? null : 'aucune ressource de version dans la DLL'
  };
}

/**
 * Version à comparer : AssemblyVersion d'abord, celle que l'on change à
 * chaque mise en production ; FileVersion à défaut.
 */
function versionDe(info) {
  if (!info) return null;
  return info.assemblyVersion || info.fileVersion || null;
}

/**
 * État d'un WS d'après ses deux versions.
 * @returns {{ etat:string, raison:string }}
 */
function etatVersions(versionLocale, versionProd) {
  if (!versionLocale) {
    return { etat: ETAT_VERSION_INCONNUE, raison: 'Version locale illisible : vérifiez My Project\\AssemblyInfo.vb.' };
  }
  if (!versionProd) {
    return {
      etat: ETAT_VERSION_INCONNUE,
      raison: 'Version en production illisible : la comparaison se fera sur les fichiers seulement.'
    };
  }
  const ecart = comparerVersions(versionLocale, versionProd);
  if (ecart === null) {
    return { etat: ETAT_VERSION_INCONNUE, raison: `Version non comparable (${versionLocale} / ${versionProd}).` };
  }
  if (ecart === 0) {
    return {
      etat: ETAT_VERSION_IDENTIQUE,
      raison: `Même version qu'en production (${versionProd}) : changez le numéro d'assembly dans My Project avant de compiler.`
    };
  }
  if (ecart < 0) {
    return {
      etat: ETAT_VERSION_ANCIENNE,
      raison: `La version locale (${versionLocale}) est plus ancienne que celle en production (${versionProd}). Récupérez la dernière version des sources.`
    };
  }
  return { etat: ETAT_PRET, raison: '' };
}

/**
 * Même numéro d'assembly ne veut pas dire même code : on a pu modifier un
 * contrôleur sans monter la version. Les sources modifiés depuis la DLL en
 * production font la différence entre « à jour » (rien à livrer) et
 * « numéro à changer » (du code attend, mais il partirait sous l'ancien
 * numéro).
 *
 * @param {{ total:number } | null} sources sources modifiés depuis la DLL en production
 */
function etatAvecSources(versionLocale, versionProd, sources) {
  const resultat = etatVersions(versionLocale, versionProd);
  if (resultat.etat !== ETAT_VERSION_IDENTIQUE || !sources) return resultat;
  if (!sources.total) {
    return {
      etat: ETAT_A_JOUR,
      raison: `Même version qu'en production (${versionProd}) et aucun fichier source modifié depuis : rien à mettre en production.`
    };
  }
  return {
    etat: ETAT_VERSION_IDENTIQUE,
    raison:
      `Même numéro d'assembly qu'en production (${versionProd}), mais ${sources.total} fichier(s) source modifié(s) depuis ` +
      'la mise en production : ce code partirait sous l\'ancien numéro. Montez le numéro dans My Project avant de compiler.'
  };
}

// ---------------------------------------------------------------------------
// Projets
// ---------------------------------------------------------------------------

/** Décode un fichier texte de Visual Studio : BOM UTF-8 / UTF-16, sinon UTF-8, sinon Windows-1252. */
function decoderTexte(tampon) {
  if (tampon.length >= 2 && tampon[0] === 0xff && tampon[1] === 0xfe) return iconv.decode(tampon.slice(2), 'utf16le');
  if (tampon.length >= 3 && tampon[0] === 0xef && tampon[1] === 0xbb && tampon[2] === 0xbf) return tampon.slice(3).toString('utf8');
  const texte = tampon.toString('utf8');
  return texte.includes('\ufffd') ? iconv.decode(tampon, 'win1252') : texte;
}

/**
 * Lit ce qui compte dans un fichier projet : nom de l'assembly, type de
 * projet, packages NuGet à la mode `packages.config`.
 */
function lireProjet(contenu, cheminProjet) {
  const nomFichier = path.basename(cheminProjet).replace(/\.(vb|cs)proj$/i, '');
  const assembly = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(contenu);
  const types = /<ProjectTypeGuids>([^<]*)<\/ProjectTypeGuids>/i.exec(contenu);
  const web =
    Boolean(types && types[1].toLowerCase().includes(GUID_APPLICATION_WEB)) ||
    /Microsoft\.WebApplication\.targets/i.test(contenu);
  // Projets référencés (OutilsWebService…) : leurs fichiers en attente dans
  // TFS partent aussi en production, dans le bin du WebService.
  const references = [];
  const motif = /<ProjectReference\s+Include="([^"]+)"/gi;
  let trouve;
  // Chemins Windows en exploitation ; chemins POSIX quand on exerce le module
  // ailleurs (tests).
  const p = cheminProjet.includes('\\') ? path.win32 : path.posix;
  while ((trouve = motif.exec(contenu))) {
    const inclus = p === path.posix ? trouve[1].replace(/\\/g, '/') : trouve[1];
    references.push(p.dirname(p.join(p.dirname(cheminProjet), inclus)));
  }
  return {
    nomProjet: nomFichier,
    assemblyName: assembly ? assembly[1] : nomFichier,
    web,
    langue: /\.csproj$/i.test(cheminProjet) ? 'cs' : 'vb',
    projetsReferences: references
  };
}

async function listerDossier(dossier) {
  try {
    return await fsp.readdir(cheminLong(dossier), { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

/**
 * Trouve le fichier projet d'un dossier : `<dossier>\*.vbproj` (ou .csproj),
 * sinon un niveau plus bas, dans le sous-dossier du même nom (solution rangée
 * à part).
 */
async function trouverProjet(dossier) {
  const contenu = await listerDossier(dossier);
  if (!contenu) return null;
  const projets = contenu.filter((e) => e.isFile() && /\.(vb|cs)proj$/i.test(e.name));
  if (projets.length) {
    const nom = path.basename(dossier).toLowerCase();
    const prefere = projets.find((e) => e.name.toLowerCase().replace(/\.(vb|cs)proj$/, '') === nom) || projets[0];
    return path.join(dossier, prefere.name);
  }
  const homonyme = contenu.find((e) => e.isDirectory() && e.name.toLowerCase() === path.basename(dossier).toLowerCase());
  if (homonyme) return trouverProjet(path.join(dossier, homonyme.name));
  return null;
}

async function existeDossier(chemin) {
  try {
    return (await fsp.stat(cheminLong(chemin))).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Inventaire des WebServices : chaque dossier du dossier local qui contient un
 * projet, apparié au dossier de même nom en production.
 *
 * @param {{ racineLocale:string, racineProd:string }} racines
 * @returns {Promise<{ webservices:object[], bibliotheques:object[], erreurs:string[] }>}
 */
async function listerWebServices({ racineLocale, racineProd, concurrence = 6 }) {
  const erreurs = [];
  const contenu = await listerDossier(racineLocale);
  if (!contenu) {
    return {
      webservices: [],
      bibliotheques: [],
      erreurs: [`Dossier local des WebServices inaccessible : ${racineLocale}`]
    };
  }
  if (!(await existeDossier(racineProd))) {
    erreurs.push(`Dossier de production des WebServices inaccessible : ${racineProd}`);
  }

  const dossiers = contenu.filter((e) => e.isDirectory() && !DOSSIERS_IGNORES.has(e.name.toLowerCase()) && !e.name.startsWith('.'));
  const webservices = [];
  const bibliotheques = [];

  await pool(dossiers, concurrence, async (element) => {
    const dossier = path.join(racineLocale, element.name);
    const projet = await trouverProjet(dossier);
    if (!projet) return;

    let infos;
    try {
      infos = lireProjet(decoderTexte(await fsp.readFile(cheminLong(projet))), projet);
    } catch (err) {
      erreurs.push(`${projet} : fichier projet illisible (${raisonLisible(err)})`);
      return;
    }

    const dossierProjet = path.dirname(projet);
    const nom = element.name;
    const dossierProd = path.join(racineProd, nom);
    const enProd = await existeDossier(dossierProd);

    const entree = {
      nom,
      projet,
      dossierProjet,
      dossierProd,
      enProd,
      web: infos.web,
      assemblyName: infos.assemblyName,
      langue: infos.langue,
      projetsReferences: infos.projetsReferences
    };

    if (!enProd) {
      entree.raison = infos.web
        ? `Aucun dossier ${nom} en production : créez d'abord l'application dans IIS, puis copiez-la une première fois à la main.`
        : 'Bibliothèque : elle part dans le bin de chaque WebService qui l\'utilise, à la compilation de celui-ci.';
      bibliotheques.push(entree);
      return;
    }

    const dllProd = path.join(dossierProd, 'bin', infos.assemblyName + '.dll');
    const [locale, prod, etatDllProd] = await Promise.all([
      lireVersionLocale(dossierProjet),
      lireVersionDll(dllProd),
      fsp.stat(cheminLong(dllProd)).catch(() => null)
    ]);
    // Date de la DLL en production : à peu de chose près, celle de la
    // dernière mise en production. Tout source plus récent n'y est pas encore.
    entree.dateProd = etatDllProd ? etatDllProd.mtimeMs : null;
    entree.sourcesModifiees = entree.dateProd
      ? await sourcesModifieesDepuis(dossierProjet, entree.dateProd)
      : { fichiers: [], total: 0 };
    entree.versionLocale = versionDe(locale);
    entree.versionLocaleFichier = locale.fichier;
    entree.versionLocaleDetail = locale;
    entree.versionProd = versionDe(prod);
    entree.versionProdDetail = prod;
    const { etat, raison } = etatAvecSources(entree.versionLocale, entree.versionProd, entree.sourcesModifiees);
    entree.etat = etat;
    entree.raison = raison;
    entree.selectionnable = etat === ETAT_PRET || etat === ETAT_VERSION_INCONNUE;
    webservices.push(entree);
  });

  const parNom = (a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' });
  webservices.sort(parNom);
  bibliotheques.sort(parNom);
  return { webservices, bibliotheques, erreurs };
}

// ---------------------------------------------------------------------------
// Ce qui a changé depuis la mise en production
// ---------------------------------------------------------------------------

/** Ce qui n'est pas du code du projet : sorties de compilation, outillage. */
const DOSSIERS_HORS_SOURCES = ['bin', 'obj', '.vs', '$tf', 'packages', 'node_modules', 'TestResults', 'App_Data'];
const FICHIERS_HORS_SOURCES = ['*.user', '*.suo', '*.vspscc', '*.vssscc', '*.cache', 'Thumbs.db', 'desktop.ini', '*.tmp'];

/**
 * Sources du projet dont la date est plus récente que la DLL en production :
 * ce qui n'est probablement pas encore parti. C'est un indice, pas une
 * preuve - une récupération TFS peut rajeunir la date d'un fichier inchangé -
 * mais il dit d'un coup d'œil sur quoi porte la nouvelle version.
 *
 * @param {string} dossierProjet
 * @param {number} depuisMs date de la DLL en production
 * @returns {Promise<{ fichiers: Array<{chemin:string, mtimeMs:number}>, total:number }>}
 */
async function sourcesModifieesDepuis(dossierProjet, depuisMs, maximum = 200) {
  const { entrees } = await parcourir(dossierProjet, {
    dossiersExclus: DOSSIERS_HORS_SOURCES,
    fichiersExclus: FICHIERS_HORS_SOURCES,
    concurrence: 4
  });
  const recents = [];
  for (const entree of entrees.values()) {
    // Deux secondes de marge : la copie vers le partage arrondit les dates.
    if (entree.mtimeMs > depuisMs + 2000) recents.push({ chemin: entree.chemin, mtimeMs: entree.mtimeMs });
  }
  recents.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { fichiers: recents.slice(0, maximum), total: recents.length };
}

// ---------------------------------------------------------------------------
// Emplacement des dossiers WebService
// ---------------------------------------------------------------------------

function styleWindows(chemin) {
  return /^[a-z]:/i.test(chemin) || chemin.startsWith('\\\\') || chemin.includes('\\');
}

/**
 * Trouve le dossier des WebServices à partir d'une racine et d'un nom
 * relatif. La racine locale est souvent celle du front
 * (`E:\…\Process\GPNET`) alors que les WebServices sont à côté
 * (`E:\…\Process\WebService`) : le dossier est cherché dans la racine,
 * puis à côté d'elle, puis un cran plus haut. Un chemin complet est pris tel
 * quel.
 *
 * @returns {Promise<{ chemin:string, trouve:boolean, essais:string[] }>}
 */
async function resoudreDossierWs(racine, dossier) {
  const nom = String(dossier || '').trim();
  const base = String(racine || '').trim().replace(/[\\/]+$/, '');
  if (/^([a-z]:|\\\\)/i.test(nom) || nom.startsWith('/')) {
    return { chemin: nom, trouve: await existeDossier(nom), essais: [nom] };
  }
  const p = styleWindows(base) ? path.win32 : path.posix;
  const essais = [];
  let courant = base;
  for (let niveau = 0; niveau < 3 && courant; niveau += 1) {
    const candidat = p.join(courant, nom);
    if (!essais.includes(candidat)) essais.push(candidat);
    const parent = p.dirname(courant);
    if (parent === courant) break;
    courant = parent;
  }
  for (const candidat of essais) {
    if (await existeDossier(candidat)) return { chemin: candidat, trouve: true, essais };
  }
  return { chemin: essais[0] || nom, trouve: false, essais };
}

// ---------------------------------------------------------------------------
// NuGet
// ---------------------------------------------------------------------------

/**
 * Les packages déclarés dans `packages.config` sont-ils présents dans le
 * dossier `packages` de la solution ? MSBuild ne les télécharge pas de
 * lui-même : il faut les avoir restaurés une fois dans Visual Studio.
 *
 * @returns {Promise<{ dossierPaquets:string|null, manquants:string[], declares:number }>}
 */
async function verifierPaquets(dossierProjet) {
  let contenu;
  try {
    contenu = decoderTexte(await fsp.readFile(cheminLong(path.join(dossierProjet, 'packages.config'))));
  } catch (err) {
    return { dossierPaquets: null, manquants: [], declares: 0 };
  }
  const paquets = [];
  const motif = /<package\s+[^>]*?id="([^"]+)"[^>]*?version="([^"]+)"/gi;
  let trouve;
  while ((trouve = motif.exec(contenu))) paquets.push(`${trouve[1]}.${trouve[2]}`);

  // Le dossier `packages` est à côté de la solution : on remonte depuis le
  // projet jusqu'à le trouver.
  let dossier = dossierProjet;
  let dossierPaquets = null;
  for (let niveau = 0; niveau < 5; niveau += 1) {
    const candidat = path.join(dossier, 'packages');
    if (await existeDossier(candidat)) {
      dossierPaquets = candidat;
      break;
    }
    const parent = path.dirname(dossier);
    if (parent === dossier) break;
    dossier = parent;
  }
  if (!dossierPaquets) return { dossierPaquets: null, manquants: paquets, declares: paquets.length };

  const presents = new Set(((await listerDossier(dossierPaquets)) || []).map((e) => e.name.toLowerCase()));
  const manquants = paquets.filter((p) => !presents.has(p.toLowerCase()));
  return { dossierPaquets, manquants, declares: paquets.length };
}

// ---------------------------------------------------------------------------
// MSBuild
// ---------------------------------------------------------------------------

function executerCourt(executable, args, delai = 15000) {
  return new Promise((resoudre) => {
    execFile(executable, args, { timeout: delai, windowsHide: true, encoding: 'buffer' }, (err, sortie) => {
      if (err) return resoudre(null);
      resoudre(decoderSortie(sortie));
    });
  });
}

async function fichierExiste(chemin) {
  try {
    return (await fsp.stat(cheminLong(chemin))).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * Emplacements où chercher MSBuild, du plus récent au plus ancien. Visual
 * Studio 2022 s'installe sous « Program Files », les précédents sous
 * « Program Files (x86) ».
 */
function emplacementsConnus(env = process.env) {
  const x86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const x64 = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  const editions = ['Enterprise', 'Professional', 'Community', 'BuildTools'];
  const liste = [];
  for (const edition of editions) liste.push(path.win32.join(x64, 'Microsoft Visual Studio', '2022', edition, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'));
  for (const edition of editions) liste.push(path.win32.join(x86, 'Microsoft Visual Studio', '2019', edition, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'));
  for (const edition of editions) liste.push(path.win32.join(x86, 'Microsoft Visual Studio', '2017', edition, 'MSBuild', '15.0', 'Bin', 'MSBuild.exe'));
  liste.push(path.win32.join(x86, 'MSBuild', '14.0', 'Bin', 'MSBuild.exe'));
  liste.push(path.win32.join(x86, 'MSBuild', '12.0', 'Bin', 'MSBuild.exe'));
  return liste;
}

/**
 * Trouve MSBuild. Ordre : chemin des réglages, vswhere (l'outil officiel de
 * Visual Studio 2017 et suivants), emplacements connus.
 *
 * @param {{ cheminForce?: string, env?: object }} [options]
 * @returns {Promise<{ chemin:string|null, source:string, version:string|null, erreur:string|null }>}
 */
async function localiserMsbuild(options = {}) {
  const { cheminForce = '', env = process.env } = options;

  if (cheminForce) {
    if (await fichierExiste(cheminForce)) {
      return { chemin: cheminForce, source: 'réglages', version: await versionMsbuild(cheminForce), erreur: null };
    }
    return {
      chemin: null,
      source: 'réglages',
      version: null,
      erreur: `MSBuild introuvable à l'emplacement indiqué dans les réglages : ${cheminForce}`
    };
  }

  const x86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.win32.join(x86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (process.platform === 'win32' && (await fichierExiste(vswhere))) {
    const sortie = await executerCourt(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.Component.MSBuild',
      '-find',
      'MSBuild\\**\\Bin\\MSBuild.exe'
    ]);
    const premier = sortie && sortie.split(/\r?\n/).map((l) => l.trim()).find((l) => /msbuild\.exe$/i.test(l) && !/\\amd64\\/i.test(l));
    if (premier && (await fichierExiste(premier))) {
      return { chemin: premier, source: 'Visual Studio (vswhere)', version: await versionMsbuild(premier), erreur: null };
    }
  }

  for (const candidat of emplacementsConnus(env)) {
    if (await fichierExiste(candidat)) {
      return { chemin: candidat, source: 'emplacement connu', version: await versionMsbuild(candidat), erreur: null };
    }
  }

  return {
    chemin: null,
    source: 'détection automatique',
    version: null,
    erreur:
      'MSBuild introuvable sur ce poste. Il est installé avec Visual Studio : indiquez son chemin dans Réglages → WebServices ' +
      '(par exemple C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe).'
  };
}

async function versionMsbuild(chemin) {
  if (process.platform !== 'win32') return null;
  const sortie = await executerCourt(chemin, ['-version', '-nologo'], 20000);
  if (!sortie) return null;
  const lignes = sortie.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lignes.length ? lignes[lignes.length - 1] : null;
}

/**
 * La console de MSBuild écrit dans la page de code OEM du poste (850 sur un
 * Windows français) quand sa sortie est redirigée ; parfois en UTF-8. On
 * prend l'UTF-8 s'il est valide, sinon l'OEM.
 */
function decoderSortie(tampon) {
  if (!tampon || !tampon.length) return '';
  const utf8 = tampon.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  return iconv.decode(tampon, 'cp850');
}

/** Arguments de la ligne de commande MSBuild. */
function argumentsMsbuild({ projet, configuration, dossierSortie }) {
  // La barre finale de OutDir est exigée par MSBuild.
  const outDir = dossierSortie.replace(/[\\/]+$/, '') + path.sep;
  return [
    projet,
    '/t:Build',
    `/p:Configuration=${configuration}`,
    // Tout le résultat part dans le dossier temporaire, y compris celui des
    // bibliothèques référencées : rien n'est écrit dans les bin du poste de
    // développement, qui restent compilés en Debug.
    `/p:OutDir=${outDir}`,
    // Produit `_PublishedWebsites\<projet>` : le site prêt à copier, avec le
    // Web.config transformé pour la configuration demandée - le même résultat
    // qu'une publication vers un dossier depuis Visual Studio.
    '/p:UseWPP_CopyWebApplication=true',
    '/p:PipelineDependsOnBuild=false',
    '/nologo',
    '/nr:false',
    '/v:minimal',
    '/clp:Summary;ForceNoAlign'
  ];
}

/**
 * Empreinte légère d'un dossier (nom, taille, date) : de quoi prouver que la
 * compilation n'a pas touché au bin du projet de développement.
 */
async function empreinteDossier(dossier) {
  const { entrees } = await parcourir(dossier, { concurrence: 4 });
  const empreinte = new Map();
  for (const [cle, entree] of entrees) empreinte.set(cle, `${entree.taille}:${Math.round(entree.mtimeMs)}`);
  return empreinte;
}

function differencesEmpreintes(avant, apres) {
  const changes = [];
  for (const [cle, valeur] of apres) {
    if (avant.get(cle) !== valeur) changes.push(cle);
  }
  for (const cle of avant.keys()) {
    if (!apres.has(cle)) changes.push(cle);
  }
  return changes;
}

/** Arrête MSBuild et ses processus enfants. */
function arreterProcessus(enfant) {
  if (!enfant || enfant.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(enfant.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    enfant.kill('SIGTERM');
  }
}

/**
 * Compile un WebService en Release dans un dossier temporaire.
 *
 * @param {object} parametres
 * @param {string} parametres.msbuild chemin de MSBuild.exe
 * @param {object} parametres.ws entrée de `listerWebServices`
 * @param {string} parametres.dossierTravail dossier temporaire propre à cette compilation
 * @param {string} [parametres.configuration]
 * @param {(lignes:string[]) => void} [parametres.surLignes] sortie de MSBuild, au fil de l'eau
 * @param {{annule:boolean, surAnnulation?:Function}} [parametres.signal]
 * @returns {Promise<object>}
 */
// ---------------------------------------------------------------------------
// Fichiers intermédiaires (obj\<configuration>)
// ---------------------------------------------------------------------------

/**
 * Dossiers `obj\<configuration>` du WebService et des projets qu'il
 * référence. `OutDir` envoie le résultat dans le temporaire, mais MSBuild
 * écrit toujours ses fichiers de travail (ressources, caches, liste des
 * fichiers produits) dans le `obj\Release` de chaque projet. Le bin et
 * `obj\Debug` du poste de développement, eux, ne sont jamais touchés.
 */
function dossiersIntermediaires(ws, configuration = 'Release') {
  const projets = [ws.dossierProjet, ...(ws.projetsReferences || [])];
  const vus = new Set();
  return projets
    .map((dossier) => path.join(dossier, 'obj', configuration))
    .filter((dossier) => {
      const cle = dossier.toLowerCase();
      if (vus.has(cle)) return false;
      vus.add(cle);
      return true;
    });
}

/**
 * Retire l'attribut lecture seule des fichiers intermédiaires. Ils ne
 * devraient jamais l'avoir ; ils l'ont quand le dossier `obj` a été ajouté
 * par erreur au contrôle de source (TFS pose la lecture seule sur ce qu'il
 * gère), et MSBuild échoue alors avec « accès refusé » (MSB3554, MSB3491).
 *
 * @returns {Promise<{ corriges: string[], erreurs: string[] }>}
 */
async function deverrouillerIntermediaires(dossiers) {
  const bilan = { corriges: [], erreurs: [] };
  for (const dossier of dossiers) {
    const { entrees } = await parcourir(dossier, { concurrence: 4 });
    for (const entree of entrees.values()) {
      try {
        const etat = await fsp.stat(cheminLong(entree.absolu));
        if ((etat.mode & 0o200) === 0) {
          await fsp.chmod(cheminLong(entree.absolu), 0o666);
          bilan.corriges.push(entree.absolu);
        }
      } catch (err) {
        bilan.erreurs.push(`${entree.absolu} : ${raisonLisible(err)}`);
      }
    }
  }
  return bilan;
}

/**
 * Supprime les dossiers intermédiaires : MSBuild les recrée entièrement à la
 * compilation suivante. C'est le remède quand la lecture seule n'était pas la
 * cause (fichiers créés par un autre compte Windows, par exemple).
 */
async function viderIntermediaires(dossiers) {
  const bilan = { supprimes: [], erreurs: [] };
  for (const dossier of dossiers) {
    try {
      await deverrouillerIntermediaires([dossier]);
      await fsp.rm(cheminLong(dossier), { recursive: true, force: true });
      bilan.supprimes.push(dossier);
    } catch (err) {
      bilan.erreurs.push(`${dossier} : ${raisonLisible(err)}`);
    }
  }
  return bilan;
}

/**
 * Découpe une ligne d'erreur MSBuild :
 * « origine(ligne,col): error CODE: message [projet] ».
 */
function lireErreurMsbuild(ligne) {
  const trouve = /^\s*(.*?)(?:\((\d+)(?:,\d+)*\))?\s*:\s*(?:error|erreur)\s*([A-Z]+\d+)?\s*:\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/i.exec(ligne);
  if (!trouve) return { code: null, message: ligne.trim(), fichier: null, ligne: null };
  const origine = trouve[1].trim();
  // Les cibles de MSBuild lui-même ne disent rien d'utile : seul un fichier
  // du projet mérite d'être cité.
  const fichier = /\\MSBuild\\|Microsoft\.[A-Za-z.]+\.targets$/i.test(origine) ? null : origine || null;
  return { code: trouve[3] || null, message: trouve[4].trim(), fichier, ligne: fichier && trouve[2] ? Number(trouve[2]) : null };
}

/** L'échec vient-il d'un accès refusé sur les fichiers intermédiaires ? */
function diagnostiquer(erreurs, dossiers) {
  const acces = erreurs.filter(
    (e) => /^(MSB3554|MSB3491|MSB3101|MSB3021|MSB3027|MSB4018)$/i.test(e.code || '') || /acc[eè]s.*refus|access.*denied/i.test(e.message)
  );
  const touchesObj = acces.filter((e) => /[\\/]obj[\\/]/i.test(e.message));
  if (!touchesObj.length) return null;
  return { type: 'obj-acces', dossiers };
}

async function compiler(parametres) {
  const {
    msbuild,
    ws,
    dossierTravail,
    configuration = 'Release',
    surLignes = null,
    signal = { annule: false }
  } = parametres;

  const debut = Date.now();
  const dossierSortie = path.join(dossierTravail, 'compilation');
  const resultat = {
    ok: false,
    code: null,
    annule: false,
    duree: 0,
    commande: null,
    erreurs: [],
    erreursDetail: [],
    avertissements: 0,
    lignes: [],
    sortie: null,
    versionCompilee: null,
    binLocalModifie: [],
    intermediaires: [],
    deverrouilles: 0,
    diagnostic: null,
    erreur: null
  };
  // MSBuild répète chaque erreur et chaque avertissement dans son résumé de
  // fin : on ne compte chaque ligne qu'une fois.
  const erreursVues = new Set();
  const avertissementsVus = new Set();

  await fsp.rm(cheminLong(dossierTravail), { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(cheminLong(dossierSortie), { recursive: true });

  const binLocal = path.join(ws.dossierProjet, 'bin');
  const avant = await empreinteDossier(binLocal);

  // Fichiers intermédiaires en lecture seule : la cause la plus fréquente
  // d'un « accès refusé » de MSBuild. Ils sont déverrouillés avant de
  // compiler, sans risque - ils ne servent qu'à MSBuild.
  resultat.intermediaires = dossiersIntermediaires(ws, configuration);
  const deverrouillage = await deverrouillerIntermediaires(resultat.intermediaires).catch(() => ({ corriges: [] }));
  resultat.deverrouilles = deverrouillage.corriges.length;

  const args = argumentsMsbuild({ projet: ws.projet, configuration, dossierSortie });
  resultat.commande = `"${msbuild}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;

  const tampon = { reste: Buffer.alloc(0), lot: [] };
  let minuteur = null;
  const vider = () => {
    minuteur = null;
    if (tampon.lot.length && surLignes) surLignes(tampon.lot.splice(0));
    else tampon.lot.length = 0;
  };
  const recevoir = (morceau) => {
    let donnees = Buffer.concat([tampon.reste, morceau]);
    let fin = donnees.indexOf(0x0a);
    while (fin !== -1) {
      const ligne = decoderSortie(donnees.slice(0, fin)).replace(/\r$/, '');
      donnees = donnees.slice(fin + 1);
      noterLigne(ligne);
      fin = donnees.indexOf(0x0a);
    }
    tampon.reste = donnees;
    if (!minuteur) minuteur = setTimeout(vider, 120);
  };
  const noterLigne = (ligne) => {
    resultat.lignes.push(ligne);
    if (resultat.lignes.length > 4000) resultat.lignes.splice(0, resultat.lignes.length - 4000);
    const propre = ligne.trim();
    if (/:\s*(error|erreur)\s*[A-Z]*\d*\s*:/i.test(ligne) && !erreursVues.has(propre) && resultat.erreurs.length < 200) {
      erreursVues.add(propre);
      resultat.erreurs.push(propre);
      resultat.erreursDetail.push(lireErreurMsbuild(propre));
    }
    if (/:\s*(warning|avertissement)\s*[A-Z]*\d*\s*:/i.test(ligne) && !avertissementsVus.has(propre)) {
      avertissementsVus.add(propre);
      resultat.avertissements += 1;
    }
    tampon.lot.push(ligne);
  };

  noterLigne(`> ${resultat.commande}`);

  const code = await new Promise((resoudre) => {
    let enfant;
    try {
      enfant = spawn(msbuild, args, { cwd: path.dirname(ws.projet), windowsHide: true });
    } catch (err) {
      resultat.erreur = `MSBuild n'a pas pu être lancé (${err.message}).`;
      resoudre(null);
      return;
    }
    signal.surAnnulation = () => arreterProcessus(enfant);
    if (signal.annule) arreterProcessus(enfant);
    enfant.stdout.on('data', recevoir);
    enfant.stderr.on('data', recevoir);
    enfant.on('error', (err) => {
      resultat.erreur = `MSBuild n'a pas pu être lancé (${raisonLisible(err)} - ${err.message}).`;
      resoudre(null);
    });
    enfant.on('close', (codeSortie) => resoudre(codeSortie));
  });

  if (tampon.reste.length) noterLigne(decoderSortie(tampon.reste).replace(/\r$/, ''));
  if (minuteur) clearTimeout(minuteur);
  vider();

  resultat.code = code;
  resultat.annule = Boolean(signal.annule);
  resultat.duree = Date.now() - debut;

  const apres = await empreinteDossier(binLocal);
  resultat.binLocalModifie = differencesEmpreintes(avant, apres);

  if (resultat.annule) {
    resultat.erreur = 'Compilation annulée.';
    return resultat;
  }
  if (code !== 0) {
    resultat.diagnostic = diagnostiquer(resultat.erreursDetail, resultat.intermediaires);
    if (!resultat.erreur) {
      resultat.erreur = resultat.diagnostic
        ? 'La compilation a échoué : MSBuild n\'a pas le droit d\'écrire ses fichiers de travail (obj\\' + configuration + ').'
        : resultat.erreurs.length
          ? `La compilation a échoué : ${resultat.erreurs.length} erreur(s).`
          : `La compilation a échoué (code de sortie ${code}).`;
    }
    return resultat;
  }

  // Le site publié porte le nom du fichier projet.
  const publies = path.join(dossierSortie, '_PublishedWebsites');
  const nomProjet = path.basename(ws.projet).replace(/\.(vb|cs)proj$/i, '');
  let sortie = path.join(publies, nomProjet);
  if (!(await existeDossier(sortie))) {
    const contenu = (await listerDossier(publies)) || [];
    const seul = contenu.filter((e) => e.isDirectory());
    sortie = seul.length === 1 ? path.join(publies, seul[0].name) : null;
  }
  if (!sortie) {
    resultat.erreur =
      'La compilation a réussi mais n\'a pas produit de site publié (_PublishedWebsites). ' +
      'Ce projet n\'est peut-être pas une application web ASP.NET.';
    return resultat;
  }

  const dll = path.join(sortie, 'bin', ws.assemblyName + '.dll');
  if (!(await fichierExiste(dll))) {
    resultat.erreur = `La compilation n'a pas produit ${ws.assemblyName}.dll dans le bin publié.`;
    return resultat;
  }

  resultat.sortie = sortie;
  resultat.versionCompilee = versionDe(await lireVersionDll(dll));
  resultat.ok = true;
  return resultat;
}

// ---------------------------------------------------------------------------
// Comparaison
// ---------------------------------------------------------------------------

/**
 * Compare le site compilé au dossier de production.
 *
 * @param {{ sortie:string, prod:string, concurrence?:number, signal?:object }} parametres
 * @returns {Promise<{ fichiers:object[], conserves:string[], ignores:object[] }>}
 */
async function comparerSortie({ sortie, prod, assemblyName = null, concurrence = 6, signal = { annule: false } }) {
  const [gauche, droite] = await Promise.all([
    parcourir(sortie, { fichiersExclus: EXCLUS_SORTIE, concurrence, signal }),
    parcourir(prod, { fichiersExclus: ['app_offline.htm'], concurrence, signal })
  ]);
  if (droite.racineInaccessible) {
    throw Object.assign(new Error(`dossier de production inaccessible (${droite.racineInaccessible}) : ${prod}`), {
      code: 'EPROD'
    });
  }

  const fichiers = [];
  await pool(
    Array.from(gauche.entrees.entries()),
    concurrence,
    async ([cle, local]) => {
      const enProd = droite.entrees.get(cle) || null;
      const entree = {
        cle,
        chemin: local.chemin,
        statut: STATUT_NOUVEAU,
        sensible: SENSIBLES.test(local.chemin),
        texte: EXTENSIONS_TEXTE.has(local.extension),
        local: { absolu: local.absolu, taille: local.taille, mtimeMs: local.mtimeMs, hash: null },
        prod: null
      };
      entree.local.hash = await hashFichier(local.absolu);
      const estAssembly = local.extension === '.dll' || local.extension === '.exe';
      if (estAssembly) {
        entree.local.version = versionDe(await lireVersionDll(local.absolu));
        entree.local.meta = await assembly.analyserFichier(local.absolu);
      }
      if (enProd) {
        entree.prod = { absolu: enProd.absolu, taille: enProd.taille, mtimeMs: enProd.mtimeMs, hash: null };
        entree.prod.hash = await hashFichier(enProd.absolu);
        if (estAssembly) {
          entree.prod.version = versionDe(await lireVersionDll(enProd.absolu));
          entree.prod.meta =
            entree.prod.hash === entree.local.hash ? entree.local.meta : await assembly.analyserFichier(enProd.absolu);
        }
        entree.statut = entree.prod.hash === entree.local.hash ? STATUT_IDENTIQUE : STATUT_MODIFIE;
      }
      fichiers.push(entree);
    },
    signal
  );

  const conserves = [];
  for (const [cle, entree] of droite.entrees) {
    if (!gauche.entrees.has(cle)) conserves.push(entree.chemin);
  }

  const ordre = (a, b) => a.chemin.localeCompare(b.chemin, 'fr', { sensitivity: 'base' });
  fichiers.sort(ordre);
  conserves.sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

  // DLL présentes seulement en production : elles restent dans le bin, et
  // comptent pour savoir si les dépendances seront trouvées.
  const binConserve = [];
  for (const [cle, entree] of droite.entrees) {
    if (gauche.entrees.has(cle) || !/^bin\\[^\\]+\.(dll|exe)$/i.test(entree.chemin)) continue;
    const meta = await assembly.analyserFichier(entree.absolu);
    if (meta) binConserve.push({ chemin: entree.chemin, meta });
  }

  // Écart d'API de l'assembly du WebService lui-même.
  let api = null;
  if (assemblyName) {
    const principal = fichiers.find((f) => f.chemin.toLowerCase() === `bin\\${assemblyName.toLowerCase()}.dll`);
    if (principal && principal.local.meta) {
      api = assembly.comparerApi(principal.prod ? principal.prod.meta : null, principal.local.meta);
      api.sansProd = !principal.prod;
    }
  }

  // Clés du Web.config : ce qui manque en production.
  const configLocal = fichiers.find((f) => f.chemin.toLowerCase() === 'web.config');
  let config = null;
  if (configLocal) {
    const lire = async (chemin) => (chemin ? decoderTexte(await fsp.readFile(cheminLong(chemin))) : null);
    try {
      // Les deux textes restent sur l'entrée : la vérification des
      // dépendances lit les redirections de celui qui sera en production.
      configLocal.local.texte = await lire(configLocal.local.absolu);
      if (configLocal.prod) configLocal.prod.texte = await lire(configLocal.prod.absolu);
      config = comparerConfig(configLocal.prod ? configLocal.prod.texte : null, configLocal.local.texte);
    } catch (err) {
      config = null;
    }
  }

  // Code modifié, méthode par méthode, dans chaque DLL de nos projets qui
  // change (les bibliothèques tierces sont l'affaire de NuGet).
  const methodes = [];
  for (const f of fichiers) {
    if (f.statut !== STATUT_MODIFIE || !/^bin\\[^\\]+\.dll$/i.test(f.chemin)) continue;
    if (TIERCES.test(path.basename(f.chemin)) || !f.local.meta || !f.prod || !f.prod.meta) continue;
    try {
      const ecart = assembly.comparerMethodes(
        await fsp.readFile(cheminLong(f.prod.absolu)),
        await fsp.readFile(cheminLong(f.local.absolu))
      );
      if (ecart) methodes.push({ dll: f.chemin, ...ecart });
    } catch (err) {
      /* DLL illisible : la comparaison fichier par fichier reste */
    }
  }

  return { fichiers, conserves, binConserve, api, config, methodes, ignores: gauche.ignores.concat(droite.ignores) };
}

// ---------------------------------------------------------------------------
// Sources livrées : le code VB qui tourne en production
// ---------------------------------------------------------------------------

/** Fichiers sources qui se lisent ligne à ligne dans le comparateur. */
const EXTENSIONS_SOURCES_TEXTE = new Set([
  '.vb', '.cs', '.config', '.asax', '.aspx', '.ascx', '.asmx', '.svc', '.master', '.xml', '.json', '.cshtml', '.vbhtml',
  '.js', '.css', '.resx', '.settings', '.vbproj', '.csproj', '.sql', '.txt', '.htm', '.html', '.xsd', '.tt', '.edmx'
]);

/**
 * Dossiers de sources qui composent un WebService : son projet et les
 * projets qu'il référence (OutilsWebService…), chacun avec son chemin
 * relatif au dossier des WebServices - c'est sous ce nom qu'il est rangé.
 */
function dossiersSources(ws, racineLocale) {
  const dossiers = [ws.dossierProjet, ...(ws.projetsReferences || [])];
  const vus = new Set();
  const resultat = [];
  for (const dossier of dossiers) {
    const cle = dossier.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    let relatif = racineLocale ? path.relative(racineLocale, dossier) : '';
    if (!relatif || relatif.startsWith('..') || path.isAbsolute(relatif)) relatif = path.basename(dossier);
    resultat.push({ dossier, relatif: relatif.split(/[\\/]+/).join('\\') });
  }
  return resultat;
}

async function inventaireSources(dossiers, concurrence = 4) {
  const entrees = new Map();
  for (const { dossier, relatif } of dossiers) {
    const lu = await parcourir(dossier, {
      dossiersExclus: DOSSIERS_HORS_SOURCES,
      fichiersExclus: FICHIERS_HORS_SOURCES,
      concurrence
    });
    for (const entree of lu.entrees.values()) {
      const chemin = relatif + '\\' + entree.chemin;
      entrees.set(chemin.toLowerCase(), { ...entree, chemin });
    }
  }
  return entrees;
}

/**
 * Copie les sources d'un WebService (projet et bibliothèques référencées,
 * sans bin ni obj) dans un dossier. Sert deux fois : à la compilation, vers
 * le dossier temporaire, pour figer exactement ce qui a été compilé ; à la
 * mise en production, de là vers les archives AVMDF.
 */
async function copierSources({ dossiers, destination, concurrence = 4 }) {
  const bilan = { fichiers: 0, octets: 0, erreurs: [] };
  const entrees = await inventaireSources(dossiers, concurrence);
  await pool(Array.from(entrees.values()), concurrence, async (entree) => {
    const cible = path.join(destination, ...entree.chemin.split(/[\\/]/));
    try {
      await fsp.mkdir(cheminLong(path.dirname(cible)), { recursive: true });
      await fsp.copyFile(cheminLong(entree.absolu), cheminLong(cible));
      const etat = await fsp.stat(cheminLong(entree.absolu));
      await fsp.utimes(cheminLong(cible), etat.atime, etat.mtime);
      bilan.fichiers += 1;
      bilan.octets += entree.taille;
    } catch (err) {
      bilan.erreurs.push(`${entree.chemin} : ${raisonLisible(err)}`);
    }
  });
  return bilan;
}

/** Copie un dossier de sources déjà figé (dossier temporaire → archives). */
async function copierDossier({ source, destination, concurrence = 4 }) {
  const bilan = { fichiers: 0, octets: 0, erreurs: [] };
  const { entrees, racineInaccessible } = await parcourir(source, { concurrence });
  if (racineInaccessible) {
    bilan.erreurs.push(`${source} : ${racineInaccessible}`);
    return bilan;
  }
  await pool(Array.from(entrees.values()), concurrence, async (entree) => {
    const cible = path.join(destination, ...entree.chemin.split(/[\\/]/));
    try {
      await fsp.mkdir(cheminLong(path.dirname(cible)), { recursive: true });
      const temporaire = cible + '.avmdf-tmp';
      await fsp.copyFile(cheminLong(entree.absolu), cheminLong(temporaire));
      await fsp.rename(cheminLong(temporaire), cheminLong(cible));
      const etat = await fsp.stat(cheminLong(entree.absolu));
      await fsp.utimes(cheminLong(cible), etat.atime, etat.mtime);
      bilan.fichiers += 1;
      bilan.octets += entree.taille;
    } catch (err) {
      bilan.erreurs.push(`${entree.chemin} : ${raisonLisible(err)}`);
    }
  });
  return bilan;
}

/**
 * Compare les sources locales d'un WebService aux sources livrées lors de
 * sa dernière mise en production.
 *
 * @returns {Promise<{ fichiers: object[], identiques: number }>}
 *   statut : modifie, nouveau (seulement en local), orphelin (seulement dans les sources livrées)
 */
async function comparerSources({ dossiers, reference, concurrence = 4 }) {
  const locales = await inventaireSources(dossiers, concurrence);
  const livre = await parcourir(reference, { concurrence });
  if (livre.racineInaccessible) {
    throw Object.assign(new Error(`sources livrées illisibles (${livre.racineInaccessible}) : ${reference}`), { code: 'EREF' });
  }
  const livrees = new Map();
  for (const entree of livre.entrees.values()) livrees.set(entree.chemin.toLowerCase(), entree);

  const fichiers = [];
  let identiques = 0;
  const texte = (chemin) => EXTENSIONS_SOURCES_TEXTE.has(path.extname(chemin).toLowerCase());
  await pool(Array.from(locales.entries()), concurrence, async ([cle, local]) => {
    const prod = livrees.get(cle);
    const fiche = {
      cle,
      chemin: local.chemin,
      texte: texte(local.chemin),
      local: { absolu: local.absolu, taille: local.taille, mtimeMs: local.mtimeMs },
      prod: prod ? { absolu: prod.absolu, taille: prod.taille, mtimeMs: prod.mtimeMs } : null,
      statut: STATUT_NOUVEAU
    };
    if (prod) {
      const meme = prod.taille === local.taille && (await hashFichier(prod.absolu)) === (await hashFichier(local.absolu));
      if (meme) {
        identiques += 1;
        return;
      }
      fiche.statut = STATUT_MODIFIE;
    }
    fichiers.push(fiche);
  });
  for (const [cle, prod] of livrees) {
    if (locales.has(cle)) continue;
    fichiers.push({
      cle,
      chemin: prod.chemin,
      texte: texte(prod.chemin),
      local: null,
      prod: { absolu: prod.absolu, taille: prod.taille, mtimeMs: prod.mtimeMs },
      statut: 'orphelin'
    });
  }
  fichiers.sort((a, b) => a.chemin.localeCompare(b.chemin, 'fr', { sensitivity: 'base' }));
  return { fichiers, identiques };
}

/**
 * Les sources qui tournent en production : celles de la dernière mise en
 * production par l'outil, en sautant celles qui ont été défaites par un
 * retour arrière.
 *
 * @param {object[]} manifestes manifestes de ce WebService, du plus récent au plus ancien
 */
function referenceSources(manifestes) {
  const restaures = new Set(
    manifestes
      .filter((m) => m.operation === 'restauration' && m.restaureDepuis && !m.simulation)
      .map((m) => String(m.restaureDepuis).toLowerCase())
  );
  for (const m of manifestes) {
    if (m.simulation || m.operation === 'restauration') continue;
    if (restaures.has(String(m.chemin || '').toLowerCase())) continue;
    if (m.webservice && m.webservice.sources) {
      return {
        chemin: m.webservice.sources,
        date: m.date,
        auteur: m.auteur || null,
        demande: m.demande,
        sprint: m.sprint,
        version: m.webservice.versionApres || null
      };
    }
    // Une mise en production plus récente, sans sources : celles d'avant ne
    // décrivent plus la production.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Web.config
// ---------------------------------------------------------------------------

/** Les `<add …/>` d'une section, par nom d'attribut clé. */
function clesSection(texte, section, attribut) {
  const cles = new Map();
  if (!texte) return cles;
  const sansCommentaires = texte.replace(/<!--[\s\S]*?-->/g, '');
  const bloc = new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`, 'i').exec(sansCommentaires);
  if (!bloc) return cles;
  const motif = new RegExp(`<add\\b[^>]*\\b${attribut}\\s*=\\s*"([^"]*)"[^>]*>`, 'gi');
  let trouve;
  while ((trouve = motif.exec(bloc[1]))) cles.set(trouve[1].toLowerCase(), trouve[1]);
  return cles;
}

/** Redirections de version déclarées (`bindingRedirect`). */
function lireRedirections(texte) {
  const redirections = new Map();
  if (!texte) return redirections;
  const sansCommentaires = texte.replace(/<!--[\s\S]*?-->/g, '');
  const blocs = sansCommentaires.match(/<dependentAssembly\b[\s\S]*?<\/dependentAssembly>/gi) || [];
  for (const bloc of blocs) {
    const nom = /<assemblyIdentity\b[^>]*\bname\s*=\s*"([^"]+)"/i.exec(bloc);
    const redirection = /<bindingRedirect\b[^>]*\boldVersion\s*=\s*"([^"]+)"[^>]*\bnewVersion\s*=\s*"([^"]+)"/i.exec(bloc);
    if (nom && redirection) {
      const [min, max] = redirection[1].split('-');
      redirections.set(nom[1].toLowerCase(), { min: min.trim(), max: (max || min).trim(), nouvelle: redirection[2].trim() });
    }
  }
  return redirections;
}

/**
 * Compare les noms (jamais les valeurs) des `appSettings` et des
 * `connectionStrings` du Web.config compilé et de celui de production. Le
 * Web.config ne part pas en production : une clé ajoutée en développement
 * doit y être reportée à la main, sinon le WebService plante au premier appel
 * qui la lit.
 */
function comparerConfig(texteProd, texteCompile) {
  const ecart = (section, attribut) => {
    const prod = clesSection(texteProd, section, attribut);
    const compile = clesSection(texteCompile, section, attribut);
    return {
      manquantesEnProd: [...compile.keys()].filter((k) => !prod.has(k)).map((k) => compile.get(k)),
      seulementEnProd: [...prod.keys()].filter((k) => !compile.has(k)).map((k) => prod.get(k))
    };
  };
  const sourceExterne = (texte) => /<(appSettings|connectionStrings)\b[^>]*\bconfigSource\s*=/i.test(texte || '');
  return {
    prodAbsent: !texteProd,
    sourceExterne: sourceExterne(texteProd) || sourceExterne(texteCompile),
    appSettings: ecart('appSettings', 'key'),
    connectionStrings: ecart('connectionStrings', 'name')
  };
}

// ---------------------------------------------------------------------------
// Dépendances entre DLL
// ---------------------------------------------------------------------------

/** Assemblies fournis par le framework .NET (GAC) : jamais attendus dans le bin. */
const FRAMEWORK = /^(mscorlib|netstandard|System|System\..+|Microsoft\.CSharp|Microsoft\.VisualBasic|Microsoft\.VisualC|WindowsBase|PresentationCore|PresentationFramework|Accessibility|Microsoft\.JScript)$/i;

function versionDansIntervalle(version, min, max) {
  return comparerVersions(version, min) >= 0 && comparerVersions(version, max) <= 0;
}

/**
 * Vérifie, pour la sélection donnée, que chaque DLL qui part trouvera dans le
 * bin de production les DLL dont elle a besoin, dans la bonne version (ou par
 * une redirection déclarée dans le Web.config qui sera en production).
 *
 * @param {object} comparaison résultat de `comparerSortie`
 * @param {Set<string>} selection clés des fichiers qui partent
 * @returns {Array<{ dll:string, reference:string, attendue:string, trouvee:string|null }>}
 */
function verifierReferences(comparaison, selection) {
  const bin = new Map();
  const noter = (meta) => {
    if (meta && meta.nom) bin.set(meta.nom.toLowerCase(), meta.version);
  };
  for (const conserve of comparaison.binConserve || []) noter(conserve.meta);
  for (const f of comparaison.fichiers) {
    if (!/^bin\\[^\\]+\.(dll|exe)$/i.test(f.chemin)) continue;
    noter(selection.has(f.cle) ? f.local.meta : f.prod ? f.prod.meta : null);
  }

  // Le Web.config qui sera en production : le compilé s'il part, sinon l'actuel.
  const config = comparaison.fichiers.find((f) => f.chemin.toLowerCase() === 'web.config');
  const texteConfig = config ? (selection.has(config.cle) ? config.local.texte : config.prod ? config.prod.texte : null) : null;
  const redirections = lireRedirections(texteConfig);

  const problemes = [];
  for (const f of comparaison.fichiers) {
    if (!selection.has(f.cle) || !f.local.meta || !/^bin\\/i.test(f.chemin)) continue;
    for (const reference of f.local.meta.references) {
      const cle = reference.nom.toLowerCase();
      const presente = bin.get(cle);
      if (presente === undefined) {
        if (FRAMEWORK.test(reference.nom)) continue;
        problemes.push({ dll: f.chemin, reference: reference.nom, attendue: reference.version, trouvee: null });
        continue;
      }
      if (comparerVersions(presente, reference.version) === 0) continue;
      const redirection = redirections.get(cle);
      if (redirection && redirection.nouvelle === presente && versionDansIntervalle(reference.version, redirection.min, redirection.max)) {
        continue;
      }
      // Une version plus récente sans redirection est le cas le plus courant
      // de « Impossible de charger le fichier ou l'assembly ».
      problemes.push({ dll: f.chemin, reference: reference.nom, attendue: reference.version, trouvee: presente });
    }
  }
  return problemes;
}

// ---------------------------------------------------------------------------
// DLL partagées entre WebServices
// ---------------------------------------------------------------------------

/** Bibliothèques tierces connues : leur version est l'affaire de NuGet, pas de la comparaison. */
const TIERCES = /^(System\.|Microsoft\.|Newtonsoft\.|Syncfusion\.|Interop\.|EntityFramework|Antlr|WebGrease|Owin|log4net|NLog)/i;

/**
 * Version de chaque DLL partagée (présente dans au moins deux WebServices,
 * hors bibliothèques tierces) dans le bin de chaque WS en production.
 *
 * @param {Array<{nom:string, dossierProd:string}>} webservices
 * @returns {Promise<{ webservices:string[], dlls:Array<{ nom:string, versions:Object<string,string|null>, divergent:boolean }> }>}
 */
async function matriceDll(webservices, concurrence = 4) {
  const parWs = new Map();
  await pool(webservices, concurrence, async (ws) => {
    const contenu = (await listerDossier(path.join(ws.dossierProd, 'bin'))) || [];
    parWs.set(ws.nom, contenu.filter((e) => e.isFile() && /\.dll$/i.test(e.name) && !TIERCES.test(e.name)).map((e) => e.name));
  });
  const compte = new Map();
  for (const noms of parWs.values()) for (const nom of noms) compte.set(nom.toLowerCase(), (compte.get(nom.toLowerCase()) || 0) + 1);
  const partagees = [...compte.entries()].filter(([, n]) => n >= 2).map(([nom]) => nom);

  const dlls = [];
  for (const nom of partagees) {
    const versions = {};
    await pool(webservices, concurrence, async (ws) => {
      const reel = (parWs.get(ws.nom) || []).find((n) => n.toLowerCase() === nom);
      if (!reel) {
        versions[ws.nom] = null;
        return;
      }
      const meta = await assembly.analyserFichier(path.join(ws.dossierProd, 'bin', reel));
      versions[ws.nom] = meta ? meta.version : versionDe(await lireVersionDll(path.join(ws.dossierProd, 'bin', reel)));
    });
    const distinctes = new Set(Object.values(versions).filter(Boolean));
    const nomAffiche = [...parWs.values()].flat().find((n) => n.toLowerCase() === nom) || nom;
    dlls.push({ nom: nomAffiche, versions, divergent: distinctes.size > 1 });
  }
  dlls.sort((a, b) => Number(b.divergent) - Number(a.divergent) || a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }));
  return { webservices: webservices.map((w) => w.nom), dlls };
}

// ---------------------------------------------------------------------------
// Le WebService répond-il ?
// ---------------------------------------------------------------------------

/** Adresse de test d'un WS : `{ws}` est remplacé par son nom. */
function urlDeTest(modele, nom) {
  const propre = String(modele || '').trim();
  if (!propre) return null;
  return propre.includes('{ws}') ? propre.split('{ws}').join(encodeURIComponent(nom)) : propre.replace(/\/?$/, '/') + encodeURIComponent(nom) + '/';
}

/**
 * Appelle l'adresse du WebService. Toute réponse sous 500 veut dire que
 * l'application a démarré (un 404 sur la racine d'une Web API est normal) ;
 * une erreur 500 ou une absence de réponse veut dire qu'elle ne tourne pas.
 * Le premier appel après une copie de DLL est lent : IIS recompile et
 * redémarre, d'où un délai généreux.
 *
 * @returns {Promise<{ url:string, ok:boolean, statut:number|null, duree:number, erreur:string|null }>}
 */
function testerUrl(url, delai = 60000) {
  const debut = Date.now();
  return new Promise((resoudre) => {
    let module;
    try {
      module = new URL(url).protocol === 'https:' ? require('https') : require('http');
    } catch (err) {
      resoudre({ url, ok: false, statut: null, duree: 0, erreur: 'adresse invalide' });
      return;
    }
    const requete = module.get(url, { timeout: delai, rejectUnauthorized: false, headers: { Accept: 'application/json' } }, (reponse) => {
      const statut = reponse.statusCode;
      const morceaux = [];
      let taille = 0;
      reponse.on('data', (morceau) => {
        taille += morceau.length;
        if (taille <= 256 * 1024) morceaux.push(morceau);
      });
      reponse.on('end', () => {
        resoudre({
          url,
          ok: statut < 500,
          statut,
          duree: Date.now() - debut,
          erreur: statut >= 500 ? `erreur ${statut}` : null,
          infos: lireInfosApi(Buffer.concat(morceaux).toString('utf8'))
        });
      });
      reponse.on('error', (err) => resoudre({ url, ok: false, statut, duree: Date.now() - debut, erreur: err.message }));
    });
    requete.on('timeout', () => requete.destroy(new Error('pas de réponse dans le délai')));
    requete.on('error', (err) => resoudre({ url, ok: false, statut: null, duree: Date.now() - debut, erreur: err.message }));
  });
}

/**
 * Lit la réponse de la route `api/Informations` des WebServices :
 * {"Donnees":[{"Nom":"WSChargement","Version":"2.0.0.3","ModeCompilation":"RELEASE"}], …}
 * C'est le WebService lui-même qui dit quelle version IIS a chargée et en
 * quel mode : la preuve que la nouvelle DLL tourne, pas seulement qu'elle a
 * été copiée. Toute autre réponse donne `null`.
 *
 * @returns {{ nom:string|null, version:string|null, mode:string|null } | null}
 */
function lireInfosApi(texte) {
  let objet;
  try {
    objet = JSON.parse(String(texte || '').replace(/^\uFEFF/, ''));
  } catch (err) {
    return null;
  }
  const valeur = (o, cle) => {
    if (!o || typeof o !== 'object') return null;
    const trouvee = Object.keys(o).find((k) => k.toLowerCase() === cle);
    return trouvee !== undefined ? o[trouvee] : null;
  };
  const donnees = valeur(objet, 'donnees');
  const ligne = Array.isArray(donnees) ? donnees[0] : donnees && typeof donnees === 'object' ? donnees : objet;
  const version = valeur(ligne, 'version');
  if (!version) return null;
  const mode = valeur(ligne, 'modecompilation');
  return {
    nom: valeur(ligne, 'nom') || null,
    version: String(version),
    mode: mode ? String(mode).toUpperCase() : null
  };
}

/** Sélection proposée : ce qui change, sauf Web.config et Global.asax. */
function selectionParDefaut(fichiers) {
  return fichiers.filter((f) => f.statut !== STATUT_IDENTIQUE && !f.sensible).map((f) => f.cle);
}

// ---------------------------------------------------------------------------
// Archivage du dossier complet
// ---------------------------------------------------------------------------

/**
 * Copie le dossier complet du WebService en production sous le dossier de
 * sprint, comme on le faisait à la main : `AvMdf\AVMDF6786\AVMDF6786_1\WSChargement`.
 *
 * Même règle que pour le front : la première version archivée dans un sprint
 * est la bonne. Un fichier déjà présent dans l'archive n'est jamais écrasé -
 * un second passage dans le même sprint ne remplace pas l'état d'origine par
 * un état intermédiaire.
 *
 * @param {object} parametres
 * @param {string} parametres.source dossier du WS en production
 * @param {string} parametres.destination `<sprint>\<WS>`
 * @param {string} parametres.racineAvmdf
 * @param {boolean} [parametres.simulation]
 * @returns {Promise<{ copies:number, conserves:number, octets:number, erreurs:string[], total:number, copiesChemins:Set<string> }>}
 */
async function archiverDossierComplet({ source, destination, racineAvmdf, simulation = false, concurrence = 4, surProgression = null }) {
  // `copiesChemins` : chemins relatifs (en minuscules) archivés par ce
  // passage-ci, pour que le manifeste ne les confonde pas avec l'archive d'un
  // passage précédent.
  const bilan = { copies: 0, conserves: 0, octets: 0, erreurs: [], total: 0, copiesChemins: new Set() };
  if (!estSousRacine(destination, racineAvmdf)) {
    bilan.erreurs.push(`destination d'archivage hors du dossier d'archives : ${destination}`);
    return bilan;
  }

  const { entrees, ignores, racineInaccessible } = await parcourir(source, {
    fichiersExclus: ['app_offline.htm'],
    concurrence
  });
  if (racineInaccessible) {
    bilan.erreurs.push(`dossier de production illisible (${racineInaccessible}) : ${source}`);
    return bilan;
  }
  for (const ignore of ignores) bilan.erreurs.push(`${ignore.chemin} : ${ignore.raison}`);

  const liste = Array.from(entrees.values());
  bilan.total = liste.length;
  let faits = 0;
  await pool(liste, concurrence, async (entree) => {
    const cible = path.join(destination, ...entree.chemin.split(/[\\/]/));
    try {
      let deja = false;
      try {
        await fsp.access(cheminLong(cible));
        deja = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (deja) {
        bilan.conserves += 1;
      } else {
        if (!simulation) {
          await fsp.mkdir(cheminLong(path.dirname(cible)), { recursive: true });
          const temporaire = cible + '.avmdf-tmp';
          await fsp.copyFile(cheminLong(entree.absolu), cheminLong(temporaire));
          await fsp.rename(cheminLong(temporaire), cheminLong(cible));
          const etat = await fsp.stat(cheminLong(entree.absolu));
          await fsp.utimes(cheminLong(cible), etat.atime, etat.mtime);
        }
        bilan.copies += 1;
        bilan.octets += entree.taille;
        bilan.copiesChemins.add(entree.chemin.toLowerCase());
      }
    } catch (err) {
      bilan.erreurs.push(`${entree.chemin} : ${raisonLisible(err)}`);
    }
    faits += 1;
    if (surProgression && faits % 10 === 0) surProgression({ phase: 'archivage', faits, total: liste.length });
  });

  if (!simulation && !bilan.erreurs.length && liste.length === 0) {
    await fsp.mkdir(cheminLong(destination), { recursive: true });
  }
  return bilan;
}

/** Nom de dossier sûr pour le dossier de travail d'une compilation. */
function nomDeTravail(nom) {
  return String(nom || 'ws').replace(/[^A-Za-z0-9_.-]+/g, '_');
}

module.exports = {
  ETAT_PRET,
  ETAT_VERSION_IDENTIQUE,
  ETAT_VERSION_ANCIENNE,
  ETAT_VERSION_INCONNUE,
  ETAT_A_JOUR,
  etatAvecSources,
  STATUT_MODIFIE,
  STATUT_NOUVEAU,
  STATUT_IDENTIQUE,
  comparerVersions,
  lireAttributsVersion,
  lireVersionLocale,
  lireVersionDll,
  chercherChaineVersion,
  versionDe,
  etatVersions,
  lireProjet,
  trouverProjet,
  listerWebServices,
  sourcesModifieesDepuis,
  resoudreDossierWs,
  verifierPaquets,
  localiserMsbuild,
  emplacementsConnus,
  argumentsMsbuild,
  decoderSortie,
  compiler,
  dossiersIntermediaires,
  deverrouillerIntermediaires,
  viderIntermediaires,
  lireErreurMsbuild,
  comparerSortie,
  selectionParDefaut,
  comparerConfig,
  dossiersSources,
  copierSources,
  copierDossier,
  comparerSources,
  referenceSources,
  lireRedirections,
  verifierReferences,
  matriceDll,
  urlDeTest,
  testerUrl,
  lireInfosApi,
  archiverDossierComplet,
  nomDeTravail
};
