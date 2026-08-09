import { h, render } from './vendor/preact.module.js';
import htm from './vendor/htm.module.js';
import { useCallback, useEffect, useMemo, useRef, useState } from './vendor/hooks.module.js';

import { EnTete } from './components/EnTete.js';
import { ArbreFichiers } from './components/ArbreFichiers.js';
import { VueDiff } from './components/VueDiff.js';
import { BandeauDeploiement, operationDe, resumerSelection } from './components/BandeauDeploiement.js';
import { Reglages } from './components/Reglages.js';
import { PanneauDestination } from './components/PanneauDestination.js';
import { ConfirmationDeploiement } from './components/ConfirmationDeploiement.js';
import { RapportDeploiement } from './components/RapportDeploiement.js';
import { Historique } from './components/Historique.js';
import { Journal } from './components/Journal.js';
import { TableauDeBord } from './components/TableauDeBord.js';
import { Aide } from './components/Aide.js';
import { Bienvenue } from './components/Bienvenue.js';
import { VersionsFichier } from './components/VersionsFichier.js';
import { EditeurFichier } from './components/EditeurFichier.js';
import { PaletteFichiers } from './components/PaletteFichiers.js';
import { Notifications, useNotifications } from './components/Notifications.js';
import { appliquerTheme, lireTheme } from './components/theme.js';
import { joindreChemin } from './components/chemins.js';
import { criteresParDefaut, filtrer, listerDossiers } from './components/filtres.js';
import { dossiersDePremierNiveau, filtrerArbre, tousLesDossiers } from './components/arborescence.js';

const html = htm.bind(h);

const ANALYSE_INACTIVE = { etat: 'inactif', progression: null, resultat: null, acces: null };

function App() {
  const [etat, setEtat] = useState('chargement');
  const [panne, setPanne] = useState(null);
  const [config, setConfig] = useState(null);
  const [defauts, setDefauts] = useState(null);
  const [infos, setInfos] = useState(null);

  const [projetId, setProjetId] = useState(null);
  const [cible, setCible] = useState({ mode: 'projet' });
  const [ecran, setEcran] = useState(null);
  const [vue, setVue] = useState('analyse');
  // Le thème est déjà posé sur la page par `theme-initial.js` ; cet état ne
  // fait que le suivre, et l'effet plus bas rejoue l'application complète
  // (mémorisation, fond de la fenêtre).
  const [theme, setTheme] = useState(lireTheme);
  const [largeurPanneau, setLargeurPanneau] = useState(() => {
    try {
      const memorise = JSON.parse(localStorage.getItem('avmdf.ui')) || {};
      return Math.min(700, Math.max(300, memorise.largeurPanneau || 380));
    } catch (err) {
      return 380;
    }
  });

  const [analyse, setAnalyse] = useState(ANALYSE_INACTIVE);
  const [criteres, setCriteres] = useState(criteresParDefaut);
  const [occurrences, setOccurrences] = useState(null);
  const [rechercheContenu, setRechercheContenu] = useState({ enCours: false, faits: 0, total: 0, trouves: null });

  const [ouverts, setOuverts] = useState(() => new Set());
  const [selection, setSelection] = useState(() => new Set());
  const [fichierActif, setFichierActif] = useState(null);
  const [diff, setDiff] = useState({ etat: 'vide' });

  const [destination, setDestination] = useState(null);
  // L'archivage AVMDF est le comportement normal. Le décocher est un choix
  // explicite, refait à chaque passage : il ne survit pas à un déploiement.
  const [archiver, setArchiver] = useState(true);
  const [versionsDe, setVersionsDe] = useState(null);
  const [editeurDe, setEditeurDe] = useState(null);
  const [paletteOuverte, setPaletteOuverte] = useState(false);
  const [deploiement, setDeploiement] = useState(null);
  const [rapport, setRapport] = useState(null);

  const { liste: notifications, notifier, notifierEchec, retirer } = useNotifications();
  const jeton = useRef(0);

  // -- Chargement initial ---------------------------------------------------
  useEffect(() => {
    let abandonne = false;
    (async () => {
      if (!window.avmdf) {
        setPanne({
          message: "Le pont entre l'interface et le système de fichiers n'a pas été chargé.",
          conseil:
            'Fermez puis relancez l\'application. Si le problème persiste, vérifiez que le fichier electron/preload.js est bien présent.'
        });
        setEtat('panne');
        return;
      }

      const [reponseInfos, reponseConfig, reponseDefauts] = await Promise.all([
        window.avmdf.systeme.infos(),
        window.avmdf.config.lire(),
        window.avmdf.config.defauts()
      ]);
      if (abandonne) return;

      if (!reponseConfig.ok) {
        setPanne(reponseConfig.erreur);
        setEtat('panne');
        return;
      }

      if (reponseInfos.ok) setInfos(reponseInfos.infos);
      if (reponseDefauts.ok) setDefauts(reponseDefauts.config);
      setConfig(reponseConfig.config);
      setEtat('pret');

      const avertissements = (reponseInfos.ok ? reponseInfos.avertissements : []).concat(
        reponseConfig.avertissements || []
      );
      avertissements.forEach((texte) => notifier({ type: 'alerte', titre: 'Réglages', texte, duree: 12000 }));

      // Au tout premier lancement, les racines vides font deux erreurs de
      // contrôle : c'est justement ce que l'écran de premier démarrage
      // demande, inutile de le doubler d'une alerte rouge.
      const premierDemarrage =
        !reponseConfig.config.racines.locale.trim() || !reponseConfig.config.racines.prod.trim();

      if (!premierDemarrage && reponseConfig.controle && reponseConfig.controle.erreurs.length) {
        notifier({
          type: 'erreur',
          titre: 'Les réglages enregistrés comportent ' + reponseConfig.controle.erreurs.length + ' erreur(s).',
          texte: 'Ouvrez les réglages pour les corriger : ' + reponseConfig.controle.erreurs[0].message
        });
      }
    })();
    return () => {
      abandonne = true;
    };
  }, [notifier]);

  useEffect(() => {
    appliquerTheme(theme);
  }, [theme]);

  // -- Abonnements aux progressions ----------------------------------------
  useEffect(() => {
    if (!window.avmdf) return undefined;
    const desabonnements = [
      window.avmdf.analyse.surProgression((avancement) =>
        setAnalyse((precedent) => ({ ...precedent, progression: avancement }))
      ),
      window.avmdf.recherche.surProgression((avancement) =>
        setRechercheContenu((precedent) => ({ ...precedent, ...avancement }))
      ),
      window.avmdf.deploiement.surProgression((avancement) =>
        setDeploiement((precedent) => (precedent ? { ...precedent, progression: avancement } : precedent))
      )
    ];
    return () => desabonnements.forEach((f) => f());
  }, []);

  // -- Projet courant -------------------------------------------------------
  const projet = useMemo(() => {
    if (!config) return null;
    const parId = config.projets.find((p) => p.id === projetId && p.actif);
    return parId || config.projets.find((p) => p.actif) || null;
  }, [config, projetId]);

  const modeLibre = cible.mode === 'libre';
  const cheminLocal = config
    ? modeLibre
      ? cible.dossierB
      : projet
        ? joindreChemin(config.racines.locale, projet.dossierLocal)
        : ''
    : '';
  const cheminProd = config
    ? modeLibre
      ? cible.dossierA
      : projet
        ? joindreChemin(config.racines.prod, projet.dossierProd)
        : ''
    : '';

  // -- Filtrage -------------------------------------------------------------
  const fichiersFiltres = useMemo(() => {
    if (!analyse.resultat) return [];
    return filtrer(analyse.resultat.fichiers, criteres, occurrences);
  }, [analyse.resultat, criteres, occurrences]);

  const arbreFiltre = useMemo(() => {
    if (!analyse.resultat) return null;
    const cles = new Set(fichiersFiltres.map((fichier) => fichier.cle));
    return filtrerArbre(analyse.resultat.arbre, cles);
  }, [analyse.resultat, fichiersFiltres]);

  const dossiers = useMemo(
    () => (analyse.resultat ? listerDossiers(analyse.resultat.fichiers) : []),
    [analyse.resultat]
  );

  const resumeSelection = useMemo(
    () => resumerSelection(analyse.resultat ? analyse.resultat.fichiers : [], selection),
    [analyse.resultat, selection]
  );
  const operation = operationDe(resumeSelection);

  // « Archiver » ne s'applique qu'aux mises en production. Supprimer un
  // orphelin sans en garder de copie serait sans retour : le bandeau ne
  // propose alors pas la case, et l'archivage reste entier.
  const archivageAvmdf = archiver || operation === 'suppression';

  // Un filtre actif déplie l'arbre : sans cela, les fichiers trouvés restent
  // cachés dans des dossiers repliés et la recherche semble ne rien donner.
  useEffect(() => {
    if (!arbreFiltre) return;
    const filtreActif =
      criteres.requete.trim() || criteres.extensions || criteres.depuis || criteres.dossier;
    if (filtreActif) setOuverts(tousLesDossiers(arbreFiltre));
  }, [criteres.requete, criteres.mode, criteres.extensions, criteres.depuis, criteres.dossier]);

  // -- Recherche dans le contenu -------------------------------------------
  useEffect(() => {
    if (!analyse.resultat || !criteres.dansLeContenu || !criteres.requete.trim()) {
      setOccurrences(null);
      setRechercheContenu({ enCours: false, faits: 0, total: 0, trouves: null });
      return undefined;
    }
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      setRechercheContenu({ enCours: true, faits: 0, total: 0, trouves: null });
      const reponse = await window.avmdf.recherche.dansLeContenu({
        requete: criteres.requete,
        mode: criteres.mode
      });
      if (abandonne) return;
      if (!reponse.ok) {
        setRechercheContenu({ enCours: false, faits: 0, total: 0, trouves: null });
        notifierEchec(reponse, 'Recherche dans le contenu impossible.');
        return;
      }
      setOccurrences(new Map(reponse.occurrences));
      setRechercheContenu((precedent) => ({
        ...precedent,
        enCours: false,
        trouves: reponse.occurrences.length
      }));
    }, 400);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
      window.avmdf.recherche.annuler();
    };
  }, [analyse.resultat, criteres.dansLeContenu, criteres.requete, criteres.mode, notifierEchec]);

  // -- Actions --------------------------------------------------------------
  const analyser = useCallback(async () => {
    if (!cheminLocal || !cheminProd) {
      notifier({
        type: 'alerte',
        titre: 'Aucune cible à comparer.',
        texte: 'Choisissez un projet actif ou lancez une comparaison libre depuis les réglages.'
      });
      return;
    }
    jeton.current += 1;
    setAnalyse({ etat: 'encours', progression: null, resultat: null, acces: null });
    setSelection(new Set());
    setFichierActif(null);
    setDiff({ etat: 'vide' });
    setOccurrences(null);

    const reponse = await window.avmdf.analyse.demarrer({
      cheminLocal,
      cheminProd,
      modeLibre,
      projet: projet ? projet.nom : null
    });

    if (!reponse.ok) {
      // Le détail par côté reste affiché dans le panneau de gauche : une
      // notification qui s'efface ne suffit pas à faire corriger un chemin.
      setAnalyse({ ...ANALYSE_INACTIVE, acces: reponse.acces || null });
      notifierEchec(reponse, 'Analyse impossible.');
      return;
    }
    if (reponse.annule || !reponse.resultat) {
      setAnalyse(ANALYSE_INACTIVE);
      notifier({ type: 'info', titre: 'Analyse annulée.' });
      return;
    }

    setAnalyse({ etat: 'termine', progression: null, resultat: reponse.resultat, acces: null });
    setOuverts(dossiersDePremierNiveau(reponse.resultat.arbre, 1));

    const compteurs = reponse.resultat.compteurs;
    const ecarts = compteurs.modifie + compteurs.nouveau + compteurs.orphelin;
    notifier({
      type: ecarts ? 'succes' : 'info',
      titre: ecarts
        ? `Analyse terminée : ${ecarts} écart(s) sur ${reponse.resultat.fichiers.length} fichiers.`
        : 'Aucun écart détecté entre local et prod.',
      texte: reponse.resultat.ignores.length
        ? `${reponse.resultat.ignores.length} élément(s) ignorés - voir le panneau en bas à gauche.`
        : ''
    });

    // Deux dossiers sans rapport donnent une analyse parfaitement lisible et
    // parfaitement fausse : elle se dit, elle ne se devine pas.
    const correspondance = reponse.resultat.correspondance;
    if (correspondance && correspondance.niveau !== 'ok') {
      notifier({
        type: correspondance.niveau === 'alerte' ? 'erreur' : 'alerte',
        titre: correspondance.titre,
        texte: correspondance.texte,
        duree: 20000
      });
    }
  }, [cheminLocal, cheminProd, modeLibre, projet, notifier, notifierEchec]);

  const choisirFichier = useCallback(
    async (fichier) => {
      setFichierActif(fichier.cle);
      setDiff({ etat: 'chargement' });
      const reponse = await window.avmdf.fichier.diff(fichier.cle);
      if (!reponse.ok) {
        setDiff({ etat: 'erreur', erreur: reponse.erreur });
        return;
      }
      setDiff({ etat: 'pret', donnees: reponse.diff });
    },
    []
  );

  /** Menu contextuel de l'arborescence : les fichiers comme les dossiers. */
  const actionSurNoeud = useCallback(
    async (action, noeud) => {
      const estDossier = noeud.type === 'dossier';

      if (action === 'copier') {
        await window.avmdf.systeme.copier(noeud.chemin);
        notifier({ type: 'succes', titre: 'Chemin copié.', texte: noeud.chemin, duree: 2500 });
        return;
      }
      if (action === 'versions') {
        setVersionsDe({ cle: noeud.cle, chemin: noeud.chemin });
        return;
      }
      if (action === 'modifier') {
        setEditeurDe({ cle: noeud.cle, chemin: noeud.chemin });
        return;
      }
      if (action === 'exclure' || action === 'exclureDossierNom' || action === 'exclureDossierChemin') {
        const motif = action === 'exclureDossierChemin' ? noeud.chemin : noeud.nom;
        const reponse = estDossier
          ? await window.avmdf.config.exclureDossier(motif)
          : await window.avmdf.config.exclureFichier(motif);
        if (!reponse.ok) {
          notifierEchec(reponse, 'Exclusion impossible.');
          return;
        }
        setConfig(reponse.config);
        const quoi = estDossier ? 'dossiers exclus' : 'fichiers exclus';
        notifier({
          type: 'succes',
          titre: reponse.deja
            ? `« ${motif} » figurait déjà dans les ${quoi}.`
            : `« ${motif} » ajouté aux ${quoi}.`,
          texte: 'L\'analyse en cours ne change pas. Relancez-la (F5) pour la mettre à jour.'
        });
        return;
      }
      if (estDossier) {
        // Un dossier n'a pas de chemin absolu dans l'analyse : il est désigné
        // par son chemin relatif, que le processus principal joint lui-même à
        // la bonne racine.
        const reponse = await window.avmdf.systeme.revelerDossier(
          noeud.chemin,
          action === 'revelerProd' ? 'prod' : 'local'
        );
        if (!reponse.ok) notifierEchec(reponse, 'Affichage impossible.');
        return;
      }
      // Chaque action désigne son côté sans repli : « ouvrir la production »
      // qui ouvrirait le fichier local ferait dire n'importe quoi à ce qu'on
      // voit ensuite à l'écran.
      const versProd = action === 'ouvrirProd' || action === 'revelerProd';
      const cote = versProd ? noeud.prod : noeud.local;
      if (!cote) {
        notifier({
          type: 'alerte',
          titre: versProd
            ? 'Ce fichier n\'existe pas en production.'
            : 'Ce fichier n\'existe pas en local.',
          texte: noeud.chemin
        });
        return;
      }
      const dansExplorateur = action === 'revelerLocal' || action === 'revelerProd';
      const reponse = dansExplorateur
        ? await window.avmdf.systeme.reveler(cote.absolu)
        : await window.avmdf.systeme.ouvrir(cote.absolu);
      if (!reponse.ok) {
        notifierEchec(reponse, dansExplorateur ? 'Affichage impossible.' : 'Ouverture impossible.');
      }
    },
    [notifier, notifierEchec]
  );

  const ouvrirExterne = useCallback(
    async (camp) => {
      if (!diff.donnees) return;
      const cote = camp === 'prod' ? diff.donnees.prod : diff.donnees.local;
      if (!cote) return;
      const reponse = await window.avmdf.systeme.ouvrir(cote.absolu);
      if (!reponse.ok) notifierEchec(reponse, 'Ouverture impossible.');
    },
    [diff, notifierEchec]
  );

  const enregistrerReglages = useCallback(
    async (brouillon) => {
      const reponse = await window.avmdf.config.enregistrer(brouillon);
      if (reponse.ok) {
        setConfig(reponse.config);
        notifier({ type: 'succes', titre: 'Réglages enregistrés.' });
      } else {
        notifierEchec(reponse, 'Réglages non enregistrés.');
      }
      return reponse;
    },
    [notifier, notifierEchec]
  );

  const reinitialiserReglages = useCallback(async () => {
    const reponse = await window.avmdf.config.reinitialiser();
    if (reponse.ok) {
      setConfig(reponse.config);
      setProjetId(null);
      notifier({ type: 'succes', titre: 'Réglages remis à leurs valeurs par défaut.' });
    } else {
      notifierEchec(reponse, 'Réinitialisation impossible.');
    }
    return reponse;
  }, [notifier, notifierEchec]);

  const changerSimulation = useCallback(
    async (valeur) => {
      const precedent = config;
      const suivant = { ...config, options: { ...config.options, simulation: valeur } };
      setConfig(suivant);
      const reponse = await window.avmdf.config.enregistrer(suivant);
      if (reponse.ok) setConfig(reponse.config);
      else {
        setConfig(precedent);
        notifierEchec(reponse, "Le mode simulation n'a pas pu être enregistré.");
      }
    },
    [config, notifierEchec]
  );

  const lancerPreflight = useCallback(async () => {
    // La destination ne sert qu'à ranger les versions remplacées. Sans
    // archivage, elle n'a plus d'objet : elle n'est ni demandée ni transmise,
    // même si un choix traîne encore de la sélection précédente.
    if (!destination && archivageAvmdf) {
      setEcran('destination');
      return;
    }
    const cible = archivageAvmdf ? destination : null;
    setDeploiement({ etape: 'preflight', progression: null, occupe: false });
    const reponse = await window.avmdf.deploiement.preflight({
      cles: [...selection],
      demande: cible ? cible.demande : null,
      sprint: cible ? cible.sprint : null,
      operation,
      archiver: archivageAvmdf,
      simulation: config.options.simulation
    });
    if (!reponse.ok) {
      setDeploiement(null);
      notifierEchec(reponse, 'Contrôles préalables impossibles.');
      return;
    }
    setDeploiement({
      etape: 'confirmation',
      controle: reponse.controle,
      resume: reponse.resume,
      occupe: false,
      progression: null
    });
  }, [destination, archivageAvmdf, selection, operation, config, notifierEchec]);

  const confirmerDeploiement = useCallback(async () => {
    const cible = archivageAvmdf ? destination : null;
    setDeploiement((precedent) => ({ ...precedent, occupe: true }));
    const reponse = await window.avmdf.deploiement.executer({
      cles: [...selection],
      demande: cible ? cible.demande : null,
      sprint: cible ? cible.sprint : null,
      operation,
      archiver: archivageAvmdf,
      simulation: config.options.simulation
    });
    if (!reponse.ok) {
      setDeploiement((precedent) =>
        precedent
          ? { ...precedent, occupe: false, controle: reponse.controle || precedent.controle }
          : precedent
      );
      notifierEchec(reponse, 'Mise en production interrompue.');
      return;
    }
    setDeploiement(null);
    setRapport(reponse);
    if (!reponse.manifeste.simulation) {
      setSelection(new Set());
      setArchiver(true);

      // L'arborescence suit sans relire le partage : ce qui est parti passe en
      // « identique » et sort donc de la liste, ce qui a échoué y reste. La
      // comparaison ouverte, elle, décrit un écart qui n'existe plus.
      if (reponse.analyse) {
        setAnalyse({ etat: 'termine', progression: null, resultat: reponse.analyse, acces: null });
        setFichierActif(null);
        setDiff({ etat: 'vide' });
      }

      notifier({
        type: reponse.rapport.echecs ? 'erreur' : 'succes',
        titre: reponse.rapport.echecs
          ? `Mise en production terminée avec ${reponse.rapport.echecs} échec(s).`
          : 'Mise en production terminée.',
        texte: reponse.analyse
          ? reponse.rapport.echecs
            ? 'L\'arborescence est à jour : seuls les fichiers en échec y restent.'
            : 'L\'arborescence est à jour.'
          : 'Relancez une analyse pour repartir de l\'état réel.'
      });
    }
    // `archivageAvmdf` fait partie des dépendances : sans lui, ce rappel garde
    // la valeur qu'avait la case au moment où il a été construit. Décocher
    // « Archiver » sans rien toucher d'autre laissait alors partir un plan
    // avec archivage, qui réclamait une demande au dernier moment.
  }, [selection, destination, archivageAvmdf, operation, config, notifier, notifierEchec]);

  // La largeur du panneau de gauche survit au redémarrage.
  useEffect(() => {
    try {
      localStorage.setItem('avmdf.ui', JSON.stringify({ largeurPanneau }));
    } catch (err) {
      /* stockage local indisponible */
    }
  }, [largeurPanneau]);

  const redimensionner = useCallback(
    (evenement) => {
      evenement.preventDefault();
      const depart = evenement.clientX;
      const base = largeurPanneau;
      const bouger = (deplacement) => {
        const largeur = Math.min(
          Math.min(760, window.innerWidth * 0.6),
          Math.max(300, base + deplacement.clientX - depart)
        );
        setLargeurPanneau(largeur);
      };
      const lacher = () => {
        window.removeEventListener('pointermove', bouger);
        window.removeEventListener('pointerup', lacher);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', bouger);
      window.addEventListener('pointerup', lacher);
    },
    [largeurPanneau]
  );

  // -- Raccourcis clavier ---------------------------------------------------
  useEffect(() => {
    function surTouche(evenement) {
      const dansUnChamp = ['INPUT', 'TEXTAREA', 'SELECT'].includes(evenement.target.tagName);
      if (evenement.key === 'F5') {
        evenement.preventDefault();
        if (vue === 'analyse' && analyse.etat !== 'encours' && !ecran && !editeurDe) analyser();
      } else if (evenement.key.toLowerCase() === 'p' && (evenement.ctrlKey || evenement.metaKey)) {
        evenement.preventDefault();
        if (vue === 'analyse' && analyse.resultat && !ecran && !editeurDe && !deploiement) {
          setPaletteOuverte(true);
        }
      } else if (evenement.key === 'Enter' && (evenement.ctrlKey || evenement.metaKey)) {
        if (dansUnChamp) return;
        evenement.preventDefault();
        if (vue === 'analyse' && !ecran && !deploiement && !editeurDe && resumeSelection.deployables + resumeSelection.orphelins > 0) {
          lancerPreflight();
        }
      }
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  // -- Rendu ----------------------------------------------------------------
  if (etat === 'chargement') {
    return html`
      <div class="demarrage">
        <img class="demarrage-logo" src="assets/logo.png" alt="Saarstahl Rail" />
        <h1><span class="demarrage-marque">AVMDF</span> Mise en production</h1>
        <div class="rail" aria-hidden="true"></div>
        <p class="attenue">Chargement des réglages…</p>
      </div>
    `;
  }

  if (etat === 'panne') {
    return html`
      <div class="demarrage">
        <img class="demarrage-logo" src="assets/logo.png" alt="Saarstahl Rail" />
        <h1><span class="demarrage-marque">AVMDF</span> Mise en production</h1>
        <div class="rail" aria-hidden="true"></div>
        <div class="encart encart-danger" style="max-width:640px;text-align:left">
          <strong>${panne.message}</strong>
          ${panne.conseil ? html`<div style="margin-top:6px">${panne.conseil}</div>` : null}
        </div>
      </div>
    `;
  }

  // Sans racine locale ni racine de production, il n'y a rien à afficher :
  // ni cible, ni projet résolu, ni analyse possible. On demande d'abord.
  const racinesAChoisir = !config.racines.locale.trim() || !config.racines.prod.trim();
  if (racinesAChoisir && ecran !== 'reglages') {
    return html`
      <${Bienvenue}
        config=${config}
        defauts=${defauts}
        onEnregistrer=${enregistrerReglages}
        onOuvrirReglages=${() => setEcran('reglages')}
      />
      <${Notifications} liste=${notifications} onFermer=${retirer} />
    `;
  }

  const compteursAffichage = analyse.resultat ? analyse.resultat.compteurs : {};

  return html`
    <div class="application">
      <${EnTete}
        config=${config}
        projet=${projet}
        cible=${cible}
        vue=${vue}
        onVue=${setVue}
        theme=${theme}
        onTheme=${setTheme}
        analyseEnCours=${analyse.etat === 'encours'}
        onChangerProjet=${(id) => {
          setProjetId(id);
          setAnalyse(ANALYSE_INACTIVE);
          setDiff({ etat: 'vide' });
          setSelection(new Set());
        }}
        onQuitterModeLibre=${() => {
          setCible({ mode: 'projet' });
          setAnalyse(ANALYSE_INACTIVE);
          setDiff({ etat: 'vide' });
        }}
        onAnalyser=${analyser}
        onAnnuler=${() => window.avmdf.analyse.annuler()}
        onOuvrirReglages=${() => setEcran('reglages')}
        onOuvrirHistorique=${() => setEcran('historique')}
        onOuvrirJournal=${() => setEcran('journal')}
      />

      ${vue === 'bord'
        ? html`<${TableauDeBord}
            onEchec=${(reponse) => notifierEchec(reponse, 'Statistiques indisponibles.')}
            onOuvrirHistorique=${() => setEcran('historique')}
          />`
        : vue === 'aide'
        ? html`<${Aide}
            onVue=${setVue}
            onOuvrirReglages=${() => setEcran('reglages')}
            onOuvrirHistorique=${() => setEcran('historique')}
            onOuvrirJournal=${() => setEcran('journal')}
          />`
        : html`
      <div class="corps" style=${'grid-template-columns:' + largeurPanneau + 'px 5px minmax(0, 1fr)'}>
        <${ArbreFichiers}
          analyse=${analyse}
          cheminLocal=${cheminLocal}
          cheminProd=${cheminProd}
          criteres=${criteres}
          onCriteres=${setCriteres}
          onReinitialiser=${() => setCriteres(criteresParDefaut())}
          arbre=${arbreFiltre}
          compteurs=${compteursAffichage}
          extensions=${analyse.resultat ? analyse.resultat.extensions : []}
          dossiers=${dossiers}
          nombreAffiches=${fichiersFiltres.length}
          nombreTotal=${analyse.resultat ? analyse.resultat.fichiers.length : 0}
          rechercheContenu=${{ ...rechercheContenu, onAnnuler: () => window.avmdf.recherche.annuler() }}
          ouverts=${ouverts}
          onOuverts=${(valeur) => setOuverts(valeur === 'tout' ? tousLesDossiers(arbreFiltre) : valeur)}
          selection=${selection}
          onSelection=${setSelection}
          natureSelection=${resumeSelection.deployables + resumeSelection.orphelins === 0 ? null : operation}
          fichierActif=${fichierActif}
          onChoisir=${choisirFichier}
          ignores=${analyse.resultat ? analyse.resultat.ignores : []}
          onAction=${actionSurNoeud}
          onAnalyser=${analyser}
          onAnnuler=${() => window.avmdf.analyse.annuler()}
        />

        <div
          class="poignee"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner les panneaux"
          title="Glisser pour redimensionner ; double-clic pour revenir à la largeur d'origine"
          onPointerDown=${redimensionner}
          onDblClick=${() => setLargeurPanneau(380)}
        ></div>

        <${VueDiff}
          diff=${diff}
          onOuvrirExterne=${ouvrirExterne}
          onNotifier=${notifier}
          onVoirVersions=${
            diff.donnees
              ? () => setVersionsDe({ cle: diff.donnees.cle, chemin: diff.donnees.chemin })
              : null
          }
          onModifier=${
            diff.donnees && diff.donnees.local
              ? () => setEditeurDe({ cle: diff.donnees.cle, chemin: diff.donnees.chemin })
              : null
          }
        />
      </div>
      `}

      ${vue === 'analyse'
        ? html`<${BandeauDeploiement}
            simulation=${config.options.simulation}
            onSimulation=${changerSimulation}
            archiver=${archiver}
            onArchiver=${setArchiver}
            selection=${resumeSelection}
            destination=${destination}
            modeLibre=${modeLibre}
            operation=${operation}
            occupe=${Boolean(deploiement)}
            onChoisirDestination=${() => setEcran('destination')}
            onDeployer=${lancerPreflight}
          />`
        : null}

      ${editeurDe
        ? html`<${EditeurFichier}
            fichier=${editeurDe}
            onFermer=${() => setEditeurDe(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Enregistrement impossible.')}
            onEnregistre=${(reponse) => {
              // L'analyse suit l'édition : le statut du fichier vient d'être
              // recalculé sur le contenu réellement écrit, sans relire l'arbre.
              if (reponse.analyse) {
                setAnalyse((precedent) =>
                  precedent.resultat
                    ? { etat: 'termine', progression: null, resultat: reponse.analyse, acces: null }
                    : precedent
                );
              }
              if (reponse.diff && fichierActif === editeurDe.cle) {
                setDiff({ etat: 'pret', donnees: reponse.diff });
              }
              notifier({
                type: 'succes',
                titre: 'Fichier enregistré.',
                texte:
                  reponse.statut === 'identique'
                    ? editeurDe.chemin + ' - le local et la production sont maintenant identiques.'
                    : editeurDe.chemin,
                duree: 4000
              });
            }}
          />`
        : null}

      ${paletteOuverte && analyse.resultat
        ? html`<${PaletteFichiers}
            fichiers=${analyse.resultat.fichiers}
            onChoisir=${choisirFichier}
            onFermer=${() => setPaletteOuverte(false)}
          />`
        : null}

      ${versionsDe
        ? html`<${VersionsFichier}
            fichier=${versionsDe}
            destination=${destination}
            simulation=${config.options.simulation}
            onChoisirDestination=${() => setEcran('destination')}
            onFermer=${() => setVersionsDe(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Versions archivées indisponibles.')}
            onRapport=${(resultat) => {
              setVersionsDe(null);
              setRapport(resultat);
              if (!resultat.manifeste.simulation) {
                notifier({
                  type: 'succes',
                  titre: 'Version remise en production.',
                  texte: 'Relancez une analyse pour repartir de l\'état réel.'
                });
              }
            }}
          />`
        : null}

      ${ecran === 'reglages'
        ? html`<${Reglages}
            config=${config}
            infos=${infos}
            defauts=${defauts}
            onEnregistrer=${enregistrerReglages}
            onReinitialiser=${reinitialiserReglages}
            onComparaisonLibre=${(libre) => {
              setCible({ mode: 'libre', dossierA: libre.dossierA, dossierB: libre.dossierB });
              setAnalyse(ANALYSE_INACTIVE);
              setDiff({ etat: 'vide' });
              setSelection(new Set());
              setEcran(null);
              notifier({
                type: 'info',
                titre: 'Comparaison libre activée.',
                texte: libre.dossierA + '  ↔  ' + libre.dossierB
              });
            }}
            onFermer=${() => setEcran(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Action impossible.')}
          />`
        : null}

      ${ecran === 'destination'
        ? html`<${PanneauDestination}
            destination=${destination}
            onValider=${(choix) => {
              setDestination(choix);
              setEcran(null);
              notifier({ type: 'succes', titre: 'Destination choisie.', texte: choix.chemin, duree: 4000 });
            }}
            onFermer=${() => setEcran(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Lecture du dossier d\'archives impossible.')}
          />`
        : null}

      ${ecran === 'historique'
        ? html`<${Historique}
            onFermer=${() => setEcran(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Historique indisponible.')}
            onNotifier=${notifier}
            onRapport=${(resultat) => {
              setEcran(null);
              setRapport(resultat);
            }}
          />`
        : null}

      ${ecran === 'journal'
        ? html`<${Journal}
            onFermer=${() => setEcran(null)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Journal indisponible.')}
          />`
        : null}

      ${deploiement
        ? html`<${ConfirmationDeploiement}
            etape=${deploiement.etape}
            controle=${deploiement.controle}
            resume=${deploiement.resume}
            occupe=${deploiement.occupe}
            progression=${deploiement.progression}
            onConfirmer=${confirmerDeploiement}
            onFermer=${() => {
              window.avmdf.deploiement.annuler();
              setDeploiement(null);
            }}
          />`
        : null}

      ${rapport
        ? html`<${RapportDeploiement}
            resultat=${rapport}
            onFermer=${() => setRapport(null)}
            onOuvrir=${(chemin) => window.avmdf.systeme.ouvrir(chemin)}
            onReveler=${(chemin) => window.avmdf.systeme.reveler(chemin)}
          />`
        : null}

      <${Notifications} liste=${notifications} onFermer=${retirer} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('racine'));
