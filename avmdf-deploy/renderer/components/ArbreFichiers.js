import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';

const html = htm.bind(h);

/**
 * Panneau gauche : recherche, filtres et arborescence des écarts.
 *
 * Étape 1 : la structure du panneau et l'état vide. Le parcours récursif,
 * les statuts et les compteurs arrivent avec `core/fsindex.js` et
 * `core/compare.js` (étape 2), la barre de filtres avec `core/search.js`
 * (étape 3).
 */
export function ArbreFichiers({ cheminLocal, cheminProd }) {
  return html`
    <div class="panneau panneau-gauche">
      <div class="panneau-entete">
        <span>Fichiers</span>
        <div style="flex:1"></div>
        <span class="note-chantier">Étape 2 · analyse</span>
      </div>
      <div class="panneau-contenu">
        <div class="etat-vide">
          <div class="etat-vide-titre">Aucune analyse effectuée</div>
          <div class="etat-vide-texte">
            L'analyse comparera récursivement, à profondeur illimitée :
          </div>
          <div class="mono etat-vide-texte" style="text-align:left">
            <div>${cheminLocal || '—'}</div>
            <div>${cheminProd || '—'}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}
