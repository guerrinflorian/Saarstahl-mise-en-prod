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
import { VersionsFichier } from './components/VersionsFichier.js';
import { Notifications, useNotifications } from './components/Notifications.js';
import { joindreChemin } from './components/chemins.js';
import { criteresParDefaut, filtrer, listerDossiers } from './components/filtres.js';
import { dossiersDePremierNiveau, filtrerArbre, tousLesDossiers } from './components/arborescence.js';

const html = htm.bind(h);

const ANALYSE_INACTIVE = { etat: 'inactif', progression: null, resultat: null };

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

      if (reponseConfig.controle && reponseConfig.controle.erreurs.length) {
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
    setAnalyse({ etat: 'encours', progression: null, resultat: null });
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
      setAnalyse(ANALYSE_INACTIVE);
      notifierEchec(reponse, 'Analyse impossible.');
      return;
    }
    if (reponse.annule || !reponse.resultat) {
      setAnalyse(ANALYSE_INACTIVE);
      notifier({ type: 'info', titre: 'Analyse annulée.' });
      return;
    }

    setAnalyse({ etat: 'termine', progression: null, resultat: reponse.resultat });
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

  const actionFichier = useCallback(
    async (action, fichier) => {
      if (action === 'copier') {
        await window.avmdf.systeme.copier(fichier.chemin);
        notifier({ type: 'succes', titre: 'Chemin copié.', texte: fichier.chemin, duree: 2500 });
        return;
      }
      if (action === 'versions') {
        setVersionsDe({ cle: fichier.cle, chemin: fichier.chemin });
        return;
      }
      if (action === 'exclure') {
        const reponse = await window.avmdf.config.exclureFichier(fichier.nom);
        if (!reponse.ok) {
          notifierEchec(reponse, 'Exclusion impossible.');
          return;
        }
        setConfig(reponse.config);
        notifier({
          type: 'succes',
          titre: reponse.deja ? 'Ce fichier était déjà exclu.' : `« ${fichier.nom} » ajouté aux fichiers exclus.`,
          texte: 'La prochaine analyse n\'en tiendra plus compte.'
        });
        return;
      }
      const cote = action === 'ouvrirProd' || action === 'reveler' ? fichier.prod || fichier.local : fichier.local || fichier.prod;
      if (!cote) {
        notifier({ type: 'alerte', titre: 'Ce fichier n\'existe pas de ce côté.' });
        return;
      }
      const reponse =
        action === 'reveler'
          ? await window.avmdf.systeme.reveler(cote.absolu)
          : await window.avmdf.systeme.ouvrir(cote.absolu);
      if (!reponse.ok) notifierEchec(reponse, 'Ouverture impossible.');
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
    if (!destination) {
      setEcran('destination');
      return;
    }
    setDeploiement({ etape: 'preflight', progression: null, occupe: false });
    const reponse = await window.avmdf.deploiement.preflight({
      cles: [...selection],
      demande: destination.demande,
      sprint: destination.sprint,
      operation,
      archiver,
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
  }, [destination, selection, operation, config, notifierEchec]);

  const confirmerDeploiement = useCallback(async () => {
    setDeploiement((precedent) => ({ ...precedent, occupe: true }));
    const reponse = await window.avmdf.deploiement.executer({
      cles: [...selection],
      demande: destination.demande,
      sprint: destination.sprint,
      operation,
      archiver,
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
      notifier({
        type: reponse.rapport.echecs ? 'erreur' : 'succes',
        titre: reponse.rapport.echecs
          ? `Mise en production terminée avec ${reponse.rapport.echecs} échec(s).`
          : 'Mise en production terminée.',
        texte: 'Relancez une analyse pour repartir de l\'état réel.'
      });
    }
  }, [selection, destination, operation, config, notifier, notifierEchec]);

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
        if (vue === 'analyse' && analyse.etat !== 'encours' && !ecran) analyser();
      } else if (evenement.key === 'Enter' && (evenement.ctrlKey || evenement.metaKey)) {
        if (dansUnChamp) return;
        evenement.preventDefault();
        if (vue === 'analyse' && !ecran && !deploiement && resumeSelection.deployables + resumeSelection.orphelins > 0) {
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
        <p class="attenue">Chargement des réglages…</p>
      </div>
    `;
  }

  if (etat === 'panne') {
    return html`
      <div class="demarrage">
        <img class="demarrage-logo" src="assets/logo.png" alt="Saarstahl Rail" />
        <h1><span class="demarrage-marque">AVMDF</span> Mise en production</h1>
        <div class="encart encart-danger" style="max-width:640px;text-align:left">
          <strong>${panne.message}</strong>
          ${panne.conseil ? html`<div style="margin-top:6px">${panne.conseil}</div>` : null}
        </div>
      </div>
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
          onAction=${actionFichier}
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
