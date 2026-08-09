import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { joindreChemin } from './chemins.js';
import { IconeEngrenage, IconeHistorique, IconeJournal, IconeLune, IconeSoleil } from './icones.js';
import { themeOppose } from './theme.js';

const html = htm.bind(h);

/**
 * Barre du haut : navigation entre l'analyse et le tableau de bord, cible de
 * la comparaison, lancement de l'analyse, accès aux écrans annexes.
 */
export function EnTete({
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
        <span class="entete-marque">AVMDF<small>Mise en production</small></span>
      </div>

      <nav class="onglets" aria-label="Vues principales">
        <button
          type="button"
          class=${'onglet' + (vue === 'analyse' ? ' actif' : '')}
          aria-current=${vue === 'analyse' ? 'page' : 'false'}
          onClick=${() => onVue('analyse')}
        >
          Analyse
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

      ${vue === 'analyse'
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
        ${vue === 'analyse'
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
