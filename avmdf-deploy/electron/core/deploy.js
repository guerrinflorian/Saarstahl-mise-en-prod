'use strict';

/**
 * deploy.js - contrôles préalables, sauvegarde, copie, manifeste et retour
 * arrière.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Règles non négociables :
 *   - rien n'est écrasé sans avoir été archivé au préalable, aucune exception ;
 *   - la copie est binaire, octet pour octet : aucun ré-encodage, aucune
 *     normalisation des fins de ligne ;
 *   - toute destination est vérifiée comme étant sous la racine de production
 *     ou sous la racine d'archives avant la moindre écriture ;
 *   - un fichier en échec n'interrompt pas les autres, il est remonté dans le
 *     rapport final.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { cheminLong, hashFichier, joindreRelatif, pool, raisonLisible } = require('./fsindex');
const { estSousRacine } = require('./avmdf');
const textdiff = require('./textdiff');

const ACTION_REMPLACEMENT = 'remplacement';
const ACTION_CREATION = 'creation';
const ACTION_SUPPRESSION = 'suppression';
const ACTION_RESTAURATION = 'restauration';

const OPERATION_DEPLOIEMENT = 'deploiement';
const OPERATION_SUPPRESSION = 'suppression';

const BLOQUANT = 'bloquant';
const AVERTISSEMENT = 'avertissement';

const NOM_APP_OFFLINE = 'app_offline.htm';

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

function horodatageFichier(date = new Date()) {
  // Millisecondes comprises : deux mises en production dans la même seconde ne
  // doivent pas écrire dans le même manifeste.
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 23);
}

function probleme(niveau, code, message, conseil, fichiers) {
  return { niveau, code, message, conseil: conseil || '', fichiers: fichiers || [] };
}

/** Copie binaire en conservant la date de modification de la source. */
async function copierAvecDate(source, destination) {
  await fsp.mkdir(cheminLong(path.dirname(destination)), { recursive: true });
  await fsp.copyFile(cheminLong(source), cheminLong(destination));
  const etat = await fsp.stat(cheminLong(source));
  await fsp.utimes(cheminLong(destination), etat.atime, etat.mtime);
}

async function existe(chemin) {
  try {
    await fsp.access(cheminLong(chemin));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Le fichier de destination est-il tenu par IIS ?
 * Une ouverture en écriture est le seul test fiable : un fichier verrouillé se
 * laisse lire mais refuse `r+`.
 */
async function estVerrouille(chemin) {
  let poignee = null;
  try {
    poignee = await fsp.open(cheminLong(chemin), 'r+');
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return err.code;
    return err.code || 'inconnu';
  } finally {
    if (poignee) await poignee.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Contrôles préalables
// ---------------------------------------------------------------------------

/**
 * Tout ce qui peut être vérifié avant la première écriture l'est ici : mieux
 * vaut échouer maintenant qu'à mi-parcours avec la moitié des fichiers déployés.
 *
 * @param {object} plan
 * @param {object} [options]
 * @returns {Promise<{problemes:object[], bloquants:object[], avertissements:object[], ok:boolean, etatsProd:Map}>}
 */
async function preflight(plan, options = {}) {
  const { concurrence = 6, signal = { annule: false }, surProgression = null } = options;
  const problemes = [];
  const etatsProd = new Map();

  // 1. Racines accessibles
  for (const [libelle, racine] of [
    ['locale', plan.racineLocale],
    ['de production', plan.racineProd],
    ['des archives AVMDF', plan.racineAvmdf]
  ]) {
    try {
      const etat = await fsp.stat(cheminLong(racine));
      if (!etat.isDirectory()) throw Object.assign(new Error('pas un dossier'), { code: 'ENOTDIR' });
    } catch (err) {
      problemes.push(
        probleme(
          BLOQUANT,
          'racine',
          `Racine ${libelle} inaccessible (${raisonLisible(err)}) : ${racine}`,
          'Vérifiez que le lecteur réseau est connecté et que vous y avez accès.'
        )
      );
    }
  }

  // 2. Périmètre : aucune écriture hors des racines configurées
  if (!estSousRacine(plan.dossierSauvegarde, plan.racineAvmdf)) {
    problemes.push(
      probleme(
        BLOQUANT,
        'perimetre',
        `Le dossier de sauvegarde sort du dossier d'archives : ${plan.dossierSauvegarde}`,
        'Choisissez une destination située sous ' + plan.racineAvmdf
      )
    );
  }
  const horsPerimetre = plan.fichiers.filter(
    (fichier) => !estSousRacine(joindreRelatif(plan.racineProd, fichier.chemin), plan.racineProd)
  );
  if (horsPerimetre.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'perimetre',
        `${horsPerimetre.length} fichier(s) viseraient une destination hors de la racine de production.`,
        'Relancez une analyse : ces chemins ne sont pas exploitables.',
        horsPerimetre.map((f) => f.chemin)
      )
    );
  }

  // 3. Écriture réellement possible dans le dossier de sauvegarde
  const testEcriture = await verifierEcriture(plan.dossierSauvegarde, plan.racineAvmdf);
  if (!testEcriture.ok) {
    problemes.push(
      probleme(
        BLOQUANT,
        'ecriture',
        `Impossible d'écrire dans le dossier de sauvegarde (${testEcriture.raison}) : ${testEcriture.dossier}`,
        'Vérifiez vos droits sur le dossier d\'archives.'
      )
    );
  }

  // 4. État de chaque fichier : source disparue, destination verrouillée,
  //    modification concurrente depuis l'analyse.
  const disparus = [];
  const verrouilles = [];
  const concurrents = [];
  const tailleChangee = [];
  let faits = 0;

  await pool(
    plan.fichiers,
    concurrence,
    async (fichier) => {
      const cheminProd = joindreRelatif(plan.racineProd, fichier.chemin);

      if (plan.operation !== OPERATION_SUPPRESSION) {
        const cheminLocal = fichier.local ? fichier.local.absolu : joindreRelatif(plan.racineLocale, fichier.chemin);
        try {
          const etat = await fsp.stat(cheminLong(cheminLocal));
          if (fichier.local && etat.size !== fichier.local.taille) {
            tailleChangee.push(fichier.chemin);
          }
        } catch (err) {
          disparus.push(fichier.chemin);
        }
      }

      const codeVerrou = await estVerrouille(cheminProd);
      if (codeVerrou) verrouilles.push(fichier.chemin);

      if (await existe(cheminProd)) {
        try {
          const etat = await fsp.stat(cheminLong(cheminProd));
          const hashActuel = await hashFichier(cheminProd);
          etatsProd.set(fichier.cle || fichier.chemin.toLowerCase(), {
            taille: etat.size,
            mtimeMs: etat.mtimeMs,
            hash: hashActuel
          });
          const attendu = fichier.prod;
          if (attendu) {
            const memeHash = attendu.hash ? attendu.hash === hashActuel : null;
            const memeTailleEtDate =
              attendu.taille === etat.size && Math.abs(attendu.mtimeMs - etat.mtimeMs) < 2000;
            if (memeHash === false || (memeHash === null && !memeTailleEtDate)) {
              concurrents.push(fichier.chemin);
            }
          }
        } catch (err) {
          verrouilles.push(fichier.chemin);
        }
      }

      faits += 1;
      if (surProgression && faits % 10 === 0) {
        surProgression({ phase: 'preflight', faits, total: plan.fichiers.length });
      }
    },
    signal
  );

  if (disparus.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'source',
        `${disparus.length} fichier(s) source ont disparu depuis l'analyse.`,
        'Relancez une analyse avant de déployer.',
        disparus
      )
    );
  }
  if (verrouilles.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'verrou',
        `${verrouilles.length} fichier(s) sont verrouillés en production.`,
        'Fichier verrouillé en production - recyclez le pool IIS ou déposez un app_offline.htm avant de continuer.',
        verrouilles
      )
    );
  }
  if (concurrents.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'concurrence',
        `${concurrents.length} fichier(s) ont changé en production depuis votre analyse.`,
        'Quelqu\'un d\'autre est passé par là. Relancez une analyse pour repartir de l\'état réel.',
        concurrents
      )
    );
  }
  if (tailleChangee.length) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'source-modifiee',
        `${tailleChangee.length} fichier(s) source ont changé depuis l'analyse : c'est la version actuelle qui partira.`,
        'Relancez une analyse si vous voulez revoir les écarts avant de déployer.',
        tailleChangee
      )
    );
  }

  // 5. web.config
  const sensibles = plan.fichiers.filter((f) => /(^|\\)web\.config$/i.test(f.chemin));
  if (sensibles.length) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'web-config',
        `Cette mise en production remplace ${sensibles.length} fichier(s) web.config.`,
        'La chaîne de connexion et les réglages de production seront écrasés par ceux de votre poste. Vérifiez que c\'est bien voulu.',
        sensibles.map((f) => f.chemin)
      )
    );
  }

  // 6. Espace disque
  const octetsNecessaires = plan.fichiers.reduce(
    (total, fichier) => total + (fichier.local ? fichier.local.taille : 0) + (fichier.prod ? fichier.prod.taille : 0),
    0
  );
  const espace = await espaceDisponible(plan.racineProd);
  if (espace !== null && espace < octetsNecessaires * 1.2) {
    problemes.push(
      probleme(
        BLOQUANT,
        'espace',
        `Espace insuffisant sur la destination : ${formaterOctets(espace)} disponibles pour ${formaterOctets(octetsNecessaires)} nécessaires.`,
        'Libérez de la place sur le serveur avant de déployer.'
      )
    );
  } else if (espace === null) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'espace-inconnu',
        'L\'espace disponible sur la destination n\'a pas pu être mesuré.',
        'Vérifiez à l\'œil qu\'il reste de la place sur le partage.'
      )
    );
  }

  const bloquants = problemes.filter((p) => p.niveau === BLOQUANT);
  const avertissements = problemes.filter((p) => p.niveau === AVERTISSEMENT);
  return { problemes, bloquants, avertissements, ok: bloquants.length === 0, etatsProd };
}

/** Test réel : on crée un fichier témoin, puis on le supprime. */
async function verifierEcriture(dossierSouhaite, racine) {
  let dossier = dossierSouhaite;
  // Le dossier de sprint n'existe pas forcément encore : on remonte au premier
  // ancêtre existant, sans jamais sortir de la racine.
  while (!(await existe(dossier)) && estSousRacine(dossier, racine) && dossier !== path.dirname(dossier)) {
    dossier = path.dirname(dossier);
  }
  const temoin = path.join(dossier, `.avmdf-test-${Date.now()}`);
  try {
    await fsp.writeFile(cheminLong(temoin), 'test');
    await fsp.unlink(cheminLong(temoin));
    return { ok: true, dossier };
  } catch (err) {
    return { ok: false, dossier, raison: raisonLisible(err) };
  }
}

async function espaceDisponible(chemin) {
  try {
    const info = await fsp.statfs(cheminLong(chemin));
    return info.bavail * info.bsize;
  } catch (err) {
    return null;
  }
}

function formaterOctets(octets) {
  if (octets === null || octets === undefined) return '-';
  const unites = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let valeur = octets;
  let rang = 0;
  while (valeur >= 1024 && rang < unites.length - 1) {
    valeur /= 1024;
    rang += 1;
  }
  return `${valeur < 10 && rang > 0 ? valeur.toFixed(1) : Math.round(valeur)} ${unites[rang]}`;
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

/**
 * Déroule la mise en production, fichier par fichier.
 *
 * En simulation, tout se déroule à l'identique - empreintes comprises - mais
 * aucun octet n'est écrit.
 *
 * @param {object} plan
 * @param {object} options
 * @returns {Promise<{manifeste:object, chemins:object, rapport:object}>}
 */
async function executer(plan, options = {}) {
  const {
    signal = { annule: false },
    surProgression = null,
    extensionsTexte = [],
    ignorerEspaces = false,
    invaliderCache = null
  } = options;

  const simulation = Boolean(plan.simulation);
  const debut = new Date();
  const resultats = [];
  let appOfflineDepose = false;

  if (!simulation) {
    await fsp.mkdir(cheminLong(plan.dossierSauvegarde), { recursive: true });
  }

  if (plan.appOffline && plan.appOffline.actif) {
    appOfflineDepose = await deposerAppOffline(plan, simulation);
  }

  try {
    // Séquentiel volontairement : une mise en production se suit à la trace, et
    // le partage réseau n'aime pas les écritures parallèles.
    for (let index = 0; index < plan.fichiers.length; index += 1) {
      if (signal.annule) break;
      const fichier = plan.fichiers[index];
      resultats.push(await traiterFichier(fichier, plan, { simulation, extensionsTexte, ignorerEspaces, invaliderCache }));
      if (surProgression) {
        surProgression({ phase: 'copie', faits: index + 1, total: plan.fichiers.length, chemin: fichier.chemin });
      }
    }
  } finally {
    if (appOfflineDepose) await retirerAppOffline(plan, simulation);
  }

  const manifeste = {
    demande: plan.demande,
    sprint: plan.sprint,
    auteur: plan.auteur,
    date: debut.toISOString(),
    projet: plan.projet,
    operation: plan.operation || OPERATION_DEPLOIEMENT,
    racineLocale: plan.racineLocale,
    racineProd: plan.racineProd,
    dossierSauvegarde: plan.dossierSauvegarde,
    simulation,
    annule: signal.annule,
    fichiers: resultats
  };

  const chemins = { manifeste: null, recapitulatif: null };
  if (!simulation) {
    const suffixe = horodatageFichier(debut);
    chemins.manifeste = path.join(plan.dossierSauvegarde, `_deploiement_${suffixe}.json`);
    chemins.recapitulatif = path.join(plan.dossierSauvegarde, '_recapitulatif.md');
    await fsp.writeFile(cheminLong(chemins.manifeste), JSON.stringify(manifeste, null, 2) + '\n', 'utf8');
    await ajouterAuRecapitulatif(chemins.recapitulatif, manifeste);
  }

  return { manifeste, chemins, rapport: resumer(manifeste) };
}

async function traiterFichier(fichier, plan, contexte) {
  const { simulation, extensionsTexte, ignorerEspaces, invaliderCache } = contexte;
  const cheminProd = joindreRelatif(plan.racineProd, fichier.chemin);
  const cheminLocal = fichier.local ? fichier.local.absolu : joindreRelatif(plan.racineLocale, fichier.chemin);
  const cheminSauvegarde = joindreRelatif(plan.dossierSauvegarde, fichier.chemin);
  const suppression = (plan.operation || OPERATION_DEPLOIEMENT) === OPERATION_SUPPRESSION;

  const entree = {
    chemin: fichier.chemin,
    action: suppression ? ACTION_SUPPRESSION : ACTION_CREATION,
    sauvegarde: null,
    hashAvant: null,
    tailleAvant: null,
    hashApres: null,
    tailleApres: null,
    lignesAjoutees: null,
    lignesSupprimees: null,
    erreur: null,
    archiveNonRemplace: false,
    sauvegardeConservee: false
  };

  try {
    const presentEnProd = await existe(cheminProd);

    // 1. Archivage de la version écrasée. Sans exception : si l'archivage
    //    échoue, on ne touche pas au fichier de production.
    if (presentEnProd) {
      if (!suppression) entree.action = ACTION_REMPLACEMENT;
      const etatProd = await fsp.stat(cheminLong(cheminProd));
      entree.tailleAvant = etatProd.size;
      entree.hashAvant = await hashFichier(cheminProd);

      if (!estSousRacine(cheminSauvegarde, plan.racineAvmdf)) {
        throw new Error('destination d\'archivage hors du dossier d\'archives');
      }

      // Un sprint peut être complété en plusieurs passages. La version « avant
      // modification » du sprint est celle du premier passage : on ne l'écrase
      // jamais, sinon l'état d'origine de la demande serait définitivement perdu.
      const dejaArchive = await existe(cheminSauvegarde);
      if (!simulation && !dejaArchive) {
        await copierAvecDate(cheminProd, cheminSauvegarde);
      }
      entree.sauvegarde = fichier.chemin;
      entree.sauvegardeConservee = dejaArchive;
    }

    if (suppression) {
      if (!presentEnProd) {
        entree.erreur = 'déjà absent de la production';
        return entree;
      }
      if (!simulation) await fsp.unlink(cheminLong(cheminProd));
      if (invaliderCache) invaliderCache(cheminProd);
      return entree;
    }

    // 2. Comptage des lignes, avant écrasement, pour le manifeste.
    const extension = path.extname(fichier.chemin).toLowerCase();
    if (extensionsTexte.includes(extension)) {
      const comptes = await compterLignesFichiers(presentEnProd ? cheminProd : null, cheminLocal, {
        ignorerEspaces,
        extensionTexte: true
      });
      entree.lignesAjoutees = comptes.ajoutees;
      entree.lignesSupprimees = comptes.supprimees;
    }

    // 3. Copie binaire vers la production, date locale conservée.
    if (!estSousRacine(cheminProd, plan.racineProd)) {
      throw new Error('destination hors de la racine de production');
    }
    const etatLocal = await fsp.stat(cheminLong(cheminLocal));
    entree.tailleApres = etatLocal.size;
    entree.hashApres = await hashFichier(cheminLocal);

    if (!simulation) {
      try {
        await copierAvecDate(cheminLocal, cheminProd);
      } catch (err) {
        entree.archiveNonRemplace = presentEnProd;
        throw err;
      }
      if (invaliderCache) invaliderCache(cheminProd);
    }
  } catch (err) {
    entree.erreur = `${raisonLisible(err)} - ${err.message}`;
    if (entree.archiveNonRemplace) {
      entree.erreur += ' (la version de production a été archivée mais n\'a PAS été remplacée)';
    }
  }

  return entree;
}

async function compterLignesFichiers(cheminGauche, cheminDroite, options) {
  try {
    const [gauche, droite] = await Promise.all([
      cheminGauche ? fsp.readFile(cheminLong(cheminGauche)) : Promise.resolve(null),
      cheminDroite ? fsp.readFile(cheminLong(cheminDroite)) : Promise.resolve(null)
    ]);
    return textdiff.compterLignes(gauche, droite, options);
  } catch (err) {
    return { ajoutees: null, supprimees: null };
  }
}

async function deposerAppOffline(plan, simulation) {
  const destination = path.join(plan.racineProd, NOM_APP_OFFLINE);
  if (!estSousRacine(destination, plan.racineProd)) return false;
  if (simulation) return true;
  try {
    await fsp.writeFile(cheminLong(destination), plan.appOffline.contenu, 'utf8');
    return true;
  } catch (err) {
    process.emitWarning(`app_offline.htm non déposé : ${err.message}`);
    return false;
  }
}

async function retirerAppOffline(plan, simulation) {
  if (simulation) return;
  const destination = path.join(plan.racineProd, NOM_APP_OFFLINE);
  try {
    await fsp.unlink(cheminLong(destination));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.emitWarning(`app_offline.htm non retiré (${err.message}) : retirez-le à la main, le site reste hors service.`);
    }
  }
}

function resumer(manifeste) {
  const fichiers = manifeste.fichiers;
  const echecs = fichiers.filter((f) => f.erreur);
  return {
    total: fichiers.length,
    remplacements: fichiers.filter((f) => f.action === ACTION_REMPLACEMENT && !f.erreur).length,
    creations: fichiers.filter((f) => f.action === ACTION_CREATION && !f.erreur).length,
    suppressions: fichiers.filter((f) => f.action === ACTION_SUPPRESSION && !f.erreur).length,
    restaurations: fichiers.filter((f) => f.action === ACTION_RESTAURATION && !f.erreur).length,
    echecs: echecs.length,
    archivesNonRemplaces: fichiers.filter((f) => f.archiveNonRemplace).length,
    lignesAjoutees: fichiers.reduce((total, f) => total + (f.lignesAjoutees || 0), 0),
    lignesSupprimees: fichiers.reduce((total, f) => total + (f.lignesSupprimees || 0), 0)
  };
}

// ---------------------------------------------------------------------------
// Récapitulatif lisible
// ---------------------------------------------------------------------------

/**
 * Rédige le récapitulatif transmis pour la traçabilité. Il s'ajoute au fichier
 * existant : un sprint complété plusieurs fois garde l'historique de ses
 * passages.
 */
function redigerRecapitulatif(manifeste) {
  const resume = resumer(manifeste);
  const date = new Date(manifeste.date);
  const lignes = [];

  lignes.push(`## ${date.toLocaleString('fr-FR')} - ${manifeste.projet}`);
  lignes.push('');
  lignes.push(`- **Demande** : ${manifeste.demande}`);
  lignes.push(`- **Sprint** : ${manifeste.sprint}`);
  lignes.push(`- **Auteur** : ${manifeste.auteur || '-'}`);
  lignes.push(`- **Opération** : ${libelleOperation(manifeste)}`);
  lignes.push(`- **Source** : \`${manifeste.racineLocale}\``);
  lignes.push(`- **Destination** : \`${manifeste.racineProd}\``);
  lignes.push(
    `- **Fichiers** : ${resume.total} au total - ${resume.remplacements} remplacé(s), ` +
      `${resume.creations} créé(s), ${resume.suppressions} supprimé(s)` +
      (resume.echecs ? `, **${resume.echecs} en échec**` : '')
  );
  lignes.push(`- **Lignes** : +${resume.lignesAjoutees} −${resume.lignesSupprimees}`);
  if (manifeste.simulation) lignes.push('- **Simulation** : aucun fichier n\'a été écrit.');
  lignes.push('');
  lignes.push('| Fichier | Action | Lignes | Sauvegarde | Résultat |');
  lignes.push('| --- | --- | --- | --- | --- |');
  for (const fichier of manifeste.fichiers) {
    const lignesTexte =
      fichier.lignesAjoutees === null ? '-' : `+${fichier.lignesAjoutees} −${fichier.lignesSupprimees}`;
    const sauvegarde = fichier.sauvegarde
      ? '`' + fichier.sauvegarde + '`' + (fichier.sauvegardeConservee ? ' (passage précédent)' : '')
      : '-';
    lignes.push(
      `| \`${fichier.chemin}\` | ${fichier.action} | ${lignesTexte} | ${sauvegarde} | ` +
        `${fichier.erreur ? '**échec : ' + fichier.erreur + '**' : 'ok'} |`
    );
  }
  lignes.push('');
  return lignes.join('\n');
}

function libelleOperation(manifeste) {
  if (manifeste.operation === OPERATION_SUPPRESSION) return 'suppression de fichiers orphelins';
  if (manifeste.operation === ACTION_RESTAURATION) return 'retour arrière';
  return 'mise en production';
}

async function ajouterAuRecapitulatif(chemin, manifeste) {
  let entete = '';
  if (!(await existe(chemin))) {
    entete = `# Récapitulatif - ${manifeste.demande} / ${manifeste.sprint}\n\n`;
  }
  await fsp.appendFile(cheminLong(chemin), entete + redigerRecapitulatif(manifeste) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

/**
 * Retrouve tous les manifestes présents sous la racine d'archives, toutes demandes
 * confondus. On ne descend que de deux niveaux : demande puis sprint.
 */
async function listerManifestes(racineAvmdf) {
  const manifestes = [];
  const erreurs = [];

  async function lireDossier(dossier, profondeur) {
    let contenu;
    try {
      contenu = await fsp.readdir(cheminLong(dossier), { withFileTypes: true });
    } catch (err) {
      erreurs.push(`${dossier} : ${raisonLisible(err)}`);
      return;
    }
    for (const element of contenu) {
      const chemin = path.join(dossier, element.name);
      if (element.isDirectory() && profondeur < 2) {
        await lireDossier(chemin, profondeur + 1);
      } else if (element.isFile() && /^_(deploiement|restauration)_.*\.json$/i.test(element.name)) {
        try {
          const brut = JSON.parse(await fsp.readFile(cheminLong(chemin), 'utf8'));
          manifestes.push({ chemin, ...brut, resume: resumer(brut) });
        } catch (err) {
          erreurs.push(`${chemin} : manifeste illisible (${err.message})`);
        }
      }
    }
  }

  await lireDossier(racineAvmdf, 0);
  manifestes.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { manifestes, erreurs };
}

// ---------------------------------------------------------------------------
// Retour arrière
// ---------------------------------------------------------------------------

/**
 * Prépare un retour arrière : ce qui sera restauré, ce qui sera supprimé, et ce
 * qui a changé en production depuis le déploiement d'origine.
 */
async function preparerRestauration(manifeste, options = {}) {
  const { concurrence = 6, signal = { annule: false } } = options;
  const operations = [];
  const problemes = [];
  const modifiesDepuis = [];
  const verrouilles = [];
  const sauvegardesManquantes = [];

  await pool(
    manifeste.fichiers.filter((f) => !f.erreur),
    concurrence,
    async (fichier) => {
      const cheminProd = joindreRelatif(manifeste.racineProd, fichier.chemin);
      const cheminSauvegarde = fichier.sauvegarde
        ? joindreRelatif(manifeste.dossierSauvegarde, fichier.sauvegarde)
        : null;

      const codeVerrou = await estVerrouille(cheminProd);
      if (codeVerrou) verrouilles.push(fichier.chemin);

      if (await existe(cheminProd)) {
        try {
          const hashActuel = await hashFichier(cheminProd);
          if (fichier.hashApres && hashActuel !== fichier.hashApres) {
            modifiesDepuis.push(fichier.chemin);
          }
        } catch (err) {
          verrouilles.push(fichier.chemin);
        }
      }

      if (fichier.action === ACTION_CREATION) {
        operations.push({ chemin: fichier.chemin, action: ACTION_SUPPRESSION, source: null });
        return;
      }

      if (!cheminSauvegarde || !(await existe(cheminSauvegarde))) {
        sauvegardesManquantes.push(fichier.chemin);
        return;
      }
      operations.push({
        chemin: fichier.chemin,
        action: ACTION_RESTAURATION,
        source: cheminSauvegarde,
        sauvegarde: fichier.sauvegarde
      });
    },
    signal
  );

  if (verrouilles.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'verrou',
        `${verrouilles.length} fichier(s) sont verrouillés en production.`,
        'Fichier verrouillé en production - recyclez le pool IIS ou déposez un app_offline.htm avant de continuer.',
        verrouilles
      )
    );
  }
  if (sauvegardesManquantes.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'sauvegarde',
        `${sauvegardesManquantes.length} sauvegarde(s) sont introuvables dans ${manifeste.dossierSauvegarde}.`,
        'Sans la version archivée, le retour arrière n\'a rien à restaurer.',
        sauvegardesManquantes
      )
    );
  }
  const archivesAnterieures = manifeste.fichiers.filter((f) => f.sauvegardeConservee && !f.erreur);
  if (archivesAnterieures.length) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'archive-anterieure',
        `${archivesAnterieures.length} fichier(s) avaient déjà été archivés lors d'un passage précédent dans ce sprint.`,
        'Ce retour arrière les ramènera à leur état d\'avant le premier passage dans ce sprint, pas à celui d\'avant ce déploiement.',
        archivesAnterieures.map((f) => f.chemin)
      )
    );
  }
  if (modifiesDepuis.length) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'modifie-depuis',
        `${modifiesDepuis.length} fichier(s) ont été modifiés en production après ce déploiement.`,
        'Le retour arrière écraserait ces modifications. Vérifiez qu\'elles n\'ont pas de valeur.',
        modifiesDepuis
      )
    );
  }

  operations.sort((a, b) => a.chemin.localeCompare(b.chemin, 'fr'));
  const bloquants = problemes.filter((p) => p.niveau === BLOQUANT);
  return {
    operations,
    problemes,
    bloquants,
    avertissements: problemes.filter((p) => p.niveau === AVERTISSEMENT),
    ok: bloquants.length === 0
  };
}

/**
 * Exécute le retour arrière et produit son propre manifeste, déposé à côté de
 * celui du déploiement d'origine.
 */
async function restaurer(manifeste, preparation, options = {}) {
  const {
    simulation = false,
    auteur = '',
    signal = { annule: false },
    surProgression = null,
    invaliderCache = null
  } = options;

  const debut = new Date();
  const resultats = [];

  for (let index = 0; index < preparation.operations.length; index += 1) {
    if (signal.annule) break;
    const operation = preparation.operations[index];
    const cheminProd = joindreRelatif(manifeste.racineProd, operation.chemin);
    const entree = {
      chemin: operation.chemin,
      action: operation.action,
      sauvegarde: operation.sauvegarde || null,
      hashAvant: null,
      tailleAvant: null,
      hashApres: null,
      tailleApres: null,
      lignesAjoutees: null,
      lignesSupprimees: null,
      erreur: null,
      archiveNonRemplace: false
    };

    try {
      if (!estSousRacine(cheminProd, manifeste.racineProd)) {
        throw new Error('destination hors de la racine de production');
      }
      if (await existe(cheminProd)) {
        const etat = await fsp.stat(cheminLong(cheminProd));
        entree.tailleAvant = etat.size;
        entree.hashAvant = await hashFichier(cheminProd);
      }

      if (operation.action === ACTION_SUPPRESSION) {
        if (!simulation && entree.hashAvant !== null) await fsp.unlink(cheminLong(cheminProd));
      } else {
        const etat = await fsp.stat(cheminLong(operation.source));
        entree.tailleApres = etat.size;
        entree.hashApres = await hashFichier(operation.source);
        if (!simulation) await copierAvecDate(operation.source, cheminProd);
      }
      if (invaliderCache) invaliderCache(cheminProd);
    } catch (err) {
      entree.erreur = `${raisonLisible(err)} - ${err.message}`;
    }

    resultats.push(entree);
    if (surProgression) {
      surProgression({ phase: 'restauration', faits: index + 1, total: preparation.operations.length });
    }
  }

  const manifesteRestauration = {
    demande: manifeste.demande,
    sprint: manifeste.sprint,
    auteur,
    date: debut.toISOString(),
    projet: manifeste.projet,
    operation: ACTION_RESTAURATION,
    restaureDepuis: manifeste.chemin || null,
    deploiementDOrigine: manifeste.date,
    racineLocale: manifeste.racineLocale,
    racineProd: manifeste.racineProd,
    dossierSauvegarde: manifeste.dossierSauvegarde,
    simulation,
    annule: signal.annule,
    fichiers: resultats
  };

  const chemins = { manifeste: null, recapitulatif: null };
  if (!simulation) {
    const suffixe = horodatageFichier(debut);
    chemins.manifeste = path.join(manifeste.dossierSauvegarde, `_restauration_${suffixe}.json`);
    chemins.recapitulatif = path.join(manifeste.dossierSauvegarde, '_recapitulatif.md');
    await fsp.writeFile(cheminLong(chemins.manifeste), JSON.stringify(manifesteRestauration, null, 2) + '\n', 'utf8');
    await ajouterAuRecapitulatif(chemins.recapitulatif, manifesteRestauration);
  }

  return { manifeste: manifesteRestauration, chemins, rapport: resumer(manifesteRestauration) };
}


/**
 * Restaure une version archivée précise d'un seul fichier.
 *
 * La version actuellement en production est d'abord archivée dans le dossier de
 * sprint choisi : revenir à une version ancienne ne fait pas perdre l'actuelle.
 * L'opération produit son propre manifeste, elle est donc réversible elle aussi.
 *
 * @param {object} plan
 * @param {object} [options]
 */
async function restaurerVersion(plan, options = {}) {
  const { invaliderCache = null } = options;
  const simulation = Boolean(plan.simulation);
  const debut = new Date();

  const cheminProd = joindreRelatif(plan.racineProd, plan.chemin);
  const cheminSauvegarde = joindreRelatif(plan.dossierSauvegarde, plan.chemin);

  const entree = {
    chemin: plan.chemin,
    action: ACTION_RESTAURATION,
    sauvegarde: null,
    versionRestauree: plan.source,
    hashAvant: null,
    tailleAvant: null,
    hashApres: null,
    tailleApres: null,
    lignesAjoutees: null,
    lignesSupprimees: null,
    erreur: null,
    archiveNonRemplace: false,
    sauvegardeConservee: false
  };

  const problemes = [];
  try {
    if (!estSousRacine(plan.source, plan.racineAvmdf)) {
      throw new Error('la version à restaurer est hors du dossier d\'archives');
    }
    if (!estSousRacine(cheminProd, plan.racineProd)) {
      throw new Error('destination hors de la racine de production');
    }
    if (!estSousRacine(cheminSauvegarde, plan.racineAvmdf)) {
      throw new Error('destination d\'archivage hors du dossier d\'archives');
    }

    const codeVerrou = await estVerrouille(cheminProd);
    if (codeVerrou) {
      problemes.push(
        probleme(
          BLOQUANT,
          'verrou',
          `Le fichier est verrouillé en production (${codeVerrou}).`,
          'Fichier verrouillé en production : recyclez le pool IIS ou déposez un app_offline.htm avant de continuer.',
          [plan.chemin]
        )
      );
      throw new Error('fichier verrouillé en production');
    }

    // 1. Archivage de la version actuelle, sans exception.
    if (await existe(cheminProd)) {
      const etatProd = await fsp.stat(cheminLong(cheminProd));
      entree.tailleAvant = etatProd.size;
      entree.hashAvant = await hashFichier(cheminProd);
      const dejaArchive = await existe(cheminSauvegarde);
      if (!simulation && !dejaArchive) await copierAvecDate(cheminProd, cheminSauvegarde);
      entree.sauvegarde = plan.chemin;
      entree.sauvegardeConservee = dejaArchive;
    }

    // 2. Remise en place de la version choisie.
    const etatSource = await fsp.stat(cheminLong(plan.source));
    entree.tailleApres = etatSource.size;
    entree.hashApres = await hashFichier(plan.source);
    if (!simulation) {
      await copierAvecDate(plan.source, cheminProd);
      if (invaliderCache) invaliderCache(cheminProd);
    }
  } catch (err) {
    entree.erreur = `${raisonLisible(err)} - ${err.message}`;
  }

  const manifeste = {
    demande: plan.demande,
    sprint: plan.sprint,
    auteur: plan.auteur,
    date: debut.toISOString(),
    projet: plan.projet,
    operation: ACTION_RESTAURATION,
    restaureDepuis: plan.source,
    racineLocale: plan.racineLocale || null,
    racineProd: plan.racineProd,
    dossierSauvegarde: plan.dossierSauvegarde,
    simulation,
    annule: false,
    fichiers: [entree]
  };

  const chemins = { manifeste: null, recapitulatif: null };
  if (!simulation && !entree.erreur) {
    const suffixe = horodatageFichier(debut);
    await fsp.mkdir(cheminLong(plan.dossierSauvegarde), { recursive: true });
    chemins.manifeste = path.join(plan.dossierSauvegarde, `_restauration_${suffixe}.json`);
    chemins.recapitulatif = path.join(plan.dossierSauvegarde, '_recapitulatif.md');
    await fsp.writeFile(cheminLong(chemins.manifeste), JSON.stringify(manifeste, null, 2) + '\n', 'utf8');
    await ajouterAuRecapitulatif(chemins.recapitulatif, manifeste);
  }

  return { manifeste, chemins, rapport: resumer(manifeste), problemes };
}

module.exports = {
  ACTION_REMPLACEMENT,
  ACTION_CREATION,
  ACTION_SUPPRESSION,
  ACTION_RESTAURATION,
  OPERATION_DEPLOIEMENT,
  OPERATION_SUPPRESSION,
  BLOQUANT,
  AVERTISSEMENT,
  NOM_APP_OFFLINE,
  preflight,
  executer,
  resumer,
  redigerRecapitulatif,
  listerManifestes,
  preparerRestauration,
  restaurer,
  restaurerVersion,
  formaterOctets,
  estVerrouille,
  copierAvecDate
};
