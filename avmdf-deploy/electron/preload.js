'use strict';

/**
 * preload.js - pont entre le renderer et le processus principal.
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
    /** Affiche un dossier de l'analyse, côté local ou côté production. */
    revelerDossier: (chemin, cote) => ipcRenderer.invoke('systeme:revelerDossier', { chemin, cote }),
    /** Copie un texte dans le presse-papiers. */
    copier: (texte) => ipcRenderer.invoke('systeme:copier', texte),
    /** Accorde le fond de la fenêtre au thème, pour les redimensionnements. */
    fondFenetre: (couleur) => ipcRenderer.invoke('systeme:fondFenetre', couleur)
  },

  config: {
    lire: () => ipcRenderer.invoke('config:lire'),
    defauts: () => ipcRenderer.invoke('config:defauts'),
    verifier: (reglages) => ipcRenderer.invoke('config:verifier', reglages),
    /** Existence et lisibilité réelles des trois racines. */
    controlerRacines: (racines) => ipcRenderer.invoke('config:controlerRacines', racines),
    enregistrer: (reglages) => ipcRenderer.invoke('config:enregistrer', reglages),
    reinitialiser: () => ipcRenderer.invoke('config:reinitialiser'),
    exclureFichier: (nom) => ipcRenderer.invoke('config:exclureFichier', nom),
    exclureDossier: (motif) => ipcRenderer.invoke('config:exclureDossier', motif),
    revelerFichier: () => ipcRenderer.invoke('config:revelerFichier')
  },

  dialogue: {
    choisirDossier: (parametres) => ipcRenderer.invoke('dialogue:choisirDossier', parametres)
  },

  analyse: {
    /** Compare récursivement les deux arborescences. */
    demarrer: (parametres) => ipcRenderer.invoke('analyse:demarrer', parametres),
    annuler: () => ipcRenderer.invoke('analyse:annuler'),
    /** Re-stat et re-hash un seul fichier, des deux côtés, sans relire le partage. */
    rafraichirFichier: (cle) => ipcRenderer.invoke('analyse:rafraichirFichier', { cle }),
    surProgression: (rappel) => abonner('analyse:progression', rappel)
  },

  recherche: {
    /** Cherche une chaîne dans le contenu des fichiers texte des deux côtés. */
    dansLeContenu: (parametres) => ipcRenderer.invoke('recherche:contenu', parametres),
    annuler: () => ipcRenderer.invoke('recherche:annuler'),
    surProgression: (rappel) => abonner('recherche:progression', rappel)
  },

  references: {
    /** Construit l'index « qui utilise ce fichier » sur la dernière analyse. */
    analyser: () => ipcRenderer.invoke('references:analyser'),
    annuler: () => ipcRenderer.invoke('references:annuler'),
    /** Références d'un fichier : qui l'utilise, et ce qu'il utilise. */
    fichier: (cle) => ipcRenderer.invoke('references:fichier', { cle }),
    surProgression: (rappel) => abonner('references:progression', rappel)
  },

  frise: {
    /** L'histoire d'un fichier : passages en production et versions archivées. */
    fichier: (chemin) => ipcRenderer.invoke('frise:fichier', { chemin })
  },

  fichier: {
    /** Comparaison ligne à ligne d'un fichier de la dernière analyse. */
    diff: (cle, options = {}) =>
      ipcRenderer.invoke('fichier:diff', { cle, ignorerEspaces: options.ignorerEspaces }),
    /** Contenu décodé de la version locale, pour l'éditeur intégré. */
    lireLocal: (cle) => ipcRenderer.invoke('fichier:lireLocal', { cle }),
    /** Réécrit la version locale dans son enveloppe d'origine (encodage, BOM, fins de ligne). */
    enregistrerLocal: (cle, texte, empreinte) =>
      ipcRenderer.invoke('fichier:enregistrerLocal', { cle, texte, empreinte }),
    /** Versions « avant modification » archivées sous la racine AVMDF. */
    versions: (cle) => ipcRenderer.invoke('fichier:versions', { cle }),
    /** Compare une version archivée à la production actuelle. */
    comparerVersion: (cle, cheminVersion) =>
      ipcRenderer.invoke('fichier:comparerVersion', { cle, cheminVersion }),
    /** Remet une version archivée en production, après archivage de l'actuelle. */
    restaurerVersion: (parametres) => ipcRenderer.invoke('fichier:restaurerVersion', parametres)
  },

  avmdf: {
    demandes: () => ipcRenderer.invoke('avmdf:demandes'),
    inspecter: (demande) => ipcRenderer.invoke('avmdf:inspecter', { demande }),
    inspecterSprint: (demande, sprint) => ipcRenderer.invoke('avmdf:inspecterSprint', { demande, sprint }),
    creerDemande: (demande) => ipcRenderer.invoke('avmdf:creerDemande', { demande })
  },

  deploiement: {
    /** Contrôles préalables : rien n'est écrit. */
    preflight: (parametres) => ipcRenderer.invoke('deploiement:preflight', parametres),
    executer: (parametres) => ipcRenderer.invoke('deploiement:executer', parametres),
    annuler: () => ipcRenderer.invoke('deploiement:annuler'),
    surProgression: (rappel) => abonner('deploiement:progression', rappel)
  },

  statistiques: {
    /** Agrège tous les manifestes du dossier d'archives pour le tableau de bord. */
    calculer: () => ipcRenderer.invoke('statistiques:calculer')
  },

  historique: {
    lister: () => ipcRenderer.invoke('historique:lister'),
    comparer: (cheminManifeste, chemin) =>
      ipcRenderer.invoke('historique:comparer', { cheminManifeste, chemin }),
    /** Re-hash la production et la confronte aux empreintes d'un manifeste. Ne lit que, n'écrit rien. */
    verifierProduction: (cheminManifeste) =>
      ipcRenderer.invoke('historique:verifierProduction', { cheminManifeste }),
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
