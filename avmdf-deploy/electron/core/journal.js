'use strict';

/**
 * journal.js - journal quotidien en texte, une ligne par événement horodaté.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 * Un incident d'écriture du journal ne doit jamais faire échouer l'opération
 * qu'il consigne : il est signalé sur la console et l'application continue.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const NIVEAUX = ['INFO', 'ALERTE', 'ERREUR'];

function deuxChiffres(nombre) {
  return String(nombre).padStart(2, '0');
}

function jourDe(date) {
  return `${date.getFullYear()}-${deuxChiffres(date.getMonth() + 1)}-${deuxChiffres(date.getDate())}`;
}

function horodatageDe(date) {
  return (
    jourDe(date) +
    ' ' +
    deuxChiffres(date.getHours()) +
    ':' +
    deuxChiffres(date.getMinutes()) +
    ':' +
    deuxChiffres(date.getSeconds())
  );
}

/**
 * @param {string} dossier dossier des journaux (userData/logs)
 */
function creerJournal(dossier) {
  let averti = false;

  function fichierDuJour(date = new Date()) {
    return path.join(dossier, `journal-${jourDe(date)}.log`);
  }

  /**
   * Consigne un événement. Ne lève jamais.
   * @param {string} niveau INFO | ALERTE | ERREUR
   * @param {string} message
   */
  function ecrire(niveau, message) {
    const date = new Date();
    const ligne = `${horodatageDe(date)}  ${(niveau || 'INFO').padEnd(6)}  ${String(message).replace(/\s+/g, ' ')}\n`;
    try {
      fs.mkdirSync(dossier, { recursive: true });
      fs.appendFileSync(fichierDuJour(date), ligne, 'utf8');
    } catch (err) {
      if (!averti) {
        averti = true;
        process.emitWarning(`Journal non écrit dans ${dossier} : ${err.message}`);
      }
    }
    return ligne;
  }

  /** Fichiers de journal présents, du plus récent au plus ancien. */
  async function lister() {
    try {
      const noms = await fsp.readdir(dossier);
      return noms
        .filter((nom) => /^journal-\d{4}-\d{2}-\d{2}\.log$/.test(nom))
        .sort()
        .reverse()
        .map((nom) => ({ nom, chemin: path.join(dossier, nom), jour: nom.slice(8, 18) }));
    } catch (err) {
      return [];
    }
  }

  /** Dernières lignes d'un journal, la plus récente en premier. */
  async function lire(nom, maximum = 2000) {
    const chemin = path.join(dossier, path.basename(nom));
    try {
      const contenu = await fsp.readFile(chemin, 'utf8');
      const lignes = contenu.split('\n').filter(Boolean);
      return { ok: true, lignes: lignes.slice(-maximum).reverse(), tronque: lignes.length > maximum };
    } catch (err) {
      return { ok: false, lignes: [], erreur: err.code === 'ENOENT' ? 'journal absent' : err.message };
    }
  }

  return { dossier, fichierDuJour, ecrire, lister, lire, NIVEAUX };
}

module.exports = { creerJournal, NIVEAUX };
