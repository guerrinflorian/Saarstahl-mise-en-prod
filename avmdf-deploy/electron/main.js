'use strict';

/**
 * main.js — fenêtre principale et handlers IPC.
 *
 * Ce fichier ne contient aucune logique métier : elle vit dans `core/`.
 * Toute écriture sur le disque passe par ici ; le renderer n'a aucun accès
 * direct au système de fichiers.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');

const config = require('./core/config');

const MODE_DEV = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let fenetre = null;
/** @type {ReturnType<typeof config.creerDepot> | null} */
let depotConfig = null;
/** Avertissements produits au premier chargement (fichier corrompu, droits…). */
let avertissementsDemarrage = [];

// ---------------------------------------------------------------------------
// Réponses IPC : une forme unique, jamais d'exception qui traverse le pont
// ---------------------------------------------------------------------------

function succes(donnees) {
  return Object.assign({ ok: true }, donnees);
}

/**
 * @param {string} message ce qui s'est passé
 * @param {string} conseil ce qu'il faut faire
 * @param {Error} [cause]
 */
function echec(message, conseil, cause) {
  if (cause) {
    console.error('[avmdf]', message, cause);
  }
  return {
    ok: false,
    erreur: {
      message,
      conseil,
      code: cause && cause.code ? cause.code : null
    }
  };
}

/**
 * Enregistre un handler IPC en le protégeant : une exception inattendue
 * devient une réponse d'échec lisible au lieu d'une promesse rejetée.
 */
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
      return echec(
        `Erreur inattendue pendant « ${canal} » : ${err.message}`,
        'Relancez l\'application ; si le problème persiste, consultez la console (Ctrl+Maj+I).',
        err
      );
    }
  });
}

/** Seule la fenêtre de l'application peut appeler les handlers. */
function expediteurAutorise(evenement) {
  return Boolean(fenetre) && evenement.sender === fenetre.webContents;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function enregistrerHandlers() {
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
        modeDev: MODE_DEV
      },
      avertissements
    });
  });

  gerer('config:lire', () => {
    const { config: reglages, existait, avertissements } = depotConfig.charger();
    return succes({
      config: reglages,
      existait,
      avertissements,
      controle: config.verifier(reglages)
    });
  });

  gerer('config:defauts', () => {
    return succes({ config: config.reglagesParDefaut(contexteConfig()) });
  });

  gerer('config:verifier', (reglages) => {
    const propre = config.normaliser(reglages, contexteConfig());
    return succes({ controle: config.verifier(propre) });
  });

  gerer('config:enregistrer', (reglages) => {
    const propre = config.normaliser(reglages, contexteConfig());
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

  gerer('config:revelerFichier', async () => {
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
    if (resultat.canceled || !resultat.filePaths.length) {
      return succes({ annule: true, chemin: '' });
    }
    return succes({ annule: false, chemin: resultat.filePaths[0] });
  });
}

function contexteConfig() {
  return { utilisateur: process.env.USERNAME || process.env.USER || '' };
}

// ---------------------------------------------------------------------------
// Fenêtre
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
    title: 'AVMDF — Mise en production',
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

  // Aucune navigation ni fenêtre secondaire : l'application est locale.
  fenetre.webContents.on('will-navigate', (evenement) => evenement.preventDefault());
  fenetre.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  fenetre.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

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

    depotConfig = config.creerDepot(path.join(app.getPath('userData'), 'config.json'), contexteConfig());

    const { existait, avertissements } = depotConfig.charger();
    avertissementsDemarrage = avertissements;
    if (!existait) {
      // Premier lancement : on matérialise le fichier pour que l'utilisateur
      // puisse le voir et l'éditer, avec le mode simulation actif par défaut.
      try {
        depotConfig.reinitialiser();
      } catch (err) {
        avertissementsDemarrage.push(
          `Réglages non enregistrés au premier lancement (${err.code || err.message}) : ` +
            `ils resteront valables pour cette session seulement.`
        );
      }
    }

    enregistrerHandlers();
    creerFenetre();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) creerFenetre();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
