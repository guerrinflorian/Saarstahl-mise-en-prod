import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { Case } from './Champs.js';

const html = htm.bind(h);

/**
 * Bandeau bas : l'état exact de ce qui part et où, visible en permanence.
 * Il change de teinte dès que la simulation est désactivée.
 */
export function BandeauDeploiement({ simulation, onSimulation, nombreSelection, destination, onDeployer }) {
  const reel = !simulation;

  return html`
    <footer class=${'bandeau' + (reel ? ' reel' : '')}>
      <div class="bandeau-resume">
        <span class="bandeau-nombre">${nombreSelection}</span>
        <span>${nombreSelection > 1 ? 'fichiers sélectionnés' : 'fichier sélectionné'}</span>
        <span class="fleche">→</span>
        ${destination
          ? html`<span class="bandeau-destination mono" title=${destination}>${destination}</span>`
          : html`<span class="rien">aucune destination choisie</span>`}
      </div>

      <div class="bandeau-actions">
        <span class=${'bandeau-etat ' + (reel ? 'reel' : 'simulation')}>
          ${reel ? 'Écriture réelle' : 'Simulation'}
        </span>
        <${Case}
          libelle="Simulation"
          coche=${simulation}
          titre="En simulation, le rapport complet est produit mais aucun octet n'est écrit"
          onChange=${onSimulation}
        />
        <button
          type="button"
          class="btn btn-accent"
          disabled=${!onDeployer || nombreSelection === 0}
          title=${onDeployer ? 'Mettre en production (Ctrl+Entrée)' : 'Mise en production : étape ultérieure du chantier'}
          onClick=${onDeployer || undefined}
        >
          Mettre en production
        </button>
      </div>
    </footer>
  `;
}
