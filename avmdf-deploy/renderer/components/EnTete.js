import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { joindreChemin } from './chemins.js';

const html = htm.bind(h);

/**
 * Barre du haut : cible de la comparaison (projet ou dossiers libres),
 * chemins résolus, lancement de l'analyse, accès aux réglages.
 */
export function EnTete({ config, projet, cible, onChangerProjet, onQuitterModeLibre, onAnalyser, onOuvrirReglages }) {
  const projetsActifs = config.projets.filter((p) => p.actif);
  const modeLibre = cible.mode === 'libre';

  const gauche = modeLibre ? cible.dossierA : projet ? joindreChemin(config.racines.locale, projet.dossierLocal) : '';
  const droite = modeLibre ? cible.dossierB : projet ? joindreChemin(config.racines.prod, projet.dossierProd) : '';

  return html`
    <header class="entete">
      <div class="entete-titre">
        <span class="entete-marque">AVMDF</span>
        <span>Mise en production</span>
      </div>

      ${modeLibre
        ? html`
            <span class="etiquette-mode">Comparaison libre</span>
            <button type="button" class="btn btn-plat" onClick=${onQuitterModeLibre}>
              Revenir aux projets
            </button>
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
                : projetsActifs.map(
                    (p) => html`<option value=${p.id} key=${p.id}>${p.nom || '(sans nom)'}</option>`
                  )}
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

      <div class="entete-actions">
        <button
          type="button"
          class="btn"
          disabled=${!gauche || !droite || !onAnalyser}
          title=${onAnalyser ? 'Comparer les deux arborescences (F5)' : 'Analyse récursive : étape suivante du chantier'}
          onClick=${onAnalyser || undefined}
        >
          Analyser
        </button>
        <button type="button" class="btn" title="Réglages" onClick=${onOuvrirReglages}>⚙ Réglages</button>
      </div>
    </header>
  `;
}
