'use strict';

/**
 * fsindex.js - parcours récursif, empreintes SHA-256, cache et concurrence
 * bornée.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Deux règles gouvernent ce fichier :
 *   - un dossier illisible ou un fichier verrouillé n'interrompt jamais un
 *     parcours ; il est consigné dans « ignorés » et le parcours continue ;
 *   - les lectures sont bornées (≈ 6 en parallèle) parce que la production est
 *     un partage SMB.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { correspondMotif } = require('./config');

// ---------------------------------------------------------------------------
// Chemins longs
// ---------------------------------------------------------------------------

/**
 * Préfixe `\\?\` pour dépasser la limite des 260 caractères. Sans lui, les
 * copies échouent silencieusement dans les arborescences profondes.
 * Sans effet hors Windows.
 */
function cheminLong(chemin) {
  if (process.platform !== 'win32') return chemin;
  if (!chemin || chemin.startsWith('\\\\?\\')) return chemin;
  const absolu = path.win32.resolve(chemin);
  if (absolu.startsWith('\\\\')) return '\\\\?\\UNC\\' + absolu.slice(2);
  return '\\\\?\\' + absolu;
}

/** Chemin relatif normalisé pour l'affichage : séparateurs Windows. */
function relatifWindows(racine, absolu) {
  const reste = absolu.slice(racine.length).replace(/^[\\/]+/, '');
  return reste.split(path.sep).join('\\');
}

/** Clé d'appariement : Windows est insensible à la casse. */
function cle(cheminRelatif) {
  return cheminRelatif.toLowerCase();
}

/**
 * Joint une racine et un chemin relatif écrit avec des séparateurs Windows.
 *
 * Les chemins relatifs manipulés par l'application utilisent toujours `\`
 * (§ « séparateurs Windows partout »). Sous Windows, `path.join` les comprend ;
 * ailleurs, il en ferait un nom de fichier contenant une contre-oblique. Passer
 * les segments un par un donne le bon résultat sur les deux systèmes, et permet
 * d'exercer ces modules depuis un script en ligne de commande.
 */
function joindreRelatif(racine, cheminRelatif) {
  const morceaux = String(cheminRelatif || '')
    .split(/[\\/]/)
    .filter(Boolean);
  return morceaux.length ? path.join(racine, ...morceaux) : racine;
}

// ---------------------------------------------------------------------------
// Concurrence
// ---------------------------------------------------------------------------

function creerSignal() {
  return {
    annule: false,
    annuler() {
      this.annule = true;
    }
  };
}

function creerSemaphore(maximum) {
  let actifs = 0;
  const attente = [];
  return {
    async acquerir() {
      if (actifs < maximum) {
        actifs += 1;
        return;
      }
      // La place est transmise directement par liberer() : le compteur ne
      // redescend pas entre-temps, la borne est stricte.
      await new Promise((resoudre) => attente.push(resoudre));
    },
    liberer() {
      const suivant = attente.shift();
      if (suivant) {
        suivant();
        return;
      }
      actifs -= 1;
    }
  };
}

/**
 * Applique `tache` à tous les éléments, `concurrence` à la fois, en s'arrêtant
 * dès que le signal est annulé.
 */
async function pool(elements, concurrence, tache, signal = { annule: false }) {
  let index = 0;
  const ouvriers = [];
  const nombre = Math.max(1, Math.min(concurrence, elements.length));
  for (let i = 0; i < nombre; i += 1) {
    ouvriers.push(
      (async () => {
        while (!signal.annule) {
          const position = index;
          index += 1;
          if (position >= elements.length) return;
          await tache(elements[position], position);
        }
      })()
    );
  }
  await Promise.all(ouvriers);
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/** Construit un test d'exclusion à partir d'une liste de motifs. */
function testeurExclusion(motifs) {
  const liste = Array.isArray(motifs) ? motifs.filter(Boolean) : [];
  if (!liste.length) return () => false;
  return (nom, cheminRelatif) =>
    liste.some((motif) => correspondMotif(motif, nom) || correspondMotif(motif, cheminRelatif));
}

function raisonLisible(err) {
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return 'accès refusé';
    case 'EBUSY':
      return 'verrouillé par un autre programme';
    case 'ENOENT':
      return 'disparu pendant l\'analyse';
    case 'ELOOP':
      return 'boucle de liens';
    case 'ENOTDIR':
      return 'ce n\'est pas un dossier';
    case 'ENAMETOOLONG':
      return 'chemin trop long';
    default:
      return err.code ? err.code.toLowerCase() : err.message;
  }
}

// ---------------------------------------------------------------------------
// Parcours
// ---------------------------------------------------------------------------

/**
 * Parcourt récursivement une racine, à profondeur illimitée.
 *
 * @param {string} racine chemin absolu
 * @param {object} options
 * @param {string[]} [options.dossiersExclus]
 * @param {string[]} [options.fichiersExclus]
 * @param {number} [options.concurrence]
 * @param {{annule:boolean}} [options.signal]
 * @param {(avancement:{dossiers:number,fichiers:number}) => void} [options.surProgression]
 * @returns {Promise<{ entrees: Map<string, object>, ignores: object[], dossiers: number }>}
 */
async function parcourir(racine, options = {}) {
  const {
    dossiersExclus = [],
    fichiersExclus = [],
    concurrence = 6,
    signal = { annule: false },
    surProgression = null
  } = options;

  const dossierExclu = testeurExclusion(dossiersExclus);
  const fichierExclu = testeurExclusion(fichiersExclus);

  const semaphore = creerSemaphore(concurrence);
  const entrees = new Map();
  const ignores = [];
  const candidats = [];
  let dossiers = 0;

  const racineNormalisee = racine.replace(/[\\/]+$/, '');

  try {
    const etat = await fsp.stat(cheminLong(racineNormalisee));
    if (!etat.isDirectory()) {
      return { entrees, ignores: [{ chemin: racine, type: 'racine', raison: 'ce n\'est pas un dossier' }], dossiers: 0 };
    }
  } catch (err) {
    return {
      entrees,
      ignores: [{ chemin: racine, type: 'racine', raison: raisonLisible(err) }],
      dossiers: 0,
      racineInaccessible: raisonLisible(err)
    };
  }

  async function visiter(absolu, relatif) {
    if (signal.annule) return;

    let contenu;
    await semaphore.acquerir();
    try {
      contenu = await fsp.readdir(cheminLong(absolu), { withFileTypes: true });
    } catch (err) {
      ignores.push({ chemin: relatif || '\\', type: 'dossier', raison: raisonLisible(err) });
      return;
    } finally {
      semaphore.liberer();
    }

    dossiers += 1;
    if (surProgression && dossiers % 25 === 0) {
      surProgression({ dossiers, fichiers: candidats.length });
    }

    const sousDossiers = [];
    for (const element of contenu) {
      const nom = element.name;
      const cheminRelatif = relatif ? relatif + '\\' + nom : nom;
      const cheminAbsolu = path.join(absolu, nom);

      if (element.isSymbolicLink()) {
        ignores.push({ chemin: cheminRelatif, type: 'lien', raison: 'lien symbolique non suivi' });
        continue;
      }
      if (element.isDirectory()) {
        if (dossierExclu(nom, cheminRelatif)) continue;
        sousDossiers.push({ absolu: cheminAbsolu, relatif: cheminRelatif });
        continue;
      }
      if (!element.isFile()) continue;
      if (fichierExclu(nom, cheminRelatif)) continue;

      candidats.push({ absolu: cheminAbsolu, chemin: cheminRelatif, nom });
    }

    await Promise.all(sousDossiers.map((d) => visiter(d.absolu, d.relatif)));
  }

  await visiter(racineNormalisee, '');

  // Tailles et dates : un stat par fichier, en concurrence bornée.
  let faits = 0;
  await pool(
    candidats,
    concurrence,
    async (candidat) => {
      try {
        const etat = await fsp.stat(cheminLong(candidat.absolu));
        entrees.set(cle(candidat.chemin), {
          chemin: candidat.chemin,
          nom: candidat.nom,
          absolu: candidat.absolu,
          taille: etat.size,
          mtimeMs: etat.mtimeMs,
          extension: extensionDe(candidat.nom)
        });
      } catch (err) {
        ignores.push({ chemin: candidat.chemin, type: 'fichier', raison: raisonLisible(err) });
      }
      faits += 1;
      if (surProgression && faits % 50 === 0) {
        surProgression({ dossiers, fichiers: faits, total: candidats.length });
      }
    },
    signal
  );

  if (surProgression) surProgression({ dossiers, fichiers: entrees.size, total: candidats.length });

  return { entrees, ignores, dossiers };
}

function extensionDe(nom) {
  const point = nom.lastIndexOf('.');
  if (point <= 0) return '';
  return nom.slice(point).toLowerCase();
}

// ---------------------------------------------------------------------------
// Empreintes
// ---------------------------------------------------------------------------

/** SHA-256 d'un fichier, lu en flux (les gros fichiers ne tiennent pas en RAM). */
function hashFichier(absolu) {
  return new Promise((resoudre, rejeter) => {
    const empreinte = crypto.createHash('sha256');
    const flux = fs.createReadStream(cheminLong(absolu));
    flux.on('error', rejeter);
    flux.on('data', (bloc) => empreinte.update(bloc));
    flux.on('end', () => resoudre(empreinte.digest('hex')));
  });
}

/**
 * Cache d'empreintes indexé sur chemin + taille + date, persisté en JSON.
 * La date n'est jamais une preuve d'égalité : elle ne sert qu'à savoir si
 * l'empreinte mémorisée est encore valable pour ce fichier.
 */
function creerCacheHash(cheminFichier, { maximum = 120000 } = {}) {
  /** @type {Map<string, {hash:string, vu:number}>} */
  let entrees = new Map();
  /**
   * Index chemin → clés : invalider un fichier ne parcourt que ses propres
   * versions, pas les 120 000 entrées du cache. Un déploiement de 500 fichiers
   * parcourait 60 millions de clés ; il en parcourt maintenant 500 poignées.
   * @type {Map<string, Set<string>>}
   */
  const parChemin = new Map();
  let modifie = false;
  let ecriture = null;

  const cheminDe = (identifiant) => identifiant.slice(0, identifiant.indexOf('|'));

  function indexer(identifiant) {
    const chemin = cheminDe(identifiant);
    let cles = parChemin.get(chemin);
    if (!cles) {
      cles = new Set();
      parChemin.set(chemin, cles);
    }
    cles.add(identifiant);
  }

  function desindexer(identifiant) {
    const chemin = cheminDe(identifiant);
    const cles = parChemin.get(chemin);
    if (!cles) return;
    cles.delete(identifiant);
    if (!cles.size) parChemin.delete(chemin);
  }

  function elaguer() {
    if (entrees.size <= maximum) return;
    const triees = [...entrees.entries()].sort((a, b) => b[1].vu - a[1].vu).slice(0, maximum);
    entrees = new Map(triees);
    parChemin.clear();
    for (const identifiant of entrees.keys()) indexer(identifiant);
  }

  try {
    const brut = JSON.parse(fs.readFileSync(cheminFichier, 'utf8'));
    if (brut && brut.entrees) {
      entrees = new Map(Object.entries(brut.entrees));
      for (const identifiant of entrees.keys()) indexer(identifiant);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.emitWarning(`Cache d'empreintes illisible (${err.message}) : il sera reconstruit.`);
    }
  }

  const cleDe = (absolu, taille, mtimeMs) =>
    absolu.toLowerCase() + '|' + taille + '|' + Math.round(mtimeMs);

  return {
    /** Empreinte d'un fichier, calculée seulement si elle n'est pas déjà connue. */
    async obtenir(absolu, taille, mtimeMs) {
      const identifiant = cleDe(absolu, taille, mtimeMs);
      const connu = entrees.get(identifiant);
      if (connu) {
        connu.vu = Date.now();
        return connu.hash;
      }
      const hash = await hashFichier(absolu);
      entrees.set(identifiant, { hash, vu: Date.now() });
      indexer(identifiant);
      // Une nouvelle version d'un fichier remplace les anciennes : sans cela le
      // cache grossit avec le nombre de modifications, pas de fichiers.
      const chemin = absolu.toLowerCase();
      const cles = parChemin.get(chemin);
      if (cles && cles.size > 1) {
        for (const ancienne of [...cles]) {
          if (ancienne !== identifiant) {
            entrees.delete(ancienne);
            cles.delete(ancienne);
          }
        }
      }
      if (entrees.size > maximum * 1.1) elaguer();
      modifie = true;
      return hash;
    },

    /** Oublie ce que l'on sait d'un fichier (après écriture, par exemple). */
    invalider(absolu) {
      const cles = parChemin.get(absolu.toLowerCase());
      if (!cles || !cles.size) return;
      for (const identifiant of [...cles]) {
        entrees.delete(identifiant);
        desindexer(identifiant);
      }
      modifie = true;
    },

    /**
     * Écriture asynchrone : sérialiser 120 000 entrées en synchrone bloquait le
     * processus principal après chaque analyse. Les appels se suivent, jamais
     * ne se chevauchent.
     */
    async enregistrer() {
      while (ecriture) await ecriture;
      if (!modifie) return;
      ecriture = (async () => {
        try {
          elaguer();
          await fsp.mkdir(path.dirname(cheminFichier), { recursive: true });
          const temporaire = cheminFichier + '.tmp';
          await fsp.writeFile(temporaire, JSON.stringify({ v: 1, entrees: Object.fromEntries(entrees) }), 'utf8');
          await fsp.rename(temporaire, cheminFichier);
          modifie = false;
        } catch (err) {
          process.emitWarning(`Cache d'empreintes non enregistré : ${err.message}`);
        }
      })();
      try {
        await ecriture;
      } finally {
        ecriture = null;
      }
    },

    /** Variante synchrone, réservée à la fermeture de l'application. */
    enregistrerSync() {
      if (!modifie) return;
      try {
        elaguer();
        fs.mkdirSync(path.dirname(cheminFichier), { recursive: true });
        const temporaire = cheminFichier + '.tmp';
        fs.writeFileSync(temporaire, JSON.stringify({ v: 1, entrees: Object.fromEntries(entrees) }), 'utf8');
        fs.renameSync(temporaire, cheminFichier);
        modifie = false;
      } catch (err) {
        process.emitWarning(`Cache d'empreintes non enregistré : ${err.message}`);
      }
    },

    get taille() {
      return entrees.size;
    }
  };
}

module.exports = {
  cheminLong,
  relatifWindows,
  cle,
  joindreRelatif,
  creerSignal,
  creerSemaphore,
  pool,
  testeurExclusion,
  raisonLisible,
  parcourir,
  hashFichier,
  creerCacheHash,
  extensionDe
};
