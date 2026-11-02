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
  return {
    nomProjet: nomFichier,
    assemblyName: assembly ? assembly[1] : nomFichier,
    web,
    langue: /\.csproj$/i.test(cheminProjet) ? 'cs' : 'vb'
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
      langue: infos.langue
    };

    if (!enProd) {
      entree.raison = infos.web
        ? `Aucun dossier ${nom} en production : créez d'abord l'application dans IIS, puis copiez-la une première fois à la main.`
        : 'Bibliothèque : elle part dans le bin de chaque WebService qui l\'utilise, à la compilation de celui-ci.';
      bibliotheques.push(entree);
      return;
    }

    const [locale, prod] = await Promise.all([
      lireVersionLocale(dossierProjet),
      lireVersionDll(path.join(dossierProd, 'bin', infos.assemblyName + '.dll'))
    ]);
    entree.versionLocale = versionDe(locale);
    entree.versionLocaleFichier = locale.fichier;
    entree.versionLocaleDetail = locale;
    entree.versionProd = versionDe(prod);
    entree.versionProdDetail = prod;
    const { etat, raison } = etatVersions(entree.versionLocale, entree.versionProd);
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
    avertissements: 0,
    lignes: [],
    sortie: null,
    versionCompilee: null,
    binLocalModifie: [],
    erreur: null
  };

  await fsp.rm(cheminLong(dossierTravail), { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(cheminLong(dossierSortie), { recursive: true });

  const binLocal = path.join(ws.dossierProjet, 'bin');
  const avant = await empreinteDossier(binLocal);

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
    if (/:\s*(error|erreur)\s+[A-Z]*\d*\s*:/i.test(ligne) && resultat.erreurs.length < 200) resultat.erreurs.push(ligne.trim());
    if (/:\s*(warning|avertissement)\s+[A-Z]*\d*\s*:/i.test(ligne)) resultat.avertissements += 1;
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
    if (!resultat.erreur) {
      resultat.erreur = resultat.erreurs.length
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
async function comparerSortie({ sortie, prod, concurrence = 6, signal = { annule: false } }) {
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
      if (enProd) {
        entree.prod = { absolu: enProd.absolu, taille: enProd.taille, mtimeMs: enProd.mtimeMs, hash: null };
        entree.prod.hash = await hashFichier(enProd.absolu);
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
  return { fichiers, conserves, ignores: gauche.ignores.concat(droite.ignores) };
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
  verifierPaquets,
  localiserMsbuild,
  emplacementsConnus,
  argumentsMsbuild,
  decoderSortie,
  compiler,
  comparerSortie,
  selectionParDefaut,
  archiverDossierComplet,
  nomDeTravail
};
