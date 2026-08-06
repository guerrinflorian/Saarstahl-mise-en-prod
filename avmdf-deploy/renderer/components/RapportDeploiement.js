import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState } from '../vendor/hooks.module.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_ACTION = {
  remplacement: 'remplacé',
  creation: 'créé',
  suppression: 'supprimé',
  restauration: 'restauré'
};

/** Rapport final : ce qui est parti, ce qui a échoué, et où sont les traces. */
export function RapportDeploiement({ resultat, onFermer, onOuvrir, onReveler }) {
  const [filtre, setFiltre] = useState('tous');
  const { manifeste, rapport, chemins } = resultat;
  const simulation = manifeste.simulation;

  const enEchec = manifeste.fichiers.filter((f) => f.erreur);
  const archivesNonRemplaces = manifeste.fichiers.filter((f) => f.archiveNonRemplace);
  const fichiers =
    filtre === 'echecs' ? enEchec : filtre === 'reussis' ? manifeste.fichiers.filter((f) => !f.erreur) : manifeste.fichiers;

  const titre = simulation
    ? 'Simulation terminée'
    : manifeste.operation === 'restauration'
      ? 'Retour arrière terminé'
      : rapport.echecs
        ? 'Mise en production terminée avec des échecs'
        : 'Mise en production terminée';

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label=${titre}>
      <div class="modale modale-large">
        <div class="modale-entete">
          <h1>${titre}</h1>
          ${simulation ? html`<span class="bandeau-etat simulation">Simulation</span>` : null}
          <div style="flex:1"></div>
          <button type="button" class="btn btn-plat" onClick=${onFermer}>Fermer ✕</button>
        </div>

        <div class="modale-corps">
          ${rapport.echecs
            ? html`<div class="encart encart-danger" style="margin-bottom:12px">
                <strong>${formaterNombre(rapport.echecs)} fichier(s) en échec.</strong>
                Les autres sont bien passés : la liste complète est ci-dessous.
              </div>`
            : null}

          ${archivesNonRemplaces.length
            ? html`<div class="encart encart-danger" style="margin-bottom:12px">
                <strong>${formaterNombre(archivesNonRemplaces.length)} fichier(s) ont été archivés mais PAS
                remplacés.</strong>
                La production est restée dans son état d'origine pour ceux-là ; l'archive existe quand même.
              </div>`
            : null}

          <div class="chiffres">
            <div class="chiffre"><span class="valeur">${formaterNombre(rapport.total)}</span><span>fichiers</span></div>
            <div class="chiffre"><span class="valeur">${formaterNombre(rapport.remplacements)}</span><span>remplacés</span></div>
            <div class="chiffre"><span class="valeur">${formaterNombre(rapport.creations)}</span><span>créés</span></div>
            ${rapport.suppressions
              ? html`<div class="chiffre"><span class="valeur">${formaterNombre(rapport.suppressions)}</span><span>supprimés</span></div>`
              : null}
            ${rapport.restaurations
              ? html`<div class="chiffre"><span class="valeur">${formaterNombre(rapport.restaurations)}</span><span>restaurés</span></div>`
              : null}
            <div class=${'chiffre' + (rapport.echecs ? ' danger' : '')}>
              <span class="valeur">${formaterNombre(rapport.echecs)}</span><span>échecs</span>
            </div>
            <div class="chiffre">
              <span class="valeur mono">+${formaterNombre(rapport.lignesAjoutees)} −${formaterNombre(rapport.lignesSupprimees)}</span>
              <span>lignes</span>
            </div>
          </div>

          ${chemins && chemins.manifeste
            ? html`
                <div class="encart" style="margin:12px 0">
                  <div>
                    <strong>Traces écrites dans</strong> <span class="mono">${manifeste.dossierSauvegarde}</span>
                  </div>
                  <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
                    <button type="button" class="btn btn-mini" onClick=${() => onOuvrir(chemins.manifeste)}>
                      Ouvrir le manifeste
                    </button>
                    <button type="button" class="btn btn-mini" onClick=${() => onOuvrir(chemins.recapitulatif)}>
                      Ouvrir le récapitulatif
                    </button>
                    <button type="button" class="btn btn-mini" onClick=${() => onReveler(chemins.manifeste)}>
                      Afficher dans l'explorateur
                    </button>
                  </div>
                </div>
              `
            : html`<div class="encart" style="margin:12px 0">
                Aucun fichier n'a été écrit : ni en production, ni dans les archives, ni de manifeste.
              </div>`}

          <div class="filtres-ligne" style="margin-bottom:6px">
            ${[
              ['tous', 'Tous (' + formaterNombre(manifeste.fichiers.length) + ')'],
              ['reussis', 'Réussis (' + formaterNombre(manifeste.fichiers.length - enEchec.length) + ')'],
              ['echecs', 'Échecs (' + formaterNombre(enEchec.length) + ')']
            ].map(
              ([valeur, libelle]) => html`
                <button
                  type="button"
                  class=${'btn btn-mini' + (filtre === valeur ? ' btn-marque' : '')}
                  key=${valeur}
                  onClick=${() => setFiltre(valeur)}
                >
                  ${libelle}
                </button>
              `
            )}
          </div>

          <table class="tableau tableau-fichiers">
            <thead>
              <tr>
                <th>Fichier</th>
                <th>Action</th>
                <th>Lignes</th>
                <th>Sauvegarde</th>
                <th>Résultat</th>
              </tr>
            </thead>
            <tbody>
              ${fichiers.map(
                (fichier) => html`
                  <tr key=${fichier.chemin} class=${fichier.erreur ? 'en-echec' : ''}>
                    <td class="mono">${fichier.chemin}</td>
                    <td>${LIBELLES_ACTION[fichier.action] || fichier.action}</td>
                    <td class="mono">
                      ${fichier.lignesAjoutees === null
                        ? '-'
                        : `+${fichier.lignesAjoutees} −${fichier.lignesSupprimees}`}
                    </td>
                    <td class="mono">
                      ${fichier.sauvegarde || '-'}
                      ${fichier.sauvegardeConservee
                        ? html`<span class="attenue" title="Archive d'un passage précédent dans ce sprint"> (déjà archivé)</span>`
                        : null}
                    </td>
                    <td>${fichier.erreur ? html`<span class="rouge">${fichier.erreur}</span>` : 'ok'}</td>
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>

        <div class="modale-pied">
          <div style="flex:1"></div>
          <button type="button" class="btn btn-accent" onClick=${onFermer}>Fermer</button>
        </div>
      </div>
    </div>
  `;
}
