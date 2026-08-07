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
const avmdf = require('./core/avmdf');
const deploy = require('./core/deploy');
const journal = require('./core/journal');
const stats = require('./core/stats');

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

function reglages() {
  return depotConfig.charger().config;
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
      return succes({ config: neuf, controle: config.verifier(neuf) });
    } catch (err) {
      return echec(
        `Impossible de réinitialiser les réglages (${err.code || err.message}).`,
        'Vérifiez les droits d\'écriture sur ' + depotConfig.chemin,
        err
      );
    }
  });

  gerer('config:exclureFichier', (nom) => {
    const actuels = reglages();
    const motif = String(nom || '').trim();
    if (!motif) return echec('Aucun fichier à exclure.', 'Réessayez depuis le menu contextuel.');
    if (actuels.exclusions.fichiers.some((m) => m.toLowerCase() === motif.toLowerCase())) {
      return succes({ config: actuels, deja: true });
    }
    actuels.exclusions.fichiers.push(motif);
    const { config: enregistre } = depotConfig.enregistrer(actuels);
    return succes({ config: enregistre, deja: false });
  });

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

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

function handlersAnalyse() {
  gerer('analyse:demarrer', async (parametres) => {
    if (analyseEnCours) {
      return echec('Une analyse est déjà en cours.', 'Attendez sa fin ou annulez-la.');
    }

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
  });

  gerer('analyse:annuler', () => {
    if (analyseEnCours) analyseEnCours.annuler();
    return succes({});
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

function handlersDiff() {
  gerer('fichier:diff', async (parametres) => {
    if (!dernierScan) return echec('Aucune analyse en mémoire.', 'Lancez d\'abord une analyse.');
    const fichier = dernierScan.parCle.get(String(parametres.cle || ''));
    if (!fichier) {
      return echec('Ce fichier ne fait pas partie de la dernière analyse.', 'Relancez une analyse.');
    }

    const actuels = reglages();
    const extensionTexte = actuels.extensionsTexte.includes(fichier.extension);

    const lire = async (cote) => {
      if (!cote) return null;
      try {
        return await fsp.readFile(fsindex.cheminLong(cote.absolu));
      } catch (err) {
        throw Object.assign(new Error(fsindex.raisonLisible(err)), { code: err.code, chemin: cote.absolu });
      }
    };

    let tamponProd = null;
    let tamponLocal = null;
    try {
      [tamponProd, tamponLocal] = await Promise.all([lire(fichier.prod), lire(fichier.local)]);
    } catch (err) {
      return echec(
        `Fichier illisible (${err.message}) : ${err.chemin}`,
        'Le fichier a peut-être été déplacé ou verrouillé depuis l\'analyse. Relancez une analyse.',
        err
      );
    }

    const resultat = textdiff.comparerTampons(tamponProd, tamponLocal, {
      ignorerEspaces: actuels.options.ignorerEspaces,
      extensionTexte
    });

    const enveloppe = {
      cle: fichier.cle,
      chemin: fichier.chemin,
      statut: fichier.statut,
      local: fichier.local && { ...fichier.local, hash: fichier.local.hash || null },
      prod: fichier.prod && { ...fichier.prod, hash: fichier.prod.hash || null },
      ...resultat
    };

    if (resultat.type === 'texte') {
      enveloppe.groupes = textdiff.grouper(resultat.lignes);
      delete enveloppe.lignes;
    }
    if (resultat.type === 'binaire') {
      enveloppe.hashLocal = fichier.local ? await empreinteSure(fichier.local.absolu) : null;
      enveloppe.hashProd = fichier.prod ? await empreinteSure(fichier.prod.absolu) : null;
    }

    return succes({ diff: enveloppe });
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
    return succes({ diff: enveloppe });
  });

  gerer('fichier:restaurerVersion', async (parametres) => {
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
      invaliderCache: (chemin) => cacheHash.invalider(chemin)
    });
    cacheHash.enregistrer();

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
    return succes({ manifeste: resultat.manifeste, chemins: resultat.chemins, rapport: resultat.rapport });
  });
}

async function empreinteSure(chemin) {
  try {
    return await fsindex.hashFichier(chemin);
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AVMDF
// ---------------------------------------------------------------------------

function handlersAvmdf() {
  gerer('avmdf:demandes', async () => {
    const actuels = reglages();
    const { demandes, erreur } = await avmdf.listerDemandes(actuels.racines.avmdf);
    if (erreur) {
      return echec(erreur, 'Vérifiez la racine des archives dans les réglages.');
    }
    return succes({ demandes, racine: actuels.racines.avmdf });
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

  // L'archivage se fait, sauf renoncement explicite : le défaut n'est jamais
  // la perte de l'état antérieur.
  //
  // La case ne concerne que les mises en production. Supprimer un orphelin
  // sans en garder de copie serait sans retour, et le bandeau ne propose
  // d'ailleurs pas la case dans ce cas : on ne se fie pas à ce que le renderer
  // envoie.
  const archiver =
    operation === deploy.OPERATION_SUPPRESSION ? true : parametres.archiver !== false;

  // La case gouverne tout le versant AVMDF. Décochée, la demande et le sprint
  // ne sont ni demandés ni lus, et rien n'est écrit sous la racine des
  // archives, pas même le manifeste : un passage à moitié archivé serait plus
  // difficile à expliquer qu'un passage qui ne l'est pas du tout. Le journal,
  // lui, garde la trace dans tous les cas.
  const demande = avmdf.normaliserDemande(parametres.demande);

  let destination = null;
  if (archiver) {
    if (!demande) {
      return { erreur: echec('Aucune demande choisie.', 'Choisissez ou créez une demande AVMDF dans le panneau de destination.') };
    }
    destination = avmdf.resoudreDestination(actuels.racines.avmdf, demande.nom, parametres.sprint);
    if (!destination.valide) {
      return { erreur: echec(destination.erreur, 'Corrigez le nom du dossier de sprint.') };
    }
  }

  return {
    plan: {
      projet: dernierScan.projet || '(dossiers libres)',
      racineLocale: dernierScan.cheminLocal,
      racineProd: dernierScan.cheminProd,
      racineAvmdf: actuels.racines.avmdf,
      demande: destination ? demande.nom : null,
      sprint: destination ? parametres.sprint.trim() : null,
      dossierSauvegarde: destination ? destination.chemin : null,
      auteur: actuels.options.auteur,
      simulation: Boolean(parametres.simulation),
      archiver,
      operation,
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
    operationEnCours = signal;
    try {
      const controle = await deploy.preflight(plan, {
        concurrence: actuels.options.lecturesSimultanees,
        signal,
        surProgression: (avancement) => emettre('deploiement:progression', avancement)
      });
      return succes({
        controle: {
          ok: controle.ok,
          bloquants: controle.bloquants,
          avertissements: controle.avertissements
        },
        resume: resumePlan(plan)
      });
    } finally {
      operationEnCours = null;
    }
  });

  gerer('deploiement:executer', async (parametres) => {
    const { plan, erreur, actuels } = construirePlan(parametres);
    if (erreur) return erreur;

    // Le préflight est rejoué juste avant d'écrire : entre la fenêtre de
    // confirmation et le clic, la production a pu bouger.
    const controle = await deploy.preflight(plan, {
      concurrence: actuels.options.lecturesSimultanees
    });
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
      plan.archiver ? 'INFO' : 'ALERTE',
      `${plan.simulation ? 'simulation' : 'mise en production'} : ${plan.fichiers.length} fichier(s) ` +
        `vers ${plan.racineProd} (${plan.operation})` +
        (plan.dossierSauvegarde ? ` - archives ${plan.dossierSauvegarde}` : '') +
        (plan.archiver ? '' : ' - SANS archivage AVMDF, passage non réversible') +
        (!plan.archiver && !plan.dossierSauvegarde ? ' et sans manifeste' : '')
    );

    try {
      const resultat = await deploy.executer(plan, {
        signal,
        extensionsTexte: actuels.extensionsTexte,
        ignorerEspaces: actuels.options.ignorerEspaces,
        invaliderCache: (chemin) => cacheHash.invalider(chemin),
        surProgression: (avancement) => emettre('deploiement:progression', avancement)
      });
      cacheHash.enregistrer();

      const r = resultat.rapport;
      carnet.ecrire(
        r.echecs ? 'ERREUR' : 'INFO',
        `${plan.simulation ? 'simulation' : 'mise en production'} terminée - ` +
          `${r.remplacements} remplacé(s), ${r.creations} créé(s), ${r.suppressions} supprimé(s), ` +
          `${r.echecs} échec(s)` +
          (resultat.chemins.manifeste ? ` - manifeste ${resultat.chemins.manifeste}` : '')
      );

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
  });

  gerer('deploiement:annuler', () => {
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
    racineProd: plan.racineProd,
    auteur: plan.auteur,
    operation: plan.operation,
    simulation: plan.simulation,
    archiver: plan.archiver,
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
  gerer('historique:lister', async () => {
    const actuels = reglages();
    const { manifestes, erreurs } = await deploy.listerManifestes(actuels.racines.avmdf);
    return succes({ manifestes, erreurs, racine: actuels.racines.avmdf });
  });

  gerer('statistiques:calculer', async () => {
    const actuels = reglages();
    const { manifestes, erreurs } = await deploy.listerManifestes(actuels.racines.avmdf);
    return succes({
      stats: stats.calculer(manifestes),
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
    return succes({ diff: enveloppe });
  });

  gerer('historique:preparerRestauration', async (parametres) => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;

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

  gerer('historique:restaurer', async (parametres) => {
    const actuels = reglages();
    const manifeste = await lireManifesteSur(parametres.cheminManifeste, actuels);
    if (manifeste.erreur) return manifeste.erreur;

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
        surProgression: (avancement) => emettre('deploiement:progression', avancement)
      });
      cacheHash.enregistrer();
      carnet.ecrire(
        resultat.rapport.echecs ? 'ERREUR' : 'INFO',
        `retour arrière terminé - ${resultat.rapport.total} fichier(s), ${resultat.rapport.echecs} échec(s)`
      );
      return succes({ manifeste: resultat.manifeste, chemins: resultat.chemins, rapport: resultat.rapport });
    } finally {
      operationEnCours = null;
    }
  });
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
    title: 'AVMDF - Mise en production',
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
    handlersAvmdf();
    handlersDeploiement();
    handlersHistorique();
    handlersSysteme();
    creerFenetre();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) creerFenetre();
    });
  });

  app.on('before-quit', () => {
    if (analyseEnCours) analyseEnCours.annuler();
    if (operationEnCours) operationEnCours.annuler();
    if (cacheHash) cacheHash.enregistrer();
    if (carnet) carnet.ecrire('INFO', 'application fermée');
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
