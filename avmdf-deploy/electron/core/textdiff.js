'use strict';

/**
 * textdiff.js - détection d'encodage et comparaison ligne à ligne.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM. Il travaille sur
 * des tampons ; c'est l'appelant qui lit les fichiers.
 *
 * Les fichiers d'un projet .NET français mélangent UTF-8 (avec ou sans BOM) et
 * Windows-1252. Sans détection par fichier, les accents partent en mojibake et
 * le diff devient illisible.
 *
 * Le décodage ne sert QU'À L'AFFICHAGE. Les copies restent binaires, octet pour
 * octet : rien n'est jamais ré-encodé ni normalisé.
 */

const Diff = require('diff');
const iconv = require('iconv-lite');

/** Au-delà, on n'affiche pas : on propose l'éditeur externe. */
const TAILLE_MAX_DIFF = 4 * 1024 * 1024;

/** Nombre de lignes changées au-delà duquel on renonce au surlignage intra-ligne. */
const MAX_SURLIGNAGE = 4000;

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

// ---------------------------------------------------------------------------
// Encodage
// ---------------------------------------------------------------------------

function commencePar(tampon, prefixe) {
  if (tampon.length < prefixe.length) return false;
  return tampon.subarray(0, prefixe.length).equals(prefixe);
}

function utf8StrictementValide(tampon) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(tampon);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * BOM d'abord, puis tentative de décodage UTF-8 strict, puis repli sur
 * Windows-1252 : dans cet ordre et pas un autre.
 * @returns {{ encodage:string, codec:string, bom:number }}
 */
function detecterEncodage(tampon) {
  if (commencePar(tampon, BOM_UTF8)) return { encodage: 'UTF-8 (BOM)', codec: 'utf8', bom: 3 };
  if (commencePar(tampon, BOM_UTF16LE)) return { encodage: 'UTF-16 LE', codec: 'utf16-le', bom: 2 };
  if (commencePar(tampon, BOM_UTF16BE)) return { encodage: 'UTF-16 BE', codec: 'utf16-be', bom: 2 };
  if (utf8StrictementValide(tampon)) return { encodage: 'UTF-8', codec: 'utf8', bom: 0 };
  return { encodage: 'Windows-1252', codec: 'win1252', bom: 0 };
}

/** Un octet nul dans les premiers kilo-octets : c'est un binaire. */
function estBinaire(tampon) {
  const fenetre = tampon.subarray(0, Math.min(tampon.length, 8192));
  return fenetre.includes(0);
}

/**
 * Style d'indentation dominant d'un fichier : tabulations, espaces, mixte.
 * Échantillonné sur les 2 000 premières lignes, largement suffisant pour un
 * fichier source.
 */
function detecterIndentation(texte) {
  const lignes = texte.split(/\r\n|\n|\r/).slice(0, 2000);
  let tabulations = 0;
  let espaces = 0;
  for (const ligne of lignes) {
    if (ligne.startsWith('\t')) tabulations += 1;
    else if (ligne.startsWith('  ')) espaces += 1;
  }
  if (!tabulations && !espaces) return 'aucune';
  if (tabulations && espaces) {
    if (tabulations >= espaces * 4) return 'tabulations';
    if (espaces >= tabulations * 4) return 'espaces';
    return 'mixte';
  }
  return tabulations ? 'tabulations' : 'espaces';
}

function detecterFinDeLigne(texte) {
  const crlf = (texte.match(/\r\n/g) || []).length;
  const total = (texte.match(/\r\n|\n|\r/g) || []).length;
  if (total === 0) return 'aucune';
  const lf = (texte.match(/(?<!\r)\n/g) || []).length;
  const cr = total - crlf - lf;
  const presents = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (presents > 1) return 'mixte';
  if (crlf > 0) return 'CRLF';
  if (lf > 0) return 'LF';
  return 'CR';
}

/**
 * Décode un tampon pour l'affichage.
 * @returns {{ texte:string, encodage:string, codec:string, finDeLigne:string }}
 */
function decoder(tampon) {
  const detection = detecterEncodage(tampon);
  const utile = detection.bom ? tampon.subarray(detection.bom) : tampon;
  const texte = iconv.decode(utile, detection.codec);
  return {
    texte,
    encodage: detection.encodage,
    codec: detection.codec,
    finDeLigne: detecterFinDeLigne(texte),
    indentation: detecterIndentation(texte)
  };
}

const FINS_DE_LIGNE = { CRLF: '\r\n', LF: '\n', CR: '\r' };

/**
 * Ré-encode un texte modifié dans l'enveloppe d'origine du fichier : même
 * encodage, même BOM, mêmes fins de ligne. C'est la contrepartie de `decoder`
 * pour l'éditeur intégré - la seule écriture de l'application qui ne soit pas
 * une copie binaire, et elle doit être indiscernable d'une édition faite dans
 * Visual Studio sur le poste.
 *
 * Un fichier aux fins de ligne mixtes ressort uniformisé en CRLF : l'éditeur
 * l'annonce avant l'enregistrement plutôt que de le faire en silence.
 *
 * En Windows-1252, tout caractère n'existe pas. Plutôt que d'écrire des « ? »
 * à sa place, l'encodage est vérifié caractère par caractère et l'échec est
 * remonté avec les caractères fautifs : c'est à l'utilisateur de les retirer,
 * pas à l'outil de changer l'encodage du fichier en douce.
 *
 * @param {string} texte contenu édité (sauts de ligne quelconques)
 * @param {{ codec:string, bom:number, finDeLigne:string }} enveloppe
 * @returns {{ tampon:Buffer|null, caracteresPerdus:string[] }}
 */
function encoder(texte, enveloppe) {
  const eol = FINS_DE_LIGNE[enveloppe.finDeLigne] || '\r\n';
  const normalise = String(texte).replace(/\r\n|\r|\n/g, eol);

  if (enveloppe.codec === 'win1252') {
    const perdus = [];
    for (const caractere of normalise) {
      if (perdus.includes(caractere)) continue;
      const aller = iconv.encode(caractere, 'win1252');
      if (iconv.decode(aller, 'win1252') !== caractere) perdus.push(caractere);
      if (perdus.length >= 8) break;
    }
    if (perdus.length) return { tampon: null, caracteresPerdus: perdus };
  }

  const corps = iconv.encode(normalise, enveloppe.codec);
  if (!enveloppe.bom) return { tampon: corps, caracteresPerdus: [] };

  const bom =
    enveloppe.codec === 'utf16-le' ? BOM_UTF16LE : enveloppe.codec === 'utf16-be' ? BOM_UTF16BE : BOM_UTF8;
  return { tampon: Buffer.concat([bom, corps]), caracteresPerdus: [] };
}

function decouperLignes(texte) {
  if (texte === '') return [];
  const lignes = texte.split(/\r\n|\n|\r/);
  // Un fichier qui se termine par un saut de ligne ne compte pas une ligne vide
  // supplémentaire.
  if (lignes.length && lignes[lignes.length - 1] === '') lignes.pop();
  return lignes;
}

// ---------------------------------------------------------------------------
// Comparaison ligne à ligne
// ---------------------------------------------------------------------------

function comparateur(ignorerEspaces) {
  if (!ignorerEspaces) return (a, b) => a === b;
  const reduire = (ligne) => ligne.replace(/\s+/g, ' ').trim();
  return (a, b) => reduire(a) === reduire(b);
}

/**
 * Produit les lignes alignées des deux côtés.
 *
 * Une suite de suppressions immédiatement suivie d'une suite d'ajouts est
 * appariée ligne à ligne : ce sont des modifications, et c'est ce qui permet
 * de surligner le fragment qui change.
 *
 * @returns {{ lignes:object[], compteurs:object, surlignageOmis:boolean }}
 */
function alignerLignes(lignesGauche, lignesDroite, { ignorerEspaces = false } = {}) {
  const parties = Diff.diffArrays(lignesGauche, lignesDroite, {
    comparator: comparateur(ignorerEspaces)
  });

  const lignes = [];
  let numeroGauche = 0;
  let numeroDroite = 0;

  for (let i = 0; i < parties.length; i += 1) {
    const partie = parties[i];

    if (!partie.added && !partie.removed) {
      for (const texte of partie.value) {
        numeroGauche += 1;
        numeroDroite += 1;
        lignes.push({
          type: 'identique',
          gauche: { numero: numeroGauche, texte },
          droite: { numero: numeroDroite, texte }
        });
      }
      continue;
    }

    if (partie.removed) {
      const suivante = parties[i + 1];
      const ajoutees = suivante && suivante.added ? suivante.value : [];
      const apparieables = Math.min(partie.value.length, ajoutees.length);

      for (let j = 0; j < apparieables; j += 1) {
        numeroGauche += 1;
        numeroDroite += 1;
        lignes.push({
          type: 'modification',
          gauche: { numero: numeroGauche, texte: partie.value[j] },
          droite: { numero: numeroDroite, texte: ajoutees[j] }
        });
      }
      for (let j = apparieables; j < partie.value.length; j += 1) {
        numeroGauche += 1;
        lignes.push({
          type: 'suppression',
          gauche: { numero: numeroGauche, texte: partie.value[j] },
          droite: null
        });
      }
      for (let j = apparieables; j < ajoutees.length; j += 1) {
        numeroDroite += 1;
        lignes.push({
          type: 'ajout',
          gauche: null,
          droite: { numero: numeroDroite, texte: ajoutees[j] }
        });
      }
      if (suivante && suivante.added) i += 1;
      continue;
    }

    for (const texte of partie.value) {
      numeroDroite += 1;
      lignes.push({
        type: 'ajout',
        gauche: null,
        droite: { numero: numeroDroite, texte }
      });
    }
  }

  const modifications = lignes.filter((l) => l.type === 'modification');

  // Une ligne dont seuls les blancs changent (indentation retouchée, espaces en
  // fin de ligne, tabulations converties) est signalée comme telle : à l'œil nu
  // les deux versions semblent identiques, et c'est précisément là qu'un diff
  // imprécis fait perdre du temps.
  const sansBlancs = (texte) => texte.replace(/[ \t\u00a0]+/g, '');
  let modificationsEspaces = 0;
  for (const ligne of modifications) {
    ligne.espacesUniquement =
      ligne.gauche.texte !== ligne.droite.texte &&
      sansBlancs(ligne.gauche.texte) === sansBlancs(ligne.droite.texte);
    if (ligne.espacesUniquement) modificationsEspaces += 1;
  }

  const surlignageOmis = modifications.length > MAX_SURLIGNAGE;
  if (!surlignageOmis) {
    for (const ligne of modifications) {
      const morceaux = Diff.diffWordsWithSpace(ligne.gauche.texte, ligne.droite.texte);
      ligne.gauche.segments = morceaux
        .filter((m) => !m.added)
        .map((m) => ({ texte: m.value, change: Boolean(m.removed) }));
      ligne.droite.segments = morceaux
        .filter((m) => !m.removed)
        .map((m) => ({ texte: m.value, change: Boolean(m.added) }));
    }
  }

  const compteurs = {
    ajoutees: lignes.filter((l) => l.type === 'ajout').length + modifications.length,
    supprimees: lignes.filter((l) => l.type === 'suppression').length + modifications.length,
    modifiees: modifications.length,
    modificationsEspaces
  };

  return { lignes, compteurs, surlignageOmis };
}

/**
 * Regroupe les lignes pour replier les blocs inchangés trop longs.
 * @returns {Array<{type:'lignes'|'repli', lignes:object[], nombre?:number}>}
 */
function grouper(lignes, { seuil = 6, contexte = 2 } = {}) {
  const groupes = [];
  let courant = [];

  const viderCourant = () => {
    if (courant.length) {
      groupes.push({ type: 'lignes', lignes: courant });
      courant = [];
    }
  };

  let i = 0;
  while (i < lignes.length) {
    if (lignes[i].type !== 'identique') {
      courant.push(lignes[i]);
      i += 1;
      continue;
    }

    let fin = i;
    while (fin < lignes.length && lignes[fin].type === 'identique') fin += 1;
    const suite = lignes.slice(i, fin);

    if (suite.length > seuil) {
      const debutVisible = groupes.length === 0 && courant.length === 0 ? 0 : contexte;
      const finVisible = fin === lignes.length ? 0 : contexte;
      courant.push(...suite.slice(0, debutVisible));
      viderCourant();
      groupes.push({
        type: 'repli',
        nombre: suite.length - debutVisible - finVisible,
        lignes: suite.slice(debutVisible, suite.length - finVisible)
      });
      if (finVisible) courant.push(...suite.slice(suite.length - finVisible));
    } else {
      courant.push(...suite);
    }
    i = fin;
  }

  viderCourant();
  return groupes;
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * Compare deux versions d'un fichier et renvoie de quoi alimenter la vue.
 *
 * Les cas particuliers sont traités explicitement : un binaire, un fichier trop
 * gros, un fichier nouveau ou un orphelin ne provoquent pas d'erreur, ils
 * renvoient un type de résultat différent.
 *
 * @param {Buffer|null} tamponGauche version de production
 * @param {Buffer|null} tamponDroite version locale
 * @param {object} [options]
 * @param {boolean} [options.ignorerEspaces]
 * @param {boolean} [options.extensionTexte] l'extension figure-t-elle dans la liste des extensions texte
 */
function comparerTampons(tamponGauche, tamponDroite, options = {}) {
  const { ignorerEspaces = false, extensionTexte = true } = options;

  const presents = [tamponGauche, tamponDroite].filter(Boolean);
  if (!presents.length) {
    return { type: 'vide' };
  }

  const tropGros = presents.find((t) => t.length > TAILLE_MAX_DIFF);
  if (tropGros) {
    return { type: 'volumineux', limite: TAILLE_MAX_DIFF, taille: tropGros.length };
  }

  if (!extensionTexte || presents.some((t) => estBinaire(t))) {
    return { type: 'binaire' };
  }

  const gauche = tamponGauche ? decoder(tamponGauche) : null;
  const droite = tamponDroite ? decoder(tamponDroite) : null;

  const lignesGauche = gauche ? decouperLignes(gauche.texte) : [];
  const lignesDroite = droite ? decouperLignes(droite.texte) : [];

  const { lignes, compteurs, surlignageOmis } = alignerLignes(lignesGauche, lignesDroite, {
    ignorerEspaces
  });

  return {
    type: 'texte',
    gauche: gauche
      ? {
          encodage: gauche.encodage,
          finDeLigne: gauche.finDeLigne,
          indentation: gauche.indentation,
          nombreLignes: lignesGauche.length
        }
      : null,
    droite: droite
      ? {
          encodage: droite.encodage,
          finDeLigne: droite.finDeLigne,
          indentation: droite.indentation,
          nombreLignes: lignesDroite.length
        }
      : null,
    ecartEncodage: Boolean(gauche && droite && gauche.encodage !== droite.encodage),
    ecartFinDeLigne: Boolean(gauche && droite && gauche.finDeLigne !== droite.finDeLigne),
    ecartIndentation: Boolean(
      gauche &&
        droite &&
        gauche.indentation !== droite.indentation &&
        gauche.indentation !== 'aucune' &&
        droite.indentation !== 'aucune'
    ),
    lignes,
    compteurs,
    surlignageOmis
  };
}

/**
 * Compte les lignes ajoutées et supprimées sans construire la vue - utilisé par
 * le manifeste de déploiement.
 */
function compterLignes(tamponGauche, tamponDroite, options = {}) {
  const resultat = comparerTampons(tamponGauche, tamponDroite, options);
  if (resultat.type !== 'texte') return { ajoutees: null, supprimees: null };
  return { ajoutees: resultat.compteurs.ajoutees, supprimees: resultat.compteurs.supprimees };
}

module.exports = {
  TAILLE_MAX_DIFF,
  detecterEncodage,
  estBinaire,
  detecterFinDeLigne,
  detecterIndentation,
  decoder,
  encoder,
  decouperLignes,
  alignerLignes,
  grouper,
  comparerTampons,
  compterLignes
};
