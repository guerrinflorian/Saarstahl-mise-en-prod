import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { Case } from './Champs.js';
import { LIBELLES, MARQUEURS, formaterNombre } from './arborescence.js';

const html = htm.bind(h);

/**
 * Bandeau bas : l'état exact de ce qui part et où, visible en permanence.
 * Il change de teinte dès que la simulation est désactivée.
 *
 * La suppression d'orphelins est une opération distincte de la mise en
 * production : on ne mélange pas les deux dans un même passage.
 */
export function BandeauDeploiement({
  simulation,
  onSimulation,
  archiver,
  onArchiver,
  selection,
  destination,
  modeLibre,
  operation,
  occupe,
  onChoisirDestination,
  onDeployer
}) {
  const reel = !simulation;
  const total = selection.deployables + selection.orphelins;
  const mixte = operation === 'mixte';
  const suppression = operation === 'suppression';

  const raisonBlocage = modeLibre
    ? 'La comparaison libre ne permet pas de mise en production.'
    : total === 0
      ? 'Cochez au moins un fichier dans l\'arborescence.'
      : mixte
        ? 'Ne mélangez pas déploiement et suppression : traitez les orphelins à part.'
        : !destination
          ? 'Choisissez d\'abord la demande et le dossier de sprint.'
          : '';

  const libelleAction = suppression ? 'Supprimer en production' : 'Mettre en production';

  return html`
    <footer class=${'bandeau' + (reel ? ' reel' : '')}>
      <div class="bandeau-resume">
        <span class="bandeau-nombre">${formaterNombre(total)}</span>
        <span>${total > 1 ? 'fichiers sélectionnés' : 'fichier sélectionné'}</span>
        ${selection.deployables && selection.orphelins
          ? html`<span class="attenue mono">
              (${formaterNombre(selection.deployables)} à déployer, ${formaterNombre(selection.orphelins)} orphelins)
            </span>`
          : null}
        <span class="fleche">→</span>
        ${destination
          ? html`<button
              type="button"
              class="bandeau-destination mono"
              title="Changer la destination"
              onClick=${onChoisirDestination}
            >
              ${destination.chemin}
            </button>`
          : html`<button
              type="button"
              class="btn btn-mini"
              disabled=${modeLibre}
              title=${modeLibre ? 'Indisponible en comparaison libre' : 'Choisir la demande et le sprint'}
              onClick=${onChoisirDestination}
            >
              Choisir la destination…
            </button>`}
      </div>

      <div class="bandeau-actions">
        ${raisonBlocage ? html`<span class="attenue bandeau-raison">${raisonBlocage}</span>` : null}
        ${!archiver && !suppression
          ? html`<span class="bandeau-etat sans-archive" title="Aucune copie de sauvegarde : ce passage ne pourra pas être annulé">
              Sans AVMDF
            </span>`
          : null}
        <span class=${'bandeau-etat ' + (reel ? 'reel' : 'simulation')}>
          ${reel ? 'Écriture réelle' : 'Simulation'}
        </span>
        ${suppression
          ? null
          : html`<${Case}
              libelle="Archiver"
              coche=${archiver}
              titre="Copier la version de production dans le dossier de sprint avant de l'écraser. Décoché, rien n'est conservé et le retour arrière devient impossible."
              onChange=${onArchiver}
            />`}
        <${Case}
          libelle="Simulation"
          coche=${simulation}
          titre="En simulation, le rapport complet est produit mais aucun octet n'est écrit"
          onChange=${onSimulation}
        />
        <button
          type="button"
          class=${'btn ' + (operation === 'suppression' ? 'btn-danger' : 'btn-accent')}
          disabled=${Boolean(raisonBlocage) || occupe}
          title=${raisonBlocage || 'Ctrl+Entrée'}
          onClick=${onDeployer}
        >
          ${occupe ? 'En cours…' : libelleAction}
        </button>
      </div>
    </footer>
  `;
}

/** Compte la sélection par nature, pour le bandeau et le choix d'opération. */
export function resumerSelection(fichiers, selection) {
  let deployables = 0;
  let orphelins = 0;
  const parStatut = {};
  for (const fichier of fichiers) {
    if (!selection.has(fichier.cle)) continue;
    parStatut[fichier.statut] = (parStatut[fichier.statut] || 0) + 1;
    if (fichier.statut === 'orphelin') orphelins += 1;
    else deployables += 1;
  }
  return { deployables, orphelins, parStatut };
}

export function operationDe(selection) {
  if (selection.deployables && selection.orphelins) return 'mixte';
  if (selection.orphelins) return 'suppression';
  return 'deploiement';
}

export { LIBELLES, MARQUEURS };
