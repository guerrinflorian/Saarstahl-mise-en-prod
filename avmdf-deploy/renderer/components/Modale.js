import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { IconeCroix } from './icones.js';

const html = htm.bind(h);

/**
 * Bandeau-titre commun à toutes les modales : une tuile d'icône, un surtitre
 * qui situe le domaine (mise en production, archives, application…), le titre
 * de l'action, puis ce que l'appelant glisse entre les deux (badges, chemins),
 * et la croix de fermeture toujours à la même place.
 *
 * Un seul composant pour toutes : c'est lui qui fait que l'application a
 * l'air dessinée d'une seule main.
 */
export function EnTeteModale({ icone, surtitre, titre, danger, onFermer, children }) {
  return html`
    <div class="modale-entete">
      ${icone
        ? html`<span class=${'modale-icone' + (danger ? ' danger' : '')} aria-hidden="true">
            <${icone} />
          </span>`
        : null}
      <div class="modale-titres">
        ${surtitre ? html`<span class="surtitre">${surtitre}</span>` : null}
        <h1>${titre}</h1>
      </div>
      ${children}
      <div style="flex:1"></div>
      ${onFermer
        ? html`<button type="button" class="btn-fermer" title="Fermer (Échap)" aria-label="Fermer" onClick=${onFermer}>
            <${IconeCroix} />
          </button>`
        : null}
    </div>
  `;
}
