import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';

const html = htm.bind(h);

/**
 * Panneau droit : comparaison ligne à ligne du fichier sélectionné.
 *
 * Étape 1 : la structure du panneau et l'état vide. La détection d'encodage,
 * le diff et le repliage arrivent avec `core/textdiff.js` (étape 4).
 */
export function VueDiff() {
  return html`
    <div class="panneau panneau-droit">
      <div class="panneau-entete">
        <span>Comparaison</span>
        <div style="flex:1"></div>
        <span class="note-chantier">Étape 4 · diff</span>
      </div>
      <div class="panneau-contenu">
        <div class="etat-vide">
          <div class="etat-vide-titre">Aucun fichier sélectionné</div>
          <div class="etat-vide-texte">
            La comparaison affichera la production à gauche et vos sources locales à droite.
          </div>
        </div>
      </div>
    </div>
  `;
}
