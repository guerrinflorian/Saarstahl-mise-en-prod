'use strict';

/**
 * search.js — moteur de recherche et de filtrage.
 *
 * Module Node pur, sans accès au disque : il travaille sur la liste produite
 * par `compare.js`. La recherche dans le contenu des fichiers lui est fournie
 * sous forme de carte `clé → occurrences`, remplie par le processus principal.
 */

const { correspondMotif } = require('./config');

const MODE_CONTIENT = 'contient';
const MODE_REGEX = 'regex';
const MODE_GLOB = 'glob';
const MODES = [MODE_CONTIENT, MODE_REGEX, MODE_GLOB];

/** Retire les accents : « Traçabilité » doit se trouver en tapant « tracabilite ». */
function sansAccents(texte) {
  return texte.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normaliser(texte) {
  return sansAccents(String(texte || '')).toLowerCase();
}

// ---------------------------------------------------------------------------
// Filtre textuel
// ---------------------------------------------------------------------------

/**
 * @param {string} requete
 * @param {string} mode contient | regex | glob
 * @returns {{ actif:boolean, valide:boolean, erreur:string|null, teste:(chemin:string)=>boolean }}
 */
function creerFiltreTexte(requete, mode = MODE_CONTIENT) {
  const propre = String(requete || '').trim();
  if (!propre) {
    return { actif: false, valide: true, erreur: null, teste: () => true };
  }

  if (mode === MODE_REGEX) {
    let expression;
    try {
      expression = new RegExp(propre, 'i');
    } catch (err) {
      return {
        actif: true,
        valide: false,
        erreur: 'Expression régulière invalide : ' + err.message,
        teste: () => false
      };
    }
    return { actif: true, valide: true, erreur: null, teste: (chemin) => expression.test(chemin) };
  }

  if (mode === MODE_GLOB) {
    return {
      actif: true,
      valide: true,
      erreur: null,
      teste: (chemin) => correspondMotif(propre, chemin)
    };
  }

  const aiguille = normaliser(propre);
  return {
    actif: true,
    valide: true,
    erreur: null,
    teste: (chemin) => normaliser(chemin).includes(aiguille)
  };
}

// ---------------------------------------------------------------------------
// Filtres combinés
// ---------------------------------------------------------------------------

function criteresParDefaut() {
  return {
    requete: '',
    mode: MODE_CONTIENT,
    statuts: { modifie: true, nouveau: true, orphelin: true, identique: false },
    extensions: null, // null = toutes
    depuis: null, // horodatage : « modifiés localement depuis »
    dossier: '',
    dansLeContenu: false
  };
}

function estVierge(criteres) {
  const defaut = criteresParDefaut();
  return (
    !criteres.requete.trim() &&
    criteres.mode === defaut.mode &&
    !criteres.extensions &&
    !criteres.depuis &&
    !criteres.dossier &&
    !criteres.dansLeContenu &&
    Object.keys(defaut.statuts).every((statut) => criteres.statuts[statut] === defaut.statuts[statut])
  );
}

/**
 * Applique tous les filtres actifs, en ET logique.
 *
 * @param {object[]} fichiers
 * @param {object} criteres
 * @param {Map<string, number>} [occurrences] clé → nombre d'occurrences trouvées
 * @returns {object[]}
 */
function filtrer(fichiers, criteres, occurrences = null) {
  const filtre = creerFiltreTexte(criteres.requete, criteres.mode);
  if (!filtre.valide) return [];

  const statuts = criteres.statuts || {};
  const extensions = criteres.extensions instanceof Set ? criteres.extensions : null;
  const dossier = String(criteres.dossier || '').replace(/[\\/]+$/, '').toLowerCase();
  const depuis = criteres.depuis || null;
  const chercheContenu = Boolean(criteres.dansLeContenu && occurrences);

  const retenus = [];
  for (const fichier of fichiers) {
    if (!statuts[fichier.statut]) continue;

    if (extensions && !extensions.has(fichier.extension || '')) continue;

    if (dossier) {
      const cle = fichier.cle;
      if (cle !== dossier && !cle.startsWith(dossier + '\\')) continue;
    }

    if (depuis) {
      // « modifiés localement depuis » : un orphelin n'a pas de version locale.
      if (!fichier.local || fichier.local.mtimeMs < depuis) continue;
    }

    if (chercheContenu && !occurrences.has(fichier.cle)) continue;

    if (filtre.actif && !chercheContenu && !filtre.teste(fichier.chemin)) continue;

    retenus.push(fichier);
  }
  return retenus;
}

// ---------------------------------------------------------------------------
// Recherche dans le contenu
// ---------------------------------------------------------------------------

/**
 * Nombre d'occurrences d'une requête dans un texte.
 * @returns {number}
 */
function compterOccurrences(texte, requete, mode = MODE_CONTIENT) {
  if (!texte || !requete) return 0;

  if (mode === MODE_REGEX) {
    let expression;
    try {
      expression = new RegExp(requete, 'gi');
    } catch (err) {
      return 0;
    }
    const trouvees = texte.match(expression);
    return trouvees ? trouvees.length : 0;
  }

  // En mode glob comme en mode « contient », on cherche la chaîne telle quelle
  // dans le contenu : un glob n'a pas de sens sur du texte libre.
  const aiguille = normaliser(mode === MODE_GLOB ? requete.replace(/[*?]/g, '') : requete);
  if (!aiguille) return 0;

  const meule = normaliser(texte);
  let nombre = 0;
  let position = meule.indexOf(aiguille);
  while (position !== -1) {
    nombre += 1;
    position = meule.indexOf(aiguille, position + aiguille.length);
  }
  return nombre;
}

// ---------------------------------------------------------------------------
// Inventaires pour la barre de filtres
// ---------------------------------------------------------------------------

/** Dossiers présents dans la liste, du plus court au plus long. */
function listerDossiers(fichiers) {
  const vus = new Set();
  for (const fichier of fichiers) {
    const morceaux = fichier.chemin.split('\\');
    let courant = '';
    for (let i = 0; i < morceaux.length - 1; i += 1) {
      courant = courant ? courant + '\\' + morceaux[i] : morceaux[i];
      vus.add(courant);
    }
  }
  return [...vus].sort((a, b) => a.localeCompare(b, 'fr'));
}

/** Bornes de temps proposées par le filtre « modifiés localement depuis ». */
function depuisQuand(choix, maintenant = Date.now()) {
  const jour = 24 * 60 * 60 * 1000;
  switch (choix) {
    case 'aujourdhui': {
      const debut = new Date(maintenant);
      debut.setHours(0, 0, 0, 0);
      return debut.getTime();
    }
    case '7jours':
      return maintenant - 7 * jour;
    case '30jours':
      return maintenant - 30 * jour;
    default:
      return null;
  }
}

module.exports = {
  MODE_CONTIENT,
  MODE_REGEX,
  MODE_GLOB,
  MODES,
  sansAccents,
  normaliser,
  creerFiltreTexte,
  criteresParDefaut,
  estVierge,
  filtrer,
  compterOccurrences,
  listerDossiers,
  depuisQuand
};
