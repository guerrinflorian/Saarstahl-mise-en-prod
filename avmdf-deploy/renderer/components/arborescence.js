/**
 * arborescence.js - mise en forme de l'arbre pour l'affichage.
 *
 * L'arbre complet est construit par `electron/core/compare.js` et transmis avec
 * le résultat d'analyse. Ici on ne fait que le tailler selon les filtres et
 * l'aplatir en lignes visibles, pour un rendu par fenêtre glissante qui reste
 * fluide au-delà de 5 000 fichiers.
 */

export const STATUTS = ['modifie', 'nouveau', 'orphelin', 'identique'];

export const MARQUEURS = { modifie: 'M', nouveau: '+', orphelin: '−', identique: '=' };

export const LIBELLES = {
  modifie: 'modifié',
  nouveau: 'nouveau',
  orphelin: 'orphelin',
  identique: 'identique'
};

export const PLURIELS = {
  modifie: 'modifiés',
  nouveau: 'nouveaux',
  orphelin: 'orphelins',
  identique: 'identiques'
};

const CHALEUR = { modifie: 3, nouveau: 2, orphelin: 1, identique: 0 };

const DEPLOYABLES = new Set(['modifie', 'nouveau']);

export function estDeployable(fichier) {
  return DEPLOYABLES.has(fichier.statut);
}

function compteursVides() {
  return { modifie: 0, nouveau: 0, orphelin: 0, identique: 0 };
}

function statutLePlusChaud(compteurs) {
  let choisi = null;
  for (const statut of STATUTS) {
    if (compteurs[statut] > 0 && (choisi === null || CHALEUR[statut] > CHALEUR[choisi])) choisi = statut;
  }
  return choisi;
}

/**
 * Taille l'arbre pour ne garder que les fichiers retenus. Les dossiers parents
 * d'un fichier retenu restent affichés, pour garder le contexte.
 *
 * @param {object} noeud arbre complet
 * @param {Set<string>} clesRetenues
 * @returns {object|null}
 */
export function filtrerArbre(noeud, clesRetenues) {
  const enfants = [];
  const compteurs = compteursVides();
  let nombreFichiers = 0;

  for (const enfant of noeud.enfants) {
    if (enfant.type === 'dossier') {
      const taille = filtrerArbre(enfant, clesRetenues);
      if (!taille) continue;
      enfants.push(taille);
      for (const statut of STATUTS) compteurs[statut] += taille.compteurs[statut];
      nombreFichiers += taille.nombreFichiers;
    } else if (clesRetenues.has(enfant.cle)) {
      enfants.push(enfant);
      compteurs[enfant.statut] += 1;
      nombreFichiers += 1;
    }
  }

  if (!enfants.length) return null;
  return {
    ...noeud,
    enfants,
    compteurs,
    nombreFichiers,
    statut: statutLePlusChaud(compteurs)
  };
}

/**
 * Aplatit l'arbre en lignes affichables, en tenant compte des dossiers repliés.
 * @param {object} racine
 * @param {Set<string>} ouverts clés des dossiers dépliés
 * @returns {Array<{noeud:object, profondeur:number}>}
 */
export function aplatir(racine, ouverts) {
  const lignes = [];
  if (!racine) return lignes;

  const descendre = (noeud, profondeur) => {
    for (const enfant of noeud.enfants) {
      lignes.push({ noeud: enfant, profondeur });
      if (enfant.type === 'dossier' && ouverts.has(enfant.cle)) {
        descendre(enfant, profondeur + 1);
      }
    }
  };

  descendre(racine, 0);
  return lignes;
}

/** Toutes les clés de dossier de l'arbre, pour « Tout déplier ». */
export function tousLesDossiers(noeud, accumulateur = new Set()) {
  if (!noeud) return accumulateur;
  for (const enfant of noeud.enfants) {
    if (enfant.type === 'dossier') {
      accumulateur.add(enfant.cle);
      tousLesDossiers(enfant, accumulateur);
    }
  }
  return accumulateur;
}

/** Dossiers à ouvrir pour rendre visibles les premiers niveaux. */
export function dossiersDePremierNiveau(noeud, profondeurMax = 1, profondeur = 0, accumulateur = new Set()) {
  if (!noeud || profondeur >= profondeurMax) return accumulateur;
  for (const enfant of noeud.enfants) {
    if (enfant.type === 'dossier') {
      accumulateur.add(enfant.cle);
      dossiersDePremierNiveau(enfant, profondeurMax, profondeur + 1, accumulateur);
    }
  }
  return accumulateur;
}

/** Fichiers déployables d'une branche, pour la case à cocher d'un dossier. */
export function fichiersDe(noeud, accumulateur = []) {
  for (const enfant of noeud.enfants) {
    if (enfant.type === 'dossier') fichiersDe(enfant, accumulateur);
    else accumulateur.push(enfant);
  }
  return accumulateur;
}

/**
 * État de la case à cocher d'un dossier : cochée, indéterminée ou vide.
 * @returns {'complet'|'partiel'|'vide'}
 */
export function etatSelection(noeud, selection) {
  const candidats = fichiersDe(noeud).filter(estDeployable);
  if (!candidats.length) return 'vide';
  let coches = 0;
  for (const fichier of candidats) if (selection.has(fichier.cle)) coches += 1;
  if (coches === 0) return 'vide';
  return coches === candidats.length ? 'complet' : 'partiel';
}

/**
 * États de coche de tous les dossiers, en une seule passe sur l'arbre.
 *
 * L'ancien calcul (`etatSelection` ligne par ligne) retraversait la branche
 * entière de chaque dossier visible à chaque rendu, jusqu'à deux fois : sur un
 * dossier racine à 5 000 descendants, chaque frame de défilement parcourait
 * 10 000 nœuds. Ici l'arbre n'est parcouru qu'une fois par changement de
 * sélection ou d'arbre, et chaque ligne lit son état dans la Map.
 *
 * Les orphelins comptent aussi : un dossier qui n'en contient que peut se
 * cocher en bloc (la suppression est une opération à part entière), il n'a pas
 * à être grisé.
 *
 * @returns {Map<string, {etat:'complet'|'partiel'|'vide', cochable:boolean}>}
 */
export function etatsSelection(racine, selection) {
  const etats = new Map();
  if (!racine) return etats;

  const visiter = (noeud) => {
    let deployables = 0;
    let coches = 0;
    let orphelins = 0;
    let orphelinsCoches = 0;
    for (const enfant of noeud.enfants) {
      if (enfant.type === 'dossier') {
        const sous = visiter(enfant);
        deployables += sous.deployables;
        coches += sous.coches;
        orphelins += sous.orphelins;
        orphelinsCoches += sous.orphelinsCoches;
      } else if (estDeployable(enfant)) {
        deployables += 1;
        if (selection.has(enfant.cle)) coches += 1;
      } else if (enfant.statut === 'orphelin') {
        orphelins += 1;
        if (selection.has(enfant.cle)) orphelinsCoches += 1;
      }
    }

    const totalCoches = coches + orphelinsCoches;
    const complet =
      (deployables > 0 && coches === deployables) ||
      (deployables === 0 && orphelins > 0 && orphelinsCoches === orphelins);
    etats.set(noeud.cle, {
      etat: totalCoches === 0 ? 'vide' : complet ? 'complet' : 'partiel',
      cochable: deployables > 0 || orphelins > 0
    });
    return { deployables, coches, orphelins, orphelinsCoches };
  };

  visiter(racine);
  return etats;
}

/** Chemin des dossiers menant à un fichier, pour les déplier automatiquement. */
export function ancetres(cheminFichier) {
  const morceaux = cheminFichier.split('\\');
  const cles = [];
  let courant = '';
  for (let i = 0; i < morceaux.length - 1; i += 1) {
    courant = courant ? courant + '\\' + morceaux[i] : morceaux[i];
    cles.push(courant.toLowerCase());
  }
  return cles;
}

export function formaterOctets(octets) {
  if (octets === null || octets === undefined) return '-';
  const unites = ['o', 'Ko', 'Mo', 'Go'];
  let valeur = octets;
  let rang = 0;
  while (valeur >= 1024 && rang < unites.length - 1) {
    valeur /= 1024;
    rang += 1;
  }
  return `${valeur < 10 && rang > 0 ? valeur.toFixed(1) : Math.round(valeur)} ${unites[rang]}`;
}

// Les formateurs Intl sont parmi les constructeurs les plus lourds de la
// plateforme : construits une fois, pas à chaque nombre affiché.
const FORMAT_DATE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});
const FORMAT_NOMBRE = new Intl.NumberFormat('fr-FR');

export function formaterDate(millisecondes) {
  if (!millisecondes) return '-';
  return FORMAT_DATE.format(new Date(millisecondes));
}

export function formaterNombre(nombre) {
  return FORMAT_NOMBRE.format(nombre);
}
