'use strict';

/**
 * preload.js — pont entre le renderer et le processus principal.
 *
 * Le renderer ne reçoit que les fonctions listées ici : ni `ipcRenderer`,
 * ni `require`, ni accès au système de fichiers.
 *
 * Toutes les fonctions renvoient une promesse résolue sur un objet
 * `{ ok: true, … }` ou `{ ok: false, erreur: { message, conseil, code } }`.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avmdf', {
  systeme: {
    /** Versions, utilisateur courant, chemins de l'application. */
    infos: () => ipcRenderer.invoke('systeme:infos')
  },

  config: {
    /** Lit les réglages enregistrés (valeurs par défaut au premier lancement). */
    lire: () => ipcRenderer.invoke('config:lire'),
    /** Renvoie les valeurs par défaut, sans rien écrire ni remplacer. */
    defauts: () => ipcRenderer.invoke('config:defauts'),
    /** Contrôle un brouillon de réglages sans rien écrire. */
    verifier: (reglages) => ipcRenderer.invoke('config:verifier', reglages),
    /** Valide puis écrit les réglages. */
    enregistrer: (reglages) => ipcRenderer.invoke('config:enregistrer', reglages),
    /** Réécrit un jeu de réglages neuf. */
    reinitialiser: () => ipcRenderer.invoke('config:reinitialiser'),
    /** Ouvre l'explorateur sur le fichier config.json. */
    revelerFichier: () => ipcRenderer.invoke('config:revelerFichier')
  },

  dialogue: {
    /** Sélecteur de dossier natif. Renvoie `{ annule, chemin }`. */
    choisirDossier: (parametres) => ipcRenderer.invoke('dialogue:choisirDossier', parametres)
  }
});
