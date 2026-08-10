import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { formaterNombre, formaterOctets } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeCouches } from './icones.js';

const html = htm.bind(h);

/**
 * FriseFichier.js - l'histoire d'un fichier, du plus récent au plus ancien.
 *
 * Chaque événement est un fait écrit sur le disque : un passage en production
 * lu dans un manifeste (demande, sprint, auteur, lignes changées), ou une
 * version archivée dont aucun manifeste ne parle (ancienne organisation). La
 * frise ne devine rien : ce que l'outil n'a pas écrit n'y figure pas, et elle
 * le dit.
 *
 * Elle s'ouvre depuis l'arbre, depuis la comparaison, et depuis les fichiers
 * chauds du tableau de bord : un chemin suffit, pas besoin d'une analyse.
 */

const LIBELLES_ACTION = {
  remplacement: 'remplacé',
  creation: 'créé',
  suppression: 'supprimé',
  restauration: 'restauré'
};

const LIBELLES_OPERATION = {
  deploiement: 'mise en production',
  suppression: 'suppression',
  restauration: 'retour arrière'
};

function formaterQuand(iso) {
  if (!iso) return 'date inconnue';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function ilYA(iso) {
  if (!iso) return '';
  const ecart = Date.now() - Date.parse(iso);
  if (Number.isNaN(ecart) || ecart < 0) return '';
  const jours = Math.floor(ecart / 86400000);
  if (jours < 1) return "aujourd'hui";
  if (jours === 1) return 'hier';
  if (jours < 31) return 'il y a ' + jours + ' jours';
  const mois = Math.floor(jours / 30.4);
  if (mois < 12) return 'il y a ' + mois + ' mois';
  const ans = Math.floor(mois / 12);
  return 'il y a ' + ans + ' an' + (ans > 1 ? 's' : '');
}

/** La classe du point sur le rail : la nature de l'événement en une couleur. */
function genrePoint(evenement) {
  if (evenement.erreur) return 'echec';
  if (evenement.type === 'archive') return 'archive';
  if (evenement.operation === 'restauration') return 'restauration';
  if (evenement.operation === 'suppression' || evenement.action === 'suppression') return 'suppression';
  return 'deploiement';
}

export function FriseFichier({ chemin, onFermer, onVersions, onEchec }) {
  const [etat, setEtat] = useState('chargement');
  const [frise, setFrise] = useState(null);

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.frise.fichier(chemin);
      if (abandonne) return;
      if (!reponse.ok) {
        setEtat('erreur');
        onEchec(reponse);
        return;
      }
      setFrise(reponse.frise);
      setEtat('pret');
    })();
    return () => {
      abandonne = true;
    };
  }, [chemin]);

  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key === 'Escape') onFermer();
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  const evenements = frise ? frise.evenements : [];
  const passages = evenements.filter((e) => e.type === 'passage');
  const conservees = evenements.filter((e) => e.version).length;
  const plusAncien = evenements.length ? evenements[evenements.length - 1] : null;
  const plusRecent = evenements.length ? evenements[0] : null;

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Frise chronologique du fichier">
      <div class="modale modale-large modale-frise">
        <${EnTeteModale} icone=${IconeCouches} surtitre="Frise chronologique" titre="L'histoire de ce fichier" onFermer=${onFermer}>
          <span class="mono attenue">${chemin}</span>
        <//>

        <div class="modale-corps frise-corps">
          ${etat === 'chargement'
            ? html`<div class="attenue">Lecture des manifestes et des archives…</div>`
            : null}

          ${etat === 'pret' && !evenements.length
            ? html`<div class="etat-vide">
                <div class="etat-vide-titre">Aucune trace pour ce fichier</div>
                <div class="etat-vide-texte">
                  Il n'est cité par aucun manifeste et aucune version archivée ne porte son chemin :
                  l'outil ne l'a encore jamais mis en production ni remplacé.
                </div>
              </div>`
            : null}

          ${etat === 'pret' && evenements.length
            ? html`
                <div class="frise-resume">
                  <span>
                    <strong>${formaterNombre(passages.length)}</strong>
                    ${' passage' + (passages.length > 1 ? 's' : '') + ' en production'}
                  </span>
                  <span>
                    <strong>${formaterNombre(conservees)}</strong>
                    ${' version' + (conservees > 1 ? 's' : '') + ' conservée' + (conservees > 1 ? 's' : '')}
                  </span>
                  ${plusRecent && plusRecent.date
                    ? html`<span>dernier mouvement <strong>${ilYA(plusRecent.date)}</strong></span>`
                    : null}
                  ${plusAncien && plusAncien.date && plusAncien !== plusRecent
                    ? html`<span>première trace <strong>${ilYA(plusAncien.date)}</strong></span>`
                    : null}
                  <span style="flex:1"></span>
                  ${onVersions
                    ? html`<button
                        type="button"
                        class="btn btn-mini"
                        title="Comparer les versions archivées à la production actuelle, et en remettre une en place"
                        onClick=${onVersions}
                      >
                        Comparer ou restaurer une version…
                      </button>`
                    : null}
                </div>

                <div class="frise">
                  ${evenements.map(
                    (evenement, index) => html`
                      <div class="frise-evenement" key=${index}>
                        <span class=${'frise-point ' + genrePoint(evenement)} aria-hidden="true"></span>
                        <div class="frise-carte">
                          <div class="frise-quand">
                            ${formaterQuand(evenement.date)}
                            ${evenement.date ? html`<span class="attenue"> · ${ilYA(evenement.date)}</span>` : null}
                          </div>
                          <div class="frise-ligne">
                            ${evenement.demande
                              ? html`<span class="mission-demande mono">${evenement.demande}</span>`
                              : html`<span class="mission-demande sans mono">sans demande</span>`}
                            ${evenement.sprint && evenement.sprint !== evenement.demande
                              ? html`<span class="attenue">sprint <span class="mono">${evenement.sprint}</span></span>`
                              : null}
                            ${evenement.action
                              ? html`<span class=${'etiquette frise-action ' + genrePoint(evenement)}>
                                  ${LIBELLES_ACTION[evenement.action] || evenement.action}
                                </span>`
                              : evenement.type === 'archive'
                                ? html`<span class="etiquette">version archivée</span>`
                                : null}
                            ${evenement.type === 'passage' && evenement.operation && evenement.operation !== 'deploiement'
                              ? html`<span class="etiquette">${LIBELLES_OPERATION[evenement.operation]}</span>`
                              : null}
                            ${evenement.erreur
                              ? html`<span class="etiquette etiquette-danger" title=${evenement.erreur}>échec</span>`
                              : null}
                            ${evenement.sansArchive
                              ? html`<span class="etiquette etiquette-danger">sans copie de sauvegarde</span>`
                              : null}
                          </div>
                          <div class="frise-detail attenue">
                            ${[
                              evenement.auteur ? 'par ' + evenement.auteur : '',
                              evenement.projet || '',
                              evenement.tailleApres !== null ? formaterOctets(evenement.tailleApres) : ''
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            ${evenement.lignesAjoutees !== null || evenement.lignesSupprimees !== null
                              ? html`<span class="mono frise-lignes">
                                  <span class="plus">+${formaterNombre(evenement.lignesAjoutees || 0)}</span>
                                  <span class="moins">−${formaterNombre(evenement.lignesSupprimees || 0)}</span>
                                </span>`
                              : null}
                          </div>
                          ${evenement.commentaire
                            ? html`<div class="frise-commentaire">« ${evenement.commentaire} »</div>`
                            : null}
                          ${evenement.version
                            ? html`<div class="frise-version mono" title=${evenement.version}>
                                ↳ copie conservée : ${evenement.version}
                              </div>`
                            : null}
                        </div>
                      </div>
                    `
                  )}
                </div>

                <p class="frise-methode attenue">
                  La frise se lit dans les manifestes et les archives AVMDF : ce que l'outil n'a pas
                  écrit (copie à la main, autre outil) ne peut pas y figurer.
                  ${frise.erreurs && frise.erreurs.length
                    ? ' ' + frise.erreurs.length + ' emplacement(s) n\'ont pas pu être lus.'
                    : ''}
                </p>
              `
            : null}
        </div>
      </div>
    </div>
  `;
}
