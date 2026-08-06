import { h, render } from './vendor/preact.module.js';
import htm from './vendor/htm.module.js';
import { useCallback, useEffect, useMemo, useState } from './vendor/hooks.module.js';
import { EnTete } from './components/EnTete.js';
import { ArbreFichiers } from './components/ArbreFichiers.js';
import { VueDiff } from './components/VueDiff.js';
import { BandeauDeploiement } from './components/BandeauDeploiement.js';
import { Reglages } from './components/Reglages.js';
import { Notifications, useNotifications } from './components/Notifications.js';
import { joindreChemin } from './components/chemins.js';

const html = htm.bind(h);

function App() {
  const [etat, setEtat] = useState('chargement'); // chargement | pret | panne
  const [panne, setPanne] = useState(null);
  const [config, setConfig] = useState(null);
  const [defauts, setDefauts] = useState(null);
  const [infos, setInfos] = useState(null);
  const [projetId, setProjetId] = useState(null);
  const [cible, setCible] = useState({ mode: 'projet' });
  const [reglagesOuverts, setReglagesOuverts] = useState(false);

  const { liste: notifications, notifier, notifierEchec, retirer } = useNotifications();

  // -- Chargement initial ---------------------------------------------------
  useEffect(() => {
    let abandonne = false;

    (async () => {
      if (!window.avmdf) {
        setPanne({
          message: 'Le pont entre l\'interface et le système de fichiers n\'a pas été chargé.',
          conseil: 'Fermez puis relancez l\'application. Si le problème persiste, vérifiez que le fichier electron/preload.js est bien présent.'
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
      avertissements.forEach((texte) =>
        notifier({ type: 'alerte', titre: 'Réglages', texte, duree: 12000 })
      );

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

  // -- Projet courant -------------------------------------------------------
  const projet = useMemo(() => {
    if (!config) return null;
    const parId = config.projets.find((p) => p.id === projetId && p.actif);
    return parId || config.projets.find((p) => p.actif) || null;
  }, [config, projetId]);

  // -- Actions --------------------------------------------------------------
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
      const suivant = {
        ...config,
        options: { ...config.options, simulation: valeur }
      };
      setConfig(suivant);
      const reponse = await window.avmdf.config.enregistrer(suivant);
      if (reponse.ok) {
        setConfig(reponse.config);
      } else {
        setConfig(precedent);
        notifierEchec(reponse, 'Le mode simulation n\'a pas pu être enregistré.');
      }
    },
    [config, notifierEchec]
  );

  const activerComparaisonLibre = useCallback(
    (libre) => {
      setCible({ mode: 'libre', dossierA: libre.dossierA, dossierB: libre.dossierB });
      setReglagesOuverts(false);
      notifier({
        type: 'info',
        titre: 'Comparaison libre activée.',
        texte: libre.dossierA + '  ↔  ' + libre.dossierB
      });
    },
    [notifier]
  );

  // -- Rendu ----------------------------------------------------------------
  if (etat === 'chargement') {
    return html`<div class="demarrage"><h1>AVMDF</h1><p class="attenue">Chargement des réglages…</p></div>`;
  }

  if (etat === 'panne') {
    return html`
      <div class="demarrage">
        <h1>AVMDF</h1>
        <div class="encart encart-danger" style="max-width:640px;text-align:left">
          <strong>${panne.message}</strong>
          ${panne.conseil ? html`<div style="margin-top:6px">${panne.conseil}</div>` : null}
        </div>
      </div>
    `;
  }

  const modeLibre = cible.mode === 'libre';
  const cheminLocal = modeLibre
    ? cible.dossierB
    : projet
      ? joindreChemin(config.racines.locale, projet.dossierLocal)
      : '';
  const cheminProd = modeLibre
    ? cible.dossierA
    : projet
      ? joindreChemin(config.racines.prod, projet.dossierProd)
      : '';

  return html`
    <div class="application">
      <${EnTete}
        config=${config}
        projet=${projet}
        cible=${cible}
        onChangerProjet=${setProjetId}
        onQuitterModeLibre=${() => setCible({ mode: 'projet' })}
        onAnalyser=${null}
        onOuvrirReglages=${() => setReglagesOuverts(true)}
      />

      <div class="corps">
        <${ArbreFichiers} cheminLocal=${cheminLocal} cheminProd=${cheminProd} />
        <${VueDiff} />
      </div>

      <${BandeauDeploiement}
        simulation=${config.options.simulation}
        onSimulation=${changerSimulation}
        nombreSelection=${0}
        destination=${null}
        onDeployer=${null}
      />

      ${reglagesOuverts
        ? html`<${Reglages}
            config=${config}
            infos=${infos}
            defauts=${defauts}
            onEnregistrer=${enregistrerReglages}
            onReinitialiser=${reinitialiserReglages}
            onComparaisonLibre=${activerComparaisonLibre}
            onFermer=${() => setReglagesOuverts(false)}
            onEchec=${(reponse) => notifierEchec(reponse, 'Action impossible.')}
          />`
        : null}

      <${Notifications} liste=${notifications} onFermer=${retirer} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('racine'));
