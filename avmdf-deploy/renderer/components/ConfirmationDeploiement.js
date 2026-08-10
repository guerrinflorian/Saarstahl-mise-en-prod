import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState } from '../vendor/hooks.module.js';
import { LIBELLES, MARQUEURS, PLURIELS, formaterNombre, formaterOctets } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeExpedier } from './icones.js';

const html = htm.bind(h);

/**
 * L'ordre de mission d'un passage, puis la confirmation.
 *
 * La fenêtre raconte le trajet avant de demander l'accord : d'où partent les
 * fichiers, où ils arrivent, sous quelle demande de travaux, et où va la copie
 * de ce qui sera écrasé. Un bloquant empêche le déploiement, point. Et pour
 * valider, il faut recopier le numéro de la demande : pas de simple bouton
 * « OK », c'est une mise en production.
 */
export function ConfirmationDeploiement({ etape, controle, resume, occupe, progression, onConfirmer, onRejouer, onFermer }) {
  const [saisie, setSaisie] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [listeDepliee, setListeDepliee] = useState(false);

  if (etape === 'preflight') {
    return html`
      <div class="voile" role="dialog" aria-modal="true" aria-label="Contrôles préalables">
        <div class="modale modale-moyenne">
          <${EnTeteModale} icone=${IconeExpedier} surtitre="Mise en production" titre="Contrôles préalables" />
          <div class="modale-corps">
            <div class="attenue">Vérification des racines, des verrous et des empreintes…</div>
            <div class="jauge" style="margin-top:10px">
              <div
                class=${'jauge-remplissage' + (progression && progression.total ? '' : ' indetermine')}
                style=${progression && progression.total
                  ? 'width:' + Math.min(100, Math.round((progression.faits / progression.total) * 100)) + '%'
                  : ''}
              ></div>
            </div>
            ${progression && progression.total
              ? html`<div class="mono attenue" style="margin-top:6px">
                  ${formaterNombre(progression.faits)} / ${formaterNombre(progression.total)} fichiers contrôlés
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
  const sansArchive = resume.archiver === false;
  const peutPartir = controle.ok && saisieCorrecte && !occupe;

  const nombre = resume.fichiers.length;
  const chiffres = `${formaterNombre(nombre)} fichier${nombre > 1 ? 's' : ''} · ${formaterOctets(resume.octets)}`;

  const statuts = Object.entries(resume.parStatut).filter(([, valeur]) => valeur > 0);

  // Le trajet : une mise en production va des sources vers la production ;
  // une suppression retire de la production, vers les archives ou vers rien.
  const borneDepart = suppression
    ? { titre: 'Production', nom: resume.projet, chemin: resume.racineProd }
    : { titre: 'Vos sources', nom: resume.projet, chemin: resume.racineLocale };
  const borneArrivee = suppression
    ? sansArchive
      ? { titre: 'Nulle part', nom: 'aucune copie conservée', chemin: '', danger: true }
      : { titre: 'Archives AVMDF', nom: resume.sprint || resume.demande, chemin: resume.dossierSauvegarde }
    : { titre: 'Production', nom: resume.projet, chemin: resume.racineProd };

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
                  <div style="display:flex;align-items:center;gap:10px">
                    <strong style="flex:1">
                      ${controle.bloquants.length} point(s) bloquant(s) - la mise en production est refusée.
                    </strong>
                    ${onRejouer
                      ? html`<button
                          type="button"
                          class="btn btn-mini"
                          title="Refaire toutes les vérifications sans refermer cette fenêtre : après un pool recyclé ou un fichier déverrouillé, c'est le geste qui suit."
                          disabled=${occupe}
                          onClick=${onRejouer}
                        >
                          Rejouer les contrôles
                        </button>`
                      : null}
                  </div>
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

          <div class=${'mission' + (resume.simulation ? ' simulation' : '')}>
            <div class="mission-trajet">
              <div class="mission-borne">
                <div class="mission-borne-titre">${borneDepart.titre}</div>
                <div class="mission-borne-nom">${borneDepart.nom}</div>
                ${borneDepart.chemin
                  ? html`<div class="mission-borne-chemin mono" title=${borneDepart.chemin}>${borneDepart.chemin}</div>`
                  : null}
              </div>
              <div class=${'mission-fleche' + (suppression ? ' retrait' : '')} aria-hidden="true">
                <div class="mission-fleche-chiffres mono">${chiffres}</div>
                <div class="mission-fleche-trait"><span class="mission-fleche-pointe"></span></div>
                <div class="mission-fleche-verbe">
                  ${suppression ? (sansArchive ? 'suppression définitive' : 'retrait, copie conservée') : 'copie, octet pour octet'}
                </div>
              </div>
              <div class=${'mission-borne' + (borneArrivee.danger ? ' danger' : '')}>
                <div class="mission-borne-titre">${borneArrivee.titre}</div>
                <div class="mission-borne-nom">${borneArrivee.nom}</div>
                ${borneArrivee.chemin
                  ? html`<div class="mission-borne-chemin mono" title=${borneArrivee.chemin}>${borneArrivee.chemin}</div>`
                  : null}
              </div>
            </div>

            <div class="mission-papiers">
              ${resume.demande
                ? html`<span class="mission-demande mono">${resume.demande}</span>`
                : html`<span class="mission-demande sans mono">sans demande</span>`}
              ${resume.sprint && resume.sprint !== resume.demande
                ? html`<span class="attenue">sprint <span class="mono">${resume.sprint}</span></span>`
                : null}
              ${resume.auteur ? html`<span class="attenue">par ${resume.auteur}</span>` : null}
              <span style="flex:1"></span>
              ${statuts.map(
                ([statut, valeur]) => html`
                  <span class=${'compteur compteur-' + statut} key=${statut}>
                    ${MARQUEURS[statut]} ${formaterNombre(valeur)} ${valeur > 1 ? PLURIELS[statut] : LIBELLES[statut]}
                  </span>
                `
              )}
            </div>

            ${!suppression
              ? html`<div class=${'mission-archives' + (sansArchive ? ' ecarte' : '')}>
                  ${sansArchive
                    ? html`<strong>Archivage écarté :</strong> les versions écrasées ne seront conservées nulle part.`
                    : html`Les versions remplacées partent d'abord vers${' '}
                        <span class="mono" title=${resume.dossierSauvegarde}>${resume.dossierSauvegarde}</span>`}
                </div>`
              : null}
          </div>

          <div class="detail-fichiers">
            <button type="button" class="btn btn-mini btn-plat" onClick=${() => setListeDepliee(!listeDepliee)}>
              ${listeDepliee ? '▾' : '▸'} Détail des ${formaterNombre(nombre)} fichiers
            </button>
            ${listeDepliee
              ? html`
                  <div class="liste-fichiers mono">
                    ${resume.fichiers.map(
                      (fichier) => html`
                        <div class="liste-fichiers-ligne" key=${fichier.chemin}>
                          <span class=${'marqueur marqueur-' + fichier.statut}>${MARQUEURS[fichier.statut]}</span>
                          <span class="liste-fichiers-chemin" title=${fichier.chemin}>${fichier.chemin}</span>
                          <span class="attenue liste-fichiers-taille">${formaterOctets(fichier.taille)}</span>
                        </div>
                      `
                    )}
                  </div>
                `
              : null}
          </div>

          <div class="champ-commentaire">
            <label for="commentaire-passage">Commentaire <span class="attenue">(facultatif)</span></label>
            <input
              type="text"
              id="commentaire-passage"
              maxlength="600"
              placeholder="Pourquoi ce passage part : correctif recherche article, écran stock…"
              autocomplete="off"
              disabled=${occupe}
              value=${commentaire}
              onInput=${(e) => setCommentaire(e.target.value)}
            />
            <div class="champ-aide" style="grid-column:auto">
              Une phrase qui suivra ce passage partout : manifeste, récapitulatif de traçabilité, historique.
            </div>
          </div>

          ${sansArchive
            ? suppression
              ? html`<div class="encart encart-danger" style="margin-top:14px">
                  <strong>Suppression définitive.</strong> Un orphelin n'existe qu'en production : sans
                  archivage AVMDF, les fichiers supprimés ne seront <strong>conservés nulle part</strong> et ne
                  pourront jamais être restaurés. Aucune demande n'est utilisée et aucun manifeste n'est
                  écrit : seul le journal gardera la ligne. Recochez « Archiver » dans le bandeau du bas
                  pour garder une copie et rester réversible.
                </div>`
              : html`<div class="encart encart-danger" style="margin-top:14px">
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
          <label for="confirmation-demande" class=${'confirmation-libelle' + (controle.ok ? '' : ' attenue')}>
            Pour confirmer, recopiez ${libelleSaisie}
            <span class="confirmation-tampon mono">${aRecopier}</span>
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
              if (e.key === 'Enter' && peutPartir) onConfirmer(commentaire);
            }}
          />
          <div style="flex:1"></div>
          <button type="button" class="btn" disabled=${occupe} onClick=${onFermer}>Annuler</button>
          <button
            type="button"
            class="btn btn-accent"
            disabled=${!peutPartir}
            title=${controle.ok ? '' : 'Un point bloquant empêche la mise en production'}
            onClick=${() => onConfirmer(commentaire)}
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
