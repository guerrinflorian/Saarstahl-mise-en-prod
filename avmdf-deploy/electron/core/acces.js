'use strict';

/**
 * acces.js - vérifie qu'une racine existe et se lit, avant de lancer quoi que
 * ce soit dessus.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Pourquoi ce contrôle existe : une analyse lancée sur un dossier illisible ne
 * plante pas, elle réussit à moitié. Le côté inaccessible rend zéro fichier, et
 * tout ce qui existe de l'autre côté ressort en « nouveau » ou en « orphelin ».
 * L'écran se remplit alors de milliers de lignes qui décrivent un problème de
 * droits, pas un écart de contenu - et la sélection qu'on y ferait effacerait
 * une production entière. Mieux vaut refuser, en disant lequel des deux
 * dossiers bloque et pourquoi.
 *
 * Les deux côtés sont toujours contrôlés, même quand le premier échoue : celui
 * qui corrige veut connaître les deux problèmes d'un coup.
 */

const fsp = require('fs/promises');

const { cheminLong } = require('./fsindex');

/** Un chemin UNC (\\serveur\partage) ne se diagnostique pas comme un chemin local. */
function estUnc(chemin) {
  return /^\\\\[^\\]/.test(String(chemin || ''));
}

/**
 * Traduit une erreur système en phrase et en conseil.
 * `probleme` est un groupe verbal : il se colle derrière « le dossier local ».
 */
function traduire(err, chemin) {
  switch (err.code) {
    case 'ENOENT':
      return {
        code: 'introuvable',
        probleme: 'est introuvable',
        conseil: estUnc(chemin)
          ? 'Le partage est peut-être arrêté, ou votre session Windows n\'y est pas connectée : ouvrez-le une fois dans l\'explorateur pour vous y authentifier.'
          : 'Vérifiez le chemin : un dossier a pu être renommé ou déplacé.'
      };
    case 'EACCES':
    case 'EPERM':
      return {
        code: 'droits',
        probleme: 'refuse l\'accès',
        conseil:
          'Votre compte Windows n\'a pas le droit de lire ce dossier. Demandez l\'accès à l\'exploitation, ou lancez l\'application avec un compte qui l\'a.'
      };
    case 'ENOTDIR':
      return {
        code: 'pas-un-dossier',
        probleme: 'n\'est pas un dossier',
        conseil: 'Le chemin désigne un fichier : indiquez le dossier qui le contient.'
      };
    case 'EBUSY':
      return {
        code: 'occupe',
        probleme: 'est verrouillé par un autre programme',
        conseil: 'Fermez ce qui tient le dossier, puis relancez l\'analyse.'
      };
    case 'ENAMETOOLONG':
      return {
        code: 'trop-long',
        probleme: 'a un chemin trop long',
        conseil: 'Raccourcissez le chemin, ou rapprochez le dossier de la racine du disque.'
      };
    case 'ELOOP':
      return {
        code: 'boucle',
        probleme: 'boucle sur lui-même',
        conseil: 'Un lien du chemin pointe vers un de ses parents : corrigez-le.'
      };
    default:
      return {
        code: err.code ? err.code.toLowerCase() : 'inconnu',
        probleme: `est inaccessible (${err.code || err.message})`,
        conseil: 'Vérifiez le chemin et vos droits dessus, puis relancez l\'analyse.'
      };
  }
}

/**
 * Contrôle une racine : existence, nature, et lecture réelle du contenu.
 *
 * Le `stat` ne suffit pas. Sur un partage, il arrive qu'un dossier se laisse
 * interroger mais pas lister : c'est le `readdir` qui tranche, et c'est lui que
 * l'analyse fera ensuite.
 *
 * @param {{role:string, libelle:string, chemin:string}} cote
 * @returns {Promise<object>} le côté enrichi de `ok`, `code`, `probleme`, `conseil`
 */
async function verifierRacine(cote) {
  const base = { ...cote, chemin: cote.chemin || '' };

  if (!base.chemin.trim()) {
    return {
      ...base,
      ok: false,
      code: 'absent',
      probleme: 'n\'est pas renseigné',
      conseil: 'Choisissez un projet actif, ou renseignez les deux dossiers dans les réglages.',
      entrees: 0
    };
  }

  const cible = cheminLong(base.chemin);

  try {
    const etat = await fsp.stat(cible);
    if (!etat.isDirectory()) {
      return {
        ...base,
        ok: false,
        code: 'pas-un-dossier',
        probleme: 'n\'est pas un dossier',
        conseil: 'Le chemin désigne un fichier : indiquez le dossier qui le contient.',
        entrees: 0
      };
    }
  } catch (err) {
    return { ...base, ok: false, ...traduire(err, base.chemin), entrees: 0 };
  }

  try {
    const contenu = await fsp.readdir(cible);
    return { ...base, ok: true, code: null, probleme: null, conseil: null, entrees: contenu.length };
  } catch (err) {
    return { ...base, ok: false, ...traduire(err, base.chemin), entrees: 0 };
  }
}

function minuscule(texte) {
  return texte.charAt(0).toLowerCase() + texte.slice(1);
}

function majuscule(texte) {
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/**
 * Contrôle plusieurs racines en parallèle et compose un message unique.
 *
 * @param {Array<{role:string, libelle:string, chemin:string}>} cotes
 * @returns {Promise<{ok:boolean, cotes:object[], problemes:object[], message:string, conseil:string}>}
 */
async function verifierRacines(cotes) {
  const resultats = await Promise.all(cotes.map(verifierRacine));
  const problemes = resultats.filter((cote) => !cote.ok);

  if (!problemes.length) {
    return { ok: true, cotes: resultats, problemes, message: '', conseil: '' };
  }

  const phrases = problemes.map((cote, index) =>
    (index === 0 ? majuscule(cote.libelle) : minuscule(cote.libelle)) + ' ' + cote.probleme
  );

  // Les conseils se répètent souvent d'un côté à l'autre (mêmes droits, même
  // serveur) : les dire deux fois ne rend pas le message plus clair.
  const conseils = [];
  for (const cote of problemes) {
    if (cote.conseil && !conseils.includes(cote.conseil)) conseils.push(cote.conseil);
  }

  return {
    ok: false,
    cotes: resultats,
    problemes,
    message: phrases.join(', et ') + '.',
    conseil: conseils.join(' ')
  };
}

module.exports = {
  estUnc,
  verifierRacine,
  verifierRacines
};
