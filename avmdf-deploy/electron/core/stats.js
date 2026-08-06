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
        dernierTicket: null
      };
      entree.passages += 1;
      entree.lignesAjoutees += fichier.lignesAjoutees || 0;
      entree.lignesSupprimees += fichier.lignesSupprimees || 0;
      if (!entree.derniereFois || String(manifeste.date) > String(entree.derniereFois)) {
        entree.derniereFois = manifeste.date;
        entree.dernierTicket = manifeste.ticket;
      }
      fichiers.set(cle, entree);
    }
  }

  const tickets = new Set(deploiements.map((m) => m.ticket).filter(Boolean));
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
      tickets: tickets.size
    },
    dernier: dernier
      ? {
          date: dernier.date,
          ticket: dernier.ticket,
          sprint: dernier.sprint,
          projet: dernier.projet,
          auteur: dernier.auteur,
          fichiers:
            ((dernier.resume || {}).remplacements || 0) + ((dernier.resume || {}).creations || 0),
          echecs: (dernier.resume || {}).echecs || 0
        }
      : null,
    parMois,
    parProjet: [...projets.values()].sort((a, b) => b.deploiements - a.deploiements),
    parAuteur: [...auteurs.values()].sort((a, b) => b.deploiements - a.deploiements).slice(0, 6),
    fichiersChauds: [...fichiers.values()]
      .sort((a, b) => b.passages - a.passages || String(b.derniereFois).localeCompare(String(a.derniereFois)))
      .slice(0, 10),
    recents: reels.slice(0, 8).map((manifeste) => ({
      date: manifeste.date,
      ticket: manifeste.ticket,
      sprint: manifeste.sprint,
      projet: manifeste.projet,
      auteur: manifeste.auteur,
      operation: manifeste.operation || 'deploiement',
      total: (manifeste.resume || {}).total || 0,
      echecs: (manifeste.resume || {}).echecs || 0
    }))
  };
}

module.exports = { calculer };
