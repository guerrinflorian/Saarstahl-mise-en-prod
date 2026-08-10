'use strict';

/**
 * references.js - où chaque fichier de l'analyse est utilisé.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Le principe est textuel et assumé comme tel : un fichier F est « utilisé »
 * par un fichier G si le contenu de G mentionne le nom de F. Cela couvre d'un
 * même geste les `<script src=…>`, les `<%@ Register Src=…>`, les `CodeFile=`,
 * les `url(…)` de CSS, les `Response.Redirect`, les appels AJAX, les images -
 * tout ce qui désigne un fichier par son nom, quelle que soit la syntaxe.
 *
 * Deux familles de motifs sont cherchées, insensibles à la casse :
 *   - le nom complet du fichier (`Recherche.aspx`, `outils.js`, `logo.png`) ;
 *   - pour les noms « composant » (tirets ou bosses camelCase), la racine sans
 *     extension et sa déclinaison kebab-case : le fichier
 *     `vjc-Gestion-Code-Acier.js` est retrouvé dans un gabarit qui écrit
 *     `<vjc-gestion-code-acier>`, et `GestionCodeAcier.js` dans
 *     `<gestion-code-acier>`.
 *
 * Les correspondances sont bornées par des frontières de nom : `Recherche.aspx`
 * ne compte pas dans `Recherche.aspx.vb` (c'est un autre fichier, qui a sa
 * propre entrée), ni `form.js` dans `platform.js`.
 *
 * Tous les noms sont cherchés en une seule passe par fichier grâce à un
 * automate d'Aho-Corasick : le coût est une lecture de chaque fichier texte,
 * pas une lecture par nom cherché.
 */

const fsp = require('fs/promises');

const { cheminLong, pool } = require('./fsindex');
const textdiff = require('./textdiff');

const LIGNES_MAX_PAR_COUPLE = 20;
const EXTRAIT_MAX = 200;

// ---------------------------------------------------------------------------
// Motifs
// ---------------------------------------------------------------------------

/** Un nom « composant » : assez long, et découpé par des tirets ou du camelCase. */
function estNomComposant(racine) {
  if (racine.length < 6) return false;
  if (racine.includes('-')) return true;
  return (racine.match(/[a-z0-9][A-Z]/g) || []).length >= 2;
}

/**
 * Les motifs à chercher pour un fichier : son nom complet, et pour les noms
 * composant la racine sans extension plus sa déclinaison kebab-case.
 * @returns {Map<string, string>} motif (minuscules) → type ('nom' | 'composant')
 */
function motifsDe(nom) {
  const motifs = new Map([[nom.toLowerCase(), 'nom']]);
  const point = nom.lastIndexOf('.');
  const racine = point > 0 ? nom.slice(0, point) : nom;
  if (estNomComposant(racine)) {
    const brut = racine.toLowerCase();
    if (!motifs.has(brut)) motifs.set(brut, 'composant');
    const kebab = racine.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    if (!motifs.has(kebab)) motifs.set(kebab, 'composant');
  }
  return motifs;
}

// ---------------------------------------------------------------------------
// Automate d'Aho-Corasick
// ---------------------------------------------------------------------------

function creerAutomate(motifs) {
  const noeuds = [{ suivants: new Map(), echec: 0, sorties: [] }];

  for (let indice = 0; indice < motifs.length; indice += 1) {
    let courant = 0;
    for (const caractere of motifs[indice]) {
      let suivant = noeuds[courant].suivants.get(caractere);
      if (suivant === undefined) {
        suivant = noeuds.length;
        noeuds.push({ suivants: new Map(), echec: 0, sorties: [] });
        noeuds[courant].suivants.set(caractere, suivant);
      }
      courant = suivant;
    }
    noeuds[courant].sorties.push(indice);
  }

  // Liens d'échec, en largeur.
  const file = [];
  let tete = 0;
  for (const enfant of noeuds[0].suivants.values()) file.push(enfant);
  while (tete < file.length) {
    const noeud = file[tete];
    tete += 1;
    for (const [caractere, enfant] of noeuds[noeud].suivants) {
      file.push(enfant);
      let repli = noeuds[noeud].echec;
      while (repli !== 0 && !noeuds[repli].suivants.has(caractere)) repli = noeuds[repli].echec;
      const cible = noeuds[repli].suivants.get(caractere);
      noeuds[enfant].echec = cible !== undefined && cible !== enfant ? cible : 0;
      noeuds[enfant].sorties.push(...noeuds[noeuds[enfant].echec].sorties);
    }
  }

  return noeuds;
}

function parcourirTexte(noeuds, texte, surSortie) {
  let courant = 0;
  for (let position = 0; position < texte.length; position += 1) {
    const caractere = texte[position];
    while (courant !== 0 && !noeuds[courant].suivants.has(caractere)) courant = noeuds[courant].echec;
    const suivant = noeuds[courant].suivants.get(caractere);
    courant = suivant === undefined ? 0 : suivant;
    const sorties = noeuds[courant].sorties;
    if (sorties.length) {
      for (const indice of sorties) surSortie(indice, position);
    }
  }
}

/** Un caractère qui peut faire partie d'un nom de fichier ou de balise. */
const CARACTERE_DE_NOM = /[a-z0-9_-]/;

/**
 * La correspondance est-elle un nom entier ? `form.js` ne compte pas dans
 * `platform.js`, et `recherche.aspx` ne compte pas dans `recherche.aspx.vb` :
 * un point suivi d'une lettre prolonge le nom vers un autre fichier.
 */
function frontieresValides(texte, debut, fin) {
  if (debut > 0 && CARACTERE_DE_NOM.test(texte[debut - 1])) return false;
  const apres = texte[fin + 1];
  if (apres === undefined) return true;
  if (CARACTERE_DE_NOM.test(apres)) return false;
  if (apres === '.' && fin + 2 < texte.length && /[a-z0-9]/.test(texte[fin + 2])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Construit l'index des références sur les fichiers d'une analyse.
 *
 * Chaque fichier texte est lu une fois par côté dont le contenu diffère : un
 * fichier « identique » n'est lu qu'en local (côté « les deux »), un modifié
 * est lu des deux côtés, un orphelin seulement en production.
 *
 * @param {object[]} fichiers entrées de l'analyse
 * @param {object} [options]
 * @returns {Promise<{parCible:Map, parSource:Map, compteurs:Map, examines:number, ignores:number}>}
 */
async function construireIndex(fichiers, options = {}) {
  const {
    extensionsTexte = [],
    concurrence = 6,
    signal = { annule: false },
    surProgression = null,
    tailleMax = textdiff.TAILLE_MAX_DIFF
  } = options;

  // 1. Motifs de tous les fichiers. Un même motif peut désigner plusieurs
  //    fichiers (deux `web.config` dans deux branches) : toutes les cibles
  //    sont retenues, la liste des références dira les chemins.
  const motifs = [];
  const ciblesParMotif = [];
  const indexParMotif = new Map();
  for (const fichier of fichiers) {
    for (const [motif, type] of motifsDe(fichier.nom)) {
      let indice = indexParMotif.get(motif);
      if (indice === undefined) {
        indice = motifs.length;
        indexParMotif.set(motif, indice);
        motifs.push(motif);
        ciblesParMotif.push([]);
      }
      ciblesParMotif[indice].push({ cle: fichier.cle, type });
    }
  }
  const automate = creerAutomate(motifs);

  // 2. Ce qui se lit, et de quel côté.
  const lectures = [];
  const texte = new Set(extensionsTexte);
  for (const fichier of fichiers) {
    if (!texte.has(fichier.extension)) continue;
    const cotes =
      fichier.statut === 'identique'
        ? [['les deux', fichier.local]]
        : [
            ['local', fichier.local],
            ['production', fichier.prod]
          ];
    for (const [cote, quoi] of cotes) {
      if (quoi && quoi.taille <= tailleMax) lectures.push({ fichier, cote, absolu: quoi.absolu });
    }
  }

  // 3. Lecture et balayage, en concurrence bornée.
  const parCible = new Map();
  const parSource = new Map();
  const cheminParCle = new Map(fichiers.map((f) => [f.cle, f.chemin]));
  const cheminDe = (cle) => cheminParCle.get(cle) || cle;
  let examines = 0;
  let ignores = 0;
  let faits = 0;

  const noter = (registre, cleEntree, source, cible, cote, ligne) => {
    let entrees = registre.get(cleEntree);
    if (!entrees) {
      entrees = new Map();
      registre.set(cleEntree, entrees);
    }
    const cleCouple = (registre === parCible ? source.cle : cible.cle) + '|' + cote;
    let entree = entrees.get(cleCouple);
    if (!entree) {
      entree = {
        cle: registre === parCible ? source.cle : cible.cle,
        chemin: registre === parCible ? source.chemin : cible.chemin,
        cote,
        lignes: []
      };
      entrees.set(cleCouple, entree);
    }
    if (entree.lignes.length < LIGNES_MAX_PAR_COUPLE && !entree.lignes.some((l) => l.numero === ligne.numero)) {
      entree.lignes.push(ligne);
    }
  };

  await pool(
    lectures,
    concurrence,
    async ({ fichier, cote, absolu }) => {
      faits += 1;
      if (surProgression && faits % 25 === 0) surProgression({ faits, total: lectures.length });
      if (signal.annule) return;

      let tampon;
      try {
        tampon = await fsp.readFile(cheminLong(absolu));
      } catch (err) {
        ignores += 1;
        return;
      }
      if (textdiff.estBinaire(tampon)) {
        ignores += 1;
        return;
      }
      const contenu = textdiff.decoder(tampon).texte;
      const minuscule = contenu.toLowerCase();
      examines += 1;

      // Débuts de ligne, pour retrouver numéro et extrait par dichotomie.
      const debutsDeLigne = [0];
      for (let i = 0; i < contenu.length; i += 1) {
        if (contenu[i] === '\n') debutsDeLigne.push(i + 1);
      }
      const ligneDe = (position) => {
        let bas = 0;
        let haut = debutsDeLigne.length - 1;
        while (bas < haut) {
          const milieu = (bas + haut + 1) >> 1;
          if (debutsDeLigne[milieu] <= position) bas = milieu;
          else haut = milieu - 1;
        }
        return bas;
      };

      const vues = new Set();
      parcourirTexte(automate, minuscule, (indiceMotif, finIncluse) => {
        const motif = motifs[indiceMotif];
        const debut = finIncluse - motif.length + 1;
        if (!frontieresValides(minuscule, debut, finIncluse)) return;

        const indiceLigne = ligneDe(debut);
        for (const cible of ciblesParMotif[indiceMotif]) {
          if (cible.cle === fichier.cle) continue; // un fichier ne se référence pas lui-même
          const cleVue = cible.cle + '|' + indiceLigne;
          if (vues.has(cleVue)) continue;
          vues.add(cleVue);

          const debutLigne = debutsDeLigne[indiceLigne];
          const finLigne = contenu.indexOf('\n', debutLigne);
          let extrait = contenu.slice(debutLigne, finLigne === -1 ? contenu.length : finLigne).trim();
          if (extrait.length > EXTRAIT_MAX) {
            const centre = Math.max(0, debut - debutLigne - Math.floor(EXTRAIT_MAX / 2));
            extrait = (centre > 0 ? '…' : '') + extrait.slice(centre, centre + EXTRAIT_MAX) + '…';
          }
          const ligne = { numero: indiceLigne + 1, extrait, motif };

          const source = { cle: fichier.cle, chemin: fichier.chemin };
          noter(parCible, cible.cle, source, cible, cote, ligne);
          noter(parSource, fichier.cle, source, { cle: cible.cle, chemin: cheminDe(cible.cle) }, cote, ligne);
        }
      });
    },
    signal
  );

  // Aplatir en tableaux triés, et compter les fichiers utilisateurs distincts.
  const aplatir = (registre) => {
    const plat = new Map();
    for (const [cle, entrees] of registre) {
      const liste = [...entrees.values()].sort(
        (a, b) => a.chemin.localeCompare(b.chemin, 'fr') || a.cote.localeCompare(b.cote, 'fr')
      );
      plat.set(cle, liste);
    }
    return plat;
  };
  const cibles = aplatir(parCible);
  const sources = aplatir(parSource);

  const compteurs = new Map(fichiers.map((f) => [f.cle, 0]));
  for (const [cle, liste] of cibles) {
    compteurs.set(cle, new Set(liste.map((entree) => entree.cle)).size);
  }

  return { parCible: cibles, parSource: sources, compteurs, examines, ignores };
}

module.exports = {
  construireIndex,
  motifsDe,
  estNomComposant,
  creerAutomate,
  parcourirTexte,
  frontieresValides
};
