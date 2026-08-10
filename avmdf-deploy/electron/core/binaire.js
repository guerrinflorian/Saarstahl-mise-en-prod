'use strict';

/**
 * binaire.js - de quoi juger deux versions d'un fichier qui ne se lit pas.
 *
 * Module Node pur, sans dépendance à Electron ni au DOM : comme textdiff, il
 * travaille sur des tampons déjà lus par l'appelant.
 *
 * Deux services :
 *  - décrire l'écart entre deux tampons : identiques ou non, taille et
 *    empreinte de chaque côté, position du premier octet qui diffère avec une
 *    fenêtre d'octets autour pour la montrer ;
 *  - préparer un aperçu affichable : les extensions que Chromium sait rendre
 *    (images, sons, vidéos, polices) deviennent des URL de données que le
 *    renderer affiche côte à côte, superpose ou soustrait pixel par pixel.
 *
 * Rien ici ne modifie quoi que ce soit : ce module ne fait que regarder.
 */

const crypto = require('crypto');

/**
 * Au-delà, pas d'URL de données : elle traverse l'IPC et reste en mémoire du
 * renderer, et une image de production n'a aucune raison de peser autant.
 */
const TAILLE_MAX_APERCU = 20 * 1024 * 1024;

/** Octets montrés avant et après le premier écart. */
const FENETRE_AVANT = 8;
const FENETRE_APRES = 16;

/**
 * Ce que Chromium 108 sait rendre nativement, par extension. Le PDF et les
 * archives n'y sont pas : eux se jugent à l'empreinte et s'ouvrent dehors.
 */
const APERCUS = {
  '.png': { genre: 'image', mime: 'image/png' },
  '.apng': { genre: 'image', mime: 'image/apng' },
  '.jpg': { genre: 'image', mime: 'image/jpeg' },
  '.jpeg': { genre: 'image', mime: 'image/jpeg' },
  '.gif': { genre: 'image', mime: 'image/gif' },
  '.bmp': { genre: 'image', mime: 'image/bmp' },
  '.webp': { genre: 'image', mime: 'image/webp' },
  '.avif': { genre: 'image', mime: 'image/avif' },
  '.ico': { genre: 'image', mime: 'image/x-icon' },
  '.cur': { genre: 'image', mime: 'image/x-icon' },
  '.svg': { genre: 'image', mime: 'image/svg+xml' },
  '.mp3': { genre: 'audio', mime: 'audio/mpeg' },
  '.wav': { genre: 'audio', mime: 'audio/wav' },
  '.ogg': { genre: 'audio', mime: 'audio/ogg' },
  '.m4a': { genre: 'audio', mime: 'audio/mp4' },
  '.mp4': { genre: 'video', mime: 'video/mp4' },
  '.webm': { genre: 'video', mime: 'video/webm' },
  '.woff': { genre: 'police', mime: 'font/woff' },
  '.woff2': { genre: 'police', mime: 'font/woff2' },
  '.ttf': { genre: 'police', mime: 'font/ttf' },
  '.otf': { genre: 'police', mime: 'font/otf' }
};

/** @returns {'image'|'audio'|'video'|'police'|null} */
function genreApercu(extension) {
  const fiche = APERCUS[String(extension || '').toLowerCase()];
  return fiche ? fiche.genre : null;
}

/**
 * Prépare l'aperçu des deux côtés d'un fichier, ou null si l'extension ne se
 * prévisualise pas. Un côté absent reste null ; un côté trop lourd garde sa
 * taille mais pas d'URL, et le renderer explique pourquoi.
 */
function construireApercu(extension, tamponGauche, tamponDroite) {
  const fiche = APERCUS[String(extension || '').toLowerCase()];
  if (!fiche) return null;

  const cote = (tampon) => {
    if (!tampon) return null;
    if (tampon.length > TAILLE_MAX_APERCU) return { url: null, tropGros: true, taille: tampon.length };
    return {
      url: `data:${fiche.mime};base64,${tampon.toString('base64')}`,
      tropGros: false,
      taille: tampon.length
    };
  };

  const gauche = cote(tamponGauche);
  const droite = cote(tamponDroite);
  if (!gauche && !droite) return null;
  return { genre: fiche.genre, mime: fiche.mime, gauche, droite };
}

/**
 * Position du premier octet qui diffère, avec une fenêtre d'octets de chaque
 * côté pour la montrer telle quelle. Les tampons sont d'abord parcourus par
 * blocs comparés nativement : seul le bloc fautif est relu octet par octet.
 *
 * @returns {null | {
 *   position:number, finCommune:boolean,
 *   gauche:{debut:number, octets:number[]},
 *   droite:{debut:number, octets:number[]}
 * }} null si les tampons sont identiques ; `finCommune` vaut true quand l'un
 * est exactement le début de l'autre : tout le contenu commun est identique,
 * seul un côté continue.
 */
function premiereDifference(tamponGauche, tamponDroite) {
  const commun = Math.min(tamponGauche.length, tamponDroite.length);
  const BLOC = 4096;

  let position = 0;
  while (position < commun) {
    const fin = Math.min(commun, position + BLOC);
    if (tamponGauche.subarray(position, fin).equals(tamponDroite.subarray(position, fin))) {
      position = fin;
      continue;
    }
    while (tamponGauche[position] === tamponDroite[position]) position += 1;
    break;
  }

  if (position === commun && tamponGauche.length === tamponDroite.length) return null;

  const fenetre = (tampon) => {
    const debut = Math.max(0, position - FENETRE_AVANT);
    const fin = Math.min(tampon.length, position + FENETRE_APRES);
    return { debut, octets: Array.from(tampon.subarray(debut, fin)) };
  };

  return {
    position,
    finCommune: position === commun,
    gauche: fenetre(tamponGauche),
    droite: fenetre(tamponDroite)
  };
}

/**
 * La fiche complète d'une comparaison binaire : verdict octet pour octet,
 * taille, date et empreinte de chaque côté, et le premier écart quand les deux
 * versions existent et diffèrent.
 *
 * @param {Buffer|null} tamponGauche
 * @param {Buffer|null} tamponDroite
 * @param {{gauche?:number|null, droite?:number|null}} [dates] mtime en ms
 */
function decrireBinaire(tamponGauche, tamponDroite, dates = {}) {
  const cote = (tampon, date) =>
    tampon
      ? {
          taille: tampon.length,
          date: typeof date === 'number' ? date : null,
          sha256: crypto.createHash('sha256').update(tampon).digest('hex')
        }
      : null;

  const identiques = tamponGauche && tamponDroite ? tamponGauche.equals(tamponDroite) : null;

  return {
    identiques,
    gauche: cote(tamponGauche, dates.gauche),
    droite: cote(tamponDroite, dates.droite),
    difference: identiques === false ? premiereDifference(tamponGauche, tamponDroite) : null
  };
}

module.exports = {
  TAILLE_MAX_APERCU,
  APERCUS,
  genreApercu,
  construireApercu,
  premiereDifference,
  decrireBinaire
};
