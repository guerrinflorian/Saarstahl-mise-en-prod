'use strict';

/**
 * avmdf.js — lecture réelle du dossier d'archives, détection des tickets et des
 * conventions de sprint.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Trois conventions coexistent selon l'ancienneté du ticket :
 *   AVMDF4590\Default.aspx              → historique (fichiers à la racine)
 *   AVMDF4602\Sprint1\ Sprint2\         → sprint
 *   AVMDF4611\AVMDF4611_1\ _2\          → suffixe
 * On ne mélange jamais deux conventions dans un même ticket.
 */

const fsp = require('fs/promises');
const path = require('path');

const { cheminLong, raisonLisible } = require('./fsindex');

const CONVENTION_SPRINT = 'sprint';
const CONVENTION_SUFFIXE = 'suffixe';
const CONVENTION_HISTORIQUE = 'historique';
const CONVENTION_VIDE = 'vide';
const CONVENTION_MIXTE = 'mixte';

const MOTIF_TICKET = /^AVMDF(\d+)$/i;
const MOTIF_SPRINT = /^Sprint\s*(\d+)$/i;

const LIBELLES_CONVENTION = {
  [CONVENTION_SPRINT]: 'sprints numérotés (Sprint1, Sprint2…)',
  [CONVENTION_SUFFIXE]: 'suffixe numéroté (AVMDF0000_1, _2…)',
  [CONVENTION_HISTORIQUE]: 'ancienne organisation : fichiers directement à la racine',
  [CONVENTION_VIDE]: 'ticket vide',
  [CONVENTION_MIXTE]: 'deux conventions mélangées'
};

// ---------------------------------------------------------------------------
// Normalisation des numéros de ticket
// ---------------------------------------------------------------------------

/** « 4611 », « avmdf4611 » ou « AVMDF 4611 » donnent tous AVMDF4611. */
function normaliserTicket(saisie) {
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
 * Liste les tickets existants, du numéro le plus élevé au plus bas.
 * @param {string} racineAvmdf
 * @returns {Promise<{tickets:object[], erreur:string|null}>}
 */
async function listerTickets(racineAvmdf) {
  let contenu;
  try {
    contenu = await fsp.readdir(cheminLong(racineAvmdf), { withFileTypes: true });
  } catch (err) {
    return {
      tickets: [],
      erreur:
        `Dossier d'archives illisible (${raisonLisible(err)}) : ` +
        racineAvmdf +
        '. Vérifiez que le lecteur réseau est connecté.'
    };
  }

  const tickets = [];
  for (const element of contenu) {
    if (!element.isDirectory()) continue;
    const trouve = element.name.match(MOTIF_TICKET);
    if (!trouve) continue;
    tickets.push({
      nom: element.name,
      numero: Number(trouve[1]),
      chemin: path.join(racineAvmdf, element.name)
    });
  }

  tickets.sort((a, b) => b.numero - a.numero);
  return { tickets, erreur: null };
}

/**
 * Inspecte un ticket : convention en place, sprints existants, nom proposé.
 *
 * @param {string} cheminTicket
 * @param {string} nomTicket
 * @returns {Promise<object>}
 */
async function inspecterTicket(cheminTicket, nomTicket) {
  let contenu;
  try {
    contenu = await fsp.readdir(cheminLong(cheminTicket), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        existe: false,
        convention: CONVENTION_VIDE,
        sprints: [],
        fichiersRacine: 0,
        proposition: nomTicket + '_1'
      };
    }
    return {
      existe: true,
      erreur: `Ticket illisible (${raisonLisible(err)}) : ${cheminTicket}`,
      convention: CONVENTION_VIDE,
      sprints: [],
      fichiersRacine: 0,
      proposition: nomTicket + '_1'
    };
  }

  const sousDossiers = contenu.filter((e) => e.isDirectory()).map((e) => e.name);
  const fichiersRacine = contenu.filter((e) => e.isFile() && !e.name.startsWith('_deploiement_')).length;

  const numerosSprint = [];
  const numerosSuffixe = [];
  const autres = [];
  const motifSuffixe = new RegExp('^' + nomTicket + '_(\\d+)$', 'i');

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
    .map((s) => ({ ...s, chemin: path.join(cheminTicket, s.nom) }))
    .sort((a, b) => b.numero - a.numero || a.nom.localeCompare(b.nom, 'fr'));

  return {
    existe: true,
    erreur: null,
    convention,
    sprints,
    fichiersRacine,
    proposition: proposerNom(convention, nomTicket, { numerosSprint, numerosSuffixe })
  };
}

/**
 * Nom de sprint proposé, toujours dans la convention déjà en place.
 * Le nom reste modifiable : ce n'est qu'une proposition.
 */
function proposerNom(convention, nomTicket, { numerosSprint = [], numerosSuffixe = [] } = {}) {
  const maximum = (liste) => liste.reduce((haut, s) => Math.max(haut, s.numero), 0);
  switch (convention) {
    case CONVENTION_SPRINT:
      return 'Sprint' + (maximum(numerosSprint) + 1);
    case CONVENTION_SUFFIXE:
      return nomTicket + '_' + (maximum(numerosSuffixe) + 1);
    case CONVENTION_MIXTE:
      // On ne tranche pas à la place de l'utilisateur : on repart du plus récent.
      return maximum(numerosSprint) >= maximum(numerosSuffixe)
        ? 'Sprint' + (maximum(numerosSprint) + 1)
        : nomTicket + '_' + (maximum(numerosSuffixe) + 1);
    case CONVENTION_HISTORIQUE:
    case CONVENTION_VIDE:
    default:
      return nomTicket + '_1';
  }
}

/**
 * Le nom de sprint saisi respecte-t-il la convention du ticket ?
 * @returns {{ compatible:boolean, message:string|null }}
 */
function verifierConvention(convention, nomTicket, nomSprint) {
  const estSprint = MOTIF_SPRINT.test(nomSprint);
  const estSuffixe = new RegExp('^' + nomTicket + '_\\d+$', 'i').test(nomSprint);

  if (convention === CONVENTION_SPRINT && estSuffixe) {
    return {
      compatible: false,
      message:
        `Ce ticket utilise la convention « Sprint N ». Ne mélangez pas les deux : ` +
        `restez sur un nom du type Sprint${'N'}.`
    };
  }
  if (convention === CONVENTION_SUFFIXE && estSprint) {
    return {
      compatible: false,
      message:
        `Ce ticket utilise la convention « ${nomTicket}_N ». Ne mélangez pas les deux : ` +
        `restez sur un nom du type ${nomTicket}_N.`
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
function resoudreDestination(racineAvmdf, nomTicket, nomSprint) {
  if (!nomTicket) {
    return { chemin: null, valide: false, erreur: 'Aucun ticket choisi.' };
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

  const chemin = path.join(racineAvmdf, nomTicket, nomSprint.trim());
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

/** Contenu d'un dossier de sprint, pour avertir avant d'y déposer des fichiers. */
async function inspecterSprint(cheminSprint) {
  try {
    const contenu = await fsp.readdir(cheminLong(cheminSprint), { withFileTypes: true });
    const fichiers = contenu.filter((e) => e.isFile()).length;
    const dossiers = contenu.filter((e) => e.isDirectory()).length;
    const manifestes = contenu.filter((e) => e.isFile() && /^_deploiement_.*\.json$/i.test(e.name)).length;
    return { existe: true, vide: contenu.length === 0, fichiers, dossiers, manifestes };
  } catch (err) {
    if (err.code === 'ENOENT') return { existe: false, vide: true, fichiers: 0, dossiers: 0, manifestes: 0 };
    return { existe: true, erreur: raisonLisible(err), vide: false, fichiers: 0, dossiers: 0, manifestes: 0 };
  }
}

module.exports = {
  CONVENTION_SPRINT,
  CONVENTION_SUFFIXE,
  CONVENTION_HISTORIQUE,
  CONVENTION_VIDE,
  CONVENTION_MIXTE,
  LIBELLES_CONVENTION,
  normaliserTicket,
  listerTickets,
  inspecterTicket,
  inspecterSprint,
  proposerNom,
  verifierConvention,
  resoudreDestination,
  estSousRacine
};
