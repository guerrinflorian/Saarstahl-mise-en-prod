'use strict';

/**
 * tfs.js - fichiers en attente d'archivage dans TFS (contrôle de source
 * Team Foundation Version Control).
 *
 * Module Node pur : aucune dépendance à Electron.
 *
 * Mettre en production un fichier extrait mais pas archivé, c'est livrer du
 * code que personne d'autre n'a : le prochain qui récupère les sources et
 * redéploie efface la modification sans le savoir. L'outil demande donc à
 * `tf.exe status` ce qui est en attente sous un dossier, avant le passage.
 *
 * C'est un garde-fou, pas un verrou : tf.exe introuvable, espace de travail
 * absent, serveur injoignable, et la vérification se dit impossible sans
 * jamais bloquer la mise en production.
 */

const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const iconv = require('iconv-lite');
const { cheminLong } = require('./fsindex');

/** Emplacement de tf.exe dans une installation de Visual Studio, à partir de sa racine. */
const TF_DANS_VS = ['Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'TeamFoundation', 'Team Explorer', 'TF.exe'];

async function fichierExiste(chemin) {
  try {
    return (await fsp.stat(cheminLong(chemin))).isFile();
  } catch (err) {
    return false;
  }
}

function decoder(tampon) {
  if (!tampon || !tampon.length) return '';
  const utf8 = tampon.toString('utf8');
  return utf8.includes('\ufffd') ? iconv.decode(tampon, 'cp850') : utf8;
}

function executer(executable, args, options = {}) {
  const { delai = 60000, cwd } = options;
  return new Promise((resoudre) => {
    execFile(
      executable,
      args,
      { timeout: delai, windowsHide: true, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, cwd },
      (err, sortie, erreurs) => {
        resoudre({ err, sortie: decoder(sortie), erreurs: decoder(erreurs) });
      }
    );
  });
}

/**
 * Trouve tf.exe : chemin des réglages, puis à côté du MSBuild trouvé (même
 * installation de Visual Studio), puis vswhere, puis les emplacements connus.
 *
 * @param {{ cheminForce?: string, msbuild?: string, env?: object }} [options]
 * @returns {Promise<{ chemin: string|null, erreur: string|null }>}
 */
async function localiserTf(options = {}) {
  const { cheminForce = '', msbuild = '', env = process.env } = options;
  if (cheminForce) {
    return (await fichierExiste(cheminForce))
      ? { chemin: cheminForce, erreur: null }
      : { chemin: null, erreur: `tf.exe introuvable à l'emplacement indiqué dans les réglages : ${cheminForce}` };
  }

  const candidats = [];
  // …\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe
  const coupure = msbuild ? msbuild.search(/[\\/]MSBuild[\\/]/i) : -1;
  if (coupure > 0) candidats.push(path.win32.join(msbuild.slice(0, coupure), ...TF_DANS_VS));

  const x86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const x64 = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  const vswhere = path.win32.join(x86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (process.platform === 'win32' && (await fichierExiste(vswhere))) {
    const { sortie } = await executer(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { delai: 15000 });
    const racine = sortie.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (racine) candidats.push(path.win32.join(racine, ...TF_DANS_VS));
  }
  for (const edition of ['Enterprise', 'Professional', 'Community']) {
    candidats.push(path.win32.join(x64, 'Microsoft Visual Studio', '2022', edition, ...TF_DANS_VS));
    candidats.push(path.win32.join(x86, 'Microsoft Visual Studio', '2019', edition, ...TF_DANS_VS));
    candidats.push(path.win32.join(x86, 'Microsoft Visual Studio', '2017', edition, ...TF_DANS_VS));
  }
  candidats.push(path.win32.join(x86, 'Microsoft Visual Studio 14.0', 'Common7', 'IDE', 'TF.exe'));
  candidats.push(path.win32.join(x86, 'Microsoft Visual Studio 12.0', 'Common7', 'IDE', 'TF.exe'));

  for (const candidat of candidats) {
    if (await fichierExiste(candidat)) return { chemin: candidat, erreur: null };
  }
  return {
    chemin: null,
    erreur: 'tf.exe introuvable (il est installé avec Visual Studio). Indiquez son chemin dans les réglages pour activer la vérification TFS.'
  };
}

/**
 * Lit la sortie de `tf status /format:brief` : une ligne par changement,
 * « nom   type de changement   chemin local ». Les en-têtes et le total
 * sont localisés (français ou anglais selon Visual Studio) : on ne garde que
 * les lignes qui finissent par un chemin local absolu.
 *
 * @returns {Array<{ nom:string, changement:string, chemin:string }>}
 */
function lireStatut(texte) {
  const lignes = String(texte || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const changements = [];
  const vus = new Set();
  const noter = (nom, changement, chemin) => {
    const cle = chemin.toLowerCase();
    if (!chemin || vus.has(cle)) return;
    vus.add(cle);
    changements.push({ nom: nom.trim(), changement: changement.trim(), chemin: chemin.trim() });
  };

  // La ligne de tirets sous l'en-tête donne la largeur exacte des colonnes :
  // le libellé le plus long d'une colonne n'est suivi que d'un seul espace,
  // on ne peut donc pas découper sur « deux espaces ou plus ».
  const tirets = lignes.find((l) => /^-+( -+){2,}$/.test(l));
  if (tirets) {
    const debuts = [0];
    for (let i = 1; i < tirets.length; i += 1) if (tirets[i - 1] === ' ' && tirets[i] === '-') debuts.push(i);
    for (const ligne of lignes) {
      if (ligne === tirets || ligne.length <= debuts[debuts.length - 1]) continue;
      const chemin = ligne.slice(debuts[debuts.length - 1]);
      if (!/^([A-Za-z]:\\|\\\\)/.test(chemin)) continue;
      noter(ligne.slice(0, debuts[1]), ligne.slice(debuts[1], debuts[debuts.length - 1]), chemin);
    }
    return changements;
  }

  // Sans en-tête : le chemin local est la fin de ligne qui commence par une
  // lettre de lecteur, le type de changement le mot qui le précède.
  for (const ligne of lignes) {
    const trouve = /^(.*\S)\s+(\S+)\s+([A-Za-z]:\\.*|\\\\.*)$/.exec(ligne);
    if (trouve) noter(trouve[1], trouve[2], trouve[3]);
  }
  return changements;
}

/**
 * Fichiers en attente d'archivage sous un dossier.
 *
 * @param {string} tf chemin de tf.exe
 * @param {string} dossier
 * @returns {Promise<{ ok:boolean, changements:object[], erreur:string|null }>}
 */
async function statut(tf, dossier) {
  if (!tf) return { ok: false, changements: [], erreur: 'tf.exe introuvable' };
  const { err, sortie, erreurs } = await executer(
    tf,
    ['status', dossier, '/recursive', '/format:brief', '/noprompt'],
    { cwd: dossier, delai: 90000 }
  );
  const changements = lireStatut(sortie);
  // tf.exe sort en erreur (code 1) quand il n'y a rien en attente sur
  // certaines versions : seule une sortie sans aucun changement ET avec un
  // message d'erreur est un échec.
  if (err && !changements.length && (erreurs.trim() || err.killed || err.code === 'ENOENT')) {
    const raison = err.killed
      ? 'tf.exe n\'a pas répondu à temps'
      : (erreurs.trim().split(/\r?\n/)[0] || err.message).slice(0, 300);
    return { ok: false, changements: [], erreur: raison };
  }
  return { ok: true, changements, erreur: null };
}

/** Les changements qui touchent un dossier donné (comparaison insensible à la casse). */
function sousDossier(changements, dossier) {
  const base = String(dossier || '').replace(/[\\/]+$/, '').toLowerCase() + '\\';
  return changements.filter((c) => c.chemin.toLowerCase().startsWith(base));
}

module.exports = { localiserTf, lireStatut, statut, sousDossier };
