import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { joindreChemin } from './chemins.js';
import { IconeEngrenage, IconeFront, IconeHistorique, IconeJournal, IconeLune, IconeServeur, IconeSoleil } from './icones.js';
import { themeOppose } from './theme.js';

const html = htm.bind(h);

/**
 * Barre du haut : choix de l'espace (Front ou WebServices), navigation entre
 * l'espace de travail et le tableau de bord, cible de la comparaison,
 * lancement de l'analyse, accès aux écrans annexes.
 */
export function EnTete({
  espace = 'front',
  onEspace,
  cheminsWs,
  config,
  projet,
  cible,
  vue,
  onVue,
  theme,
  onTheme,
  analyseEnCours,
  onChangerProjet,
  onQuitterModeLibre,
  onAnalyser,
  onAnnuler,
  onOuvrirReglages,
  onOuvrirHistorique,
  onOuvrirJournal
}) {
  const projetsActifs = config.projets.filter((p) => p.actif);
  const modeLibre = cible.mode === 'libre';
  const ws = espace === 'ws';

  const gauche = modeLibre
    ? cible.dossierB
    : projet
      ? joindreChemin(config.racines.locale, projet.dossierLocal)
      : '';
  const droite = modeLibre
    ? cible.dossierA
    : projet
      ? joindreChemin(config.racines.prod, projet.dossierProd)
      : '';

  return html`
    <header class="entete">
      <div class="entete-titre">
        <img class="entete-logo" src="assets/marque.png" alt="Saarstahl Rail" />
        <span class="entete-marque">MEPFront<small>Mise en production</small></span>
      </div>

      <div class="espaces" role="tablist" aria-label="Ce que l'on met en production">
        <button
          type="button"
          role="tab"
          class=${'espace' + (!ws ? ' actif' : '')}
          aria-selected=${!ws ? 'true' : 'false'}
          title="Front : les sources (aspx, js, css…) copiées telles quelles"
          onClick=${() => onEspace && onEspace('front')}
        >
          <${IconeFront} /> Front
        </button>
        <button
          type="button"
          role="tab"
          class=${'espace' + (ws ? ' actif' : '')}
          aria-selected=${ws ? 'true' : 'false'}
          title="WebServices : compilés en Release, dossier complet archivé, bin copié"
          onClick=${() => onEspace && onEspace('ws')}
        >
          <${IconeServeur} /> WebServices
        </button>
      </div>

      <nav class="onglets" aria-label="Vues principales">
        <button
          type="button"
          class=${'onglet' + (vue === 'analyse' ? ' actif' : '')}
          aria-current=${vue === 'analyse' ? 'page' : 'false'}
          onClick=${() => onVue('analyse')}
        >
          ${ws ? 'Mise en production' : 'Analyse'}
        </button>
        <button
          type="button"
          class=${'onglet' + (vue === 'bord' ? ' actif' : '')}
          aria-current=${vue === 'bord' ? 'page' : 'false'}
          onClick=${() => onVue('bord')}
        >
          Tableau de bord
        </button>
        <button
          type="button"
          class=${'onglet' + (vue === 'aide' ? ' actif' : '')}
          aria-current=${vue === 'aide' ? 'page' : 'false'}
          title="Comprendre l'interface, les statuts, le déroulé d'une mise en production"
          onClick=${() => onVue('aide')}
        >
          Aide
        </button>
      </nav>

      ${vue === 'analyse' && ws
        ? html`<div class="entete-chemins mono">
            ${cheminsWs
              ? html`
                  <span class="chemin" title=${cheminsWs.locale}>${cheminsWs.locale}</span>
                  <span class="fleche">→</span>
                  <span class="chemin" title=${cheminsWs.prod}>${cheminsWs.prod}</span>
                `
              : null}
          </div>`
        : vue === 'analyse'
        ? html`
            ${modeLibre
              ? html`
                  <span class="etiquette-mode">Comparaison libre</span>
                  <button type="button" class="btn btn-plat" onClick=${onQuitterModeLibre}>Revenir aux projets</button>
                `
              : html`
                  <label for="choix-projet">Projet</label>
                  <select
                    id="choix-projet"
                    value=${projet ? projet.id : ''}
                    disabled=${projetsActifs.length === 0}
                    onChange=${(evenement) => onChangerProjet(evenement.target.value)}
                  >
                    ${projetsActifs.length === 0
                      ? html`<option value="">Aucun projet actif</option>`
                      : projetsActifs.map((p) => html`<option value=${p.id} key=${p.id}>${p.nom || '(sans nom)'}</option>`)}
                  </select>
                `}

            <div class="entete-chemins mono">
              ${gauche || droite
                ? html`
                    <span class="chemin" title=${gauche}>${gauche}</span>
                    <span class="fleche">→</span>
                    <span class="chemin" title=${droite}>${droite}</span>
                  `
                : html`<span class="rien">Aucune cible : ajoutez un projet dans les réglages.</span>`}
            </div>
          `
        : html`<div style="flex:1"></div>`}

      <div class="entete-actions">
        ${vue === 'analyse' && !ws
          ? analyseEnCours
            ? html`<button type="button" class="btn" onClick=${onAnnuler}>Annuler l'analyse</button>`
            : html`<button
                type="button"
                class="btn"
                disabled=${!gauche || !droite}
                title="Comparer les deux arborescences (F5)"
                onClick=${onAnalyser}
              >
                Analyser
              </button>`
          : null}
        <button type="button" class="btn btn-plat" title="Déploiements passés et retour arrière" onClick=${onOuvrirHistorique}>
          <${IconeHistorique} /> Historique
        </button>
        <button type="button" class="btn btn-plat" title="Journal des événements" onClick=${onOuvrirJournal}>
          <${IconeJournal} /> Journal
        </button>
        <button
          type="button"
          class="btn btn-carre"
          title=${'Passer au thème ' + (theme === 'clair' ? 'sombre' : 'clair')}
          aria-label=${'Passer au thème ' + (theme === 'clair' ? 'sombre' : 'clair')}
          onClick=${() => onTheme(themeOppose(theme))}
        >
          ${theme === 'clair' ? html`<${IconeLune} />` : html`<${IconeSoleil} />`}
        </button>
        <button type="button" class="btn" title="Réglages" onClick=${onOuvrirReglages}>
          <${IconeEngrenage} /> Réglages
        </button>
      </div>
    </header>
  `;
}
