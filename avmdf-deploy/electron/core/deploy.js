'use strict';

/**
 * deploy.js - contrôles préalables, sauvegarde, copie, manifeste et retour
 * arrière.
 *
 * Module Node pur : aucune dépendance à Electron ni au DOM.
 *
 * Règles non négociables :
 *   - rien n'est écrasé sans avoir été archivé au préalable, sauf renoncement
 *     explicite pour le passage entier (`plan.archiver` à faux), qui est alors
 *     inscrit dans le manifeste et interdit le retour arrière ;
 *   - la copie est binaire, octet pour octet : aucun ré-encodage, aucune
 *     normalisation des fins de ligne. Seule la date change : le fichier de
 *     production porte celle de sa mise en production, l'archive celle qu'il
 *     avait avant d'être remplacé ;
 *   - toute destination est vérifiée comme étant sous la racine de production
 *     ou sous la racine d'archives avant la moindre écriture ;
 *   - un fichier en échec n'interrompt pas les autres, il est remonté dans le
 *     rapport final.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { cheminLong, hashFichier, joindreRelatif, pool, raisonLisible } = require('./fsindex');
const { estSousRacine, DOSSIER_OUTIL } = require('./avmdf');
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

/**
 * Copie binaire en conservant la date de modification de la source.
 *
 * C'est ce qu'il faut pour une archive : le fichier rangé sous AVMDF doit
 * garder la date qu'il avait en production, sinon il ne dit plus de quand
 * datait la version remplacée.
 */
async function copierAvecDate(source, destination) {
  await copierAtomique(source, destination);
  const etat = await fsp.stat(cheminLong(source));
  await fsp.utimes(cheminLong(destination), etat.atime, etat.mtime);
}

/**
 * Copie en deux temps : fichier temporaire voisin, puis renommage par-dessus la
 * cible. Un processus tué ou un partage qui tombe en pleine copie ne peut ainsi
 * laisser ni archive tronquée qui passerait ensuite pour complète, ni fichier
 * de production à moitié écrit.
 */
async function copierAtomique(source, destination) {
  await fsp.mkdir(cheminLong(path.dirname(destination)), { recursive: true });
  const temporaire = destination + '.avmdf-tmp';
  await fsp.copyFile(cheminLong(source), cheminLong(temporaire));
  try {
    await fsp.rename(cheminLong(temporaire), cheminLong(destination));
  } catch (err) {
    await fsp.unlink(cheminLong(temporaire)).catch(() => {});
    throw err;
  }
}

/** Même geste pour un contenu en mémoire : le manifeste ne doit jamais être tronqué. */
async function ecrireAtomique(chemin, contenu) {
  const temporaire = chemin + '.avmdf-tmp';
  await fsp.writeFile(cheminLong(temporaire), contenu, 'utf8');
  try {
    await fsp.rename(cheminLong(temporaire), cheminLong(chemin));
  } catch (err) {
    await fsp.unlink(cheminLong(temporaire)).catch(() => {});
    throw err;
  }
}

/**
 * Copie binaire datée du moment où elle a lieu.
 *
 * C'est ce qu'il faut vers la production : dans l'explorateur du serveur, la
 * date d'un fichier répond à la question qu'on se pose vraiment, « quand est-ce
 * que ça a été mis en prod ? ». Reprendre la date du poste de développement
 * afficherait une date sans rapport, souvent bien plus ancienne.
 *
 * La comparaison ne s'en trouve pas faussée : elle se décide sur la taille
 * puis sur l'empreinte, jamais sur la date.
 */
async function copierVersProduction(source, destination) {
  await copierAtomique(source, destination);
  const maintenant = new Date();
  await fsp.utimes(cheminLong(destination), maintenant, maintenant);
}

/**
 * Le fichier existe-t-il ? Seul `ENOENT` vaut « non » : toute autre erreur
 * (droits, partage qui ne répond plus, E/S) est propagée. Conclure « absent »
 * sur un partage injoignable ferait sauter l'archivage et écraser la
 * production sans copie de sauvegarde - chaque appelant décide quoi faire de
 * l'erreur, jamais elle ne se déguise en absence.
 */
async function existe(chemin) {
  try {
    await fsp.access(cheminLong(chemin));
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

// Un fichier de production peut refuser d'être remplacé pour des raisons très
// différentes, et le remède n'est pas le même. Les confondre sous le mot
// « verrouillé » envoie chercher au mauvais endroit.
const CAUSE_OUVERT = 'ouvert';
const CAUSE_LECTURE_SEULE = 'lecture-seule';
const CAUSE_DROITS = 'droits';
const CAUSE_ILLISIBLE = 'illisible';
const CAUSE_INCONNUE = 'inconnue';

/**
 * IIS ne tient que ce qu'il a chargé : la DLL de l'application et ses
 * satellites. Une page, une feuille de style ou une image sont lues, envoyées
 * et refermées - recycler le pool n'y changera rien.
 */
const TENU_PAR_IIS = /(^|[\\/])bin[\\/]|\.(dll|exe|pdb)$/i;

/**
 * Le fichier de destination peut-il être remplacé ?
 *
 * Une ouverture en écriture est le seul test fiable : un fichier tenu par un
 * autre programme se laisse lire mais refuse `r+`. Reste à savoir pourquoi le
 * système a dit non.
 *
 * @param {string} chemin
 * @returns {Promise<null|{cause:string, code:string}>} null si le fichier est
 *   remplaçable, ou simplement absent
 */
async function obstacleEcriture(chemin) {
  let poignee = null;
  try {
    poignee = await fsp.open(cheminLong(chemin), 'r+');
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'EBUSY') return { cause: CAUSE_OUVERT, code: err.code };
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // Sous Windows, Node éteint le bit d'écriture du mode quand l'attribut
      // « lecture seule » est posé. C'est ce qui sépare un fichier protégé d'un
      // droit NTFS manquant, deux situations qui ne se corrigent pas pareil.
      try {
        const etat = await fsp.stat(cheminLong(chemin));
        if (!(etat.mode & 0o200)) return { cause: CAUSE_LECTURE_SEULE, code: err.code };
      } catch (autre) {
        /* même la lecture de l'état est refusée : on s'en tient aux droits */
      }
      return { cause: CAUSE_DROITS, code: err.code };
    }
    return { cause: CAUSE_INCONNUE, code: err.code || 'inconnu' };
  } finally {
    if (poignee) await poignee.close().catch(() => {});
  }
}

const LIBELLES_OBSTACLE = {
  [CAUSE_OUVERT]: {
    message: (n) =>
      n > 1
        ? `${n} fichiers sont ouverts par un autre programme en production.`
        : '1 fichier est ouvert par un autre programme en production.',
    conseil:
      'Pour savoir qui le tient, sur le serveur : Gestion de l\'ordinateur, Outils système, ' +
      'Dossiers partagés, Fichiers ouverts. Un éditeur resté ouvert sur le partage, un antivirus ' +
      'ou une sauvegarde en cours suffisent à bloquer un fichier.'
  },
  [CAUSE_LECTURE_SEULE]: {
    message: (n) =>
      n > 1
        ? `${n} fichiers sont en lecture seule en production.`
        : '1 fichier est en lecture seule en production.',
    conseil:
      'Retirez l\'attribut « lecture seule » : clic droit sur le fichier, Propriétés, puis ' +
      'décochez la case. En ligne de commande sur le serveur : attrib -R suivi du chemin.'
  },
  [CAUSE_DROITS]: {
    message: (n) =>
      n > 1
        ? `${n} fichiers refusent l'écriture : droits insuffisants.`
        : '1 fichier refuse l\'écriture : droits insuffisants.',
    conseil:
      'Vous pouvez lire ces fichiers mais pas les remplacer. Faites ouvrir vos droits en écriture ' +
      'sur le dossier concerné, ou déployez depuis un compte qui les a.'
  },
  [CAUSE_ILLISIBLE]: {
    message: (n) =>
      n > 1
        ? `${n} fichiers de production n'ont pas pu être lus.`
        : '1 fichier de production n\'a pas pu être lu.',
    conseil:
      'Le fichier a peut-être disparu ou changé de droits depuis l\'analyse. Relancez une analyse ' +
      'pour repartir de l\'état réel.'
  },
  [CAUSE_INCONNUE]: {
    message: (n) =>
      n > 1
        ? `${n} fichiers ne peuvent pas être remplacés en production.`
        : '1 fichier ne peut pas être remplacé en production.',
    conseil:
      'Le système a refusé l\'ouverture en écriture sans motif reconnu. Vérifiez le fichier à la ' +
      'main sur le serveur avant de recommencer.'
  }
};

/** Accumule les obstacles rencontrés, une entrée par cause. */
function creerRegistreObstacles() {
  const parCause = new Map();
  return {
    noter(cause, code, chemin) {
      let entree = parCause.get(cause);
      if (!entree) {
        entree = { fichiers: [], codes: new Set() };
        parCause.set(cause, entree);
      }
      entree.fichiers.push(chemin);
      entree.codes.add(code);
    },
    /**
     * Un point bloquant par cause, avec son conseil propre. Le conseil sur le
     * pool IIS n'apparaît que si au moins un fichier concerné est de ceux qu'IIS
     * tient réellement.
     */
    problemes() {
      const sortie = [];
      for (const [cause, { fichiers, codes }] of parCause) {
        const libelle = LIBELLES_OBSTACLE[cause] || LIBELLES_OBSTACLE[CAUSE_INCONNUE];
        let conseil = libelle.conseil;
        if (cause === CAUSE_OUVERT && fichiers.some((chemin) => TENU_PAR_IIS.test(chemin))) {
          conseil +=
            ' Pour une DLL du dossier bin, c\'est IIS lui-même qui la tient : recyclez le pool ' +
            'd\'applications, ou activez le dépôt d\'un app_offline.htm dans les réglages.';
        }
        sortie.push(
          probleme(
            BLOQUANT,
            'verrou',
            `${libelle.message(fichiers.length)} (${[...codes].sort().join(', ')})`,
            conseil,
            fichiers
          )
        );
      }
      return sortie;
    }
  };
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

  // Sans dossier de sauvegarde, ce passage ne touche pas aux archives : ni
  // copie de sauvegarde, ni manifeste. Tout ce qui les concerne est écarté des
  // contrôles, à commencer par l'accès à la racine AVMDF.
  const avecArchives = Boolean(plan.dossierSauvegarde);

  // 1. Racines accessibles
  const racines = [
    ['locale', plan.racineLocale],
    ['de production', plan.racineProd]
  ];
  if (avecArchives) racines.push(['des archives AVMDF', plan.racineAvmdf]);
  for (const [libelle, racine] of racines) {
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
  if (avecArchives && !estSousRacine(plan.dossierSauvegarde, plan.racineAvmdf)) {
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
  if (avecArchives) {
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
  }

  // 4. État de chaque fichier : source disparue, destination verrouillée,
  //    modification concurrente depuis l'analyse.
  const disparus = [];
  const obstacles = creerRegistreObstacles();
  const concurrents = [];
  const apparus = [];
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

      const obstacle = await obstacleEcriture(cheminProd);
      if (obstacle) obstacles.noter(obstacle.cause, obstacle.code, fichier.chemin);

      let presentEnProd = false;
      try {
        presentEnProd = await existe(cheminProd);
      } catch (err) {
        // Le partage ne répond pas pour ce fichier : impossible de savoir s'il
        // existe, donc impossible de garantir l'archivage. Bloquant.
        if (!obstacle) obstacles.noter(CAUSE_ILLISIBLE, err.code || 'inconnu', fichier.chemin);
      }

      if (presentEnProd) {
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
          } else if (plan.operation !== OPERATION_SUPPRESSION) {
            // L'analyse donnait ce fichier pour nouveau : quelqu'un l'a créé en
            // production depuis. L'écraser sans l'avoir comparé serait un
            // écrasement aveugle, pas une création.
            apparus.push(fichier.chemin);
          }
        } catch (err) {
          // Le fichier existe mais ne se laisse ni mesurer ni lire : ce n'est
          // pas le même problème qu'une ouverture en écriture refusée.
          obstacles.noter(CAUSE_ILLISIBLE, err.code || 'inconnu', fichier.chemin);
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
  problemes.push(...obstacles.problemes());
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
  if (apparus.length) {
    problemes.push(
      probleme(
        BLOQUANT,
        'concurrence',
        `${apparus.length} fichier(s) donnés pour nouveaux existent désormais en production.`,
        'Quelqu\'un d\'autre les y a déposés depuis votre analyse. Relancez une analyse pour les comparer avant d\'écraser quoi que ce soit.',
        apparus
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

  // 5. Archivage écarté : ce passage ne sera pas réversible.
  if (plan.archiver === false && plan.operation === OPERATION_SUPPRESSION) {
    // Un orphelin n'existe qu'en production : sans archive, son contenu ne
    // survivra nulle part. C'est le renoncement le plus lourd de l'outil.
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'sans-archive',
        `Archivage AVMDF écarté : ${plan.fichiers.length} fichier(s) seront supprimés définitivement, sans copie de sauvegarde.`,
        'Ces fichiers n\'existent qu\'en production : leur contenu ne sera conservé nulle part et ne pourra jamais être restauré.',
        plan.fichiers.map((f) => f.chemin)
      )
    );
  } else if (plan.archiver === false) {
    const remplaces = [];
    for (const fichier of plan.fichiers) {
      try {
        if (await existe(joindreRelatif(plan.racineProd, fichier.chemin))) remplaces.push(fichier.chemin);
      } catch (err) {
        // Injoignable : mieux vaut prévenir d'un écrasement possible que le taire.
        remplaces.push(fichier.chemin);
      }
    }
    if (remplaces.length) {
      problemes.push(
        probleme(
          AVERTISSEMENT,
          'sans-archive',
          `Archivage AVMDF écarté : ${remplaces.length} version(s) de production seront écrasées sans copie de sauvegarde.`,
          'Le retour arrière sera impossible pour ce passage.',
          remplaces
        )
      );
    }
  }

  // 6 bis. Sans destination, rien ne s'écrit sous la racine des archives : ni
  // les versions remplacées, ni le manifeste qui les recense.
  if (!avecArchives) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'sans-manifeste',
        'Sans archivage, ni manifeste ni récapitulatif ne seront écrits.',
        'Ce passage n\'apparaîtra ni dans l\'historique ni dans le tableau de bord. Seul le journal en gardera la trace. Recochez « Archiver » si vous voulez le retrouver plus tard.'
      )
    );
  }

  // 6. web.config
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

  // 7. Espace disque. La production reçoit les tailles locales, les archives
  //    reçoivent les tailles de production. `statfs` n'existe qu'à partir de
  //    Node 18 : sur Electron 22 (Node 16, le poste type), la mesure est
  //    impossible - on le dit, parce qu'un contrôle qui se tait ressemble à un
  //    feu vert.
  const octetsNecessaires = plan.fichiers.reduce(
    (total, fichier) => total + (fichier.local ? fichier.local.taille : 0),
    0
  );
  const { mesurable, octets: espace } = await espaceDisponible(plan.racineProd);
  if (!mesurable) {
    problemes.push(
      probleme(
        AVERTISSEMENT,
        'espace-non-mesurable',
        `L'espace disponible en production ne peut pas être mesuré sur ce poste (${formaterOctets(octetsNecessaires)} à écrire).`,
        'La version de Node embarquée ne sait pas interroger le volume. Vérifiez à l\'œil qu\'il reste de la place sur le partage.'
      )
    );
  } else if (espace !== null && espace < octetsNecessaires * 1.2) {
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
  if (avecArchives && mesurable) {
    const octetsArchives = plan.fichiers.reduce(
      (total, fichier) => total + (fichier.prod ? fichier.prod.taille : 0),
      0
    );
    const archives = await espaceDisponible(plan.racineAvmdf);
    if (archives.octets !== null && archives.octets < octetsArchives * 1.2) {
      problemes.push(
        probleme(
          BLOQUANT,
          'espace',
          `Espace insuffisant sur le dossier d'archives : ${formaterOctets(archives.octets)} disponibles pour ${formaterOctets(octetsArchives)} à archiver.`,
          'Libérez de la place sous ' + plan.racineAvmdf + ' avant de déployer.'
        )
      );
    }
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
  try {
    while (!(await existe(dossier)) && estSousRacine(dossier, racine) && dossier !== path.dirname(dossier)) {
      dossier = path.dirname(dossier);
    }
  } catch (err) {
    return { ok: false, dossier, raison: raisonLisible(err) };
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

/**
 * Place restante sur le volume qui porte ce chemin.
 *
 * `statfs` n'existe qu'à partir de Node 18. Electron 22, retenu pour rester
 * compatible avec Windows Server 2012 R2, embarque Node 16 : la mesure y est
 * tout simplement impossible. On le distingue d'un échec de mesure, parce que
 * répéter « l'espace n'a pas pu être mesuré » à chaque passage n'apprendrait
 * rien à personne et finirait par faire ignorer les vrais avertissements.
 *
 * @returns {Promise<{mesurable: boolean, octets: number|null}>}
 */
async function espaceDisponible(chemin) {
  if (typeof fsp.statfs !== 'function') return { mesurable: false, octets: null };
  try {
    const info = await fsp.statfs(cheminLong(chemin));
    return { mesurable: true, octets: info.bavail * info.bsize };
  } catch (err) {
    return { mesurable: true, octets: null };
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
    invaliderCache = null,
    etatsProd = null,
    dossierSecours = null
  } = options;

  const simulation = Boolean(plan.simulation);
  const debut = new Date();
  const resultats = [];
  let appOfflineDepose = false;
  let etatAppOffline = null;

  if (!simulation && plan.dossierSauvegarde) {
    await fsp.mkdir(cheminLong(plan.dossierSauvegarde), { recursive: true });
  }

  if (plan.appOffline && plan.appOffline.actif) {
    const depot = await deposerAppOffline(plan, simulation);
    etatAppOffline = { depose: depot.ok, erreurDepot: depot.erreur, retire: null, erreurRetrait: null };
    appOfflineDepose = depot.ok;
  }

  try {
    // Séquentiel volontairement : une mise en production se suit à la trace, et
    // le partage réseau n'aime pas les écritures parallèles.
    for (let index = 0; index < plan.fichiers.length; index += 1) {
      if (signal.annule) break;
      const fichier = plan.fichiers[index];
      resultats.push(
        await traiterFichier(fichier, plan, { simulation, extensionsTexte, ignorerEspaces, invaliderCache, etatsProd })
      );
      if (surProgression) {
        surProgression({ phase: 'copie', faits: index + 1, total: plan.fichiers.length, chemin: fichier.chemin });
      }
    }
  } finally {
    if (appOfflineDepose) {
      const retrait = await retirerAppOffline(plan, simulation);
      etatAppOffline.retire = retrait.ok;
      etatAppOffline.erreurRetrait = retrait.erreur;
    }
  }

  const manifeste = {
    demande: plan.demande,
    sprint: plan.sprint,
    auteur: plan.auteur,
    date: debut.toISOString(),
    projet: plan.projet,
    operation: plan.operation || OPERATION_DEPLOIEMENT,
    // Le mot du déployeur : pourquoi ce passage. Il suit le manifeste partout,
    // du récapitulatif à l'historique.
    commentaire: plan.commentaire || null,
    racineLocale: plan.racineLocale,
    racineProd: plan.racineProd,
    dossierSauvegarde: plan.dossierSauvegarde,
    archivage: plan.archiver !== false,
    simulation,
    annule: signal.annule,
    appOffline: etatAppOffline,
    fichiers: resultats
  };

  // Sans dossier de sauvegarde, il n'y a nulle part où déposer le manifeste :
  // le passage ne laisse de trace que dans le journal, et le rapport le dit.
  const chemins = await deposerTraces(manifeste, plan.dossierSauvegarde, `_deploiement_${horodatageFichier(debut)}.json`, {
    simulation,
    dossierSecours
  });

  return { manifeste, chemins, rapport: resumer(manifeste) };
}

/**
 * Ce que lit la personne qui parcourt les archives à la main : posé une fois
 * dans `_donnees-outil`, il dit ce que ce dossier est, et surtout ce qu'il
 * n'est pas.
 */
const CONTENU_LISEZMOI = [
  'Ce dossier appartient à l\'outil « AVMDF Mise en production ».',
  '',
  'Il ne contient AUCUN fichier de la demande de travaux : uniquement les',
  'données de l\'outil, c\'est-à-dire les manifestes de chaque passage',
  '(_deploiement_*.json, _restauration_*.json) et leur récapitulatif lisible',
  '(recapitulatif.md).',
  '',
  'Les versions « avant modification », elles, sont rangées à côté, dans le',
  'dossier du sprint, chacune à son chemin d\'origine.',
  '',
  'Ne rien modifier ni supprimer ici : ces fichiers rendent possibles',
  'l\'historique, la vérification de la production et le retour arrière.',
  ''
].join('\r\n');

/**
 * Dépose le manifeste et complète le récapitulatif dans le sous-dossier
 * `_donnees-outil` du sprint : les traces de l'outil ne se mélangent pas aux
 * versions archivées de la demande, et un LISEZMOI l'explique sur place.
 *
 * Le manifeste est la seule preuve de ce qui vient d'être écrit : il part en
 * deux temps (fichier temporaire puis renommage) et un échec ne se perd jamais
 * en silence. Si le partage refuse, une copie de secours part dans
 * `dossierSecours` (sous le profil local du poste) et l'erreur est portée par
 * `chemins.erreurEcriture`, donc par le rapport et le journal.
 */
async function deposerTraces(manifeste, dossier, nomManifeste, options = {}) {
  const { simulation = false, dossierSecours = null } = options;
  const chemins = { manifeste: null, recapitulatif: null, manifesteSecours: null, erreurEcriture: null };
  if (simulation || !dossier) return chemins;

  const dossierOutil = path.join(dossier, DOSSIER_OUTIL);
  let dossierTraces = dossierOutil;
  try {
    await fsp.mkdir(cheminLong(dossierOutil), { recursive: true });
    const lisezmoi = path.join(dossierOutil, 'LISEZMOI.txt');
    if (!(await existe(lisezmoi))) {
      try {
        await ecrireAtomique(lisezmoi, CONTENU_LISEZMOI);
      } catch (err) {
        /* sans LISEZMOI le dossier reste explicite par son nom */
      }
    }
  } catch (err) {
    // Impossible de créer le sous-dossier : le manifeste vaut plus que le
    // rangement, il part à la racine du sprint comme avant la 2.0.
    dossierTraces = dossier;
  }

  const contenu = JSON.stringify(manifeste, null, 2) + '\n';
  const cible = path.join(dossierTraces, nomManifeste);
  try {
    await ecrireAtomique(cible, contenu);
    chemins.manifeste = cible;
  } catch (err) {
    chemins.erreurEcriture = `manifeste non écrit dans le sprint (${raisonLisible(err)} - ${err.message})`;
    if (dossierSecours) {
      try {
        await fsp.mkdir(cheminLong(dossierSecours), { recursive: true });
        const secours = path.join(dossierSecours, nomManifeste);
        await ecrireAtomique(secours, contenu);
        chemins.manifesteSecours = secours;
      } catch (autre) {
        chemins.erreurEcriture += ` ; copie de secours impossible (${raisonLisible(autre)})`;
      }
    }
  }

  try {
    const recapitulatif = path.join(
      dossierTraces,
      dossierTraces === dossierOutil ? 'recapitulatif.md' : '_recapitulatif.md'
    );
    await ajouterAuRecapitulatif(recapitulatif, manifeste);
    chemins.recapitulatif = recapitulatif;
  } catch (err) {
    const message = `récapitulatif non complété (${raisonLisible(err)})`;
    chemins.erreurEcriture = chemins.erreurEcriture ? `${chemins.erreurEcriture} ; ${message}` : message;
  }

  return chemins;
}

async function traiterFichier(fichier, plan, contexte) {
  const { simulation, extensionsTexte, ignorerEspaces, invaliderCache, etatsProd } = contexte;
  // Pas de dossier de sauvegarde, pas d'archivage : l'invariant tient quoi que
  // dise le drapeau.
  const archiver = plan.archiver !== false && Boolean(plan.dossierSauvegarde);
  const cheminProd = joindreRelatif(plan.racineProd, fichier.chemin);
  const cheminLocal = fichier.local ? fichier.local.absolu : joindreRelatif(plan.racineLocale, fichier.chemin);
  const cheminSauvegarde = plan.dossierSauvegarde
    ? joindreRelatif(plan.dossierSauvegarde, fichier.chemin)
    : null;
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
    sauvegardeConservee: false,
    sansArchive: false
  };

  try {
    const presentEnProd = await existe(cheminProd);

    // 1. Archivage de la version écrasée. Si l'archivage échoue, on ne touche
    //    pas au fichier de production.
    //
    //    L'archivage peut être écarté pour un passage entier (`plan.archiver`
    //    à faux) : une feuille de style ou une retouche mineure ne mérite pas
    //    toujours son dossier AVMDF. L'empreinte et la taille de la version
    //    écrasée restent relevées - le manifeste dit alors ce qui a été perdu,
    //    même s'il ne peut plus le rendre.
    if (presentEnProd) {
      if (!suppression) entree.action = ACTION_REMPLACEMENT;
      // Le préflight vient de relever taille et empreinte de chaque destination,
      // et il bloque à la moindre modification concurrente : inutile de relire
      // tout le fichier sur le partage une troisième fois.
      const connu = etatsProd ? etatsProd.get(fichier.cle || fichier.chemin.toLowerCase()) : null;
      if (connu && connu.hash) {
        entree.tailleAvant = connu.taille;
        entree.hashAvant = connu.hash;
      } else {
        const etatProd = await fsp.stat(cheminLong(cheminProd));
        entree.tailleAvant = etatProd.size;
        entree.hashAvant = await hashFichier(cheminProd);
      }

      if (archiver) {
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
      } else {
        entree.sansArchive = true;
      }
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

    // 3. Copie binaire vers la production, datée du moment de la copie.
    if (!estSousRacine(cheminProd, plan.racineProd)) {
      throw new Error('destination hors de la racine de production');
    }
    const etatLocal = await fsp.stat(cheminLong(cheminLocal));
    entree.tailleApres = etatLocal.size;
    entree.hashApres = await hashFichier(cheminLocal);

    if (!simulation) {
      try {
        await copierVersProduction(cheminLocal, cheminProd);
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
  if (!estSousRacine(destination, plan.racineProd)) {
    return { ok: false, erreur: 'destination hors de la racine de production' };
  }
  if (simulation) return { ok: true, erreur: null };
  try {
    await fsp.writeFile(cheminLong(destination), plan.appOffline.contenu, 'utf8');
    return { ok: true, erreur: null };
  } catch (err) {
    return { ok: false, erreur: `${raisonLisible(err)} - ${err.message}` };
  }
}

/**
 * Retire le fichier d'attente. C'est le geste qui remet le site en ligne : un
 * échec ici laisserait la production hors service, donc on réessaie, et le
 * résultat remonte jusqu'au manifeste et au rapport au lieu de s'évaporer dans
 * un avertissement de console.
 */
async function retirerAppOffline(plan, simulation) {
  if (simulation) return { ok: true, erreur: null };
  const destination = path.join(plan.racineProd, NOM_APP_OFFLINE);
  let derniere = null;
  for (let essai = 0; essai < 3; essai += 1) {
    try {
      await fsp.unlink(cheminLong(destination));
      return { ok: true, erreur: null };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, erreur: null };
      derniere = err;
      await new Promise((reprendre) => setTimeout(reprendre, 500));
    }
  }
  return { ok: false, erreur: `${raisonLisible(derniere)} - ${derniere.message}` };
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
  if (manifeste.commentaire) lignes.push(`- **Commentaire** : ${manifeste.commentaire}`);
  lignes.push(`- **Source** : \`${manifeste.racineLocale}\``);
  lignes.push(`- **Destination** : \`${manifeste.racineProd}\``);
  lignes.push(
    `- **Fichiers** : ${resume.total} au total - ${resume.remplacements} remplacé(s), ` +
      `${resume.creations} créé(s), ${resume.suppressions} supprimé(s)` +
      (resume.echecs ? `, **${resume.echecs} en échec**` : '')
  );
  lignes.push(`- **Lignes** : +${resume.lignesAjoutees} −${resume.lignesSupprimees}`);
  if (manifeste.archivage === false) {
    lignes.push(
      '- **Archivage AVMDF** : écarté pour ce passage. Les versions remplacées n\'ont pas été ' +
        'conservées ; leur empreinte figure dans le manifeste, mais le retour arrière est impossible.'
    );
  }
  if (manifeste.simulation) lignes.push('- **Simulation** : aucun fichier n\'a été écrit.');
  lignes.push('');
  lignes.push('| Fichier | Action | Lignes | Sauvegarde | Résultat |');
  lignes.push('| --- | --- | --- | --- | --- |');
  for (const fichier of manifeste.fichiers) {
    const lignesTexte =
      fichier.lignesAjoutees === null ? '-' : `+${fichier.lignesAjoutees} −${fichier.lignesSupprimees}`;
    const sauvegarde = fichier.sauvegarde
      ? '`' + fichier.sauvegarde + '`' + (fichier.sauvegardeConservee ? ' (passage précédent)' : '')
      : fichier.sansArchive
        ? '**non archivé**'
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
  try {
    if (!(await existe(chemin))) {
      entete = `# Récapitulatif - ${manifeste.demande} / ${manifeste.sprint}\n\n`;
    }
  } catch (err) {
    entete = '';
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
async function listerManifestes(racineAvmdf, options = {}) {
  const { concurrence = 6 } = options;
  const manifestes = [];
  const erreurs = [];
  const aLire = [];

  async function inventorier(dossier, profondeur) {
    let contenu;
    try {
      contenu = await fsp.readdir(cheminLong(dossier), { withFileTypes: true });
    } catch (err) {
      erreurs.push(`${dossier} : ${raisonLisible(err)}`);
      return [];
    }
    const sousDossiers = [];
    for (const element of contenu) {
      const chemin = path.join(dossier, element.name);
      // Depuis la 2.0, les traces vivent dans `_donnees-outil` sous le
      // sprint : ce dossier-là se visite à toute profondeur ; les autres
      // s'arrêtent au niveau des sprints.
      if (element.isDirectory() && (profondeur < 2 || element.name.toLowerCase() === DOSSIER_OUTIL)) {
        sousDossiers.push(chemin);
      } else if (element.isFile() && /^_(deploiement|restauration)_.*\.json$/i.test(element.name)) {
        aLire.push(chemin);
      }
    }
    return sousDossiers;
  }

  // Niveau par niveau (racine, demandes, sprints, dossier de l'outil), en
  // concurrence bornée : sur un partage à plusieurs centaines de demandes, la
  // version séquentielle se comptait en dizaines de secondes.
  let niveau = [racineAvmdf];
  for (let profondeur = 0; profondeur < 4 && niveau.length; profondeur += 1) {
    const suivant = [];
    await pool(niveau, concurrence, async (dossier) => {
      suivant.push(...(await inventorier(dossier, profondeur)));
    });
    niveau = suivant;
  }

  await pool(aLire, concurrence, async (chemin) => {
    try {
      const brut = JSON.parse(await fsp.readFile(cheminLong(chemin), 'utf8'));
      manifestes.push({ chemin, ...brut, resume: resumer(brut) });
    } catch (err) {
      erreurs.push(`${chemin} : manifeste illisible (${err.message})`);
    }
  });

  manifestes.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { manifestes, erreurs };
}

// ---------------------------------------------------------------------------
// Vérification après coup
// ---------------------------------------------------------------------------

const VERDICT_CONFORME = 'conforme';
const VERDICT_MODIFIE = 'modifie';
const VERDICT_ABSENT = 'absent';
const VERDICT_REAPPARU = 'reapparu';
const VERDICT_INVERIFIABLE = 'inverifiable';

/**
 * Confronte la production actuelle à ce qu'un manifeste dit y avoir écrit.
 *
 * C'est la réponse à « est-ce que ma production est toujours celle que j'ai
 * livrée ? » : chaque fichier du passage est re-hashé et comparé à l'empreinte
 * `hashApres` du manifeste. Rien n'est écrit, nulle part : ce contrôle lit.
 *
 * Verdicts par fichier :
 *   - conforme      : l'empreinte actuelle est celle du manifeste ;
 *   - modifie       : le fichier existe mais son contenu a changé depuis ;
 *   - absent        : le fichier déployé ne se trouve plus en production ;
 *   - reapparu      : un fichier supprimé par le passage est revenu ;
 *   - inverifiable  : le fichier ne se laisse pas lire, ou le manifeste n'a
 *                     pas d'empreinte pour lui.
 *
 * @param {object} manifeste
 * @param {object} [options]
 * @returns {Promise<{resultats:object[], resume:object}>}
 */
async function verifierManifeste(manifeste, options = {}) {
  const { concurrence = 6, signal = { annule: false }, surProgression = null } = options;
  const aVerifier = manifeste.fichiers.filter((f) => !f.erreur);
  const resultats = [];
  let faits = 0;

  await pool(
    aVerifier,
    concurrence,
    async (fichier) => {
      const cheminProd = joindreRelatif(manifeste.racineProd, fichier.chemin);
      const entree = { chemin: fichier.chemin, action: fichier.action, verdict: null, hashActuel: null };

      let present = null;
      try {
        present = await existe(cheminProd);
      } catch (err) {
        present = null;
      }
      if (present === null) {
        entree.verdict = VERDICT_INVERIFIABLE;
      } else if (fichier.action === ACTION_SUPPRESSION) {
        entree.verdict = present ? VERDICT_REAPPARU : VERDICT_CONFORME;
      } else if (!present) {
        entree.verdict = VERDICT_ABSENT;
      } else if (!fichier.hashApres) {
        entree.verdict = VERDICT_INVERIFIABLE;
      } else {
        try {
          entree.hashActuel = await hashFichier(cheminProd);
          entree.verdict = entree.hashActuel === fichier.hashApres ? VERDICT_CONFORME : VERDICT_MODIFIE;
        } catch (err) {
          entree.verdict = VERDICT_INVERIFIABLE;
        }
      }

      resultats.push(entree);
      faits += 1;
      if (surProgression && faits % 5 === 0) {
        surProgression({ phase: 'verification', faits, total: aVerifier.length });
      }
    },
    signal
  );

  resultats.sort((a, b) => a.chemin.localeCompare(b.chemin, 'fr'));
  const compter = (verdict) => resultats.filter((r) => r.verdict === verdict).length;
  return {
    resultats,
    date: new Date().toISOString(),
    resume: {
      total: resultats.length,
      ignores: manifeste.fichiers.length - aVerifier.length,
      conformes: compter(VERDICT_CONFORME),
      modifies: compter(VERDICT_MODIFIE),
      absents: compter(VERDICT_ABSENT),
      reapparus: compter(VERDICT_REAPPARU),
      inverifiables: compter(VERDICT_INVERIFIABLE)
    }
  };
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

  // Deux cas où il n'y a rien à restaurer, à refuser avant le moindre calcul :
  // sans ces gardes, un manifeste sans dossier de sauvegarde pouvait mener à
  // des suppressions réelles suivies d'un plantage.
  if (manifeste.simulation) {
    const seul = probleme(
      BLOQUANT,
      'simulation',
      'Ce manifeste est une simulation : rien n\'a été écrit, il n\'y a rien à restaurer.',
      ''
    );
    return { operations: [], problemes: [seul], bloquants: [seul], avertissements: [], ok: false };
  }
  if (!manifeste.dossierSauvegarde) {
    const seul = probleme(
      BLOQUANT,
      'sans-archive',
      'Ce manifeste ne référence aucun dossier de sauvegarde : le retour arrière est impossible.',
      'Ce passage a été fait sans archivage AVMDF. Le manifeste garde l\'empreinte des versions remplacées, à défaut de leur contenu.'
    );
    return { operations: [], problemes: [seul], bloquants: [seul], avertissements: [], ok: false };
  }

  const operations = [];
  const problemes = [];
  const modifiesDepuis = [];
  const obstacles = creerRegistreObstacles();
  const sauvegardesManquantes = [];

  await pool(
    manifeste.fichiers.filter((f) => !f.erreur),
    concurrence,
    async (fichier) => {
      const cheminProd = joindreRelatif(manifeste.racineProd, fichier.chemin);
      const cheminSauvegarde = fichier.sauvegarde
        ? joindreRelatif(manifeste.dossierSauvegarde, fichier.sauvegarde)
        : null;

      const obstacle = await obstacleEcriture(cheminProd);
      if (obstacle) obstacles.noter(obstacle.cause, obstacle.code, fichier.chemin);

      try {
        if (await existe(cheminProd)) {
          const hashActuel = await hashFichier(cheminProd);
          if (fichier.hashApres && hashActuel !== fichier.hashApres) {
            modifiesDepuis.push(fichier.chemin);
          }
        }
      } catch (err) {
        if (!obstacle) obstacles.noter(CAUSE_ILLISIBLE, err.code || 'inconnu', fichier.chemin);
      }

      if (fichier.action === ACTION_CREATION) {
        operations.push({ chemin: fichier.chemin, action: ACTION_SUPPRESSION, source: null });
        return;
      }

      let sauvegardePresente = false;
      try {
        sauvegardePresente = Boolean(cheminSauvegarde) && (await existe(cheminSauvegarde));
      } catch (err) {
        // Archives injoignables : autant dire manquante, cela bloque la
        // restauration au lieu de la lancer à moitié.
        sauvegardePresente = false;
      }
      if (!sauvegardePresente) {
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

  problemes.push(...obstacles.problemes());
  if (sauvegardesManquantes.length) {
    // Deux causes très différentes : soit l'archivage avait été écarté à la
    // demande, soit l'archive a disparu depuis. Le message le dit.
    const sansArchivage = manifeste.archivage === false;
    problemes.push(
      probleme(
        BLOQUANT,
        'sauvegarde',
        sansArchivage
          ? `Ce déploiement a été fait sans archivage AVMDF : ${sauvegardesManquantes.length} fichier(s) n'ont aucune version « avant modification ».`
          : `${sauvegardesManquantes.length} sauvegarde(s) sont introuvables dans ${manifeste.dossierSauvegarde}.`,
        sansArchivage
          ? 'Rien n\'a été conservé de l\'état antérieur : le retour arrière est impossible pour ce passage. Le manifeste garde l\'empreinte des versions remplacées, à défaut de leur contenu.'
          : 'Sans la version archivée, le retour arrière n\'a rien à restaurer.',
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
    invaliderCache = null,
    dossierSecours = null
  } = options;

  // Mêmes gardes qu'à la préparation : sans elles, un manifeste sans dossier de
  // sauvegarde exécutait ses suppressions puis plantait sur path.join(null, …),
  // sans écrire le manifeste de restauration.
  if (manifeste.simulation) {
    throw new Error('ce manifeste est une simulation : rien n\'a été écrit, il n\'y a rien à restaurer');
  }
  if (!manifeste.dossierSauvegarde) {
    throw new Error('ce manifeste ne référence aucun dossier de sauvegarde : le retour arrière est impossible');
  }

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
        if (!simulation) await copierVersProduction(operation.source, cheminProd);
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

  const chemins = await deposerTraces(
    manifesteRestauration,
    manifeste.dossierSauvegarde,
    `_restauration_${horodatageFichier(debut)}.json`,
    { simulation, dossierSecours }
  );

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

    const obstacle = await obstacleEcriture(cheminProd);
    if (obstacle) {
      const registre = creerRegistreObstacles();
      registre.noter(obstacle.cause, obstacle.code, plan.chemin);
      problemes.push(...registre.problemes());
      throw new Error('le fichier ne peut pas être remplacé en production');
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
      await copierVersProduction(plan.source, cheminProd);
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

  let chemins = { manifeste: null, recapitulatif: null, manifesteSecours: null, erreurEcriture: null };
  if (!simulation && !entree.erreur) {
    await fsp.mkdir(cheminLong(plan.dossierSauvegarde), { recursive: true });
    chemins = await deposerTraces(manifeste, plan.dossierSauvegarde, `_restauration_${horodatageFichier(debut)}.json`, {
      simulation,
      dossierSecours: options.dossierSecours || null
    });
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
  deposerTraces,
  listerManifestes,
  verifierManifeste,
  preparerRestauration,
  restaurer,
  restaurerVersion,
  formaterOctets,
  obstacleEcriture,
  creerRegistreObstacles,
  copierAvecDate,
  copierVersProduction
};
