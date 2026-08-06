'use strict';

/**
 * compare.js — appariement des deux arborescences et attribution des statuts.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Règles de comparaison, sans exception :
 *   - une taille différente suffit à conclure « modifié », sans lire le contenu ;
 *   - à tailles égales, on tranche sur un SHA-256 des deux côtés ;
 *   - la date de modification n'est jamais une preuve d'égalité. Une copie
 *     réseau, un git checkout ou un rebuild la réécrivent sans que le contenu
 *     change. Elle n'est qu'une information affichée.
 */

const { pool } = require('./fsindex');

const MODIFIE = 'modifie';
const NOUVEAU = 'nouveau';
const ORPHELIN = 'orphelin';
const IDENTIQUE = 'identique';

const STATUTS = [MODIFIE, NOUVEAU, ORPHELIN, IDENTIQUE];

/** Du plus « chaud » au plus froid : un dossier prend le statut de son enfant le plus chaud. */
const CHALEUR = { [MODIFIE]: 3, [NOUVEAU]: 2, [ORPHELIN]: 1, [IDENTIQUE]: 0 };

/** Seuls « modifié » et « nouveau » partent en production. */
const DEPLOYABLES = new Set([MODIFIE, NOUVEAU]);

const LIBELLES = {
  [MODIFIE]: 'modifié',
  [NOUVEAU]: 'nouveau',
  [ORPHELIN]: 'orphelin',
  [IDENTIQUE]: 'identique'
};

/** Marqueur d'une seule lettre, pour ne pas dépendre uniquement de la couleur. */
const MARQUEURS = {
  [MODIFIE]: 'M',
  [NOUVEAU]: '+',
  [ORPHELIN]: '−',
  [IDENTIQUE]: '='
};

function compteursVides() {
  return { [MODIFIE]: 0, [NOUVEAU]: 0, [ORPHELIN]: 0, [IDENTIQUE]: 0 };
}

// ---------------------------------------------------------------------------
// Appariement
// ---------------------------------------------------------------------------

/**
 * Apparie deux index par chemin relatif normalisé en minuscules et attribue un
 * statut provisoire. Les fichiers présents des deux côtés à taille égale sont
 * rendus dans `aVerifier` : leur statut dépend de leur empreinte.
 *
 * @param {Map<string, object>} local
 * @param {Map<string, object>} prod
 */
function apparier(local, prod) {
  const fichiers = [];
  const aVerifier = [];

  for (const [identifiant, entreeLocale] of local) {
    const entreeProd = prod.get(identifiant);
    if (!entreeProd) {
      fichiers.push(creerFichier(identifiant, entreeLocale, null, NOUVEAU));
      continue;
    }
    if (entreeLocale.taille !== entreeProd.taille) {
      fichiers.push(creerFichier(identifiant, entreeLocale, entreeProd, MODIFIE));
      continue;
    }
    if (entreeLocale.taille === 0) {
      // Deux fichiers vides : rien à lire, ils sont identiques.
      fichiers.push(creerFichier(identifiant, entreeLocale, entreeProd, IDENTIQUE));
      continue;
    }
    const fichier = creerFichier(identifiant, entreeLocale, entreeProd, null);
    fichiers.push(fichier);
    aVerifier.push(fichier);
  }

  for (const [identifiant, entreeProd] of prod) {
    if (local.has(identifiant)) continue;
    fichiers.push(creerFichier(identifiant, null, entreeProd, ORPHELIN));
  }

  fichiers.sort((a, b) => a.cle.localeCompare(b.cle, 'fr'));
  return { fichiers, aVerifier };
}

function creerFichier(identifiant, entreeLocale, entreeProd, statut) {
  const reference = entreeLocale || entreeProd;
  return {
    cle: identifiant,
    // La casse affichée est celle du poste local quand le fichier y existe.
    chemin: reference.chemin,
    nom: reference.nom,
    extension: reference.extension,
    statut,
    local: entreeLocale ? cote(entreeLocale) : null,
    prod: entreeProd ? cote(entreeProd) : null
  };
}

function cote(entree) {
  return {
    absolu: entree.absolu,
    chemin: entree.chemin,
    taille: entree.taille,
    mtimeMs: entree.mtimeMs,
    hash: null
  };
}

// ---------------------------------------------------------------------------
// Vérification du contenu
// ---------------------------------------------------------------------------

/**
 * Tranche le sort des fichiers de même taille en calculant les deux empreintes.
 *
 * @param {object[]} aVerifier
 * @param {object} options
 * @param {(cote:object) => Promise<string>} options.hasher
 * @param {number} [options.concurrence]
 * @param {{annule:boolean}} [options.signal]
 * @param {(avancement:{faits:number,total:number}) => void} [options.surProgression]
 * @param {(incident:object) => void} [options.surIncident]
 */
async function verifierContenus(aVerifier, options) {
  const {
    hasher,
    concurrence = 6,
    signal = { annule: false },
    surProgression = null,
    surIncident = null
  } = options;

  let faits = 0;
  await pool(
    aVerifier,
    concurrence,
    async (fichier) => {
      try {
        const [hashLocal, hashProd] = await Promise.all([hasher(fichier.local), hasher(fichier.prod)]);
        fichier.local.hash = hashLocal;
        fichier.prod.hash = hashProd;
        fichier.statut = hashLocal === hashProd ? IDENTIQUE : MODIFIE;
      } catch (err) {
        // Fichier verrouillé ou disparu : on ne conclut pas à l'égalité, on le
        // signale et on le traite comme modifié pour qu'il reste visible.
        fichier.statut = MODIFIE;
        fichier.incertain = true;
        if (surIncident) {
          surIncident({
            chemin: fichier.chemin,
            type: 'fichier',
            raison: 'contenu illisible (' + (err.code || err.message) + ') — statut supposé modifié'
          });
        }
      }
      faits += 1;
      if (surProgression && faits % 10 === 0) surProgression({ faits, total: aVerifier.length });
    },
    signal
  );

  if (surProgression) surProgression({ faits, total: aVerifier.length });
  return faits;
}

// ---------------------------------------------------------------------------
// Synthèse
// ---------------------------------------------------------------------------

function compter(fichiers) {
  const compteurs = compteursVides();
  for (const fichier of fichiers) {
    if (fichier.statut) compteurs[fichier.statut] += 1;
  }
  return compteurs;
}

/** Extensions présentes et leur nombre, triées par fréquence décroissante. */
function inventaireExtensions(fichiers) {
  const nombres = new Map();
  for (const fichier of fichiers) {
    const extension = fichier.extension || '(sans extension)';
    nombres.set(extension, (nombres.get(extension) || 0) + 1);
  }
  return [...nombres.entries()]
    .map(([extension, nombre]) => ({ extension, nombre }))
    .sort((a, b) => b.nombre - a.nombre || a.extension.localeCompare(b.extension));
}

// ---------------------------------------------------------------------------
// Arborescence
// ---------------------------------------------------------------------------

/**
 * Construit la vraie hiérarchie des dossiers à partir de la liste plate.
 * Chaque dossier porte le compte agrégé de ses descendants par statut et le
 * statut le plus chaud qu'il contient.
 *
 * @param {object[]} fichiers
 * @returns {object} nœud racine
 */
function construireArbre(fichiers) {
  const racine = creerDossier('', '');

  for (const fichier of fichiers) {
    const morceaux = fichier.chemin.split('\\');
    let courant = racine;
    for (let i = 0; i < morceaux.length - 1; i += 1) {
      const nom = morceaux[i];
      const identifiant = nom.toLowerCase();
      let suivant = courant.index.get(identifiant);
      if (!suivant) {
        const chemin = courant.chemin ? courant.chemin + '\\' + nom : nom;
        suivant = creerDossier(nom, chemin);
        courant.index.set(identifiant, suivant);
        courant.enfants.push(suivant);
      }
      courant = suivant;
    }
    courant.enfants.push({ type: 'fichier', ...fichier });
  }

  finaliser(racine);
  return racine;
}

function creerDossier(nom, chemin) {
  return {
    type: 'dossier',
    nom,
    chemin,
    cle: chemin.toLowerCase(),
    enfants: [],
    index: new Map(),
    compteurs: compteursVides(),
    statut: null,
    nombreFichiers: 0
  };
}

/** Trie (dossiers d'abord) et fait remonter les compteurs. */
function finaliser(noeud) {
  delete noeud.index;
  noeud.enfants.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dossier' ? -1 : 1;
    return a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' });
  });

  for (const enfant of noeud.enfants) {
    if (enfant.type === 'dossier') {
      finaliser(enfant);
      for (const statut of STATUTS) noeud.compteurs[statut] += enfant.compteurs[statut];
      noeud.nombreFichiers += enfant.nombreFichiers;
    } else {
      if (enfant.statut) noeud.compteurs[enfant.statut] += 1;
      noeud.nombreFichiers += 1;
    }
  }

  noeud.statut = statutLePlusChaud(noeud.compteurs);
}

function statutLePlusChaud(compteurs) {
  let choisi = null;
  for (const statut of STATUTS) {
    if (compteurs[statut] > 0 && (choisi === null || CHALEUR[statut] > CHALEUR[choisi])) {
      choisi = statut;
    }
  }
  return choisi;
}

// ---------------------------------------------------------------------------
// Comparaison complète
// ---------------------------------------------------------------------------

/**
 * Enchaîne appariement, vérification du contenu et synthèse.
 * @returns {Promise<{fichiers:object[], compteurs:object, extensions:object[], incidents:object[]}>}
 */
async function comparer(local, prod, options) {
  const { fichiers, aVerifier } = apparier(local, prod);
  const incidents = [];

  await verifierContenus(aVerifier, {
    ...options,
    surIncident: (incident) => incidents.push(incident)
  });

  return {
    fichiers,
    compteurs: compter(fichiers),
    extensions: inventaireExtensions(fichiers),
    incidents,
    aVerifier: aVerifier.length
  };
}

module.exports = {
  MODIFIE,
  NOUVEAU,
  ORPHELIN,
  IDENTIQUE,
  STATUTS,
  DEPLOYABLES,
  LIBELLES,
  MARQUEURS,
  compteursVides,
  apparier,
  verifierContenus,
  comparer,
  compter,
  inventaireExtensions,
  construireArbre,
  statutLePlusChaud
};
