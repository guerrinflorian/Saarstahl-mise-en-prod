'use strict';

/**
 * avmdf.js - lecture réelle du dossier d'archives, détection des demandes et des
 * conventions de sprint.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Trois conventions coexistent selon l'ancienneté de la demande :
 *   AVMDF4590\Default.aspx              → historique (fichiers à la racine)
 *   AVMDF4602\Sprint1\ Sprint2\         → sprint
 *   AVMDF4611\AVMDF4611_1\ _2\          → suffixe
 * On ne mélange jamais deux conventions dans une même demande.
 */

const fsp = require('fs/promises');
const path = require('path');

const { cheminLong, joindreRelatif, pool, raisonLisible } = require('./fsindex');

const CONVENTION_SPRINT = 'sprint';
const CONVENTION_SUFFIXE = 'suffixe';
const CONVENTION_HISTORIQUE = 'historique';
const CONVENTION_VIDE = 'vide';
const CONVENTION_MIXTE = 'mixte';

const MOTIF_DEMANDE = /^AVMDF(\d+)$/i;
const MOTIF_SPRINT = /^Sprint\s*(\d+)$/i;

/**
 * Dossier des mises en production sans numéro de demande : les passages
 * mineurs y sont archivés dans un sous-dossier horodaté chacun, avec leur
 * manifeste. Ils restent donc réversibles, lisibles dans l'historique et
 * comptés au tableau de bord, exactement comme les autres.
 */
const DEMANDE_MINEURE = 'AVMDFMINEUR';

/** Nom du sous-dossier d'un passage mineur : lisible et triable. */
function nomPassageMineur(date) {
  const d = date instanceof Date ? date : new Date();
  const deux = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + deux(d.getMonth() + 1) + '-' + deux(d.getDate()) +
    '_' + deux(d.getHours()) + deux(d.getMinutes()) + deux(d.getSeconds())
  );
}

const MOTIF_PASSAGE_MINEUR = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

/**
 * Sous-dossier où l'outil range SES fichiers dans un dossier de sprint :
 * manifestes, récapitulatif, LISEZMOI. Le nom dit ce qu'il est, pour que
 * quiconque parcourt les archives comprenne d'un coup d'œil que rien ici
 * n'appartient à la demande de travaux. Les versions écrites avant la 2.0
 * restent à la racine du sprint (`_deploiement_*.json`, `_recapitulatif.md`)
 * et sont toujours lues.
 */
const DOSSIER_OUTIL = '_donnees-outil';

/** Fichiers de l'outil restés à la racine d'un sprint (avant la 2.0). */
const MOTIF_FICHIER_OUTIL = /^_(deploiement|restauration)_.*\.json$|^_recapitulatif\.md$/i;

const LIBELLES_CONVENTION = {
  [CONVENTION_SPRINT]: 'sprints numérotés (Sprint1, Sprint2…)',
  [CONVENTION_SUFFIXE]: 'suffixe numéroté (AVMDF0000_1, _2…)',
  [CONVENTION_HISTORIQUE]: 'ancienne organisation : fichiers directement à la racine',
  [CONVENTION_VIDE]: 'demande vide',
  [CONVENTION_MIXTE]: 'deux conventions mélangées'
};

// ---------------------------------------------------------------------------
// Normalisation des numéros de demande
// ---------------------------------------------------------------------------

/** « 4611 », « avmdf4611 » ou « AVMDF 4611 » donnent tous AVMDF4611. */
function normaliserDemande(saisie) {
  const propre = String(saisie || '').trim().replace(/\s+/g, '');
  if (!propre) return null;
  const numerique = propre.match(/^(\d+)$/);
  if (numerique) return { nom: 'AVMDF' + numerique[1], numero: Number(numerique[1]) };
  const complet = propre.match(/^avmdf(\d+)$/i);
  if (complet) return { nom: 'AVMDF' + complet[1], numero: Number(complet[1]) };
  return null;
}

// ---------------------------------------------------------------------------
// Lecture du dossier d'archives
// ---------------------------------------------------------------------------

/**
 * Liste les demandes existantes, du numéro le plus élevé au plus bas.
 * @param {string} racineAvmdf
 * @returns {Promise<{demandes:object[], erreur:string|null}>}
 */
async function listerDemandes(racineAvmdf) {
  let contenu;
  try {
    contenu = await fsp.readdir(cheminLong(racineAvmdf), { withFileTypes: true });
  } catch (err) {
    return {
      demandes: [],
      erreur:
        `Dossier d'archives illisible (${raisonLisible(err)}) : ` +
        racineAvmdf +
        '. Vérifiez que le lecteur réseau est connecté.'
    };
  }

  const demandes = [];
  for (const element of contenu) {
    if (!element.isDirectory()) continue;
    // Le dossier des passages mineurs compte comme une demande : ses versions
    // archivées doivent ressortir partout (frise, versions d'un fichier).
    if (element.name.toUpperCase() === DEMANDE_MINEURE) {
      demandes.push({
        nom: element.name,
        numero: 0,
        mineure: true,
        chemin: path.join(racineAvmdf, element.name)
      });
      continue;
    }
    const trouve = element.name.match(MOTIF_DEMANDE);
    if (!trouve) continue;
    demandes.push({
      nom: element.name,
      numero: Number(trouve[1]),
      chemin: path.join(racineAvmdf, element.name)
    });
  }

  demandes.sort((a, b) => b.numero - a.numero);
  return { demandes, erreur: null };
}

/**
 * Inspecte une demande : convention en place, sprints existants, nom proposé.
 *
 * @param {string} cheminDemande
 * @param {string} nomDemande
 * @returns {Promise<object>}
 */
async function inspecterDemande(cheminDemande, nomDemande) {
  let contenu;
  try {
    contenu = await fsp.readdir(cheminLong(cheminDemande), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        existe: false,
        convention: CONVENTION_VIDE,
        sprints: [],
        fichiersRacine: 0,
        proposition: nomDemande + '_1'
      };
    }
    return {
      existe: true,
      erreur: `Demande illisible (${raisonLisible(err)}) : ${cheminDemande}`,
      convention: CONVENTION_VIDE,
      sprints: [],
      fichiersRacine: 0,
      proposition: nomDemande + '_1'
    };
  }

  const sousDossiers = contenu
    .filter((e) => e.isDirectory() && e.name.toLowerCase() !== DOSSIER_OUTIL)
    .map((e) => e.name);
  const fichiersRacine = contenu.filter((e) => e.isFile() && !MOTIF_FICHIER_OUTIL.test(e.name)).length;

  const numerosSprint = [];
  const numerosSuffixe = [];
  const autres = [];
  const motifSuffixe = new RegExp('^' + nomDemande + '_(\\d+)$', 'i');

  for (const nom of sousDossiers) {
    const sprint = nom.match(MOTIF_SPRINT);
    if (sprint) {
      numerosSprint.push({ nom, numero: Number(sprint[1]) });
      continue;
    }
    const suffixe = nom.match(motifSuffixe);
    if (suffixe) {
      numerosSuffixe.push({ nom, numero: Number(suffixe[1]) });
      continue;
    }
    autres.push({ nom, numero: 0 });
  }

  let convention;
  if (numerosSprint.length && numerosSuffixe.length) convention = CONVENTION_MIXTE;
  else if (numerosSprint.length) convention = CONVENTION_SPRINT;
  else if (numerosSuffixe.length) convention = CONVENTION_SUFFIXE;
  else if (fichiersRacine > 0) convention = CONVENTION_HISTORIQUE;
  else if (autres.length) convention = CONVENTION_SUFFIXE;
  else convention = CONVENTION_VIDE;

  const sprints = [...numerosSprint, ...numerosSuffixe, ...autres]
    .map((s) => ({ ...s, chemin: path.join(cheminDemande, s.nom) }))
    .sort((a, b) => b.numero - a.numero || a.nom.localeCompare(b.nom, 'fr'));

  return {
    existe: true,
    erreur: null,
    convention,
    sprints,
    fichiersRacine,
    proposition: proposerNom(convention, nomDemande, { numerosSprint, numerosSuffixe })
  };
}

/**
 * Nom de sprint proposé, toujours dans la convention déjà en place.
 * Le nom reste modifiable : ce n'est qu'une proposition.
 */
function proposerNom(convention, nomDemande, { numerosSprint = [], numerosSuffixe = [] } = {}) {
  const maximum = (liste) => liste.reduce((haut, s) => Math.max(haut, s.numero), 0);
  switch (convention) {
    case CONVENTION_SPRINT:
      return 'Sprint' + (maximum(numerosSprint) + 1);
    case CONVENTION_SUFFIXE:
      return nomDemande + '_' + (maximum(numerosSuffixe) + 1);
    case CONVENTION_MIXTE:
      // On ne tranche pas à la place de l'utilisateur : on repart du plus récent.
      return maximum(numerosSprint) >= maximum(numerosSuffixe)
        ? 'Sprint' + (maximum(numerosSprint) + 1)
        : nomDemande + '_' + (maximum(numerosSuffixe) + 1);
    case CONVENTION_HISTORIQUE:
    case CONVENTION_VIDE:
    default:
      return nomDemande + '_1';
  }
}

/**
 * Le nom de sprint saisi respecte-t-il la convention de la demande ?
 * @returns {{ compatible:boolean, message:string|null }}
 */
function verifierConvention(convention, nomDemande, nomSprint) {
  const estSprint = MOTIF_SPRINT.test(nomSprint);
  const estSuffixe = new RegExp('^' + nomDemande + '_\\d+$', 'i').test(nomSprint);

  if (convention === CONVENTION_SPRINT && estSuffixe) {
    return {
      compatible: false,
      message:
        `Cette demande utilise la convention « Sprint N ». Ne mélangez pas les deux : ` +
        `restez sur un nom du type Sprint${'N'}.`
    };
  }
  if (convention === CONVENTION_SUFFIXE && estSprint) {
    return {
      compatible: false,
      message:
        `Cette demande utilise la convention « ${nomDemande}_N ». Ne mélangez pas les deux : ` +
        `restez sur un nom du type ${nomDemande}_N.`
    };
  }
  return { compatible: true, message: null };
}

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/**
 * Résout le dossier de sauvegarde et vérifie qu'il ne sort pas du périmètre.
 * @returns {{ chemin:string|null, valide:boolean, erreur:string|null }}
 */
function resoudreDestination(racineAvmdf, nomDemande, nomSprint) {
  if (!nomDemande) {
    return { chemin: null, valide: false, erreur: 'Aucune demande choisie.' };
  }
  if (!nomSprint || !nomSprint.trim()) {
    return { chemin: null, valide: false, erreur: 'Aucun dossier de sprint indiqué.' };
  }
  if (/[\\/:*?"<>|]/.test(nomSprint)) {
    return {
      chemin: null,
      valide: false,
      erreur: 'Le nom du sprint ne peut pas contenir \\ / : * ? " < > |'
    };
  }

  const chemin = path.join(racineAvmdf, nomDemande, nomSprint.trim());
  if (!estSousRacine(chemin, racineAvmdf)) {
    return { chemin: null, valide: false, erreur: 'La destination sortirait du dossier d\'archives.' };
  }
  return { chemin, valide: true, erreur: null };
}

/**
 * Un chemin est-il bien contenu dans une racine ? Comparaison insensible à la
 * casse, et sur des frontières de dossier : `Z:\AvMdfBis` n'est pas sous
 * `Z:\AvMdf`.
 */
function estSousRacine(chemin, racine) {
  const resoudre = (valeur) =>
    path.resolve(valeur).replace(/[\\/]+$/, '').toLowerCase();
  const cible = resoudre(chemin);
  const base = resoudre(racine);
  if (cible === base) return true;
  return cible.startsWith(base + path.sep.toLowerCase()) || cible.startsWith(base + '\\') || cible.startsWith(base + '/');
}

/**
 * Contenu d'un dossier de sprint, pour avertir avant d'y déposer des fichiers.
 *
 * Les fichiers de l'outil (dossier `_donnees-outil`, et manifestes ou
 * récapitulatif restés à la racine avant la 2.0) ne comptent ni dans
 * `fichiers` ni dans `vide` : ce que l'avertissement mesure, ce sont les
 * versions archivées déjà présentes, pas les traces de l'outil.
 */
async function inspecterSprint(cheminSprint) {
  try {
    const contenu = await fsp.readdir(cheminLong(cheminSprint), { withFileTypes: true });
    const fichiers = contenu.filter((e) => e.isFile() && !MOTIF_FICHIER_OUTIL.test(e.name)).length;
    const dossiers = contenu.filter((e) => e.isDirectory() && e.name.toLowerCase() !== DOSSIER_OUTIL).length;
    let manifestes = contenu.filter((e) => e.isFile() && /^_deploiement_.*\.json$/i.test(e.name)).length;
    if (contenu.some((e) => e.isDirectory() && e.name.toLowerCase() === DOSSIER_OUTIL)) {
      try {
        const outil = await fsp.readdir(cheminLong(path.join(cheminSprint, DOSSIER_OUTIL)));
        manifestes += outil.filter((n) => /^_deploiement_.*\.json$/i.test(n)).length;
      } catch (err) {
        /* dossier de l'outil illisible : le compte des manifestes reste partiel */
      }
    }
    return { existe: true, vide: fichiers === 0 && dossiers === 0, fichiers, dossiers, manifestes };
  } catch (err) {
    if (err.code === 'ENOENT') return { existe: false, vide: true, fichiers: 0, dossiers: 0, manifestes: 0 };
    return { existe: true, erreur: raisonLisible(err), vide: false, fichiers: 0, dossiers: 0, manifestes: 0 };
  }
}


// ---------------------------------------------------------------------------
// Versions archivées d'un fichier
// ---------------------------------------------------------------------------

/**
 * Retrouve toutes les versions « avant modification » d'un fichier, tous
 * demandes et tous sprints confondus.
 *
 * On regarde dans chaque dossier de sprint, et aussi à la racine de chaque
 * demande pour la convention historique. Les manifestes présents sur place
 * fournissent la date et l'auteur ; à défaut, on se rabat sur la date du
 * fichier archivé.
 *
 * @param {string} racineAvmdf
 * @param {string} cheminRelatif chemin relatif du fichier, séparateurs Windows
 * @returns {Promise<{versions:object[], erreur:string|null}>}
 */
async function versionsArchivees(racineAvmdf, cheminRelatif, options = {}) {
  const { concurrence = 6, signal = { annule: false } } = options;
  if (!cheminRelatif) return { versions: [], erreur: null };

  const { demandes, erreur } = await listerDemandes(racineAvmdf);
  if (erreur) return { versions: [], erreur };

  const emplacements = [];
  for (const demande of demandes) {
    emplacements.push({ demande: demande.nom, numero: demande.numero, sprint: null, dossier: demande.chemin });
    let contenu = [];
    try {
      contenu = await fsp.readdir(cheminLong(demande.chemin), { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const element of contenu) {
      if (!element.isDirectory()) continue;
      emplacements.push({
        demande: demande.nom,
        numero: demande.numero,
        sprint: element.name,
        dossier: path.join(demande.chemin, element.name)
      });
    }
  }

  const versions = [];
  await pool(
    emplacements,
    concurrence,
    async (emplacement) => {
      const chemin = joindreRelatif(emplacement.dossier, cheminRelatif);
      try {
        const etat = await fsp.stat(cheminLong(chemin));
        if (!etat.isFile()) return;
        versions.push({
          demande: emplacement.demande,
          numero: emplacement.numero,
          sprint: emplacement.sprint,
          dossier: emplacement.dossier,
          chemin,
          taille: etat.size,
          mtimeMs: etat.mtimeMs,
          date: null,
          auteur: null,
          action: null,
          simulation: false
        });
      } catch (err) {
        /* pas de version archivée ici */
      }
    },
    signal
  );

  await enrichirParLesManifestes(versions, cheminRelatif, concurrence, signal);

  versions.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : a.mtimeMs;
    const db = b.date ? Date.parse(b.date) : b.mtimeMs;
    return db - da;
  });

  return { versions, erreur: null };
}

/** Complète les versions avec la date, l'auteur et l'action lus des manifestes. */
async function enrichirParLesManifestes(versions, cheminRelatif, concurrence, signal) {
  const dossiers = [...new Set(versions.map((v) => v.dossier))];
  const parDossier = new Map();

  await pool(
    dossiers,
    concurrence,
    async (dossier) => {
      // Les manifestes vivent dans `_donnees-outil` depuis la 2.0, à la
      // racine du sprint avant : les deux emplacements sont lus.
      const chemins = [];
      for (const emplacement of [dossier, path.join(dossier, DOSSIER_OUTIL)]) {
        try {
          const noms = (await fsp.readdir(cheminLong(emplacement))).filter((n) =>
            /^_(deploiement|restauration)_.*\.json$/i.test(n)
          );
          chemins.push(...noms.map((nom) => path.join(emplacement, nom)));
        } catch (err) {
          /* emplacement absent ou illisible : l'autre suffit */
        }
      }
      if (!chemins.length) return;
      const entrees = [];
      for (const chemin of chemins) {
        try {
          const manifeste = JSON.parse(await fsp.readFile(cheminLong(chemin), 'utf8'));
          const fichier = (manifeste.fichiers || []).find(
            (f) => String(f.chemin || '').toLowerCase() === cheminRelatif.toLowerCase()
          );
          if (fichier) {
            entrees.push({
              date: manifeste.date,
              auteur: manifeste.auteur,
              action: fichier.action,
              simulation: Boolean(manifeste.simulation),
              manifeste: chemin
            });
          }
        } catch (err) {
          /* manifeste illisible : la version reste utilisable sans métadonnées */
        }
      }
      entrees.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (entrees.length) parDossier.set(dossier, entrees[0]);
    },
    signal
  );

  for (const version of versions) {
    const trouve = parDossier.get(version.dossier);
    if (!trouve) continue;
    version.date = trouve.date;
    version.auteur = trouve.auteur;
    version.action = trouve.action;
    version.simulation = trouve.simulation;
    version.manifeste = trouve.manifeste;
  }
}

module.exports = {
  CONVENTION_SPRINT,
  CONVENTION_SUFFIXE,
  CONVENTION_HISTORIQUE,
  CONVENTION_VIDE,
  CONVENTION_MIXTE,
  DOSSIER_OUTIL,
  MOTIF_FICHIER_OUTIL,
  LIBELLES_CONVENTION,
  DEMANDE_MINEURE,
  MOTIF_PASSAGE_MINEUR,
  nomPassageMineur,
  normaliserDemande,
  listerDemandes,
  inspecterDemande,
  inspecterSprint,
  proposerNom,
  verifierConvention,
  resoudreDestination,
  estSousRacine,
  versionsArchivees
};
