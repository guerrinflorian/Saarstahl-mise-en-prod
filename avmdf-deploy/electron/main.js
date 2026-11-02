'use strict';

/**
 * main.js - fenêtre principale et handlers IPC.
 *
 * Ce fichier n'orchestre que des appels : la logique vit dans `core/`.
 * Toute écriture sur le disque passe par ici ; le renderer n'a aucun accès
 * direct au système de fichiers et ne manipule jamais de chemin absolu qu'il
 * aurait fabriqué lui-même - il désigne les fichiers par leur clé d'analyse.
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const config = require('./core/config');
const acces = require('./core/acces');
const fsindex = require('./core/fsindex');
const compare = require('./core/compare');
const search = require('./core/search');
const textdiff = require('./core/textdiff');
const binaire = require('./core/binaire');
const avmdf = require('./core/avmdf');
const deploy = require('./core/deploy');
const journal = require('./core/journal');
const stats = require('./core/stats');
const references = require('./core/references');
const webservice = require('./core/webservice');
const tfs = require('./core/tfs');

const MODE_DEV = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let fenetre = null;
let depotConfig = null;
let cacheHash = null;
let carnet = null;
let avertissementsDemarrage = [];

/** Analyse en cours et dernier résultat connu, qui fait autorité côté serveur. */
let analyseEnCours = null;
let dernierScan = null;
let rechercheEnCours = null;
let operationEnCours = null;
let preflightEnCours = null;

/**
 * Index des références (« qui utilise ce fichier »), construit à la demande
 * sur la dernière analyse, invalidé dès qu'un contenu change : l'index décrit
 * des fichiers, pas une analyse figée.
 */
let dernieresReferences = null;
let referencesEnCours = null;

function invaliderReferences() {
  dernieresReferences = null;
}

/**
 * Dernier préflight réussi, réutilisable par l'exécution : entre la fenêtre de
 * confirmation et le clic, inutile de relire toute la production une seconde
 * fois si rien n'a changé dans le plan. Le jeton est invalidé par un nouveau
 * scan, un changement de plan, ou cinq minutes d'attente.
 */
let dernierPreflight = null;
const DUREE_JETON_PREFLIGHT = 5 * 60 * 1000;

/**
 * Manifestes de la racine d'archives, partagés entre l'historique et le
 * tableau de bord : les deux écrans relisaient chacun tout le partage à chaque
 * affichage. Invalidé après chaque écriture réelle, et au bout de 30 secondes.
 */
let cacheManifestes = null;
const DUREE_CACHE_MANIFESTES = 30 * 1000;

/**
 * Une seule opération lourde à la fois : un scan lancé pendant une mise en
 * production laisserait le plan pointer sur les objets d'une analyse disparue,
 * et deux opérations se partageraient la même poignée d'annulation.
 */
let operationExclusive = null;

// ---------------------------------------------------------------------------
// Réponses IPC
// ---------------------------------------------------------------------------

function succes(donnees) {
  return Object.assign({ ok: true }, donnees);
}

function echec(message, conseil, cause) {
  if (cause) console.error('[avmdf]', message, cause);
  return {
    ok: false,
    erreur: { message, conseil, code: cause && cause.code ? cause.code : null }
  };
}

function gerer(canal, handler) {
  ipcMain.handle(canal, async (evenement, ...arguments_) => {
    if (!expediteurAutorise(evenement)) {
      return echec(
        'Demande refusée : elle ne provient pas de la fenêtre de l\'application.',
        'Fermez puis relancez l\'application.'
      );
    }
    try {
      return await handler(...arguments_);
    } catch (err) {
      if (carnet) carnet.ecrire('ERREUR', `${canal} : ${err.message}`);
      return echec(
        `Erreur inattendue pendant « ${canal} » : ${err.message}`,
        'Relancez l\'application ; si le problème persiste, consultez le journal.',
        err
      );
    }
  });
}

function expediteurAutorise(evenement) {
  return Boolean(fenetre) && evenement.sender === fenetre.webContents;
}

function emettre(canal, donnees) {
  if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send(canal, donnees);
}

function contexteConfig() {
  return { utilisateur: process.env.USERNAME || process.env.USER || '' };
}

/**
 * Réglages en mémoire : le fichier n'est relu qu'après une écriture, pas à
 * chacun des vingt-quatre points d'appel (dont l'ouverture de chaque fichier).
 */
let reglagesConnus = null;

function reglages() {
  if (!reglagesConnus) reglagesConnus = depotConfig.charger().config;
  return reglagesConnus;
}

async function exclusif(nom, corps) {
  if (operationExclusive) {
    return echec(
      `Opération refusée : ${operationExclusive} est en cours.`,
      'Attendez la fin de l\'opération en cours, ou annulez-la, avant d\'en lancer une autre.'
    );
  }
  operationExclusive = nom;
  try {
    return await corps();
  } finally {
    operationExclusive = null;
  }
}

/** Ce qui rend un préflight réutilisable : même sélection, même destination, mêmes choix. */
function signaturePlan(plan) {
  return JSON.stringify({
    operation: plan.operation,
    simulation: plan.simulation,
    archiver: plan.archiver,
    dossierSauvegarde: plan.dossierSauvegarde,
    racineProd: plan.racineProd,
    cles: plan.fichiers.map((f) => f.cle).sort()
  });
}

function listerManifestesEnCache(actuels, rafraichir = false) {
  const racine = actuels.racines.avmdf;
  const valide =
    !rafraichir &&
    cacheManifestes &&
    cacheManifestes.racine === racine &&
    Date.now() - cacheManifestes.date < DUREE_CACHE_MANIFESTES;
  if (!valide) {
    const promesse = deploy
      .listerManifestes(racine, { concurrence: actuels.options.lecturesSimultanees })
      .catch((err) => {
        cacheManifestes = null;
        throw err;
      });
    cacheManifestes = { racine, date: Date.now(), promesse };
  }
  return cacheManifestes.promesse;
}

function invaliderManifestes() {
  cacheManifestes = null;
}

/**
 * Les racines qu'un manifeste déclare doivent rester dans le périmètre
 * configuré : un manifeste ancien (racine déplacée depuis) ou retouché à la
 * main ne fait écrire nulle part ailleurs. Contrôlé avant toute restauration ;
 * la simple lecture (comparer, vérifier) reste permise.
 */
function perimetreManifeste(contenu, actuels) {
  const problemes = [];
  const racineWs = config.resoudreWebServices(actuels).prod;
  const sousProd =
    contenu.racineProd &&
    (avmdf.estSousRacine(contenu.racineProd, actuels.racines.prod) ||
      (contenu.type === 'webservice' &&
        ((racineWs && avmdf.estSousRacine(contenu.racineProd, racineWs)) ||
          (racinesWsTrouvees && avmdf.estSousRacine(contenu.racineProd, racinesWsTrouvees.prod)))));
  if (!sousProd) {
    problemes.push(
      `la racine de production du manifeste sort du périmètre configuré (${contenu.racineProd || 'absente'})`
    );
  }
  if (contenu.dossierSauvegarde && !avmdf.estSousRacine(contenu.dossierSauvegarde, actuels.racines.avmdf)) {
    problemes.push(`le dossier de sauvegarde du manifeste sort du dossier d'archives (${contenu.dossierSauvegarde})`);
  }
  return problemes;
}

function journaliserTraces(chemins) {
  if (chemins && chemins.erreurEcriture) {
    carnet.ecrire(
      'ERREUR',
      `traces du passage : ${chemins.erreurEcriture}` +
        (chemins.manifesteSecours ? ` - copie de secours : ${chemins.manifesteSecours}` : '')
    );
  }
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function handlersConfig() {
  gerer('systeme:infos', () => {
    const avertissements = avertissementsDemarrage;
    avertissementsDemarrage = [];
    return succes({
      infos: {
        versionApp: app.getVersion(),
        versionElectron: process.versions.electron,
        versionNode: process.versions.node,
        plateforme: process.platform,
        utilisateur: process.env.USERNAME || process.env.USER || os.userInfo().username || '',
        cheminConfig: depotConfig.chemin,
        dossierDonnees: app.getPath('userData'),
        dossierJournaux: carnet.dossier,
        modeDev: MODE_DEV
      },
      avertissements
    });
  });

  gerer('config:lire', () => {
    const { config: lus, existait, avertissements } = depotConfig.charger();
    reglagesConnus = lus;
    return succes({ config: lus, existait, avertissements, controle: config.verifier(lus) });
  });

  gerer('config:defauts', () => succes({ config: config.reglagesParDefaut(contexteConfig()) }));

  gerer('config:verifier', (brut) => {
    const propre = config.normaliser(brut, contexteConfig());
    return succes({ controle: config.verifier(propre) });
  });

  gerer('config:enregistrer', (brut) => {
    const propre = config.normaliser(brut, contexteConfig());
    const controle = config.verifier(propre);
    if (controle.erreurs.length) {
      return Object.assign(
        echec(
          'Réglages non enregistrés : ' + controle.erreurs.length + ' point(s) à corriger.',
          'Corrigez les champs signalés en rouge, puis enregistrez de nouveau.'
        ),
        { controle }
      );
    }
    try {
      const { config: enregistre } = depotConfig.enregistrer(propre);
      reglagesConnus = enregistre;
      return succes({ config: enregistre, controle: config.verifier(enregistre) });
    } catch (err) {
      return echec(
        `Impossible d'écrire les réglages dans ${depotConfig.chemin} (${err.code || err.message}).`,
        'Vérifiez que le dossier est accessible en écriture et qu\'aucun autre programme ne tient le fichier.',
        err
      );
    }
  });

  gerer('config:reinitialiser', () => {
    try {
      const { config: neuf } = depotConfig.reinitialiser();
      reglagesConnus = neuf;
      return succes({ config: neuf, controle: config.verifier(neuf) });
    } catch (err) {
      return echec(
        `Impossible de réinitialiser les réglages (${err.code || err.message}).`,
        'Vérifiez les droits d\'écriture sur ' + depotConfig.chemin,
        err
      );
    }
  });

  gerer('config:exclureFichier', (nom) =>
    ajouterExclusion('fichiers', nom, 'Aucun fichier à exclure.')
  );

  gerer('config:exclureDossier', (motif) =>
    ajouterExclusion('dossiers', motif, 'Aucun dossier à exclure.')
  );

  // Sert l'écran de premier démarrage : dire tout de suite si un dossier saisi
  // existe et se lit, plutôt que de le découvrir à la première analyse.
  gerer('config:controlerRacines', async (racines = {}) => {
    const controle = await acces.verifierRacines([
      { role: 'locale', titre: 'Racine locale', libelle: 'La racine locale', chemin: String(racines.locale || '') },
      { role: 'prod', titre: 'Racine de production', libelle: 'La racine de production', chemin: String(racines.prod || '') },
      {
        role: 'avmdf',
        titre: 'Racine des archives AVMDF',
        libelle: 'La racine des archives AVMDF',
        chemin: String(racines.avmdf || '')
      }
    ]);
    return succes({ acces: controle });
  });

  gerer('config:revelerFichier', () => {
    shell.showItemInFolder(depotConfig.chemin);
    return succes({});
  });

  gerer('dialogue:choisirDossier', async (parametres = {}) => {
    const resultat = await dialog.showOpenDialog(fenetre, {
      title: parametres.titre || 'Choisir un dossier',
      defaultPath: parametres.cheminInitial || undefined,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choisir ce dossier'
    });
    if (resultat.canceled || !resultat.filePaths.length) return succes({ annule: true, chemin: '' });
    return succes({ annule: false, chemin: resultat.filePaths[0] });
  });
}

/**
 * Ajoute un motif à une liste d'exclusions et enregistre.
 *
 * Le motif est rendu tel quel dans la réponse : c'est lui que l'interface
 * montre, plutôt que « c'est fait ». Une exclusion posée d'un clic droit se
 * retrouve autrement mal dans les réglages quand on la cherche.
 *
 * @param {'fichiers'|'dossiers'} categorie
 * @param {string} brut
 * @param {string} messageVide
 */
function ajouterExclusion(categorie, brut, messageVide) {
  const motif = String(brut || '').trim();
  if (!motif) return echec(messageVide, 'Réessayez depuis le menu contextuel.');

  const actuels = reglages();
  const liste = actuels.exclusions[categorie];
  if (liste.some((connu) => connu.toLowerCase() === motif.toLowerCase())) {
    return succes({ config: actuels, motif, deja: true });
  }

  liste.push(motif);
  const { config: enregistre } = depotConfig.enregistrer(actuels);
  reglagesConnus = enregistre;
  carnet.ecrire('INFO', `exclusion ajoutée (${categorie}) : ${motif}`);
  return succes({ config: enregistre, motif, deja: false });
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

function handlersAnalyse() {
  gerer('analyse:demarrer', (parametres) => exclusif('une analyse', async () => {
    const actuels = reglages();
    const cheminLocal = String(parametres.cheminLocal || '');
    const cheminProd = String(parametres.cheminProd || '');

    // Les deux racines sont contrôlées avant le premier parcours. Une analyse
    // qui démarre sur un dossier illisible ne s'arrête pas : elle rend un côté
    // vide, et l'écran se remplit d'écarts qui n'existent pas.
    const racines = await acces.verifierRacines([
      { role: 'local', titre: 'Dossier local', libelle: 'Le dossier local', chemin: cheminLocal },
      { role: 'prod', titre: 'Dossier de production', libelle: 'Le dossier de production', chemin: cheminProd }
    ]);
    if (!racines.ok) {
      carnet.ecrire(
        'ERREUR',
        'analyse refusée - ' +
          racines.problemes.map((cote) => `${cote.role} : ${cote.code} (${cote.chemin || 'non renseigné'})`).join(' ; ')
      );
      return Object.assign(echec(racines.message, racines.conseil), { acces: racines });
    }

    const signal = fsindex.creerSignal();
    analyseEnCours = signal;
    const debut = Date.now();
    carnet.ecrire('INFO', `analyse lancée : ${cheminLocal} ↔ ${cheminProd}`);

    try {
      const optionsParcours = {
        dossiersExclus: actuels.exclusions.dossiers,
        fichiersExclus: actuels.exclusions.fichiers,
        concurrence: actuels.options.lecturesSimultanees,
        signal
      };

      emettre('analyse:progression', { phase: 'local', libelle: 'Analyse locale', fichiers: 0 });
      const local = await fsindex.parcourir(cheminLocal, {
        ...optionsParcours,
        surProgression: (avancement) =>
          emettre('analyse:progression', { phase: 'local', libelle: 'Analyse locale', ...avancement })
      });

      if (signal.annule) return succes({ annule: true });

      emettre('analyse:progression', { phase: 'prod', libelle: 'Analyse production', fichiers: 0 });
      const prod = await fsindex.parcourir(cheminProd, {
        ...optionsParcours,
        surProgression: (avancement) =>
          emettre('analyse:progression', { phase: 'prod', libelle: 'Analyse production', ...avancement })
      });

      if (signal.annule) return succes({ annule: true });

      const resultat = await compare.comparer(local.entrees, prod.entrees, {
        hasher: (cote) => cacheHash.obtenir(cote.absolu, cote.taille, cote.mtimeMs),
        concurrence: actuels.options.lecturesSimultanees,
        signal,
        surProgression: (avancement) =>
          emettre('analyse:progression', {
            phase: 'contenu',
            libelle: 'Vérification du contenu',
            ...avancement
          })
      });

      cacheHash.enregistrer();

      const ignores = [...local.ignores.map((i) => ({ ...i, cote: 'local' })), ...prod.ignores.map((i) => ({ ...i, cote: 'prod' })), ...resultat.incidents.map((i) => ({ ...i, cote: 'contenu' }))];

      invaliderReferences();
      dernierScan = {
        cheminLocal,
        cheminProd,
        modeLibre: Boolean(parametres.modeLibre),
        projet: parametres.projet || null,
        date: new Date().toISOString(),
        duree: Date.now() - debut,
        fichiers: resultat.fichiers,
        parCle: new Map(resultat.fichiers.map((f) => [f.cle, f])),
        compteurs: resultat.compteurs,
        extensions: resultat.extensions,
        ignores,
        annule: signal.annule
      };

      carnet.ecrire(
        signal.annule ? 'ALERTE' : 'INFO',
        `analyse ${signal.annule ? 'annulée' : 'terminée'} en ${Math.round((Date.now() - debut) / 1000)} s - ` +
          `${resultat.fichiers.length} fichiers, ${resultat.compteurs.modifie} modifiés, ` +
          `${resultat.compteurs.nouveau} nouveaux, ${resultat.compteurs.orphelin} orphelins, ` +
          `${ignores.length} ignorés`
      );

      const pourEnvoi = pourLeRenderer(dernierScan);
      if (pourEnvoi.correspondance.niveau !== 'ok') {
        carnet.ecrire(
          'ALERTE',
          `correspondance douteuse (${pourEnvoi.correspondance.code}) : ` +
            `${pourEnvoi.correspondance.communs} fichier(s) commun(s) sur ` +
            `${pourEnvoi.correspondance.local} en local et ${pourEnvoi.correspondance.prod} en production`
        );
      }

      return succes({ annule: signal.annule, resultat: pourEnvoi });
    } finally {
      analyseEnCours = null;
    }
  }));

  gerer('analyse:annuler', () => {
    if (analyseEnCours) analyseEnCours.annuler();
    return succes({});
  });

  // Réanalyse d'un seul fichier : re-stat et re-hash des deux côtés, sans
  // relire tout le partage. C'est le geste qui suit un « fichier verrouillé »
  // corrigé, ou un doute sur un seul écart, quand les milliers d'autres
  // fichiers n'ont pas bougé.
  gerer('analyse:rafraichirFichier', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) {
      return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');
    }

    const actuels = reglages();
    const cheminLocal = fichier.local
      ? fichier.local.absolu
      : fsindex.joindreRelatif(dernierScan.cheminLocal, fichier.chemin);
    const cheminProd = fichier.prod
      ? fichier.prod.absolu
      : fsindex.joindreRelatif(dernierScan.cheminProd, fichier.chemin);

    const relever = async (absolu) => {
      try {
        const etat = await fsp.stat(fsindex.cheminLong(absolu));
        if (!etat.isFile()) return null;
        return { absolu, chemin: fichier.chemin, taille: etat.size, mtimeMs: etat.mtimeMs, hash: null };
      } catch (err) {
        return null;
      }
    };
    const [local, prod] = await Promise.all([relever(cheminLocal), relever(cheminProd)]);

    // Mêmes règles que l'analyse complète : la taille tranche, sinon
    // l'empreinte. Jamais la date.
    let statut = null;
    if (local && prod) {
      if (local.taille !== prod.taille) {
        statut = compare.MODIFIE;
      } else {
        try {
          local.hash = await cacheHash.obtenir(local.absolu, local.taille, local.mtimeMs);
          prod.hash = await cacheHash.obtenir(prod.absolu, prod.taille, prod.mtimeMs);
        } catch (err) {
          return echec(
            `Le contenu n'a pas pu être vérifié (${fsindex.raisonLisible(err)}) : ${fichier.chemin}`,
            'Un des deux côtés ne se laisse pas lire. Réessayez, ou relancez une analyse complète.',
            err
          );
        }
        statut = local.hash === prod.hash ? compare.IDENTIQUE : compare.MODIFIE;
      }
    } else if (local) {
      statut = compare.NOUVEAU;
    } else if (prod) {
      statut = compare.ORPHELIN;
    }

    if (statut === null) {
      // Disparu des deux côtés : il n'a plus rien à faire dans l'analyse.
      dernierScan.fichiers = dernierScan.fichiers.filter((f) => f.cle !== fichier.cle);
      dernierScan.parCle.delete(fichier.cle);
    } else {
      fichier.local = local;
      fichier.prod = prod;
      fichier.statut = statut;
    }
    dernierScan.compteurs = compare.compter(dernierScan.fichiers);
    dernierScan.extensions = compare.inventaireExtensions(dernierScan.fichiers);
    cacheHash.enregistrer();
    invaliderReferences();

    carnet.ecrire(
      'INFO',
      `fichier réanalysé : ${fichier.chemin} → ${statut === null ? 'disparu des deux côtés' : statut}`
    );

    let diff = null;
    if (statut !== null) {
      try {
        diff = await construireDiff(fichier, actuels);
      } catch (err) {
        /* la comparaison se rechargera à la demande */
      }
    }

    return succes({
      statut,
      supprime: statut === null,
      analyse: pourLeRenderer(dernierScan),
      diff
    });
  });

  gerer('recherche:contenu', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    if (rechercheEnCours) rechercheEnCours.annuler();

    const actuels = reglages();
    const requete = String(parametres.requete || '').trim();
    if (!requete) return succes({ occurrences: [] });

    const signal = fsindex.creerSignal();
    rechercheEnCours = signal;
    const extensions = new Set(actuels.extensionsTexte);
    const candidats = dernierScan.fichiers.filter((fichier) => extensions.has(fichier.extension));
    const occurrences = [];
    let faits = 0;

    try {
      await fsindex.pool(
        candidats,
        actuels.options.lecturesSimultanees,
        async (fichier) => {
          let total = 0;
          for (const cote of [fichier.local, fichier.prod]) {
            if (!cote || cote.taille > textdiff.TAILLE_MAX_DIFF) continue;
            try {
              const tampon = await fsp.readFile(fsindex.cheminLong(cote.absolu));
              if (textdiff.estBinaire(tampon)) continue;
              total += search.compterOccurrences(textdiff.decoder(tampon).texte, requete, parametres.mode);
            } catch (err) {
              /* fichier illisible : il ne remonte simplement pas dans les résultats */
            }
          }
          if (total > 0) occurrences.push([fichier.cle, total]);
          faits += 1;
          if (faits % 25 === 0) {
            emettre('recherche:progression', { faits, total: candidats.length });
          }
        },
        signal
      );
      emettre('recherche:progression', { faits, total: candidats.length });
      return succes({ occurrences, annule: signal.annule, examines: faits });
    } finally {
      if (rechercheEnCours === signal) rechercheEnCours = null;
    }
  });

  gerer('recherche:annuler', () => {
    if (rechercheEnCours) rechercheEnCours.annuler();
    return succes({});
  });
}

/** Le renderer n'a pas besoin des index internes ; la Map n'est pas sérialisable. */
/**
 * Met l'analyse en mémoire à jour d'après le manifeste, sans relire le partage.
 *
 * Après une copie réussie, le fichier de production a exactement le contenu du
 * fichier local : ce n'est pas une supposition, c'est ce que le manifeste
 * enregistre, empreinte comprise. Inutile de reparcourir des milliers de
 * fichiers sur le réseau pour apprendre ce qu'on vient d'écrire soi-même.
 *
 * Ce qui a échoué garde son statut : l'écart est toujours là, il doit rester
 * visible.
 *
 * @param {object} manifeste
 * @returns {boolean} vrai si l'analyse a changé
 */
function rafraichirScan(manifeste) {
  if (!dernierScan || manifeste.simulation) return false;
  // Une restauration remet en production un contenu venu des archives, pas des
  // sources locales : conclure « identique » serait faux.
  if (manifeste.operation === 'restauration') return false;

  const aRetirer = new Set();
  let touches = 0;

  for (const entree of manifeste.fichiers) {
    if (entree.erreur) continue;
    const fichier = dernierScan.parCle.get(entree.chemin.toLowerCase());
    if (!fichier) continue;

    // Un orphelin supprimé n'existe plus nulle part : il quitte la liste.
    if (entree.action === 'suppression') {
      aRetirer.add(fichier.cle);
      touches += 1;
      continue;
    }

    // Copie binaire : les deux côtés ont désormais le même contenu, octet pour
    // octet. La date, elle, est celle de la mise en production.
    fichier.statut = compare.IDENTIQUE;
    fichier.prod = {
      absolu: fsindex.joindreRelatif(dernierScan.cheminProd, fichier.chemin),
      chemin: fichier.chemin,
      taille: entree.tailleApres,
      mtimeMs: Date.now(),
      hash: entree.hashApres || null
    };
    if (fichier.local) fichier.local.hash = entree.hashApres || fichier.local.hash;
    touches += 1;
  }

  if (!touches) return false;

  if (aRetirer.size) {
    dernierScan.fichiers = dernierScan.fichiers.filter((fichier) => !aRetirer.has(fichier.cle));
    dernierScan.parCle = new Map(dernierScan.fichiers.map((fichier) => [fichier.cle, fichier]));
  }
  dernierScan.compteurs = compare.compter(dernierScan.fichiers);
  dernierScan.extensions = compare.inventaireExtensions(dernierScan.fichiers);
  return true;
}

function pourLeRenderer(scan) {
  return {
    cheminLocal: scan.cheminLocal,
    cheminProd: scan.cheminProd,
    modeLibre: scan.modeLibre,
    projet: scan.projet,
    date: scan.date,
    duree: scan.duree,
    fichiers: scan.fichiers,
    compteurs: scan.compteurs,
    extensions: scan.extensions,
    ignores: scan.ignores,
    // Recalculée à chaque envoi plutôt que mémorisée : une mise en production
    // rapproche les deux côtés, le constat doit suivre.
    correspondance: compare.diagnostiquerCorrespondance(scan.fichiers),
    arbre: compare.construireArbre(scan.fichiers)
  };
}

// ---------------------------------------------------------------------------
// Comparaison ligne à ligne
// ---------------------------------------------------------------------------

/** mtime d'un chemin, ou null s'il ne se laisse pas regarder. */
async function dateModification(chemin) {
  if (!chemin) return null;
  try {
    return (await fsp.stat(fsindex.cheminLong(chemin))).mtimeMs;
  } catch (err) {
    return null;
  }
}

/**
 * Complète une enveloppe de comparaison quand le contenu ne se lit pas ligne à
 * ligne : verdict octet pour octet, empreintes, premier écart, et aperçu
 * affichable pour ce que Chromium sait rendre (images, sons, vidéos, polices).
 *
 * Un fichier prévisualisable trop volumineux pour le diff texte est reclassé
 * binaire plutôt que refusé : une photo de 6 Mo se juge à l'œil, pas ligne à
 * ligne. Et un SVG, texte par nature, reçoit en plus son aperçu : son code se
 * compare, son rendu se regarde.
 */
function completerBinaire(enveloppe, extension, tamponGauche, tamponDroite, dates = {}) {
  const plusGros = Math.max(tamponGauche ? tamponGauche.length : 0, tamponDroite ? tamponDroite.length : 0);
  if (enveloppe.type === 'volumineux' && binaire.genreApercu(extension) && plusGros <= binaire.TAILLE_MAX_APERCU) {
    enveloppe.type = 'binaire';
    delete enveloppe.limite;
    delete enveloppe.taille;
  }

  if (enveloppe.type === 'binaire') {
    enveloppe.binaire = binaire.decrireBinaire(tamponGauche, tamponDroite, dates);
    enveloppe.apercu = binaire.construireApercu(extension, tamponGauche, tamponDroite);
  } else if (enveloppe.type === 'texte' && binaire.genreApercu(extension) === 'image') {
    enveloppe.apercu = binaire.construireApercu(extension, tamponGauche, tamponDroite);
  }
}

/**
 * Construit l'enveloppe de comparaison d'un fichier de la dernière analyse.
 * Partagée entre l'affichage du diff et le rafraîchissement après une édition
 * dans l'éditeur intégré.
 */
async function construireDiff(fichier, actuels, surcharges = {}) {
  const extensionTexte = actuels.extensionsTexte.includes(fichier.extension);
  // Le renderer peut demander, pour un fichier, de neutraliser les blancs sans
  // toucher au réglage global : un choix de lecture, pas de configuration.
  const ignorerEspaces =
    typeof surcharges.ignorerEspaces === 'boolean'
      ? surcharges.ignorerEspaces
      : actuels.options.ignorerEspaces;

  // Le scan connaît déjà les tailles : un fichier au-delà de la limite du
  // comparateur est refusé avant d'être lu, pas après deux lectures complètes
  // (un journal de 300 Mo passait deux fois en mémoire pour être refusé).
  const plusGros = Math.max(fichier.local ? fichier.local.taille : 0, fichier.prod ? fichier.prod.taille : 0);
  // Une image ou un média au-delà de la limite du diff texte mérite quand même
  // d'être lu : son aperçu remplace le refus. `completerBinaire` fera le
  // reclassement ; ici on décide seulement de lire ou non.
  const previsualisable = Boolean(binaire.genreApercu(fichier.extension)) && plusGros <= binaire.TAILLE_MAX_APERCU;
  if (plusGros > textdiff.TAILLE_MAX_DIFF && !previsualisable) {
    return {
      cle: fichier.cle,
      chemin: fichier.chemin,
      statut: fichier.statut,
      ignorerEspaces,
      local: fichier.local && { ...fichier.local, hash: fichier.local.hash || null },
      prod: fichier.prod && { ...fichier.prod, hash: fichier.prod.hash || null },
      type: 'volumineux',
      limite: textdiff.TAILLE_MAX_DIFF,
      taille: plusGros
    };
  }

  const lire = async (cote) => {
    if (!cote) return null;
    try {
      return await fsp.readFile(fsindex.cheminLong(cote.absolu));
    } catch (err) {
      throw Object.assign(new Error(fsindex.raisonLisible(err)), { code: err.code, chemin: cote.absolu });
    }
  };

  const [tamponProd, tamponLocal] = await Promise.all([lire(fichier.prod), lire(fichier.local)]);

  const resultat = textdiff.comparerTampons(tamponProd, tamponLocal, {
    ignorerEspaces,
    extensionTexte
  });

  const enveloppe = {
    cle: fichier.cle,
    chemin: fichier.chemin,
    statut: fichier.statut,
    ignorerEspaces,
    local: fichier.local && { ...fichier.local, hash: fichier.local.hash || null },
    prod: fichier.prod && { ...fichier.prod, hash: fichier.prod.hash || null },
    ...resultat
  };

  if (resultat.type === 'texte') {
    enveloppe.groupes = textdiff.grouper(resultat.lignes);
    delete enveloppe.lignes;
  }
  completerBinaire(enveloppe, fichier.extension, tamponProd, tamponLocal, {
    gauche: fichier.prod ? fichier.prod.mtimeMs : null,
    droite: fichier.local ? fichier.local.mtimeMs : null
  });

  return enveloppe;
}

function handlersDiff() {
  gerer('fichier:diff', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) {
      return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');
    }

    try {
      const surcharges =
        typeof parametres.ignorerEspaces === 'boolean' ? { ignorerEspaces: parametres.ignorerEspaces } : {};
      return succes({ diff: await construireDiff(fichier, reglages(), surcharges) });
    } catch (err) {
      return echec(
        `Fichier illisible (${err.message}) : ${err.chemin || fichier.chemin}`,
        'Le fichier a peut-être été déplacé ou verrouillé depuis l\'analyse. Relancez une analyse.',
        err
      );
    }
  });

  // -- Éditeur intégré ------------------------------------------------------
  //
  // La seule écriture de l'application qui ne soit pas une copie binaire :
  // elle ne touche qu'au fichier LOCAL désigné par la dernière analyse, jamais
  // à la production ni aux archives. Le fichier ressort dans son enveloppe
  // d'origine - encodage, BOM, fins de ligne - comme s'il avait été modifié
  // dans l'éditeur du poste.

  gerer('fichier:lireLocal', async (parametres) => {
    const controle = fichierEditable(String(parametres.cle || ''));
    if (controle.erreur) return controle.erreur;
    const { fichier } = controle;

    let tampon;
    try {
      tampon = await fsp.readFile(fsindex.cheminLong(fichier.local.absolu));
    } catch (err) {
      return echec(
        `Fichier illisible (${fsindex.raisonLisible(err)}) : ${fichier.local.absolu}`,
        'Le fichier a peut-être été déplacé ou verrouillé depuis l\'analyse. Relancez une analyse.',
        err
      );
    }

    if (textdiff.estBinaire(tampon)) {
      return echec(
        'Ce fichier contient des octets nuls : il ne s\'édite pas comme du texte.',
        'Ouvrez-le avec le programme qui sait le manipuler.'
      );
    }

    const decodage = textdiff.decoder(tampon);
    const empreinte = await empreinteSure(fichier.local.absolu);
    return succes({
      chemin: fichier.chemin,
      texte: decodage.texte,
      encodage: decodage.encodage,
      finDeLigne: decodage.finDeLigne,
      empreinte,
      taille: tampon.length
    });
  });

  gerer('fichier:enregistrerLocal', async (parametres) => {
    const controle = fichierEditable(String(parametres.cle || ''));
    if (controle.erreur) return controle.erreur;
    const { fichier } = controle;
    const actuels = reglages();
    const absolu = fichier.local.absolu;

    // Le fichier est relu au moment d'écrire : son enveloppe (encodage, BOM,
    // fins de ligne) est redétectée sur l'état réel du disque, et une
    // modification faite entre-temps par un autre programme bloque
    // l'enregistrement au lieu d'être écrasée sans un mot.
    let tamponActuel;
    try {
      tamponActuel = await fsp.readFile(fsindex.cheminLong(absolu));
    } catch (err) {
      return echec(
        `Le fichier ne se laisse plus lire (${fsindex.raisonLisible(err)}) : ${absolu}`,
        'Il a peut-être été déplacé ou supprimé depuis l\'ouverture de l\'éditeur. Relancez une analyse.',
        err
      );
    }
    const empreinteActuelle = await empreinteSure(absolu);
    if (parametres.empreinte && empreinteActuelle && parametres.empreinte !== empreinteActuelle) {
      return echec(
        'Le fichier a changé sur le disque depuis l\'ouverture de l\'éditeur.',
        'Un autre programme l\'a modifié entre-temps. Fermez l\'éditeur, relancez une analyse et rouvrez-le : enregistrer maintenant écraserait ces modifications.'
      );
    }

    const detection = textdiff.detecterEncodage(tamponActuel);
    const finDeLigne = textdiff.detecterFinDeLigne(textdiff.decoder(tamponActuel).texte);
    const { tampon, caracteresPerdus } = textdiff.encoder(String(parametres.texte || ''), {
      codec: detection.codec,
      bom: detection.bom,
      finDeLigne
    });
    if (!tampon) {
      return echec(
        `Ce fichier est en Windows-1252, et ${caracteresPerdus.length > 1 ? 'ces caractères n\'y existent pas' : 'ce caractère n\'y existe pas'} : ${caracteresPerdus.map((c) => '« ' + c + ' »').join(' ')}`,
        'Retirez-les ou remplacez-les par leur équivalent ANSI : l\'outil n\'écrit jamais de « ? » à la place, et ne change jamais l\'encodage d\'un fichier.'
      );
    }

    // Écriture atomique : le fichier d'origine reste intact tant que la
    // nouvelle version n'est pas complète sur le disque.
    const temporaire = absolu + '.avmdf-tmp';
    try {
      await fsp.writeFile(fsindex.cheminLong(temporaire), tampon);
      await fsp.rename(fsindex.cheminLong(temporaire), fsindex.cheminLong(absolu));
    } catch (err) {
      await fsp.unlink(fsindex.cheminLong(temporaire)).catch(() => {});
      return echec(
        `Enregistrement impossible (${fsindex.raisonLisible(err)}) : ${absolu}`,
        'Vérifiez que le fichier n\'est pas verrouillé par un autre programme et que le dossier est accessible en écriture.',
        err
      );
    }

    // L'analyse en mémoire suit : taille, date, empreinte et statut du fichier
    // sont recalculés sur ce qui vient d'être écrit, sans relire tout l'arbre.
    cacheHash.invalider(absolu);
    const etat = await fsp.stat(fsindex.cheminLong(absolu));
    const hashLocal = await empreinteSure(absolu);
    fichier.local.taille = etat.size;
    fichier.local.mtimeMs = etat.mtimeMs;
    fichier.local.hash = hashLocal;

    if (!fichier.prod) {
      fichier.statut = compare.NOUVEAU;
    } else if (fichier.prod.taille !== etat.size) {
      fichier.statut = compare.MODIFIE;
    } else {
      const hashProd =
        fichier.prod.hash ||
        (await cacheHash.obtenir(fichier.prod.absolu, fichier.prod.taille, fichier.prod.mtimeMs).catch(() => null));
      fichier.prod.hash = hashProd;
      fichier.statut = hashProd && hashProd === hashLocal ? compare.IDENTIQUE : compare.MODIFIE;
    }
    dernierScan.compteurs = compare.compter(dernierScan.fichiers);
    cacheHash.enregistrer();
    invaliderReferences();

    carnet.ecrire('INFO', `fichier local enregistré depuis l'éditeur : ${fichier.chemin} (${etat.size} octets)`);

    let diff = null;
    try {
      diff = await construireDiff(fichier, actuels);
    } catch (err) {
      /* le diff se rechargera à la demande ; l'enregistrement, lui, est fait */
    }

    return succes({
      chemin: fichier.chemin,
      statut: fichier.statut,
      empreinte: hashLocal,
      analyse: pourLeRenderer(dernierScan),
      diff
    });
  });

  gerer('fichier:versions', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) {
      return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');
    }
    const actuels = reglages();
    const { versions, erreur } = await avmdf.versionsArchivees(actuels.racines.avmdf, fichier.chemin, {
      concurrence: actuels.options.lecturesSimultanees
    });
    if (erreur) return echec(erreur, 'Vérifiez la racine des archives dans les réglages.');
    return succes({ chemin: fichier.chemin, statut: fichier.statut, versions });
  });

  gerer('fichier:comparerVersion', async (parametres) => {
    const actuels = reglages();
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');

    const source = String(parametres.cheminVersion || '');
    if (!avmdf.estSousRacine(source, actuels.racines.avmdf)) {
      return echec(
        'Cette version est hors du dossier d\'archives.',
        'Rouvrez la liste des versions pour repartir du contenu réel.'
      );
    }

    const lire = async (chemin) => {
      if (!chemin) return null;
      try {
        return await fsp.readFile(fsindex.cheminLong(chemin));
      } catch (err) {
        return null;
      }
    };
    const cheminProd = fsindex.joindreRelatif(dernierScan.cheminProd, fichier.chemin);
    const [archive, actuel] = await Promise.all([lire(source), lire(cheminProd)]);
    if (!archive) {
      return echec(
        'Version archivée illisible : ' + source,
        'Le fichier a peut-être été déplacé dans le dossier d\'archives.'
      );
    }

    const resultat = textdiff.comparerTampons(archive, actuel, {
      ignorerEspaces: actuels.options.ignorerEspaces,
      extensionTexte: actuels.extensionsTexte.includes(fichier.extension)
    });
    const enveloppe = {
      cle: fichier.cle,
      chemin: fichier.chemin,
      statut: fichier.statut,
      titreGauche: 'Version archivée',
      titreDroite: 'Production actuelle',
      ...resultat
    };
    if (resultat.type === 'texte') {
      enveloppe.groupes = textdiff.grouper(resultat.lignes);
      delete enveloppe.lignes;
    }
    let dates = {};
    if (resultat.type !== 'texte') {
      const [dateArchive, dateProd] = await Promise.all([dateModification(source), dateModification(cheminProd)]);
      dates = { gauche: dateArchive, droite: dateProd };
    }
    completerBinaire(enveloppe, fichier.extension, archive, actuel, dates);
    return succes({ diff: enveloppe });
  });

  gerer('fichier:restaurerVersion', (parametres) => exclusif('une restauration de version', async () => {
    const actuels = reglages();
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    if (dernierScan.modeLibre) {
      return echec(
        'La comparaison libre ne permet pas de restaurer une version.',
        'Revenez à un projet configuré.'
      );
    }
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');

    const source = String(parametres.cheminVersion || '');
    if (!avmdf.estSousRacine(source, actuels.racines.avmdf)) {
      return echec('Cette version est hors du dossier d\'archives.', 'Rouvrez la liste des versions.');
    }

    const demande = avmdf.normaliserDemande(parametres.demande);
    if (!demande) {
      return echec(
        'Aucune destination d\'archivage choisie.',
        'Choisissez une demande et un sprint dans le bandeau du bas : la version actuelle doit être archivée avant d\'être remplacée.'
      );
    }
    const destination = avmdf.resoudreDestination(actuels.racines.avmdf, demande.nom, parametres.sprint);
    if (!destination.valide) return echec(destination.erreur, 'Corrigez le nom du dossier de sprint.');

    const plan = {
      projet: dernierScan.projet || '(dossiers libres)',
      racineLocale: dernierScan.cheminLocal,
      racineProd: dernierScan.cheminProd,
      racineAvmdf: actuels.racines.avmdf,
      dossierSauvegarde: destination.chemin,
      demande: demande.nom,
      sprint: parametres.sprint.trim(),
      auteur: actuels.options.auteur,
      simulation: Boolean(parametres.simulation),
      chemin: fichier.chemin,
      source
    };

    carnet.ecrire(
      'ALERTE',
      `${plan.simulation ? 'simulation de ' : ''}restauration de version : ${fichier.chemin} depuis ${source}`
    );
    const resultat = await deploy.restaurerVersion(plan, {
      invaliderCache: (chemin) => cacheHash.invalider(chemin),
      dossierSecours: path.join(app.getPath('userData'), 'manifestes-secours')
    });
    cacheHash.enregistrer();
    if (!plan.simulation) {
      invaliderManifestes();
      invaliderReferences();
    }

    if (resultat.manifeste.fichiers[0].erreur) {
      return Object.assign(
        echec(
          'Restauration impossible : ' + resultat.manifeste.fichiers[0].erreur,
          resultat.problemes.length ? resultat.problemes[0].conseil : 'Relancez une analyse et réessayez.'
        ),
        { problemes: resultat.problemes }
      );
    }
    carnet.ecrire('INFO', `restauration de version terminée : ${fichier.chemin}`);
    journaliserTraces(resultat.chemins);
    return succes({ manifeste: resultat.manifeste, chemins: resultat.chemins, rapport: resultat.rapport });
  }));
}

async function empreinteSure(chemin) {
  try {
    return await fsindex.hashFichier(chemin);
  } catch (err) {
    return null;
  }
}

/**
 * Le fichier peut-il passer par l'éditeur intégré ? Il doit venir de la
 * dernière analyse, exister côté local, être d'une extension texte et rester
 * sous la taille affichable. La production et les archives ne s'éditent
 * jamais : l'éditeur ne connaît que le côté local.
 */
function fichierEditable(cle) {
  if (!dernierScan) {
    return { erreur: echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.') };
  }
  const fichier = dernierScan.parCle.get(cle);
  if (!fichier) {
    return { erreur: echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.') };
  }
  if (!fichier.local) {
    return {
      erreur: echec(
        'Ce fichier n\'existe qu\'en production : il n\'y a rien à éditer en local.',
        'L\'éditeur ne modifie que les sources locales, jamais la production.'
      )
    };
  }
  if (!avmdf.estSousRacine(fichier.local.absolu, dernierScan.cheminLocal)) {
    return { erreur: echec('Ce fichier est hors du dossier analysé.', 'Relancez une analyse.') };
  }
  const actuels = reglages();
  if (!actuels.extensionsTexte.includes(fichier.extension)) {
    return {
      erreur: echec(
        'Cette extension n\'est pas dans la liste des extensions texte.',
        'Ajoutez-la dans les réglages si ce fichier est bien du texte, ou ouvrez-le avec son programme.'
      )
    };
  }
  if (fichier.local.taille > textdiff.TAILLE_MAX_DIFF) {
    return {
      erreur: echec(
        'Fichier trop volumineux pour l\'éditeur intégré.',
        'Ouvrez-le dans votre éditeur habituel : clic droit, « Ouvrir la version locale ».'
      )
    };
  }
  return { fichier };
}

// ---------------------------------------------------------------------------
// Références : qui utilise ce fichier
// ---------------------------------------------------------------------------

function handlersReferences() {
  gerer('references:analyser', () => exclusif('une analyse des références', async () => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');

    const actuels = reglages();
    const signal = fsindex.creerSignal();
    referencesEnCours = signal;
    const debut = Date.now();
    try {
      const index = await references.construireIndex(dernierScan.fichiers, {
        extensionsTexte: actuels.extensionsTexte,
        concurrence: actuels.options.lecturesSimultanees,
        signal,
        surProgression: (avancement) => emettre('references:progression', avancement)
      });
      if (signal.annule) return succes({ annule: true });

      dernieresReferences = { scan: dernierScan, index, date: Date.now() };
      carnet.ecrire(
        'INFO',
        `références analysées : ${index.examines} fichier(s) lus, ${index.ignores} ignoré(s), en ` +
          `${Math.round((Date.now() - debut) / 1000)} s`
      );
      return succes({
        annule: false,
        compteurs: [...index.compteurs],
        examines: index.examines,
        ignores: index.ignores,
        dureeMs: Date.now() - debut
      });
    } finally {
      referencesEnCours = null;
    }
  }));

  gerer('references:annuler', () => {
    if (referencesEnCours) referencesEnCours.annuler();
    return succes({});
  });

  gerer('references:fichier', (parametres) => {
    if (!dernieresReferences || dernieresReferences.scan !== dernierScan) {
      return echec(
        'L\'index des références n\'est plus à jour.',
        'Relancez l\'analyse des références : un contenu a changé depuis.'
      );
    }
    const cle = String(parametres.cle || '');
    return succes({
      utilisePar: dernieresReferences.index.parCible.get(cle) || [],
      utilise: dernieresReferences.index.parSource.get(cle) || []
    });
  });
}

// ---------------------------------------------------------------------------
// AVMDF
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Frise chronologique d'un fichier
// ---------------------------------------------------------------------------

/**
 * L'histoire complète d'un fichier, racontée par ce que l'outil a réellement
 * écrit : chaque passage en production lu dans les manifestes (demande,
 * sprint, auteur, action, lignes), et chaque version archivée, y compris
 * celles de l'ancienne organisation qui n'ont pas de manifeste.
 *
 * La frise ne dépend pas de l'analyse en mémoire : un chemin suffit, elle
 * s'ouvre donc aussi depuis le tableau de bord.
 */
function handlersFrise() {
  gerer('frise:fichier', async (parametres) => {
    const actuels = reglages();
    const chemin = String(parametres.chemin || '').trim();
    if (!chemin) return echec('Aucun chemin fourni.', 'Rouvrez la frise depuis un fichier.');

    const [reponseVersions, cache] = await Promise.all([
      avmdf.versionsArchivees(actuels.racines.avmdf, chemin, {
        concurrence: actuels.options.lecturesSimultanees
      }),
      listerManifestesEnCache(actuels)
    ]);

    const cle = chemin.toLowerCase();
    const evenements = [];

    for (const manifeste of cache.manifestes) {
      const entree = (manifeste.fichiers || []).find(
        (f) => String(f.chemin || '').toLowerCase() === cle
      );
      if (!entree) continue;
      evenements.push({
        type: 'passage',
        date: manifeste.date || null,
        operation: manifeste.operation || 'deploiement',
        demande: manifeste.demande || null,
        sprint: manifeste.sprint || null,
        projet: manifeste.projet || null,
        auteur: manifeste.auteur || null,
        commentaire: manifeste.commentaire || null,
        action: entree.action || null,
        erreur: entree.erreur || null,
        lignesAjoutees: typeof entree.lignesAjoutees === 'number' ? entree.lignesAjoutees : null,
        lignesSupprimees: typeof entree.lignesSupprimees === 'number' ? entree.lignesSupprimees : null,
        tailleApres: typeof entree.tailleApres === 'number' ? entree.tailleApres : null,
        sansArchive: Boolean(entree.sansArchive),
        version:
          entree.sauvegarde && manifeste.dossierSauvegarde
            ? fsindex.joindreRelatif(manifeste.dossierSauvegarde, entree.sauvegarde)
            : null,
        manifeste: manifeste.chemin || null
      });
    }

    // Les versions archivées que les manifestes ne racontent pas : ancienne
    // organisation, ou manifeste perdu. Elles comptent quand même.
    const versionsRacontees = new Set(
      evenements.map((e) => String(e.version || '').toLowerCase()).filter(Boolean)
    );
    for (const version of reponseVersions.versions || []) {
      if (versionsRacontees.has(String(version.chemin).toLowerCase())) continue;
      evenements.push({
        type: 'archive',
        date: version.date || (version.mtimeMs ? new Date(version.mtimeMs).toISOString() : null),
        operation: null,
        demande: version.demande || null,
        sprint: version.sprint || null,
        projet: null,
        auteur: version.auteur || null,
        commentaire: null,
        action: version.action || null,
        erreur: null,
        lignesAjoutees: null,
        lignesSupprimees: null,
        tailleApres: typeof version.taille === 'number' ? version.taille : null,
        sansArchive: false,
        version: version.chemin,
        manifeste: version.manifeste || null
      });
    }

    evenements.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    return succes({
      frise: {
        chemin,
        evenements,
        erreurs: [...(cache.erreurs || []), ...(reponseVersions.erreur ? [reponseVersions.erreur] : [])]
      }
    });
  });
}

function handlersAvmdf() {
  gerer('avmdf:demandes', async () => {
    const actuels = reglages();
    const { demandes, erreur } = await avmdf.listerDemandes(actuels.racines.avmdf);
    if (erreur) {
      return echec(erreur, 'Vérifiez la racine des archives dans les réglages.');
    }
    // AVMDFMINEUR n'est pas une demande à choisir : on y arrive en décochant
    // « Archiver », jamais par le panneau de destination.
    return succes({ demandes: demandes.filter((d) => !d.mineure), racine: actuels.racines.avmdf });
  });

  gerer('avmdf:inspecter', async (parametres) => {
    const actuels = reglages();
    const demande = avmdf.normaliserDemande(parametres.demande);
    if (!demande) {
      return echec(
        'Numéro de demande incompréhensible.',
        'Saisissez un numéro seul (4611) ou un nom complet (AVMDF4611).'
      );
    }
    const cheminDemande = path.join(actuels.racines.avmdf, demande.nom);
    const inspection = await avmdf.inspecterDemande(cheminDemande, demande.nom);
    return succes({ demande: { ...demande, chemin: cheminDemande }, inspection });
  });

  gerer('avmdf:inspecterSprint', async (parametres) => {
    const actuels = reglages();
    const destination = avmdf.resoudreDestination(
      actuels.racines.avmdf,
      parametres.demande,
      parametres.sprint
    );
    if (!destination.valide) return echec(destination.erreur, 'Corrigez le nom du dossier de sprint.');

    const demande = avmdf.normaliserDemande(parametres.demande);
    const inspection = await avmdf.inspecterDemande(
      path.join(actuels.racines.avmdf, demande.nom),
      demande.nom
    );
    const etat = await avmdf.inspecterSprint(destination.chemin);
    return succes({
      chemin: destination.chemin,
      etat,
      convention: inspection.convention,
      compatible: avmdf.verifierConvention(inspection.convention, demande.nom, parametres.sprint.trim())
    });
  });

  gerer('avmdf:creerDemande', async (parametres) => {
    const actuels = reglages();
    const demande = avmdf.normaliserDemande(parametres.demande);
    if (!demande) return echec('Numéro de demande incompréhensible.', 'Saisissez un numéro, par exemple 4611.');
    const cheminDemande = path.join(actuels.racines.avmdf, demande.nom);
    if (!avmdf.estSousRacine(cheminDemande, actuels.racines.avmdf)) {
      return echec('Destination hors du dossier d\'archives.', 'Vérifiez la racine AVMDF dans les réglages.');
    }
    try {
      await fsp.mkdir(fsindex.cheminLong(cheminDemande), { recursive: true });
      carnet.ecrire('INFO', `demande créée : ${cheminDemande}`);
      return succes({ demande: { ...demande, chemin: cheminDemande } });
    } catch (err) {
      return echec(
        `Création de la demande impossible (${fsindex.raisonLisible(err)}) : ${cheminDemande}`,
        'Vérifiez vos droits sur le dossier d\'archives.',
        err
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Mise en production
// ---------------------------------------------------------------------------

/** Construit le plan à partir des clés désignées par le renderer. */
function construirePlan(parametres) {
  const actuels = reglages();
  if (!dernierScan) {
    return { erreur: echec('Aucune analyse en mémoire.', 'Lancez une analyse avant de déployer.') };
  }
  if (dernierScan.modeLibre) {
    return {
      erreur: echec(
        'La comparaison libre ne permet pas de mise en production.',
        'Revenez à un projet configuré : l\'archivage AVMDF a besoin des racines de production.'
      )
    };
  }

  const cles = Array.isArray(parametres.cles) ? parametres.cles : [];
  const fichiers = cles.map((cle) => dernierScan.parCle.get(cle)).filter(Boolean);
  if (!fichiers.length) {
    return { erreur: echec('Aucun fichier sélectionné.', 'Cochez au moins un fichier dans l\'arborescence.') };
  }

  const operation = parametres.operation === deploy.OPERATION_SUPPRESSION
    ? deploy.OPERATION_SUPPRESSION
    : deploy.OPERATION_DEPLOIEMENT;

  const mauvaisStatut = fichiers.filter((fichier) =>
    operation === deploy.OPERATION_SUPPRESSION
      ? fichier.statut !== compare.ORPHELIN
      : !compare.DEPLOYABLES.has(fichier.statut)
  );
  if (mauvaisStatut.length) {
    return {
      erreur: echec(
        `${mauvaisStatut.length} fichier(s) sélectionnés ne correspondent pas à cette opération.`,
        'Relancez une analyse : la sélection ne colle plus aux statuts relevés.'
      )
    };
  }

  // L'archivage se fait toujours : le défaut n'est jamais la perte de l'état
  // antérieur, et depuis la 2.2.0 le renoncement à la demande n'y change rien.
  //
  // La case décochée signifie « sans numéro de demande », pas « sans trace » :
  // le passage est dit mineur, la version écrasée et le manifeste partent dans
  // AVMDFMINEUR sous un sous-dossier horodaté. Il reste donc réversible,
  // visible dans l'historique et compté au tableau de bord.
  const mineur = parametres.archiver === false;

  const demande = avmdf.normaliserDemande(parametres.demande);

  let destination = null;
  let nomDemande = null;
  let nomSprint = null;
  if (!mineur) {
    if (!demande) {
      return { erreur: echec('Aucune demande choisie.', 'Choisissez ou créez une demande AVMDF dans le panneau de destination.') };
    }
    nomDemande = demande.nom;
    nomSprint = String(parametres.sprint || '').trim();
    destination = avmdf.resoudreDestination(actuels.racines.avmdf, nomDemande, nomSprint);
    if (!destination.valide) {
      return { erreur: echec(destination.erreur, 'Corrigez le nom du dossier de sprint.') };
    }
  } else {
    // Le sous-dossier horodaté est figé au préflight : l'exécution renvoie le
    // même nom pour que la confirmation montre exactement ce qui sera écrit
    // (et pour que le préflight réutilisé garde sa signature).
    nomDemande = avmdf.DEMANDE_MINEURE;
    nomSprint = avmdf.MOTIF_PASSAGE_MINEUR.test(String(parametres.sprint || '').trim())
      ? String(parametres.sprint).trim()
      : avmdf.nomPassageMineur(new Date());
    destination = avmdf.resoudreDestination(actuels.racines.avmdf, nomDemande, nomSprint);
    if (!destination.valide) {
      return { erreur: echec(destination.erreur, 'Vérifiez la racine des archives dans les réglages.') };
    }
  }

  return {
    plan: {
      projet: dernierScan.projet || '(dossiers libres)',
      racineLocale: dernierScan.cheminLocal,
      racineProd: dernierScan.cheminProd,
      racineAvmdf: actuels.racines.avmdf,
      demande: nomDemande,
      sprint: nomSprint,
      dossierSauvegarde: destination.chemin,
      auteur: actuels.options.auteur,
      simulation: Boolean(parametres.simulation),
      archiver: true,
      mineur,
      operation,
      // Une phrase au plus : le commentaire explique le passage, il ne raconte
      // pas le sprint.
      commentaire: String(parametres.commentaire || '').trim().slice(0, 600) || null,
      appOffline: actuels.options.appOffline,
      fichiers
    },
    actuels
  };
}

function handlersDeploiement() {
  gerer('deploiement:preflight', async (parametres) => {
    const { plan, erreur, actuels } = construirePlan(parametres);
    if (erreur) return erreur;

    const signal = fsindex.creerSignal();
    preflightEnCours = signal;
    try {
      const controle = await deploy.preflight(plan, {
        concurrence: actuels.options.lecturesSimultanees,
        signal,
        surProgression: (avancement) => emettre('deploiement:progression', avancement)
      });
      if (!signal.annule && !plan.simulation) {
        const tfsAvertissement = await avertissementTfsFront(plan);
        if (tfsAvertissement) {
          controle.problemes.push(tfsAvertissement);
          controle.avertissements.push(tfsAvertissement);
        }
      }

      // Le résultat vaut jeton : si le plan n'a pas bougé, l'exécution le
      // réutilisera au lieu de relire toute la production une seconde fois.
      let jeton = null;
      if (!signal.annule) {
        jeton = `pf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        dernierPreflight = {
          jeton,
          signature: signaturePlan(plan),
          scan: dernierScan,
          date: Date.now(),
          controle
        };
      }

      return succes({
        jeton,
        controle: {
          ok: controle.ok,
          bloquants: controle.bloquants,
          avertissements: controle.avertissements
        },
        resume: resumePlan(plan)
      });
    } finally {
      preflightEnCours = null;
    }
  });

  gerer('deploiement:executer', (parametres) => exclusif('une mise en production', async () => {
    const { plan, erreur, actuels } = construirePlan(parametres);
    if (erreur) return erreur;

    // Le préflight qui vient d'être montré à l'utilisateur vaut pour
    // l'exécution, tant que le plan et l'analyse n'ont pas bougé et que
    // l'attente est restée courte. Sinon, il est rejoué : entre la fenêtre de
    // confirmation et le clic, la production a pu bouger.
    const reutilisable =
      dernierPreflight &&
      parametres.jetonPreflight === dernierPreflight.jeton &&
      dernierPreflight.scan === dernierScan &&
      dernierPreflight.signature === signaturePlan(plan) &&
      Date.now() - dernierPreflight.date < DUREE_JETON_PREFLIGHT &&
      dernierPreflight.controle.ok;
    const controle = reutilisable
      ? dernierPreflight.controle
      : await deploy.preflight(plan, { concurrence: actuels.options.lecturesSimultanees });
    if (!controle.ok) {
      return Object.assign(
        echec(
          'Mise en production interrompue : ' + controle.bloquants.length + ' point(s) bloquant(s).',
          'Corrigez-les puis relancez une analyse.'
        ),
        { controle: { ok: false, bloquants: controle.bloquants, avertissements: controle.avertissements } }
      );
    }

    const signal = fsindex.creerSignal();
    operationEnCours = signal;
    carnet.ecrire(
      'INFO',
      `${plan.simulation ? 'simulation' : 'mise en production'} : ${plan.fichiers.length} fichier(s) ` +
        `vers ${plan.racineProd} (${plan.operation})` +
        (plan.dossierSauvegarde ? ` - archives ${plan.dossierSauvegarde}` : '') +
        (plan.mineur ? ' - passage mineur, sans numéro de demande' : '')
    );

    try {
      const resultat = await deploy.executer(plan, {
        signal,
        extensionsTexte: actuels.extensionsTexte,
        ignorerEspaces: actuels.options.ignorerEspaces,
        invaliderCache: (chemin) => cacheHash.invalider(chemin),
        surProgression: (avancement) => emettre('deploiement:progression', avancement),
        // Les empreintes relevées par le préflight servent au manifeste : pas de
        // troisième lecture complète de chaque destination.
        etatsProd: controle.etatsProd || null,
        dossierSecours: path.join(app.getPath('userData'), 'manifestes-secours')
      });
      cacheHash.enregistrer();
      dernierPreflight = null;
      if (!plan.simulation) {
        invaliderManifestes();
        invaliderReferences();
      }

      const r = resultat.rapport;
      carnet.ecrire(
        r.echecs ? 'ERREUR' : 'INFO',
        `${plan.simulation ? 'simulation' : 'mise en production'} terminée - ` +
          `${r.remplacements} remplacé(s), ${r.creations} créé(s), ${r.suppressions} supprimé(s), ` +
          `${r.echecs} échec(s)` +
          (resultat.chemins.manifeste ? ` - manifeste ${resultat.chemins.manifeste}` : '')
      );
      const appOffline = resultat.manifeste.appOffline;
      if (appOffline && appOffline.erreurDepot) {
        carnet.ecrire('ALERTE', `app_offline.htm non déposé, le site est resté en ligne pendant la copie : ${appOffline.erreurDepot}`);
      }
      if (appOffline && appOffline.erreurRetrait) {
        carnet.ecrire('ERREUR', `app_offline.htm NON RETIRÉ, le site est resté hors service : ${appOffline.erreurRetrait} - retirez-le à la main dans ${plan.racineProd}`);
      }
      journaliserTraces(resultat.chemins);

      // L'arborescence se remet à jour toute seule : les fichiers partis
      // passent en « identique », les orphelins supprimés disparaissent.
      const analyse = rafraichirScan(resultat.manifeste) ? pourLeRenderer(dernierScan) : null;

      return succes({
        manifeste: resultat.manifeste,
        chemins: resultat.chemins,
        rapport: resultat.rapport,
        avertissements: controle.avertissements,
        analyse
      });
    } finally {
      operationEnCours = null;
    }
  }));

  gerer('deploiement:annuler', () => {
    if (preflightEnCours) preflightEnCours.annuler();
    if (operationEnCours) operationEnCours.annuler();
    return succes({});
  });
}

function resumePlan(plan) {
  const parStatut = { modifie: 0, nouveau: 0, orphelin: 0 };
  let octets = 0;
  for (const fichier of plan.fichiers) {
    if (parStatut[fichier.statut] !== undefined) parStatut[fichier.statut] += 1;
    if (fichier.local) octets += fichier.local.taille;
  }
  return {
    projet: plan.projet,
    demande: plan.demande,
    sprint: plan.sprint,
    dossierSauvegarde: plan.dossierSauvegarde,
    racineLocale: plan.racineLocale,
    racineProd: plan.racineProd,
    auteur: plan.auteur,
    operation: plan.operation,
    simulation: plan.simulation,
    archiver: plan.archiver,
    mineur: Boolean(plan.mineur),
    parStatut,
    octets,
    fichiers: plan.fichiers.map((fichier) => ({
      chemin: fichier.chemin,
      statut: fichier.statut,
      taille: fichier.local ? fichier.local.taille : fichier.prod ? fichier.prod.taille : 0
    }))
  };
}

// ---------------------------------------------------------------------------
// Historique et retour arrière
// ---------------------------------------------------------------------------

function handlersHistorique() {
  gerer('historique:lister', async (parametres = {}) => {
    const actuels = reglages();
    const { manifestes, erreurs } = await listerManifestesEnCache(actuels, Boolean(parametres.rafraichir));
    return succes({ manifestes, erreurs, racine: actuels.racines.avmdf });
  });

  gerer('statistiques:calculer', async (parametres = {}) => {
    const actuels = reglages();
    const { manifestes, erreurs } = await listerManifestesEnCache(actuels, Boolean(parametres.rafraichir));
    // Le tableau de bord suit l'espace choisi : les passages du front d'un
    // côté, ceux des WebServices de l'autre.
    const retenus =
      parametres.espace === 'ws'
        ? manifestes.filter((m) => m.type === 'webservice')
        : parametres.espace === 'front'
          ? manifestes.filter((m) => m.type !== 'webservice')
          : manifestes;
    return succes({
      espace: parametres.espace || null,
      stats: stats.calculer(retenus),
      erreurs,
      racine: actuels.racines.avmdf
    });
  });

  gerer('historique:comparer', async (parametres) => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;

    const entree = manifeste.contenu.fichiers.find((f) => f.chemin === parametres.chemin);
    if (!entree) return echec('Ce fichier ne figure pas dans le manifeste.', 'Rechargez l\'historique.');

    const cheminSauvegarde = entree.sauvegarde
      ? fsindex.joindreRelatif(manifeste.contenu.dossierSauvegarde, entree.sauvegarde)
      : null;
    const cheminProd = fsindex.joindreRelatif(manifeste.contenu.racineProd, entree.chemin);

    const lire = async (chemin) => {
      if (!chemin) return null;
      try {
        return await fsp.readFile(fsindex.cheminLong(chemin));
      } catch (err) {
        return null;
      }
    };

    const [sauvegarde, actuel] = await Promise.all([lire(cheminSauvegarde), lire(cheminProd)]);
    const extension = path.extname(entree.chemin).toLowerCase();
    const resultat = textdiff.comparerTampons(sauvegarde, actuel, {
      ignorerEspaces: actuels.options.ignorerEspaces,
      extensionTexte: actuels.extensionsTexte.includes(extension)
    });

    const enveloppe = {
      cle: entree.chemin.toLowerCase(),
      chemin: entree.chemin,
      statut: 'modifie',
      titreGauche: 'Sauvegarde',
      titreDroite: 'Production actuelle',
      absent: { sauvegarde: !sauvegarde, prod: !actuel },
      ...resultat
    };
    if (resultat.type === 'texte') {
      enveloppe.groupes = textdiff.grouper(resultat.lignes);
      delete enveloppe.lignes;
    }
    let dates = {};
    if (resultat.type !== 'texte') {
      const [dateSauvegarde, dateProd] = await Promise.all([
        dateModification(cheminSauvegarde),
        dateModification(cheminProd)
      ]);
      dates = { gauche: dateSauvegarde, droite: dateProd };
    }
    completerBinaire(enveloppe, extension, sauvegarde, actuel, dates);
    return succes({ diff: enveloppe });
  });

  // Confronte la production actuelle à un manifeste : rien n'est écrit, tout
  // est lu. C'est le contrôle « ma prod est-elle toujours celle que j'ai
  // livrée ? », depuis l'historique ou juste après un passage.
  gerer('historique:verifierProduction', async (parametres) => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;
    if (manifeste.contenu.simulation) {
      return echec(
        'Ce manifeste vient d\'une simulation : rien n\'a été écrit, il n\'y a rien à vérifier.',
        'Choisissez un passage réel.'
      );
    }

    const verification = await deploy.verifierManifeste(manifeste.contenu, {
      concurrence: actuels.options.lecturesSimultanees
    });
    const r = verification.resume;
    carnet.ecrire(
      r.conformes === r.total ? 'INFO' : 'ALERTE',
      `vérification production (${manifeste.contenu.demande || 'sans demande'} / ${manifeste.contenu.sprint || '-'}) : ` +
        `${r.conformes}/${r.total} intact(s), ${r.modifies} modifié(s) depuis, ${r.absents} absent(s), ` +
        `${r.reapparus} réapparu(s), ${r.inverifiables} invérifiable(s)`
    );
    return succes({ verification });
  });

  gerer('historique:preparerRestauration', async (parametres) => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;
    const horsPerimetre = perimetreManifeste(manifeste.contenu, actuels);
    if (horsPerimetre.length) {
      return echec(
        'Retour arrière refusé : ' + horsPerimetre.join(' ; ') + '.',
        'Les racines configurées ont changé depuis ce passage, ou le manifeste a été modifié : rien ne sera écrit hors du périmètre actuel.'
      );
    }

    const preparation = await deploy.preparerRestauration(manifeste.contenu, {
      concurrence: actuels.options.lecturesSimultanees
    });
    return succes({
      manifeste: manifeste.contenu,
      preparation: {
        ok: preparation.ok,
        operations: preparation.operations.map((o) => ({ chemin: o.chemin, action: o.action })),
        bloquants: preparation.bloquants,
        avertissements: preparation.avertissements
      }
    });
  });

  gerer('historique:restaurer', (parametres) => exclusif('un retour arrière', async () => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;
    const horsPerimetre = perimetreManifeste(manifeste.contenu, actuels);
    if (horsPerimetre.length) {
      return echec(
        'Retour arrière refusé : ' + horsPerimetre.join(' ; ') + '.',
        'Les racines configurées ont changé depuis ce passage, ou le manifeste a été modifié : rien ne sera écrit hors du périmètre actuel.'
      );
    }

    const preparation = await deploy.preparerRestauration(manifeste.contenu, {
      concurrence: actuels.options.lecturesSimultanees
    });
    if (!preparation.ok) {
      return Object.assign(
        echec(
          'Retour arrière interrompu : ' + preparation.bloquants.length + ' point(s) bloquant(s).',
          'Corrigez-les avant de réessayer.'
        ),
        { preparation: { ok: false, bloquants: preparation.bloquants, avertissements: preparation.avertissements } }
      );
    }

    const signal = fsindex.creerSignal();
    operationEnCours = signal;
    carnet.ecrire('ALERTE', `retour arrière demandé sur ${parametres.cheminManifeste}`);
    try {
      const resultat = await deploy.restaurer(manifeste.contenu, preparation, {
        simulation: Boolean(parametres.simulation),
        auteur: actuels.options.auteur,
        signal,
        invaliderCache: (chemin) => cacheHash.invalider(chemin),
        surProgression: (avancement) => emettre('deploiement:progression', avancement),
        dossierSecours: path.join(app.getPath('userData'), 'manifestes-secours')
      });
      cacheHash.enregistrer();
      if (!parametres.simulation) invaliderManifestes();
      carnet.ecrire(
        resultat.rapport.echecs ? 'ERREUR' : 'INFO',
        `retour arrière terminé - ${resultat.rapport.total} fichier(s), ${resultat.rapport.echecs} échec(s)`
      );
      journaliserTraces(resultat.chemins);
      return succes({ manifeste: resultat.manifeste, chemins: resultat.chemins, rapport: resultat.rapport });
    } finally {
      operationEnCours = null;
    }
  }));
}

// ---------------------------------------------------------------------------
// TFS : fichiers en attente d'archivage
// ---------------------------------------------------------------------------

let tfConnu = null;
const statutsTfs = new Map();
const DUREE_STATUT_TFS = 30 * 1000;

async function cheminTf(actuels) {
  const force = actuels.options.tfs.chemin;
  if (!tfConnu || tfConnu.force !== force) {
    tfConnu = {
      force,
      ...(await tfs.localiserTf({ cheminForce: force, msbuild: msbuildConnu ? msbuildConnu.chemin : '' }))
    };
  }
  return tfConnu;
}

/**
 * Changements en attente sous un dossier. Mis en cache trente secondes :
 * tf.exe met quelques secondes à répondre, et le préflight puis l'exécution
 * le demanderaient deux fois de suite.
 *
 * @returns {Promise<{ actif:boolean, ok:boolean, changements:object[], erreur:string|null }>}
 */
async function statutTfs(dossier) {
  const actuels = reglages();
  if (!actuels.options.tfs.actif) return { actif: false, ok: true, changements: [], erreur: null };
  if (process.platform !== 'win32') return { actif: true, ok: false, changements: [], erreur: 'vérification TFS disponible sous Windows seulement' };
  const cle = String(dossier || '').toLowerCase();
  const connu = statutsTfs.get(cle);
  if (connu && Date.now() - connu.date < DUREE_STATUT_TFS) return connu.resultat;
  const tf = await cheminTf(actuels);
  const resultat = tf.chemin
    ? { actif: true, ...(await tfs.statut(tf.chemin, dossier)) }
    : { actif: true, ok: false, changements: [], erreur: tf.erreur };
  statutsTfs.set(cle, { date: Date.now(), resultat });
  return resultat;
}

/**
 * Avertissement du front : parmi les fichiers qui partent, ceux qui sont
 * extraits sans être archivés dans TFS.
 */
async function avertissementTfsFront(plan) {
  if (plan.operation === deploy.OPERATION_SUPPRESSION) return null;
  const etat = await statutTfs(plan.racineLocale);
  if (!etat.actif) return null;
  if (!etat.ok) {
    return {
      niveau: deploy.AVERTISSEMENT,
      code: 'tfs-inverifiable',
      message: `Vérification TFS impossible : ${etat.erreur}.`,
      conseil: 'Vérifiez à la main dans Visual Studio (Team Explorer, Modifications en attente) que tout est archivé.',
      fichiers: []
    };
  }
  const enAttente = new Map(etat.changements.map((c) => [c.chemin.toLowerCase(), c]));
  const concernes = plan.fichiers
    .map((f) => (f.local ? enAttente.get(String(f.local.absolu).toLowerCase()) : null))
    .filter(Boolean);
  if (!concernes.length) return null;
  return {
    niveau: deploy.AVERTISSEMENT,
    code: 'tfs',
    message: `${concernes.length} fichier(s) que vous mettez en production ne sont pas archivés dans TFS.`,
    conseil: 'Archivez-les avant ou juste après : sinon, le prochain qui récupère les sources et redéploie effacera ces modifications.',
    fichiers: concernes.map((c) => `${c.nom} (${c.changement})`)
  };
}

// ---------------------------------------------------------------------------
// WebServices
// ---------------------------------------------------------------------------

/**
 * Compilations en mémoire, par WebService : le résultat de MSBuild (dossier
 * publié dans le temporaire) et sa comparaison avec la production. C'est ce
 * qui fait autorité au moment de la mise en production : le renderer ne
 * désigne que des noms et des clés.
 */
const compilationsWs = new Map();
let inventaireWs = null;
let msbuildConnu = null;
let compilationWsEnCours = null;
/** Dossiers WebService réellement trouvés au dernier inventaire. */
let racinesWsTrouvees = null;

function dossierTravailWs() {
  return path.join(app.getPath('temp'), 'MEPFront-WS');
}

function annulerCompilationWs() {
  if (!compilationWsEnCours) return;
  compilationWsEnCours.annule = true;
  if (typeof compilationWsEnCours.surAnnulation === 'function') compilationWsEnCours.surAnnulation();
}

/** Ce que l'interface reçoit d'un fichier comparé : jamais de chemin absolu à réutiliser. */
function fichierWsPourRenderer(fichier) {
  return {
    cle: fichier.cle,
    chemin: fichier.chemin,
    statut: fichier.statut,
    sensible: fichier.sensible,
    texte: fichier.texte,
    tailleLocale: fichier.local ? fichier.local.taille : null,
    tailleProd: fichier.prod ? fichier.prod.taille : null,
    versionLocale: fichier.local ? fichier.local.version || null : null,
    versionProd: fichier.prod ? fichier.prod.version || null : null,
    dateProd: fichier.prod ? fichier.prod.mtimeMs : null
  };
}

function compilationPourRenderer(nom) {
  const entree = compilationsWs.get(nom);
  if (!entree) return null;
  const { resultat, comparaison, paquets, ws, date } = entree;
  if (comparaison && !comparaison.binConserve) comparaison.binConserve = [];
  return {
    nom,
    date,
    ok: resultat.ok,
    annule: resultat.annule,
    erreur: resultat.erreur,
    erreurs: resultat.erreurs,
    avertissements: resultat.avertissements,
    duree: resultat.duree,
    commande: resultat.commande,
    lignes: resultat.lignes,
    sortie: resultat.sortie,
    versionCompilee: resultat.versionCompilee,
    versionProd: ws.versionProd,
    binLocalModifie: resultat.binLocalModifie,
    paquets,
    tfs: entree.tfs || null,
    comparaison: comparaison
      ? {
          fichiers: comparaison.fichiers.map(fichierWsPourRenderer),
          conserves: comparaison.conserves,
          selection: webservice.selectionParDefaut(comparaison.fichiers),
          api: comparaison.api || null,
          config: comparaison.config || null,
          references: comparaison.fichiers.length
            ? webservice.verifierReferences(comparaison, new Set(webservice.selectionParDefaut(comparaison.fichiers)))
            : [],
          erreur: comparaison.erreur || null
        }
      : null
  };
}

/**
 * Demande et sprint d'un passage : la même règle que pour le front. Sans
 * numéro de demande, le passage est dit mineur et part dans AVMDFMINEUR.
 */
function destinationDuPassage(parametres, actuels) {
  const mineur = parametres.archiver === false;
  if (!mineur) {
    const demande = avmdf.normaliserDemande(parametres.demande);
    if (!demande) {
      return { erreur: echec('Aucune demande choisie.', 'Choisissez ou créez une demande AVMDF dans le panneau de destination.') };
    }
    const nomSprint = String(parametres.sprint || '').trim();
    const destination = avmdf.resoudreDestination(actuels.racines.avmdf, demande.nom, nomSprint);
    if (!destination.valide) return { erreur: echec(destination.erreur, 'Corrigez le nom du dossier de sprint.') };
    return { mineur, nomDemande: demande.nom, nomSprint, chemin: destination.chemin };
  }
  const nomSprint = avmdf.MOTIF_PASSAGE_MINEUR.test(String(parametres.sprint || '').trim())
    ? String(parametres.sprint).trim()
    : avmdf.nomPassageMineur(new Date());
  const destination = avmdf.resoudreDestination(actuels.racines.avmdf, avmdf.DEMANDE_MINEURE, nomSprint);
  if (!destination.valide) return { erreur: echec(destination.erreur, 'Vérifiez la racine des archives dans les réglages.') };
  return { mineur, nomDemande: avmdf.DEMANDE_MINEURE, nomSprint, chemin: destination.chemin };
}

/**
 * Un plan de mise en production par WebService coché. Chaque plan est un plan
 * ordinaire de deploy.js : la source est le site compilé, la destination le
 * dossier du WS en production, la sauvegarde `<sprint>\<WS>`.
 */
async function construirePlansWs(parametres) {
  const actuels = reglages();
  const demandes = Array.isArray(parametres.webservices) ? parametres.webservices : [];
  if (!demandes.length) {
    return { erreur: echec('Aucun WebService à mettre en production.', 'Compilez puis cochez au moins un WebService.') };
  }
  const destination = destinationDuPassage(parametres, actuels);
  if (destination.erreur) return { erreur: destination.erreur };

  const plans = [];
  for (const demande of demandes) {
    const nom = String(demande.nom || '');
    const entree = compilationsWs.get(nom);
    if (!entree || !entree.resultat.ok || !entree.comparaison) {
      return { erreur: echec(`${nom} n'a pas de compilation réussie en mémoire.`, 'Recompilez ce WebService avant de le mettre en production.') };
    }
    const cles = new Set(Array.isArray(demande.cles) ? demande.cles : []);
    const fichiers = entree.comparaison.fichiers.filter(
      (f) => cles.has(f.cle) && f.statut !== webservice.STATUT_IDENTIQUE
    );
    if (!fichiers.length) {
      return { erreur: echec(`${nom} : aucun fichier coché.`, 'Cochez au moins un fichier qui diffère de la production, ou décochez ce WebService.') };
    }

    // La version de production est relue maintenant : quelqu'un a pu passer
    // depuis la compilation.
    const versionProd = webservice.versionDe(
      await webservice.lireVersionDll(path.join(entree.ws.dossierProd, 'bin', entree.ws.assemblyName + '.dll'))
    );
    const dossierSauvegarde = path.join(destination.chemin, nom);
    plans.push({
      nom,
      versionProd,
      versionCompilee: entree.resultat.versionCompilee,
      plan: {
        projet: nom,
        racineLocale: entree.resultat.sortie,
        racineProd: entree.ws.dossierProd,
        racineAvmdf: actuels.racines.avmdf,
        demande: destination.nomDemande,
        sprint: destination.nomSprint,
        dossierSauvegarde,
        dossierTraces: destination.chemin,
        auteur: actuels.options.auteur,
        simulation: Boolean(parametres.simulation),
        archiver: true,
        mineur: destination.mineur,
        operation: deploy.OPERATION_DEPLOIEMENT,
        commentaire: String(parametres.commentaire || '').trim().slice(0, 600) || null,
        appOffline: { actif: Boolean(parametres.appOffline), contenu: actuels.options.appOffline.contenu },
        fichiers,
        complements: {
          type: 'webservice',
          webservice: {
            nom,
            assembly: entree.ws.assemblyName,
            versionAvant: versionProd,
            versionApres: entree.resultat.versionCompilee,
            configuration: actuels.webservices.configuration,
            msbuild: msbuildConnu ? msbuildConnu.chemin : null,
            archiveComplete: dossierSauvegarde
          }
        }
      }
    });
  }
  return { plans, destination, actuels };
}

/** Contrôles propres aux WebServices, en plus du préflight ordinaire. */
async function controlesWs(entree) {
  const problemes = [];
  const ecart = webservice.comparerVersions(entree.versionCompilee, entree.versionProd);
  if (entree.versionProd && ecart !== null && ecart <= 0) {
    problemes.push({
      niveau: deploy.BLOQUANT,
      code: 'version',
      message:
        ecart === 0
          ? `${entree.nom} : la version compilée (${entree.versionCompilee}) est celle déjà en production.`
          : `${entree.nom} : la version compilée (${entree.versionCompilee}) est plus ancienne que celle en production (${entree.versionProd}).`,
      conseil: 'Changez le numéro d\'assembly dans My Project\\AssemblyInfo.vb, puis recompilez.',
      fichiers: []
    });
  } else if (!entree.versionProd || ecart === null) {
    problemes.push({
      niveau: deploy.AVERTISSEMENT,
      code: 'version-inconnue',
      message: `${entree.nom} : la version en production n'a pas pu être lue, l'outil ne peut pas vérifier que la vôtre est plus récente.`,
      conseil: 'Vérifiez à l\'œil le numéro d\'assembly avant de confirmer.',
      fichiers: []
    });
  }
  const compilation = compilationsWs.get(entree.nom);
  const comparaison = compilation && compilation.comparaison;
  if (comparaison && comparaison.config) {
    const c = comparaison.config;
    const manquantes = c.appSettings.manquantesEnProd.map((k) => `appSettings : ${k}`)
      .concat(c.connectionStrings.manquantesEnProd.map((k) => `connectionStrings : ${k}`));
    const webConfigPart = entree.plan.fichiers.some((f) => f.chemin.toLowerCase() === 'web.config');
    if (manquantes.length && !webConfigPart) {
      problemes.push({
        niveau: deploy.AVERTISSEMENT,
        code: 'config-manquante',
        message: `${entree.nom} : ${manquantes.length} clé(s) du Web.config compilé n'existent pas dans celui de production.`,
        conseil: 'Ajoutez-les à la main dans le Web.config de production, avec les valeurs de production : sinon le WebService plantera au premier appel qui les lit.',
        fichiers: manquantes
      });
    }
  }
  if (comparaison && comparaison.api && comparaison.api.retirees.length) {
    problemes.push({
      niveau: deploy.AVERTISSEMENT,
      code: 'api-retiree',
      message: `${entree.nom} : ${comparaison.api.retirees.length} méthode(s) exposée(s) disparaissent ou changent de paramètres.`,
      conseil: 'Un client (GPNet, une application mobile…) qui les appelle encore recevra une erreur. Vérifiez que plus personne ne les utilise.',
      fichiers: comparaison.api.retirees
    });
  }
  if (comparaison) {
    const references = webservice.verifierReferences(comparaison, new Set(entree.plan.fichiers.map((f) => f.cle)));
    if (references.length) {
      problemes.push({
        niveau: deploy.AVERTISSEMENT,
        code: 'references',
        message: `${entree.nom} : ${references.length} DLL nécessaire(s) absente(s) ou dans une autre version dans le bin de production.`,
        conseil: 'Cochez la DLL correspondante si elle est dans la compilation, ou ajoutez une redirection de version dans le Web.config. Sinon : « Impossible de charger le fichier ou l\'assembly » au démarrage.',
        fichiers: references.map((r) => `${r.dll} → ${r.reference} ${r.attendue}${r.trouvee ? ` (trouvée : ${r.trouvee})` : ' (absente)'}`)
      });
    }
  }
  if (compilation && compilation.tfs && compilation.tfs.ok && compilation.tfs.changements.length) {
    problemes.push({
      niveau: deploy.AVERTISSEMENT,
      code: 'tfs',
      message: `${entree.nom} : ${compilation.tfs.changements.length} fichier(s) source ne sont pas archivés dans TFS.`,
      conseil: 'Ils sont compilés dans ce qui part en production. Archivez-les, sinon le prochain qui récupère les sources et republie effacera ces modifications.',
      fichiers: compilation.tfs.changements.map((c) => `${c.nom} (${c.changement})`)
    });
  }

  const sensibles = entree.plan.fichiers.filter((f) => f.sensible);
  if (sensibles.length) {
    problemes.push({
      niveau: deploy.AVERTISSEMENT,
      code: 'sensible',
      message: `${entree.nom} : ${sensibles.map((f) => f.chemin).join(', ')} ${sensibles.length > 1 ? 'seront remplacés' : 'sera remplacé'}.`,
      conseil: 'Ces fichiers portent la configuration de production (chaînes de connexion, clés). Vérifiez l\'écart avant de confirmer.',
      fichiers: sensibles.map((f) => f.chemin)
    });
  }
  try {
    const contenu = await fsp.readdir(fsindex.cheminLong(entree.plan.dossierSauvegarde));
    if (contenu.length) {
      problemes.push({
        niveau: deploy.AVERTISSEMENT,
        code: 'archive-anterieure',
        message: `${entree.nom} : un dossier ${entree.nom} existe déjà dans ce sprint.`,
        conseil: 'Les fichiers déjà archivés sont gardés tels quels (c\'est l\'état d\'avant le premier passage) ; seuls les manquants sont ajoutés.',
        fichiers: []
      });
    }
  } catch (err) {
    /* pas encore d'archive : cas normal */
  }
  return problemes;
}

function resumePlanWs(entree) {
  const parStatut = { modifie: 0, nouveau: 0 };
  let octets = 0;
  for (const fichier of entree.plan.fichiers) {
    if (parStatut[fichier.statut] !== undefined) parStatut[fichier.statut] += 1;
    octets += fichier.local ? fichier.local.taille : 0;
  }
  return {
    nom: entree.nom,
    versionProd: entree.versionProd,
    versionCompilee: entree.versionCompilee,
    racineProd: entree.plan.racineProd,
    dossierSauvegarde: entree.plan.dossierSauvegarde,
    parStatut,
    octets,
    fichiers: entree.plan.fichiers.map((f) => ({
      chemin: f.chemin,
      statut: f.statut,
      sensible: f.sensible,
      taille: f.local ? f.local.taille : 0
    }))
  };
}

async function preflightWs(plans, actuels) {
  const resultats = [];
  for (const entree of plans) {
    const controle = await deploy.preflight(entree.plan, { concurrence: actuels.options.lecturesSimultanees });
    const supplements = await controlesWs(entree);
    const problemes = controle.problemes.concat(supplements);
    resultats.push({
      nom: entree.nom,
      ok: !problemes.some((p) => p.niveau === deploy.BLOQUANT),
      bloquants: problemes.filter((p) => p.niveau === deploy.BLOQUANT),
      avertissements: problemes.filter((p) => p.niveau === deploy.AVERTISSEMENT),
      etatsProd: controle.etatsProd,
      resume: resumePlanWs(entree)
    });
  }
  return resultats;
}

function handlersWebServices() {
  gerer('ws:lister', async (parametres = {}) => {
    const actuels = reglages();
    if (!actuels.racines.locale || !actuels.racines.prod) {
      return echec('Racines des WebServices non configurées.', 'Renseignez les racines locale et production dans les réglages.');
    }
    // La racine locale est souvent celle du front (…\Process\GPNET) : le
    // dossier WebService est cherché dedans, puis à côté.
    const [trouveLocal, trouveProd] = await Promise.all([
      webservice.resoudreDossierWs(actuels.racines.locale, actuels.webservices.dossierLocal),
      webservice.resoudreDossierWs(actuels.racines.prod, actuels.webservices.dossierProd)
    ]);
    const racines = { locale: trouveLocal.chemin, prod: trouveProd.chemin };
    racinesWsTrouvees = racines;
    if (parametres.rafraichirMsbuild || !msbuildConnu || msbuildConnu.cheminForce !== actuels.webservices.msbuild) {
      msbuildConnu = {
        ...(await webservice.localiserMsbuild({ cheminForce: actuels.webservices.msbuild })),
        cheminForce: actuels.webservices.msbuild
      };
    }
    const inventaire = await webservice.listerWebServices({
      racineLocale: racines.locale,
      racineProd: racines.prod,
      concurrence: actuels.options.lecturesSimultanees
    });
    inventaireWs = inventaire;
    if (!trouveLocal.trouve) {
      inventaire.erreurs.unshift(`Cherché aussi dans : ${trouveLocal.essais.join(' ; ')}. Indiquez le chemin complet dans Réglages → WebServices.`);
    }

    // Dernier passage de chaque WS par l'outil, lu dans les manifestes. Un
    // partage d'archives injoignable ne doit pas empêcher la liste.
    const passages = new Map();
    try {
      const { manifestes } = await listerManifestesEnCache(actuels);
      for (const m of manifestes) {
        if (m.type !== 'webservice' || m.simulation) continue;
        const cle = String(m.projet || '').toLowerCase();
        const liste = passages.get(cle) || [];
        liste.push({
          date: m.date,
          auteur: m.auteur || null,
          demande: m.demande,
          sprint: m.sprint,
          operation: m.operation,
          commentaire: m.commentaire || null,
          versionAvant: m.webservice ? m.webservice.versionAvant : null,
          versionApres: m.webservice ? m.webservice.versionApres : null,
          dossierSauvegarde: m.dossierSauvegarde || null,
          chemin: m.chemin,
          fichiers: Array.isArray(m.fichiers) ? m.fichiers.length : 0
        });
        passages.set(cle, liste);
      }
    } catch (err) {
      /* historique illisible : la liste reste utile sans lui */
    }

    return succes({
      racines,
      configuration: actuels.webservices.configuration,
      urlTest: actuels.webservices.urlTest || null,
      tfsActif: actuels.options.tfs.actif,
      msbuild: { chemin: msbuildConnu.chemin, source: msbuildConnu.source, version: msbuildConnu.version, erreur: msbuildConnu.erreur },
      webservices: inventaire.webservices.map((ws) => ({
        nom: ws.nom,
        projet: ws.projet,
        dossierProd: ws.dossierProd,
        assemblyName: ws.assemblyName,
        versionLocale: ws.versionLocale,
        versionLocaleFichier: ws.versionLocaleFichier,
        versionProd: ws.versionProd,
        etat: ws.etat,
        raison: ws.raison,
        selectionnable: ws.selectionnable,
        dateProd: ws.dateProd || null,
        sourcesModifiees: ws.sourcesModifiees || { fichiers: [], total: 0 },
        passages: (passages.get(ws.nom.toLowerCase()) || []).slice(0, 10),
        compilation: compilationPourRenderer(ws.nom)
      })),
      bibliotheques: inventaire.bibliotheques.map((b) => ({ nom: b.nom, projet: b.projet, web: b.web, raison: b.raison })),
      erreurs: inventaire.erreurs
    });
  });

  gerer('ws:compiler', (parametres = {}) => exclusif('une compilation', async () => {
    const actuels = reglages();
    const nom = String(parametres.nom || '');
    if (!inventaireWs) return echec('Liste des WebServices non chargée.', 'Rechargez la liste.');
    const ws = inventaireWs.webservices.find((w) => w.nom === nom);
    if (!ws) return echec(`WebService inconnu : ${nom}`, 'Rechargez la liste des WebServices.');

    // La version locale est relue au moment de compiler : c'est souvent juste
    // avant que l'on vient de la changer dans Visual Studio.
    const locale = await webservice.lireVersionLocale(ws.dossierProjet);
    ws.versionLocale = webservice.versionDe(locale);
    const etat = webservice.etatVersions(ws.versionLocale, ws.versionProd);
    ws.etat = etat.etat;
    ws.raison = etat.raison;
    if (etat.etat === webservice.ETAT_VERSION_IDENTIQUE || etat.etat === webservice.ETAT_VERSION_ANCIENNE) {
      return echec(etat.raison, 'Changez le numéro d\'assembly dans My Project, enregistrez, puis rechargez la liste.');
    }

    if (!msbuildConnu || !msbuildConnu.chemin) {
      msbuildConnu = {
        ...(await webservice.localiserMsbuild({ cheminForce: actuels.webservices.msbuild })),
        cheminForce: actuels.webservices.msbuild
      };
    }
    if (!msbuildConnu.chemin) return echec(msbuildConnu.erreur, 'Indiquez le chemin de MSBuild.exe dans Réglages → WebServices.');

    const paquets = await webservice.verifierPaquets(ws.dossierProjet);
    const signal = { annule: false };
    compilationWsEnCours = signal;
    carnet.ecrire('INFO', `compilation ${actuels.webservices.configuration} de ${nom} (${ws.projet})`);
    let resultat;
    try {
      resultat = await webservice.compiler({
        msbuild: msbuildConnu.chemin,
        ws,
        dossierTravail: path.join(dossierTravailWs(), webservice.nomDeTravail(nom)),
        configuration: actuels.webservices.configuration,
        surLignes: (lignes) => emettre('ws:journal', { nom, lignes }),
        signal
      });
    } finally {
      compilationWsEnCours = null;
    }

    let comparaison = null;
    if (resultat.ok) {
      try {
        comparaison = await webservice.comparerSortie({
          sortie: resultat.sortie,
          prod: ws.dossierProd,
          assemblyName: ws.assemblyName,
          concurrence: actuels.options.lecturesSimultanees
        });
      } catch (err) {
        comparaison = { fichiers: [], conserves: [], erreur: `Comparaison impossible : ${fsindex.raisonLisible(err)} - ${err.message}` };
      }
    }

    // Fichiers en attente dans TFS : ceux du WS et ceux des bibliothèques
    // qu'il référence, qui partent aussi dans son bin.
    let etatTfs = null;
    if (actuels.options.tfs.actif) {
      const racine = racinesWsTrouvees ? racinesWsTrouvees.locale : path.dirname(ws.dossierProjet);
      const brut = await statutTfs(racine);
      const dossiers = [ws.dossierProjet, ...(ws.projetsReferences || [])];
      etatTfs = {
        ok: brut.ok,
        erreur: brut.erreur,
        changements: brut.ok
          ? dossiers.flatMap((d) => tfs.sousDossier(brut.changements, d)).filter((c, i, t) => t.findIndex((x) => x.chemin === c.chemin) === i)
          : []
      };
    }

    compilationsWs.set(nom, { ws, resultat, comparaison, paquets, tfs: etatTfs, date: new Date().toISOString() });
    carnet.ecrire(
      resultat.ok ? 'INFO' : 'ERREUR',
      `compilation de ${nom} ${resultat.ok ? 'réussie' : 'en échec'} en ${Math.round(resultat.duree / 1000)} s` +
        (resultat.ok ? ` - version ${resultat.versionCompilee || '?'}` : ` - ${resultat.erreur}`) +
        (resultat.binLocalModifie.length ? ` - ATTENTION, bin local modifié (${resultat.binLocalModifie.length} fichier(s))` : '')
    );
    return succes({ compilation: compilationPourRenderer(nom) });
  }));

  gerer('ws:annulerCompilation', () => {
    annulerCompilationWs();
    return succes({});
  });

  // Les dépendances dépendent de ce qui est coché : recalculées à chaque
  // changement de sélection, tout est déjà en mémoire.
  gerer('ws:references', (parametres = {}) => {
    const entree = compilationsWs.get(String(parametres.nom || ''));
    if (!entree || !entree.comparaison || !entree.comparaison.fichiers) return succes({ references: [] });
    if (!entree.comparaison.binConserve) entree.comparaison.binConserve = [];
    const selection = new Set(Array.isArray(parametres.cles) ? parametres.cles : []);
    return succes({ references: webservice.verifierReferences(entree.comparaison, selection) });
  });

  gerer('ws:matrice', async () => {
    if (!inventaireWs) return echec('Liste des WebServices non chargée.', 'Rechargez la liste.');
    const actuels = reglages();
    const matrice = await webservice.matriceDll(
      inventaireWs.webservices.map((w) => ({ nom: w.nom, dossierProd: w.dossierProd })),
      Math.min(4, actuels.options.lecturesSimultanees)
    );
    return succes({ matrice });
  });

  gerer('ws:tester', async (parametres = {}) => {
    const actuels = reglages();
    const url = webservice.urlDeTest(actuels.webservices.urlTest, String(parametres.nom || ''));
    if (!url) {
      return echec(
        'Aucune adresse de test configurée.',
        'Renseignez « Adresse de test » dans Réglages → WebServices, par exemple http://serveur/{ws}/'
      );
    }
    const test = await webservice.testerUrl(url);
    carnet.ecrire(test.ok ? 'INFO' : 'ALERTE', `test de ${parametres.nom} : ${url} → ${test.ok ? 'répond' : 'ne répond pas'} (${test.statut || test.erreur})`);
    return succes({ test });
  });

  gerer('ws:oublier', (parametres = {}) => {
    compilationsWs.delete(String(parametres.nom || ''));
    return succes({});
  });

  gerer('ws:diff', async (parametres = {}) => {
    const actuels = reglages();
    const entree = compilationsWs.get(String(parametres.nom || ''));
    if (!entree || !entree.comparaison) return echec('Aucune compilation en mémoire pour ce WebService.', 'Recompilez-le.');
    const fichier = entree.comparaison.fichiers.find((f) => f.cle === parametres.cle);
    if (!fichier) return echec('Fichier inconnu dans cette compilation.', 'Recompilez le WebService.');

    const lire = async (chemin) => {
      if (!chemin) return null;
      try {
        return await fsp.readFile(fsindex.cheminLong(chemin));
      } catch (err) {
        return null;
      }
    };
    const [prod, compile] = await Promise.all([lire(fichier.prod && fichier.prod.absolu), lire(fichier.local.absolu)]);
    const extension = path.extname(fichier.chemin).toLowerCase();
    const resultat = textdiff.comparerTampons(prod, compile, {
      ignorerEspaces: actuels.options.ignorerEspaces,
      extensionTexte: fichier.texte || actuels.extensionsTexte.includes(extension)
    });
    const enveloppe = {
      cle: fichier.cle,
      chemin: fichier.chemin,
      statut: fichier.statut,
      titreGauche: 'Production',
      titreDroite: 'Compilé (' + actuels.webservices.configuration + ')',
      absent: { sauvegarde: !prod, prod: !compile },
      ...resultat
    };
    if (resultat.type === 'texte') {
      enveloppe.groupes = textdiff.grouper(resultat.lignes);
      delete enveloppe.lignes;
    }
    completerBinaire(enveloppe, extension, prod, compile, {});
    return succes({ diff: enveloppe });
  });

  gerer('ws:preflight', async (parametres = {}) => {
    const { plans, erreur, actuels, destination } = await construirePlansWs(parametres);
    if (erreur) return erreur;
    const controles = await preflightWs(plans, actuels);
    return succes({
      destination: { demande: destination.nomDemande, sprint: destination.nomSprint, chemin: destination.chemin, mineur: destination.mineur },
      simulation: Boolean(parametres.simulation),
      appOffline: Boolean(parametres.appOffline),
      controles: controles.map(({ etatsProd, ...reste }) => reste),
      ok: controles.every((c) => c.ok)
    });
  });

  gerer('ws:executer', (parametres = {}) => exclusif('une mise en production', async () => {
    const { plans, erreur, actuels } = await construirePlansWs(parametres);
    if (erreur) return erreur;

    // Tout est contrôlé avant le premier octet écrit : un WS bloqué arrête le
    // passage entier, pas seulement lui.
    const controles = await preflightWs(plans, actuels);
    if (!controles.every((c) => c.ok)) {
      return Object.assign(
        echec(
          'Mise en production interrompue : des points bloquants sont apparus depuis le contrôle.',
          'Relisez les contrôles, corrigez, puis relancez.'
        ),
        { controles: controles.map(({ etatsProd, ...reste }) => reste) }
      );
    }

    const simulation = Boolean(parametres.simulation);
    const resultats = [];
    const signal = fsindex.creerSignal();
    operationEnCours = signal;
    try {
      for (let index = 0; index < plans.length; index += 1) {
        const entree = plans[index];
        const controle = controles[index];
        if (signal.annule) {
          resultats.push({ nom: entree.nom, nonTraite: true, erreur: 'Passage annulé avant ce WebService.' });
          continue;
        }
        emettre('ws:progression', { nom: entree.nom, phase: 'archivage', index, total: plans.length });

        // 1. Le dossier complet de production, avant tout.
        const archive = await webservice.archiverDossierComplet({
          source: entree.plan.racineProd,
          destination: entree.plan.dossierSauvegarde,
          racineAvmdf: actuels.racines.avmdf,
          simulation,
          concurrence: Math.min(4, actuels.options.lecturesSimultanees)
        });
        entree.plan.archivesDuPassage = archive.copiesChemins;
        entree.plan.complements.webservice.archive = {
          copies: archive.copies,
          conserves: archive.conserves,
          octets: archive.octets,
          total: archive.total
        };
        if (archive.erreurs.length) {
          // Rien n'est écrasé sans archive : ce WS et les suivants s'arrêtent là.
          carnet.ecrire('ERREUR', `archivage du dossier ${entree.plan.racineProd} incomplet : ${archive.erreurs.slice(0, 5).join(' ; ')}`);
          resultats.push({
            nom: entree.nom,
            erreur:
              `Archivage du dossier complet incomplet (${archive.erreurs.length} erreur(s)) : rien n'a été copié en production pour ce WebService. ` +
              archive.erreurs.slice(0, 3).join(' ; '),
            archive: { copies: archive.copies, conserves: archive.conserves, octets: archive.octets, total: archive.total }
          });
          for (const suivant of plans.slice(index + 1)) {
            resultats.push({ nom: suivant.nom, nonTraite: true, erreur: 'Non traité : le WebService précédent a échoué à l\'archivage.' });
          }
          break;
        }

        // 2. La copie, le manifeste, le récapitulatif : ceux du front.
        emettre('ws:progression', { nom: entree.nom, phase: 'copie', index, total: plans.length });
        carnet.ecrire(
          'INFO',
          `${simulation ? 'simulation' : 'mise en production'} WebService ${entree.nom} : ${entree.plan.fichiers.length} fichier(s) ` +
            `vers ${entree.plan.racineProd} - version ${entree.versionProd || '?'} → ${entree.versionCompilee || '?'} - archive ${entree.plan.dossierSauvegarde}`
        );
        const resultat = await deploy.executer(entree.plan, {
          signal,
          extensionsTexte: actuels.extensionsTexte,
          ignorerEspaces: actuels.options.ignorerEspaces,
          invaliderCache: (chemin) => cacheHash.invalider(chemin),
          etatsProd: controle.etatsProd,
          dossierSecours: path.join(app.getPath('userData'), 'manifestes-secours')
        });
        journaliserTraces(resultat.chemins);
        const r = resultat.rapport;
        carnet.ecrire(
          r.echecs ? 'ERREUR' : 'INFO',
          `${entree.nom} terminé - ${r.remplacements} remplacé(s), ${r.creations} créé(s), ${r.echecs} échec(s)` +
            (resultat.chemins.manifeste ? ` - manifeste ${resultat.chemins.manifeste}` : '')
        );
        const appOffline = resultat.manifeste.appOffline;
        if (appOffline && appOffline.erreurRetrait) {
          carnet.ecrire('ERREUR', `app_offline.htm NON RETIRÉ de ${entree.plan.racineProd} : ${appOffline.erreurRetrait}`);
        }
        // Le WS répond-il encore ? Seulement après une écriture réelle.
        let test = null;
        const url = webservice.urlDeTest(actuels.webservices.urlTest, entree.nom);
        if (!simulation && url && !r.echecs) {
          emettre('ws:progression', { nom: entree.nom, phase: 'test', index, total: plans.length });
          test = await webservice.testerUrl(url);
          carnet.ecrire(
            test.ok ? 'INFO' : 'ERREUR',
            `${entree.nom} après mise en production : ${url} → ${test.ok ? 'répond' : 'NE RÉPOND PAS'} (${test.statut || test.erreur})`
          );
        }
        resultats.push({
          nom: entree.nom,
          test,
          manifeste: resultat.manifeste,
          chemins: resultat.chemins,
          rapport: r,
          archive: { copies: archive.copies, conserves: archive.conserves, octets: archive.octets, total: archive.total },
          avertissements: controle.avertissements
        });
        if (!simulation) compilationsWs.delete(entree.nom);
      }
    } finally {
      operationEnCours = null;
    }

    if (!simulation) invaliderManifestes();
    cacheHash.enregistrer();
    return succes({ simulation, resultats });
  }));
}

/** Relit un manifeste depuis le disque en vérifiant qu'il est bien sous la racine d'archives. */
async function lireManifesteSur(chemin, actuels) {
  const cible = String(chemin || '');
  if (!cible || !avmdf.estSousRacine(cible, actuels.racines.avmdf)) {
    return {
      erreur: echec(
        'Ce manifeste est hors du dossier d\'archives.',
        'Rechargez l\'historique depuis la racine AVMDF configurée.'
      )
    };
  }
  try {
    const contenu = JSON.parse(await fsp.readFile(fsindex.cheminLong(cible), 'utf8'));
    return { contenu: { ...contenu, chemin: cible } };
  } catch (err) {
    return {
      erreur: echec(
        `Manifeste illisible (${fsindex.raisonLisible(err)}) : ${cible}`,
        'Le fichier a peut-être été déplacé ou modifié à la main.',
        err
      )
    };
  }
}

// ---------------------------------------------------------------------------
// Journal et actions système
// ---------------------------------------------------------------------------

function handlersSysteme() {
  gerer('journal:lister', async () => succes({ fichiers: await carnet.lister(), dossier: carnet.dossier }));

  gerer('journal:lire', async (nom) => {
    const resultat = await carnet.lire(nom);
    if (!resultat.ok) {
      return echec(`Journal illisible (${resultat.erreur}).`, 'Choisissez un autre jour dans la liste.');
    }
    return succes(resultat);
  });

  gerer('journal:ouvrirDossier', async () => {
    await fsp.mkdir(carnet.dossier, { recursive: true });
    shell.openPath(carnet.dossier);
    return succes({});
  });

  gerer('systeme:ouvrir', async (parametres) => {
    const chemin = cheminAutorise(parametres.chemin);
    if (!chemin) return echec('Chemin hors du périmètre de l\'application.', 'Relancez une analyse.');
    const erreur = await shell.openPath(chemin);
    if (erreur) {
      return echec(
        `Ouverture impossible : ${erreur}`,
        'Aucun programme n\'est peut-être associé à ce type de fichier.'
      );
    }
    return succes({});
  });

  gerer('systeme:reveler', (parametres) => {
    const chemin = cheminAutorise(parametres.chemin);
    if (!chemin) return echec('Chemin hors du périmètre de l\'application.', 'Relancez une analyse.');
    shell.showItemInFolder(chemin);
    return succes({});
  });

  /**
   * Montre un dossier de l'arborescence dans l'explorateur, d'un côté ou de
   * l'autre. Le renderer désigne le dossier par son chemin relatif : c'est ici
   * qu'il est joint à la racine du dernier scan, jamais dans l'interface.
   */
  gerer('systeme:revelerDossier', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const cote = parametres.cote === 'prod' ? 'production' : 'local';
    const racine = cote === 'production' ? dernierScan.cheminProd : dernierScan.cheminLocal;
    const cible = cheminAutorise(fsindex.joindreRelatif(racine, String(parametres.chemin || '')));
    if (!cible) return echec('Chemin hors du périmètre de l\'application.', 'Relancez une analyse.');

    try {
      const etat = await fsp.stat(fsindex.cheminLong(cible));
      if (!etat.isDirectory()) return echec(`Ce n'est pas un dossier : ${cible}`, 'Relancez une analyse.');
    } catch (err) {
      return echec(
        `Ce dossier n'existe pas côté ${cote} : ${cible}`,
        'Un dossier peut n\'exister que d\'un seul côté ; c\'est le cas quand tout son contenu est nouveau ou orphelin.',
        err
      );
    }

    shell.showItemInFolder(cible);
    return succes({});
  });

  gerer('systeme:copier', (texte) => {
    clipboard.writeText(String(texte || ''));
    return succes({});
  });

  // Le fond de la fenêtre est ce qui s'affiche pendant un redimensionnement,
  // avant que la page ne soit repeinte. Laissé au gris sombre en thème clair,
  // il fait clignoter du noir sur les bords à chaque coup de souris.
  gerer('systeme:fondFenetre', (couleur) => {
    const valeur = String(couleur || '');
    if (!/^#[0-9a-f]{6}$/i.test(valeur)) {
      return echec('Couleur de fond invalide.', 'Attendu : une couleur hexadécimale, par exemple #16191c.');
    }
    if (fenetre && !fenetre.isDestroyed()) fenetre.setBackgroundColor(valeur);
    return succes({});
  });
}

/**
 * N'autorise l'ouverture que de chemins issus de la dernière analyse ou situés
 * sous les racines configurées : le renderer ne choisit pas ce qu'il ouvre.
 */
function cheminAutorise(chemin) {
  const cible = String(chemin || '');
  if (!cible) return null;
  const actuels = reglages();
  const racines = [actuels.racines.locale, actuels.racines.prod, actuels.racines.avmdf];
  if (dernierScan) racines.push(dernierScan.cheminLocal, dernierScan.cheminProd);
  const racinesWs = config.resoudreWebServices(actuels);
  racines.push(racinesWs.locale, racinesWs.prod, dossierTravailWs());
  if (racinesWsTrouvees) racines.push(racinesWsTrouvees.locale, racinesWsTrouvees.prod);
  return racines.some((racine) => racine && avmdf.estSousRacine(cible, racine)) ? cible : null;
}

// ---------------------------------------------------------------------------
// Fenêtre et cycle de vie
// ---------------------------------------------------------------------------

function creerFenetre() {
  fenetre = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#16191d',
    autoHideMenuBar: true,
    title: 'MEPFront - Mise en production',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  fenetre.once('ready-to-show', () => {
    fenetre.show();
    if (MODE_DEV) fenetre.webContents.openDevTools({ mode: 'bottom' });
  });

  fenetre.on('closed', () => {
    fenetre = null;
  });

  fenetre.webContents.on('will-navigate', (evenement) => evenement.preventDefault());
  fenetre.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  fenetre.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!fenetre) return;
    if (fenetre.isMinimized()) fenetre.restore();
    fenetre.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('fr.process.avmdf-deploy');

    const donnees = app.getPath('userData');
    depotConfig = config.creerDepot(path.join(donnees, 'config.json'), contexteConfig());
    cacheHash = fsindex.creerCacheHash(path.join(donnees, 'cache-hash.json'));
    carnet = journal.creerJournal(path.join(donnees, 'logs'));

    const { existait, avertissements } = depotConfig.charger();
    avertissementsDemarrage = avertissements;
    if (!existait) {
      try {
        depotConfig.reinitialiser();
      } catch (err) {
        avertissementsDemarrage.push(
          `Réglages non enregistrés au premier lancement (${err.code || err.message}) : ` +
            'ils resteront valables pour cette session seulement.'
        );
      }
    }

    carnet.ecrire('INFO', `application démarrée (version ${app.getVersion()})`);

    handlersConfig();
    handlersAnalyse();
    handlersDiff();
    handlersReferences();
    handlersFrise();
    handlersAvmdf();
    handlersDeploiement();
    handlersHistorique();
    handlersWebServices();
    handlersSysteme();
    creerFenetre();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) creerFenetre();
    });
  });

  app.on('before-quit', () => {
    if (analyseEnCours) analyseEnCours.annuler();
    if (preflightEnCours) preflightEnCours.annuler();
    if (operationEnCours) operationEnCours.annuler();
    annulerCompilationWs();
    if (cacheHash) cacheHash.enregistrerSync();
    if (carnet) carnet.ecrire('INFO', 'application fermée');
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
