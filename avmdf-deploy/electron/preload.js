'use strict';

/**
 * preload.js — pont entre le renderer et le processus principal.
 *
 * Le renderer ne reçoit que les fonctions listées ici : ni `ipcRenderer`,
 * ni `require`, ni accès au système de fichiers.
 *
 * Toutes les fonctions renvoient une promesse résolue sur un objet
 * `{ ok: true, … }` ou `{ ok: false, erreur: { message, conseil, code } }`.
 *
 * Les abonnements (`sur…`) renvoient une fonction de désinscription et ne
 * transmettent que les données, jamais l'événement Electron.
 */

const { contextBridge, ipcRenderer } = require('electron');

function abonner(canal, rappel) {
  const ecouteur = (_evenement, donnees) => rappel(donnees);
  ipcRenderer.on(canal, ecouteur);
  return () => ipcRenderer.removeListener(canal, ecouteur);
}

contextBridge.exposeInMainWorld('avmdf', {
  systeme: {
    /** Versions, utilisateur courant, chemins de l'application. */
    infos: () => ipcRenderer.invoke('systeme:infos'),
    /** Ouvre un fichier avec le programme associé. */
    ouvrir: (chemin) => ipcRenderer.invoke('systeme:ouvrir', { chemin }),
    /** Affiche un fichier dans l'explorateur. */
    reveler: (chemin) => ipcRenderer.invoke('systeme:reveler', { chemin }),
    /** Copie un texte dans le presse-papiers. */
    copier: (texte) => ipcRenderer.invoke('systeme:copier', texte)
  },

  config: {
    lire: () => ipcRenderer.invoke('config:lire'),
    defauts: () => ipcRenderer.invoke('config:defauts'),
    verifier: (reglages) => ipcRenderer.invoke('config:verifier', reglages),
    enregistrer: (reglages) => ipcRenderer.invoke('config:enregistrer', reglages),
    reinitialiser: () => ipcRenderer.invoke('config:reinitialiser'),
    exclureFichier: (nom) => ipcRenderer.invoke('config:exclureFichier', nom),
    revelerFichier: () => ipcRenderer.invoke('config:revelerFichier')
  },

  dialogue: {
    choisirDossier: (parametres) => ipcRenderer.invoke('dialogue:choisirDossier', parametres)
  },

  analyse: {
    /** Compare récursivement les deux arborescences. */
    demarrer: (parametres) => ipcRenderer.invoke('analyse:demarrer', parametres),
    annuler: () => ipcRenderer.invoke('analyse:annuler'),
    surProgression: (rappel) => abonner('analyse:progression', rappel)
  },

  recherche: {
    /** Cherche une chaîne dans le contenu des fichiers texte des deux côtés. */
    dansLeContenu: (parametres) => ipcRenderer.invoke('recherche:contenu', parametres),
    annuler: () => ipcRenderer.invoke('recherche:annuler'),
    surProgression: (rappel) => abonner('recherche:progression', rappel)
  },

  fichier: {
    /** Comparaison ligne à ligne d'un fichier de la dernière analyse. */
    diff: (cle) => ipcRenderer.invoke('fichier:diff', { cle })
  },

  avmdf: {
    tickets: () => ipcRenderer.invoke('avmdf:tickets'),
    inspecter: (ticket) => ipcRenderer.invoke('avmdf:inspecter', { ticket }),
    inspecterSprint: (ticket, sprint) => ipcRenderer.invoke('avmdf:inspecterSprint', { ticket, sprint }),
    creerTicket: (ticket) => ipcRenderer.invoke('avmdf:creerTicket', { ticket })
  },

  deploiement: {
    /** Contrôles préalables : rien n'est écrit. */
    preflight: (parametres) => ipcRenderer.invoke('deploiement:preflight', parametres),
    executer: (parametres) => ipcRenderer.invoke('deploiement:executer', parametres),
    annuler: () => ipcRenderer.invoke('deploiement:annuler'),
    surProgression: (rappel) => abonner('deploiement:progression', rappel)
  },

  historique: {
    lister: () => ipcRenderer.invoke('historique:lister'),
    comparer: (cheminManifeste, chemin) =>
      ipcRenderer.invoke('historique:comparer', { cheminManifeste, chemin }),
    preparerRestauration: (cheminManifeste) =>
      ipcRenderer.invoke('historique:preparerRestauration', { cheminManifeste }),
    restaurer: (cheminManifeste, simulation) =>
      ipcRenderer.invoke('historique:restaurer', { cheminManifeste, simulation })
  },

  journal: {
    lister: () => ipcRenderer.invoke('journal:lister'),
    lire: (nom) => ipcRenderer.invoke('journal:lire', nom),
    ouvrirDossier: () => ipcRenderer.invoke('journal:ouvrirDossier')
  }
});
