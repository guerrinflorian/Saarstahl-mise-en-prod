'use strict';

/**
 * stats.js - agrégation des manifestes en statistiques pour le tableau de bord.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM. Il travaille sur la
 * liste produite par `deploy.listerManifestes`, c'est-à-dire sur ce qui est
 * réellement écrit dans le dossier d'archives. Les simulations sont comptées à
 * part et n'entrent dans aucun total de production.
 */

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function moisDe(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { annee: date.getFullYear(), mois: date.getMonth() };
}

function cleMois(annee, mois) {
  return annee + '-' + String(mois + 1).padStart(2, '0');
}

/**
 * @param {object[]} manifestes liste triée du plus récent au plus ancien
 * @param {Date} [maintenant]
 * @returns {object} statistiques prêtes à afficher
 */
function calculer(manifestes, maintenant = new Date()) {
  const reels = manifestes.filter((m) => !m.simulation);
  const simulations = manifestes.length - reels.length;

  const deploiements = reels.filter((m) => !m.operation || m.operation === 'deploiement');
  const suppressions = reels.filter((m) => m.operation === 'suppression');
  const restaurations = reels.filter((m) => m.operation === 'restauration');

  // Totaux de production : uniquement les déploiements réels.
  let fichiersDeployes = 0;
  let lignesAjoutees = 0;
  let lignesSupprimees = 0;
  let echecs = 0;
  for (const manifeste of reels) {
    const resume = manifeste.resume || {};
    echecs += resume.echecs || 0;
  }
  for (const manifeste of deploiements) {
    const resume = manifeste.resume || {};
    fichiersDeployes += (resume.remplacements || 0) + (resume.creations || 0);
    lignesAjoutees += resume.lignesAjoutees || 0;
    lignesSupprimees += resume.lignesSupprimees || 0;
  }

  // Activité des douze derniers mois, mois courant compris.
  const parMois = [];
  const indexMois = new Map();
  for (let i = 11; i >= 0; i -= 1) {
    const date = new Date(maintenant.getFullYear(), maintenant.getMonth() - i, 1);
    const cle = cleMois(date.getFullYear(), date.getMonth());
    indexMois.set(cle, parMois.length);
    parMois.push({
      cle,
      libelle: MOIS_COURTS[date.getMonth()],
      annee: date.getFullYear(),
      deploiements: 0,
      fichiers: 0
    });
  }
  for (const manifeste of deploiements) {
    const quand = moisDe(manifeste.date);
    if (!quand) continue;
    const position = indexMois.get(cleMois(quand.annee, quand.mois));
    if (position === undefined) continue;
    parMois[position].deploiements += 1;
    const resume = manifeste.resume || {};
    parMois[position].fichiers += (resume.remplacements || 0) + (resume.creations || 0);
  }

  // Répartition par projet et par auteur.
  const projets = new Map();
  const auteurs = new Map();
  for (const manifeste of deploiements) {
    const resume = manifeste.resume || {};
    const nombreFichiers = (resume.remplacements || 0) + (resume.creations || 0);
    const projet = manifeste.projet || '(sans projet)';
    const entreeProjet = projets.get(projet) || { nom: projet, deploiements: 0, fichiers: 0 };
    entreeProjet.deploiements += 1;
    entreeProjet.fichiers += nombreFichiers;
    projets.set(projet, entreeProjet);

    const auteur = manifeste.auteur || '(sans auteur)';
    const entreeAuteur = auteurs.get(auteur) || { nom: auteur, deploiements: 0, fichiers: 0 };
    entreeAuteur.deploiements += 1;
    entreeAuteur.fichiers += nombreFichiers;
    auteurs.set(auteur, entreeAuteur);
  }

  // Fichiers les plus déployés : les points chauds du projet. Un fichier qui
  // repart en production toutes les semaines mérite qu'on le sache.
  const fichiers = new Map();
  for (const manifeste of deploiements) {
    for (const fichier of manifeste.fichiers || []) {
      if (fichier.erreur) continue;
      if (fichier.action !== 'remplacement' && fichier.action !== 'creation') continue;
      const cle = String(fichier.chemin || '').toLowerCase();
      const entree = fichiers.get(cle) || {
        chemin: fichier.chemin,
        passages: 0,
        lignesAjoutees: 0,
        lignesSupprimees: 0,
        derniereFois: null,
        derniereDemande: null
      };
      entree.passages += 1;
      entree.lignesAjoutees += fichier.lignesAjoutees || 0;
      entree.lignesSupprimees += fichier.lignesSupprimees || 0;
      if (!entree.derniereFois || String(manifeste.date) > String(entree.derniereFois)) {
        entree.derniereFois = manifeste.date;
        entree.derniereDemande = manifeste.demande;
      }
      fichiers.set(cle, entree);
    }
  }

  // Volume réellement écrit, et répartition par type de fichier.
  let octetsDeployes = 0;
  const extensions = new Map();
  for (const manifeste of deploiements) {
    for (const fichier of manifeste.fichiers || []) {
      if (fichier.erreur) continue;
      if (fichier.action !== 'remplacement' && fichier.action !== 'creation') continue;
      octetsDeployes += fichier.tailleApres || 0;
      const chemin = String(fichier.chemin || '');
      const nom = chemin.split(/[\\/]/).pop() || '';
      const point = nom.lastIndexOf('.');
      const extension = point > 0 ? nom.slice(point).toLowerCase() : '(sans extension)';
      const entree = extensions.get(extension) || { nom: extension, fichiers: 0 };
      entree.fichiers += 1;
      extensions.set(extension, entree);
    }
  }

  // Le rythme de la semaine : à quels jours partent les mises en production.
  const parJourSemaine = [
    { nom: 'lun.', deploiements: 0 },
    { nom: 'mar.', deploiements: 0 },
    { nom: 'mer.', deploiements: 0 },
    { nom: 'jeu.', deploiements: 0 },
    { nom: 'ven.', deploiements: 0 },
    { nom: 'sam.', deploiements: 0 },
    { nom: 'dim.', deploiements: 0 }
  ];
  for (const manifeste of deploiements) {
    const date = new Date(manifeste.date);
    if (Number.isNaN(date.getTime())) continue;
    parJourSemaine[(date.getDay() + 6) % 7].deploiements += 1;
  }

  // Les demandes revisitées : plusieurs passages sous le même numéro AVMDF,
  // c'est l'histoire d'une intervention qui a demandé plusieurs allers.
  // AVMDFMINEUR n'en est pas une : les passages mineurs s'y accumulent par
  // définition, ils écraseraient toujours ce classement sans rien raconter.
  const parDemande = new Map();
  for (const manifeste of deploiements) {
    if (!manifeste.demande) continue;
    if (String(manifeste.demande).toUpperCase() === 'AVMDFMINEUR') continue;
    const entree = parDemande.get(manifeste.demande) || {
      demande: manifeste.demande,
      passages: 0,
      sprints: new Set(),
      derniereFois: null
    };
    entree.passages += 1;
    if (manifeste.sprint) entree.sprints.add(manifeste.sprint);
    if (!entree.derniereFois || String(manifeste.date) > String(entree.derniereFois)) {
      entree.derniereFois = manifeste.date;
    }
    parDemande.set(manifeste.demande, entree);
  }
  const demandesRevisitees = [...parDemande.values()]
    .filter((d) => d.passages > 1)
    .sort((a, b) => b.passages - a.passages || String(b.derniereFois).localeCompare(String(a.derniereFois)))
    .slice(0, 6)
    .map((d) => ({ demande: d.demande, passages: d.passages, sprints: d.sprints.size, derniereFois: d.derniereFois }));

  // La cadence : l'écart moyen entre deux passages réels.
  let cadenceJours = null;
  if (deploiements.length > 1) {
    const premier = Date.parse(deploiements[deploiements.length - 1].date);
    const dernierTemps = Date.parse(deploiements[0].date);
    if (!Number.isNaN(premier) && !Number.isNaN(dernierTemps) && dernierTemps > premier) {
      cadenceJours = (dernierTemps - premier) / 86400000 / (deploiements.length - 1);
    }
  }

  const demandes = new Set(deploiements.map((m) => m.demande).filter(Boolean));
  const dernier = deploiements[0] || null;

  return {
    totaux: {
      deploiements: deploiements.length,
      restaurations: restaurations.length,
      suppressions: suppressions.length,
      simulations,
      fichiersDeployes,
      lignesAjoutees,
      lignesSupprimees,
      echecs,
      demandes: demandes.size,
      octetsDeployes,
      cadenceJours
    },
    dernier: dernier
      ? {
          date: dernier.date,
          demande: dernier.demande,
          sprint: dernier.sprint,
          projet: dernier.projet,
          auteur: dernier.auteur,
          chemin: dernier.chemin || null,
          fichiers:
            ((dernier.resume || {}).remplacements || 0) + ((dernier.resume || {}).creations || 0),
          echecs: (dernier.resume || {}).echecs || 0
        }
      : null,
    parMois,
    parJourSemaine,
    parExtension: [...extensions.values()].sort((a, b) => b.fichiers - a.fichiers).slice(0, 8),
    demandesRevisitees,
    parProjet: [...projets.values()].sort((a, b) => b.deploiements - a.deploiements),
    parAuteur: [...auteurs.values()].sort((a, b) => b.deploiements - a.deploiements).slice(0, 6),
    fichiersChauds: [...fichiers.values()]
      .sort((a, b) => b.passages - a.passages || String(b.derniereFois).localeCompare(String(a.derniereFois)))
      .slice(0, 10),
    recents: reels.slice(0, 8).map((manifeste) => ({
      date: manifeste.date,
      demande: manifeste.demande,
      sprint: manifeste.sprint,
      projet: manifeste.projet,
      auteur: manifeste.auteur,
      operation: manifeste.operation || 'deploiement',
      commentaire: manifeste.commentaire || null,
      total: (manifeste.resume || {}).total || 0,
      echecs: (manifeste.resume || {}).echecs || 0
    }))
  };
}

module.exports = { calculer };
