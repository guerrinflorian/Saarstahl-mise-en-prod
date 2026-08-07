'use strict';

/**
 * compare.js - appariement des deux arborescences et attribution des statuts.
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
            raison: 'contenu illisible (' + (err.code || err.message) + ') - statut supposé modifié'
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
// Correspondance des deux dossiers
// ---------------------------------------------------------------------------

/** En dessous, les deux dossiers ne décrivent visiblement pas la même chose. */
const PROPORTION_MINIMALE = 0.2;

/** Sous ce nombre de fichiers, une proportion ne veut plus rien dire. */
const ECHANTILLON_MINIMAL = 8;

/**
 * Dit si les deux arborescences comparées se ressemblent assez pour que la
 * comparaison ait un sens.
 *
 * Deux dossiers sans rapport ne produisent pas d'erreur : ils produisent une
 * liste énorme où tout le local est « nouveau » et toute la production
 * « orpheline ». C'est parfaitement lisible, parfaitement faux, et une
 * sélection large y détruirait la production. Le seul moyen de s'en apercevoir
 * est de regarder la proportion de chemins présents des deux côtés.
 *
 * Tout se déduit de la liste des fichiers : la fonction reste juste après une
 * mise en production, qui déplace des fichiers d'une catégorie à l'autre.
 *
 * @param {object[]} fichiers
 * @returns {{niveau:'ok'|'attention'|'alerte', code:string, titre:string, texte:string, local:number, prod:number, communs:number, proportion:number}}
 */
function diagnostiquerCorrespondance(fichiers) {
  let local = 0;
  let prod = 0;
  let communs = 0;
  const dossiersLocaux = new Set();
  const dossiersProd = new Set();

  for (const fichier of fichiers) {
    const separateur = fichier.chemin.indexOf('\\');
    const tete = separateur > 0 ? fichier.chemin.slice(0, separateur).toLowerCase() : null;
    if (fichier.local) {
      local += 1;
      if (tete) dossiersLocaux.add(tete);
    }
    if (fichier.prod) {
      prod += 1;
      if (tete) dossiersProd.add(tete);
    }
    if (fichier.local && fichier.prod) communs += 1;
  }

  let dossiersCommuns = 0;
  for (const nom of dossiersLocaux) {
    if (dossiersProd.has(nom)) dossiersCommuns += 1;
  }

  const plusPetit = Math.min(local, prod);
  const proportion = plusPetit ? communs / plusPetit : 0;
  const mesures = { local, prod, communs, proportion, dossiersCommuns };

  // Le détail sur les dossiers de premier niveau n'est parlant que si les deux
  // côtés en ont : deux dossiers plats ne se départagent pas comme ça.
  const noteDossiers =
    dossiersLocaux.size && dossiersProd.size && dossiersCommuns === 0
      ? ' Aucun dossier de premier niveau ne porte le même nom des deux côtés.'
      : '';

  if (!local && !prod) {
    return {
      ...mesures,
      niveau: 'attention',
      code: 'deux-vides',
      titre: 'Les deux dossiers sont vides.',
      texte: 'Il n\'y a rien à comparer, aux exclusions près. Vérifiez les deux chemins.'
    };
  }

  if (!local) {
    return {
      ...mesures,
      niveau: 'alerte',
      code: 'local-vide',
      titre: 'Le dossier local ne contient aucun fichier.',
      texte:
        (prod > 1
          ? `Les ${prod} fichiers de la production ressortent donc tous comme orphelins. `
          : 'Le fichier de la production ressort donc comme orphelin. ') +
        'Vérifiez le chemin local avant de supprimer quoi que ce soit.'
    };
  }

  if (!prod) {
    return {
      ...mesures,
      niveau: 'attention',
      code: 'prod-vide',
      titre: 'Le dossier de production est vide.',
      texte:
        (local > 1
          ? `Les ${local} fichiers locaux ressortent donc tous comme nouveaux. `
          : 'Le fichier local ressort donc comme nouveau. ') +
        'C\'est attendu pour une toute première mise en production, suspect sinon.'
    };
  }

  if (!communs) {
    return {
      ...mesures,
      niveau: 'alerte',
      code: 'rien-en-commun',
      titre: 'Ces deux dossiers n\'ont aucun fichier en commun.',
      texte:
        `${local} fichier${local > 1 ? 's' : ''} d'un côté, ${prod} de l'autre, ` +
        'et pas un seul chemin identique.' +
        noteDossiers +
        ' Ce ne sont probablement pas les deux dossiers à comparer.'
    };
  }

  if (plusPetit >= ECHANTILLON_MINIMAL && proportion < PROPORTION_MINIMALE) {
    return {
      ...mesures,
      niveau: 'alerte',
      code: 'peu-en-commun',
      titre: 'Ces deux dossiers ne se ressemblent guère.',
      texte:
        (communs > 1
          ? `Seuls ${communs} fichiers sur ${plusPetit} sont présents des deux côtés, `
          : `Un seul fichier sur ${plusPetit} est présent des deux côtés, `) +
        `soit ${Math.round(proportion * 100)} %.` +
        noteDossiers +
        ' Vérifiez que le projet pointe bien sur le bon sous-dossier de production.'
    };
  }

  return { ...mesures, niveau: 'ok', code: 'correspond', titre: '', texte: '' };
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
  diagnostiquerCorrespondance,
  construireArbre,
  statutLePlusChaud
};
