'use strict';

/**
 * miseajour.js - récupération de la dernière version au lancement.
 *
 * L'application installée (setup) interroge les releases GitHub du dépôt,
 * télécharge la nouvelle version en arrière-plan si elle existe, puis propose
 * de redémarrer ; refuser installe quand même à la fermeture. Tout échec est
 * silencieux pour l'utilisateur et tracé au journal : un poste sans accès à
 * GitHub démarre exactement comme avant.
 *
 * La vérification ne concerne que l'application installée : l'exécutable
 * portable ne sait pas se remplacer lui-même, il n'interroge rien.
 */

const { app, dialog } = require('electron');

/**
 * @param {object} parametres
 * @param {() => import('electron').BrowserWindow | null} parametres.laFenetre
 * @param {{ecrire: (niveau: string, message: string) => void}} parametres.carnet
 */
function verifierMiseAJour({ laFenetre, carnet }) {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    carnet.ecrire('ALERTE', `mise à jour : module indisponible (${err.message})`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (infos) => {
    carnet.ecrire('INFO', `mise à jour : version ${infos.version} disponible, téléchargement en cours`);
  });

  autoUpdater.on('update-not-available', () => {
    carnet.ecrire('INFO', 'mise à jour : application à jour');
  });

  autoUpdater.on('error', (err) => {
    // Pas de GitHub depuis ce poste, dépôt inaccessible, coupure : l'outil
    // fonctionne sans, personne n'est interrompu pour ça.
    carnet.ecrire('ALERTE', `mise à jour : vérification impossible (${err.message ? err.message.split('\n')[0] : err})`);
  });

  autoUpdater.on('update-downloaded', async (infos) => {
    carnet.ecrire('INFO', `mise à jour : version ${infos.version} téléchargée`);
    const fenetre = laFenetre();
    if (!fenetre) return;
    const { response } = await dialog.showMessageBox(fenetre, {
      type: 'info',
      title: 'Mise à jour',
      message: `La version ${infos.version} est prête.`,
      detail:
        'Redémarrer maintenant pour l\'installer ? « À la fermeture » l\'installera au prochain arrêt de l\'application.',
      buttons: ['Redémarrer maintenant', 'À la fermeture'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((err) => {
    carnet.ecrire('ALERTE', `mise à jour : vérification impossible (${err.message ? err.message.split('\n')[0] : err})`);
  });
}

module.exports = { verifierMiseAJour };
