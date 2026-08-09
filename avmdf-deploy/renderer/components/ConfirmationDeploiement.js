import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState } from '../vendor/hooks.module.js';
import { LIBELLES, MARQUEURS, PLURIELS, formaterNombre, formaterOctets } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeExpedier } from './icones.js';

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
          <${EnTeteModale} icone=${IconeExpedier} surtitre="Mise en production" titre="Contrôles préalables" />
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

  const numeroDemande = String(resume.demande || '').replace(/\D/g, '');
  // Sans demande, il n'y a pas de numéro à recopier. On confirme alors sur le
  // nombre de fichiers : le geste reste le même, et il force à relire ce qui
  // part. Ce qu'il ne faut surtout pas, c'est un champ vide qui se valide seul.
  const aRecopier = numeroDemande || String(resume.fichiers.length);
  const libelleSaisie = numeroDemande ? 'le numéro de la demande' : 'le nombre de fichiers';
  const saisieCorrecte = saisie.trim() === aRecopier;
  const suppression = resume.operation === 'suppression';
  const peutPartir = controle.ok && saisieCorrecte && !occupe;

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Confirmation de mise en production">
      <div class="modale modale-large">
        <${EnTeteModale}
          icone=${IconeExpedier}
          danger=${suppression}
          surtitre=${suppression ? 'Suppression en production' : 'Mise en production'}
          titre=${suppression ? 'Supprimer en production' : 'Mettre en production'}
          onFermer=${onFermer}
        >
          <span class=${'bandeau-etat ' + (resume.simulation ? 'simulation' : 'reel')}>
            ${resume.simulation ? 'Simulation' : 'Écriture réelle'}
          </span>
        <//>

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
              <tr>
                <th>Archivage AVMDF</th>
                <td>
                  ${resume.archiver === false
                    ? html`<span class="rouge">écarté pour ce passage : rien ne sera écrit dans les archives</span>`
                    : 'les versions remplacées sont conservées'}
                </td>
              </tr>
              ${resume.archiver === false
                ? null
                : html`<tr>
                    <th>Dossier de sauvegarde</th>
                    <td class="mono">${resume.dossierSauvegarde}</td>
                  </tr>`}
              <tr>
                <th>Fichiers</th>
                <td>
                  ${Object.entries(resume.parStatut)
                    .filter(([, nombre]) => nombre > 0)
                    .map(
                      ([statut, nombre]) => html`
                        <span class=${'compteur compteur-' + statut} key=${statut}>
                          ${MARQUEURS[statut]} ${formaterNombre(nombre)} ${nombre > 1 ? PLURIELS[statut] : LIBELLES[statut]}
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

          ${resume.archiver === false && !suppression
            ? html`<div class="encart encart-danger" style="margin-top:14px">
                <strong>Archivage AVMDF écarté.</strong> Les versions actuellement en production seront
                écrasées sans être conservées, et <strong>ce passage ne pourra pas être annulé</strong>. Aucune
                demande n'est utilisée et aucun manifeste n'est écrit : le passage n'apparaîtra ni dans
                l'historique ni dans le tableau de bord, seul le journal en gardera la ligne. Recochez
                « Archiver » dans le bandeau du bas pour revenir au comportement normal.
              </div>`
            : null}

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
            Saisissez ${libelleSaisie} (<span class="mono">${aRecopier}</span>) pour confirmer :
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
