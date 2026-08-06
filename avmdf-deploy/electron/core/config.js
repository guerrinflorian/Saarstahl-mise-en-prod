'use strict';

/**
 * config.js — réglages de l'application : valeurs par défaut, chargement,
 * vérification et sauvegarde.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM, utilisable depuis
 * un script en ligne de commande.
 *
 *   const { creerDepot } = require('./electron/core/config');
 *   const depot = creerDepot('C:\\chemin\\config.json');
 *   const { config } = depot.charger();
 *
 * Les chemins du domaine (racines, dossiers de projet) sont des chemins Windows
 * et sont toujours manipulés avec `path.win32`, y compris si le module tourne
 * sous Linux. Seul l'accès au fichier de configuration lui-même utilise `path`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION_CONFIG = 1;

const CONTENU_APP_OFFLINE_DEFAUT = [
  '<!doctype html>',
  '<html lang="fr">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <title>Maintenance en cours</title>',
  '</head>',
  '<body style="font-family:Segoe UI,sans-serif;padding:3rem;">',
  '  <h1>Mise à jour en cours</h1>',
  '  <p>L\'application est momentanément indisponible. Merci de réessayer dans quelques minutes.</p>',
  '</body>',
  '</html>',
  ''
].join('\r\n');

/** Nom du fichier dont l'exclusion est expliquée dans l'interface. */
const FICHIER_SENSIBLE = 'web.config';

// ---------------------------------------------------------------------------
// Valeurs par défaut
// ---------------------------------------------------------------------------

/**
 * @param {{ utilisateur?: string }} [contexte]
 * @returns {object} un jeu de réglages complet, prêt à être enregistré.
 */
function reglagesParDefaut(contexte = {}) {
  const utilisateur =
    contexte.utilisateur || process.env.USERNAME || process.env.USER || safeUserInfo();

  return {
    version: VERSION_CONFIG,
    racines: {
      locale: 'E:\\F Guerrin\\Process',
      prod: 'Z:\\',
      avmdf: 'Z:\\AvMdf'
    },
    projets: [
      creerProjet({ nom: 'GPNet', dossierLocal: 'GPNET', dossierProd: 'GPNet' }),
      creerProjet({ nom: 'WebService', dossierLocal: 'WebService', dossierProd: 'WebService' })
    ],
    exclusions: {
      dossiers: [
        '.vs',
        '.git',
        '.svn',
        'bin',
        'obj',
        'packages',
        'node_modules',
        'App_Data',
        'TestResults',
        '_ReSharper*'
      ],
      fichiers: [
        'web.config',
        '*.user',
        '*.suo',
        '*.pdb',
        '*.cache',
        '*.sln.docstates',
        'Thumbs.db',
        'desktop.ini',
        '*.tmp'
      ]
    },
    extensionsTexte: [
      '.aspx', '.ascx', '.master', '.asax', '.ashx', '.asmx', '.sitemap', '.skin', '.browser',
      '.cs', '.vb', '.cshtml', '.vbhtml', '.resx',
      '.js', '.ts', '.json', '.css', '.less', '.scss',
      '.htm', '.html', '.xml', '.config', '.xsl', '.xslt', '.svg',
      '.sql', '.txt', '.md', '.ini', '.log', '.csv',
      '.csproj', '.vbproj', '.sln',
      '.bat', '.cmd', '.ps1'
    ],
    options: {
      ignorerEspaces: false,
      ignorerFinsDeLigne: true,
      auteur: utilisateur,
      simulation: true,
      lecturesSimultanees: 6,
      appOffline: {
        actif: false,
        contenu: CONTENU_APP_OFFLINE_DEFAUT
      }
    },
    comparaisonLibre: {
      dossierA: '',
      dossierB: ''
    }
  };
}

function safeUserInfo() {
  try {
    return os.userInfo().username || '';
  } catch (err) {
    // os.userInfo() lève si l'utilisateur n'a pas d'entrée passwd (conteneur).
    return '';
  }
}

/** Crée une entrée de projet complète, avec un identifiant stable. */
function creerProjet(valeurs = {}) {
  return {
    id: valeurs.id || nouvelIdentifiant(),
    nom: texte(valeurs.nom),
    dossierLocal: texte(valeurs.dossierLocal),
    dossierProd: texte(valeurs.dossierProd),
    actif: valeurs.actif === undefined ? true : Boolean(valeurs.actif)
  };
}

function nouvelIdentifiant() {
  const crypto = require('crypto');
  return 'p_' + crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function texte(valeur) {
  return typeof valeur === 'string' ? valeur.trim() : '';
}

/** Liste de chaînes non vides, sans doublon (comparaison insensible à la casse). */
function listeDeTextes(valeur, secours) {
  const source = Array.isArray(valeur) ? valeur : secours;
  const vues = new Set();
  const sortie = [];
  for (const brut of source) {
    const propre = texte(brut);
    if (!propre) continue;
    const cle = propre.toLowerCase();
    if (vues.has(cle)) continue;
    vues.add(cle);
    sortie.push(propre);
  }
  return sortie;
}

function listeExtensions(valeur, secours) {
  return listeDeTextes(valeur, secours).map((ext) => {
    const propre = ext.toLowerCase();
    return propre.startsWith('.') ? propre : '.' + propre;
  });
}

function entier(valeur, secours, min, max) {
  const nombre = Number.parseInt(valeur, 10);
  if (!Number.isFinite(nombre)) return secours;
  return Math.min(max, Math.max(min, nombre));
}

function booleen(valeur, secours) {
  return typeof valeur === 'boolean' ? valeur : secours;
}

/**
 * Complète un objet partiel (fichier ancien, champ supprimé à la main, valeur
 * du mauvais type) avec les valeurs par défaut. Ne lève jamais.
 * @param {any} brut
 * @param {{ utilisateur?: string }} [contexte]
 */
function normaliser(brut, contexte = {}) {
  const defauts = reglagesParDefaut(contexte);
  const source = brut && typeof brut === 'object' ? brut : {};
  const racines = source.racines && typeof source.racines === 'object' ? source.racines : {};
  const exclusions = source.exclusions && typeof source.exclusions === 'object' ? source.exclusions : {};
  const options = source.options && typeof source.options === 'object' ? source.options : {};
  const appOffline = options.appOffline && typeof options.appOffline === 'object' ? options.appOffline : {};
  const libre = source.comparaisonLibre && typeof source.comparaisonLibre === 'object' ? source.comparaisonLibre : {};

  const projets = Array.isArray(source.projets) ? source.projets.map(creerProjet) : defauts.projets;

  return {
    version: VERSION_CONFIG,
    racines: {
      locale: texte(racines.locale) || defauts.racines.locale,
      prod: texte(racines.prod) || defauts.racines.prod,
      avmdf: texte(racines.avmdf) || defauts.racines.avmdf
    },
    projets,
    exclusions: {
      dossiers: listeDeTextes(exclusions.dossiers, defauts.exclusions.dossiers),
      fichiers: listeDeTextes(exclusions.fichiers, defauts.exclusions.fichiers)
    },
    extensionsTexte: listeExtensions(source.extensionsTexte, defauts.extensionsTexte),
    options: {
      ignorerEspaces: booleen(options.ignorerEspaces, defauts.options.ignorerEspaces),
      ignorerFinsDeLigne: booleen(options.ignorerFinsDeLigne, defauts.options.ignorerFinsDeLigne),
      auteur: texte(options.auteur) || defauts.options.auteur,
      simulation: booleen(options.simulation, defauts.options.simulation),
      lecturesSimultanees: entier(options.lecturesSimultanees, defauts.options.lecturesSimultanees, 1, 32),
      appOffline: {
        actif: booleen(appOffline.actif, false),
        contenu:
          typeof appOffline.contenu === 'string' && appOffline.contenu.length
            ? appOffline.contenu
            : CONTENU_APP_OFFLINE_DEFAUT
      }
    },
    comparaisonLibre: {
      dossierA: texte(libre.dossierA),
      dossierB: texte(libre.dossierB)
    }
  };
}

// ---------------------------------------------------------------------------
// Motifs glob (exclusions)
// ---------------------------------------------------------------------------

const cacheMotifs = new Map();

/**
 * Traduit un motif d'exclusion en expression régulière.
 * `*` et `?` ne traversent pas les séparateurs, `**` les traverse.
 * @param {string} motif
 * @returns {RegExp}
 */
function motifEnRegex(motif) {
  const enCache = cacheMotifs.get(motif);
  if (enCache) return enCache;

  const JOKER_PROFOND = '\u0000';
  let corps = '';
  for (let i = 0; i < motif.length; i += 1) {
    const c = motif[i];
    if (c === '*') {
      if (motif[i + 1] === '*') {
        corps += JOKER_PROFOND;
        i += 1;
      } else {
        corps += '[^\\\\/]*';
      }
    } else if (c === '?') {
      corps += '[^\\\\/]';
    } else if (c === '/' || c === '\\') {
      corps += '[\\\\/]';
    } else {
      corps += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  corps = corps.split(JOKER_PROFOND).join('.*');

  const regex = new RegExp('^' + corps + '$', 'i');
  cacheMotifs.set(motif, regex);
  return regex;
}

/**
 * @param {string} motif motif d'exclusion (glob accepté)
 * @param {string} nom nom de fichier ou chemin relatif
 * @returns {boolean}
 */
function correspondMotif(motif, nom) {
  if (!motif || !nom) return false;
  return motifEnRegex(motif).test(nom);
}

/**
 * `web.config` est-il couvert par la liste des fichiers exclus ?
 * Prend en compte les motifs (`*.config` exclut aussi web.config).
 * @param {object} config
 * @returns {boolean}
 */
function fichierSensibleExclu(config) {
  const motifs = (config && config.exclusions && config.exclusions.fichiers) || [];
  return motifs.some((motif) => correspondMotif(motif, FICHIER_SENSIBLE));
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------

/**
 * Contrôle de cohérence des réglages. Ne touche pas au disque : ne vérifie pas
 * que les dossiers existent (c'est le rôle du préflight au moment du scan).
 *
 * @param {object} config
 * @returns {{ erreurs: Array<{champ:string, message:string}>,
 *             avertissements: Array<{champ:string, message:string}> }}
 */
function verifier(config) {
  const erreurs = [];
  const avertissements = [];
  const ajouterErreur = (champ, message) => erreurs.push({ champ, message });
  const ajouterAvertissement = (champ, message) => avertissements.push({ champ, message });

  const racines = config.racines || {};
  if (!texte(racines.locale)) ajouterErreur('racines.locale', 'Indiquer la racine locale (dossier des sources).');
  if (!texte(racines.prod)) ajouterErreur('racines.prod', 'Indiquer la racine de production.');
  if (!texte(racines.avmdf)) ajouterErreur('racines.avmdf', 'Indiquer la racine des archives AVMDF.');

  if (
    texte(racines.locale) &&
    normaliserPourComparaison(racines.locale) === normaliserPourComparaison(racines.prod)
  ) {
    ajouterErreur('racines.prod', 'La racine de production est identique à la racine locale.');
  }

  const projets = Array.isArray(config.projets) ? config.projets : [];
  const actifs = projets.filter((p) => p.actif);
  if (!actifs.length) {
    ajouterAvertissement('projets', 'Aucun projet actif : rien ne pourra être analysé.');
  }

  const nomsVus = new Map();
  projets.forEach((projet, index) => {
    const position = `projets[${index}]`;
    if (!texte(projet.nom)) {
      ajouterErreur(position + '.nom', `Projet n° ${index + 1} : le nom est vide.`);
    } else {
      const cle = projet.nom.toLowerCase();
      if (nomsVus.has(cle)) {
        ajouterErreur(position + '.nom', `Deux projets portent le nom « ${projet.nom} ».`);
      }
      nomsVus.set(cle, index);
    }
    if (!texte(projet.dossierLocal)) {
      ajouterErreur(position + '.dossierLocal', `Projet « ${projet.nom || index + 1} » : dossier local vide.`);
    }
    if (!texte(projet.dossierProd)) {
      ajouterErreur(position + '.dossierProd', `Projet « ${projet.nom || index + 1} » : dossier de production vide.`);
    }
    if (path.win32.isAbsolute(projet.dossierLocal) || path.win32.isAbsolute(projet.dossierProd)) {
      ajouterAvertissement(
        position,
        `Projet « ${projet.nom || index + 1} » : indiquer un dossier relatif à la racine, pas un chemin complet.`
      );
    }
  });

  if (!fichierSensibleExclu(config)) {
    ajouterAvertissement(
      'exclusions.fichiers',
      'web.config n\'est plus exclu : il sera comparé et pourra être déployé. ' +
        'Chaque mise en production qui le concerne affichera un avertissement.'
    );
  }

  if (!Array.isArray(config.extensionsTexte) || !config.extensionsTexte.length) {
    ajouterAvertissement(
      'extensionsTexte',
      'Aucune extension texte : tous les fichiers seront traités comme binaires, sans comparaison ligne à ligne.'
    );
  }

  const options = config.options || {};
  if (!texte(options.auteur)) {
    ajouterAvertissement('options.auteur', 'Sans auteur, les manifestes de déploiement ne seront pas nominatifs.');
  }
  if (options.lecturesSimultanees > 12) {
    ajouterAvertissement(
      'options.lecturesSimultanees',
      'Au-delà de 12 lectures simultanées, un partage réseau SMB ralentit au lieu d\'accélérer.'
    );
  }

  return { erreurs, avertissements };
}

function normaliserPourComparaison(chemin) {
  return texte(chemin).replace(/[\\/]+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Résolution des chemins de projet
// ---------------------------------------------------------------------------

/**
 * Résout les deux racines d'un projet à partir des racines globales.
 * @param {object} config
 * @param {object} projet
 * @returns {{ nom:string, locale:string, prod:string }}
 */
function resoudreProjet(config, projet) {
  return {
    nom: projet.nom,
    locale: joindreWin(config.racines.locale, projet.dossierLocal),
    prod: joindreWin(config.racines.prod, projet.dossierProd)
  };
}

/** Jointure de chemins Windows, valable quel que soit l'OS courant. */
function joindreWin(racine, relatif) {
  const base = texte(racine);
  const suite = texte(relatif);
  if (!base) return suite;
  if (!suite) return base;
  return path.win32.join(base, suite);
}

/** Retrouve un projet par identifiant, ou le premier projet actif. */
function projetParDefaut(config, id) {
  const projets = Array.isArray(config.projets) ? config.projets : [];
  if (id) {
    const trouve = projets.find((p) => p.id === id);
    if (trouve) return trouve;
  }
  return projets.find((p) => p.actif) || projets[0] || null;
}

// ---------------------------------------------------------------------------
// Dépôt : lecture / écriture du fichier
// ---------------------------------------------------------------------------

/**
 * @param {string} cheminFichier chemin absolu du config.json
 * @param {{ utilisateur?: string }} [contexte]
 */
function creerDepot(cheminFichier, contexte = {}) {
  const cheminSauvegarde = cheminFichier.replace(/\.json$/i, '') + '.precedent.json';

  /**
   * Charge les réglages. N'échoue jamais : en cas de fichier illisible ou
   * corrompu, met le fichier fautif de côté et repart des valeurs par défaut,
   * en signalant l'incident dans `avertissements`.
   *
   * @returns {{ config: object, existait: boolean, avertissements: string[] }}
   */
  function charger() {
    const avertissements = [];

    let brut = null;
    let existait = false;
    try {
      brut = fs.readFileSync(cheminFichier, 'utf8');
      existait = true;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        avertissements.push(
          `Réglages illisibles (${err.code || err.message}) : les valeurs par défaut sont utilisées. ` +
            `Vérifiez les droits sur ${cheminFichier}`
        );
      }
      return { config: reglagesParDefaut(contexte), existait: false, avertissements };
    }

    let objet = null;
    try {
      objet = JSON.parse(brut);
    } catch (err) {
      const misDeCote = mettreDeCote(cheminFichier, brut);
      avertissements.push(
        `Le fichier de réglages n'était pas un JSON valide (${err.message}). ` +
          `Il a été conservé sous ${misDeCote} et les valeurs par défaut ont été rechargées.`
      );
      return { config: reglagesParDefaut(contexte), existait, avertissements };
    }

    return { config: normaliser(objet, contexte), existait, avertissements };
  }

  /**
   * Écrit les réglages sur disque (écriture atomique : fichier temporaire puis
   * renommage), après avoir conservé la version précédente.
   *
   * @param {object} config
   * @returns {{ config: object }}
   * @throws {Error} si l'écriture échoue (code d'erreur système conservé)
   */
  function enregistrer(config) {
    const propre = normaliser(config, contexte);

    fs.mkdirSync(path.dirname(cheminFichier), { recursive: true });

    try {
      if (fs.existsSync(cheminFichier)) {
        fs.copyFileSync(cheminFichier, cheminSauvegarde);
      }
    } catch (err) {
      // La copie de sécurité est un confort, pas une condition : on continue,
      // mais sans masquer l'incident.
      process.emitWarning(`Copie de sécurité des réglages impossible : ${err.message}`);
    }

    const temporaire = cheminFichier + '.tmp';
    fs.writeFileSync(temporaire, JSON.stringify(propre, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaire, cheminFichier);

    return { config: propre };
  }

  /** Réécrit un fichier de réglages neuf et le renvoie. */
  function reinitialiser() {
    return enregistrer(reglagesParDefaut(contexte));
  }

  return {
    chemin: cheminFichier,
    cheminSauvegarde,
    charger,
    enregistrer,
    reinitialiser
  };
}

/** Conserve une copie horodatée d'un fichier illisible, et renvoie son chemin. */
function mettreDeCote(cheminFichier, contenu) {
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = `${cheminFichier}.corrompu-${horodatage}`;
  try {
    fs.writeFileSync(destination, contenu, 'utf8');
    return destination;
  } catch (err) {
    return `${cheminFichier} (copie impossible : ${err.message})`;
  }
}

module.exports = {
  VERSION_CONFIG,
  FICHIER_SENSIBLE,
  CONTENU_APP_OFFLINE_DEFAUT,
  reglagesParDefaut,
  creerProjet,
  normaliser,
  verifier,
  correspondMotif,
  motifEnRegex,
  fichierSensibleExclu,
  resoudreProjet,
  joindreWin,
  projetParDefaut,
  creerDepot
};
