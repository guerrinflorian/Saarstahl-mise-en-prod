import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState } from '../vendor/hooks.module.js';
import { LIBELLES, MARQUEURS, PLURIELS, formaterNombre, formaterOctets } from './arborescence.js';

const html = htm.bind(h);

/**
 * Récapitulatif des contrôles préalables, puis confirmation.
 *
 * Un bloquant empêche le déploiement, point. Et pour valider, il faut saisir le
 * numéro de la demande : pas de simple bouton « OK », c'est une mise en production.
 */
export function ConfirmationDeploiement({ etape, controle, resume, occupe, progression, onConfirmer, onFermer }) {
  const [saisie, setSaisie] = useState('');
  const [listeDepliee, setListeDepliee] = useState(false);

  if (etape === 'preflight') {
    return html`
      <div class="voile" role="dialog" aria-modal="true" aria-label="Contrôles préalables">
        <div class="modale modale-moyenne">
          <div class="modale-entete"><h1>Contrôles préalables</h1></div>
          <div class="modale-corps">
            <div class="attenue">Vérification des racines, des verrous et des empreintes…</div>
            ${progression && progression.total
              ? html`<div class="mono" style="margin-top:8px">
                  ${formaterNombre(progression.faits)} / ${formaterNombre(progression.total)}
                </div>`
              : null}
          </div>
          <div class="modale-pied">
            <div style="flex:1"></div>
            <button type="button" class="btn" onClick=${onFermer}>Annuler</button>
          </div>
        </div>
      </div>
    `;
  }

  const numero = String(resume.demande || '').replace(/\D/g, '');
  const saisieCorrecte = saisie.trim() === numero;
  const suppression = resume.operation === 'suppression';
  const peutPartir = controle.ok && saisieCorrecte && !occupe;

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Confirmation de mise en production">
      <div class="modale modale-large">
        <div class="modale-entete">
          <h1>${suppression ? 'Supprimer en production' : 'Mettre en production'}</h1>
          <span class=${'bandeau-etat ' + (resume.simulation ? 'simulation' : 'reel')}>
            ${resume.simulation ? 'Simulation' : 'Écriture réelle'}
          </span>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-plat" onClick=${onFermer}>Fermer ✕</button>
        </div>

        <div class="modale-corps">
          ${controle.bloquants.length
            ? html`
                <div class="encart encart-danger" style="margin-bottom:14px">
                  <strong>${controle.bloquants.length} point(s) bloquant(s) - la mise en production est refusée.</strong>
                  ${controle.bloquants.map(
                    (probleme) => html`
                      <div class="probleme" key=${probleme.code + probleme.message}>
                        <div>${probleme.message}</div>
                        ${probleme.conseil ? html`<div class="attenue">${probleme.conseil}</div>` : null}
                        ${probleme.fichiers && probleme.fichiers.length
                          ? html`<ul class="mono">
                              ${probleme.fichiers.slice(0, 12).map((chemin) => html`<li key=${chemin}>${chemin}</li>`)}
                              ${probleme.fichiers.length > 12
                                ? html`<li>… et ${formaterNombre(probleme.fichiers.length - 12)} autres</li>`
                                : null}
                            </ul>`
                          : null}
                      </div>
                    `
                  )}
                </div>
              `
            : null}

          ${controle.avertissements.length
            ? html`
                <div class="encart encart-alerte" style="margin-bottom:14px">
                  <strong>${controle.avertissements.length} avertissement(s)</strong>
                  ${controle.avertissements.map(
                    (probleme) => html`
                      <div class="probleme" key=${probleme.code + probleme.message}>
                        <div>${probleme.message}</div>
                        ${probleme.conseil ? html`<div class="attenue">${probleme.conseil}</div>` : null}
                        ${probleme.fichiers && probleme.fichiers.length
                          ? html`<ul class="mono">
                              ${probleme.fichiers.slice(0, 8).map((chemin) => html`<li key=${chemin}>${chemin}</li>`)}
                            </ul>`
                          : null}
                      </div>
                    `
                  )}
                </div>
              `
            : null}

          <table class="tableau tableau-resume">
            <tbody>
              <tr><th>Projet</th><td>${resume.projet}</td></tr>
              <tr><th>Opération</th><td>${suppression ? 'suppression de fichiers orphelins' : 'mise en production'}</td></tr>
              <tr><th>Auteur</th><td>${resume.auteur || '-'}</td></tr>
              <tr><th>Destination production</th><td class="mono">${resume.racineProd}</td></tr>
              <tr><th>Dossier de sauvegarde</th><td class="mono">${resume.dossierSauvegarde}</td></tr>
              <tr>
                <th>Fichiers</th>
                <td>
                  ${Object.entries(resume.parStatut)
                    .filter(([, nombre]) => nombre > 0)
                    .map(
                      ([statut, nombre]) => html`
                        <span class=${'compteur compteur-' + statut} key=${statut}>
                          ${MARQUEURS[statut]} ${formaterNombre(nombre)}
                          ${nombre > 1 ? PLURIELS[statut] : LIBELLES[statut]}
                        </span>
                      `
                    )}
                  <span class="attenue"> - ${formaterOctets(resume.octets)}</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="detail-fichiers">
            <button type="button" class="btn btn-mini btn-plat" onClick=${() => setListeDepliee(!listeDepliee)}>
              ${listeDepliee ? '▾' : '▸'} Détail des ${formaterNombre(resume.fichiers.length)} fichiers
            </button>
            ${listeDepliee
              ? html`
                  <div class="liste-fichiers mono">
                    ${resume.fichiers.map(
                      (fichier) => html`
                        <div key=${fichier.chemin}>
                          <span class=${'marqueur marqueur-' + fichier.statut}>${MARQUEURS[fichier.statut]}</span>
                          ${fichier.chemin}
                          <span class="attenue">${formaterOctets(fichier.taille)}</span>
                        </div>
                      `
                    )}
                  </div>
                `
              : null}
          </div>

          ${resume.simulation
            ? html`<div class="encart" style="margin-top:14px">
                <strong>Mode simulation.</strong> Tout le processus se déroule et le rapport complet est produit,
                mais aucun octet n'est écrit. Décochez « Simulation » dans le bandeau du bas pour déployer
                réellement.
              </div>`
            : null}
        </div>

        <div class="modale-pied">
          <label for="confirmation-demande" class=${controle.ok ? '' : 'attenue'}>
            Saisissez le numéro de la demande (<span class="mono">${numero}</span>) pour confirmer :
          </label>
          <input
            type="text"
            id="confirmation-demande"
            class=${'mono' + (saisie && !saisieCorrecte ? ' invalide' : '')}
            style="width:90px"
            autocomplete="off"
            spellcheck="false"
            disabled=${!controle.ok || occupe}
            value=${saisie}
            onInput=${(e) => setSaisie(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter' && peutPartir) onConfirmer();
            }}
          />
          <div style="flex:1"></div>
          <button type="button" class="btn" disabled=${occupe} onClick=${onFermer}>Annuler</button>
          <button
            type="button"
            class="btn btn-accent"
            disabled=${!peutPartir}
            title=${controle.ok ? '' : 'Un point bloquant empêche la mise en production'}
            onClick=${onConfirmer}
          >
            ${occupe
              ? 'En cours…'
              : resume.simulation
                ? 'Lancer la simulation'
                : suppression
                  ? 'Supprimer en production'
                  : 'Mettre en production'}
          </button>
        </div>
      </div>
    </div>
  `;
}
