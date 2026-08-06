/**
 * filtres.js — application des filtres côté affichage.
 *
 * Ces prédicats reprennent ceux de `electron/core/search.js`, qui reste le
 * moteur de référence (et le seul utilisable en ligne de commande). Le doublon
 * est assumé : filtrer dans le renderer évite un aller-retour IPC à chaque
 * frappe, ce qui compte avec plusieurs milliers de fichiers. Toute évolution
 * d'une règle doit être reportée dans les deux fichiers.
 */

export const MODE_CONTIENT = 'contient';
export const MODE_REGEX = 'regex';
export const MODE_GLOB = 'glob';

export function criteresParDefaut() {
  return {
    requete: '',
    mode: MODE_CONTIENT,
    statuts: { modifie: true, nouveau: true, orphelin: true, identique: false },
    extensions: null,
    depuis: null,
    dossier: '',
    dansLeContenu: false
  };
}

export function estVierge(criteres) {
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

export function normaliser(texte) {
  return String(texte || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const cacheMotifs = new Map();

/** Glob : `*` et `?` ne traversent pas les séparateurs, `**` les traverse. */
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

export function creerFiltreTexte(requete, mode = MODE_CONTIENT) {
  const propre = String(requete || '').trim();
  if (!propre) return { actif: false, valide: true, erreur: null, teste: () => true };

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
    return { actif: true, valide: true, erreur: null, teste: (chemin) => motifEnRegex(propre).test(chemin) };
  }

  const aiguille = normaliser(propre);
  return {
    actif: true,
    valide: true,
    erreur: null,
    teste: (chemin) => normaliser(chemin).includes(aiguille)
  };
}

/** Applique tous les filtres actifs, en ET logique. */
export function filtrer(fichiers, criteres, occurrences = null) {
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
    if (dossier && fichier.cle !== dossier && !fichier.cle.startsWith(dossier + '\\')) continue;
    if (depuis && (!fichier.local || fichier.local.mtimeMs < depuis)) continue;
    if (chercheContenu && !occurrences.has(fichier.cle)) continue;
    if (filtre.actif && !chercheContenu && !filtre.teste(fichier.chemin)) continue;
    retenus.push(fichier);
  }
  return retenus;
}

export function listerDossiers(fichiers) {
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

export function depuisQuand(choix, maintenant = Date.now()) {
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
