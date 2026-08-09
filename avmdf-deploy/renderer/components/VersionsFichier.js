import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { VueDiff } from './VueDiff.js';
import { formaterDate, formaterNombre, formaterOctets } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeCouches, IconeExpedier } from './icones.js';

const html = htm.bind(h);

const LIBELLES_ACTION = {
  remplacement: 'remplacé',
  creation: 'créé',
  suppression: 'supprimé',
  restauration: 'restauré'
};

/**
 * Toutes les versions « avant modification » d'un fichier, toutes demandes et
 * sprints confondus : on les compare à la production actuelle et on peut en
 * remettre une en place.
 *
 * Remettre une ancienne version archive d'abord la version actuelle : revenir
 * en arrière ne fait jamais perdre l'état courant.
 */
export function VersionsFichier({ fichier, destination, simulation, onChoisirDestination, onFermer, onEchec, onRapport }) {
  const [etat, setEtat] = useState('chargement');
  const [versions, setVersions] = useState([]);
  const [choisie, setChoisie] = useState(null);
  const [diff, setDiff] = useState({ etat: 'vide' });
  const [confirmation, setConfirmation] = useState(false);
  const [saisie, setSaisie] = useState('');
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.fichier.versions(fichier.cle);
      if (abandonne) return;
      if (!reponse.ok) {
        setEtat('erreur');
        onEchec(reponse);
        return;
      }
      setVersions(reponse.versions);
      setEtat('pret');
      if (reponse.versions.length) choisir(reponse.versions[0]);
    })();
    return () => {
      abandonne = true;
    };
  }, [fichier.cle]);

  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key !== 'Escape') return;
      if (confirmation) setConfirmation(false);
      else onFermer();
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  async function choisir(version) {
    setChoisie(version);
    setDiff({ etat: 'chargement' });
    const reponse = await window.avmdf.fichier.comparerVersion(fichier.cle, version.chemin);
    if (!reponse.ok) {
      setDiff({ etat: 'erreur', erreur: reponse.erreur });
      return;
    }
    setDiff({ etat: 'pret', donnees: reponse.diff });
  }

  async function restaurer() {
    setOccupe(true);
    const reponse = await window.avmdf.fichier.restaurerVersion({
      cle: fichier.cle,
      cheminVersion: choisie.chemin,
      demande: destination.demande,
      sprint: destination.sprint,
      simulation
    });
    setOccupe(false);
    if (!reponse.ok) {
      onEchec(reponse);
      return;
    }
    setConfirmation(false);
    onRapport(reponse);
  }

  const numero = destination ? String(destination.demande || '').replace(/\D/g, '') : '';

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Versions archivées du fichier">
      <div class="modale modale-plein">
        <${EnTeteModale} icone=${IconeCouches} surtitre="Archives" titre="Versions archivées" onFermer=${onFermer}>
          <span class="mono attenue">${fichier.chemin}</span>
        <//>

        ${etat === 'chargement'
          ? html`<div class="modale-corps"><div class="attenue">Lecture du dossier d'archives…</div></div>`
          : html`
              <div class="historique">
                <div class="historique-liste">
                  ${versions.length === 0
                    ? html`<div class="etat-vide">
                        <div class="etat-vide-titre">Aucune version archivée</div>
                        <div class="etat-vide-texte">
                          Ce fichier n'a encore jamais été remplacé par l'outil, ou ses archives sont
                          rangées ailleurs que sous la racine AVMDF.
                        </div>
                      </div>`
                    : null}
                  ${versions.map(
                    (version) => html`
                      <button
                        type="button"
                        class=${'historique-entree' + (choisie && choisie.chemin === version.chemin ? ' choisi' : '')}
                        key=${version.chemin}
                        onClick=${() => choisir(version)}
                      >
                        <div class="historique-ligne1">
                          <span class="mono">${version.demande}${version.sprint ? ' / ' + version.sprint : ''}</span>
                          ${version.action
                            ? html`<span class="etiquette">${LIBELLES_ACTION[version.action] || version.action}</span>`
                            : html`<span class="etiquette">ancienne organisation</span>`}
                        </div>
                        <div class="historique-ligne2 attenue">
                          ${version.date ? new Date(version.date).toLocaleString('fr-FR') : formaterDate(version.mtimeMs)}
                          ${version.auteur ? ' · ' + version.auteur : ''}
                        </div>
                        <div class="historique-ligne2 attenue">${formaterOctets(version.taille)}</div>
                      </button>
                    `
                  )}
                </div>

                <div class="historique-detail" style="display:flex;flex-direction:column">
                  ${choisie
                    ? html`
                        <div class="versions-barre">
                          <span class="mono attenue">${choisie.chemin}</span>
                          <div style="flex:1"></div>
                          ${destination
                            ? html`<button
                                type="button"
                                class="btn btn-accent"
                                disabled=${occupe}
                                title=${'La version actuelle sera archivée dans ' + destination.chemin}
                                onClick=${() => {
                                  setSaisie('');
                                  setConfirmation(true);
                                }}
                              >
                                Remettre cette version en production
                              </button>`
                            : html`
                                <span class="attenue">
                                  La version actuelle doit être archivée avant d'être remplacée.
                                </span>
                                <button type="button" class="btn" onClick=${onChoisirDestination}>
                                  Choisir la destination d'archivage…
                                </button>
                              `}
                        </div>
                        <div class="historique-diff">
                          <${VueDiff} diff=${diff} onOuvrirExterne=${() => {}} inversable=${false} />
                        </div>
                      `
                    : html`<div class="etat-vide">
                        <div class="attenue">Choisissez une version à comparer avec la production actuelle.</div>
                      </div>`}
                </div>
              </div>
            `}
      </div>

      ${confirmation
        ? html`
            <div class="voile" role="dialog" aria-modal="true" aria-label="Confirmer la remise en production">
              <div class="modale modale-moyenne">
                <${EnTeteModale}
                  icone=${IconeExpedier}
                  surtitre="Remise en production"
                  titre="Remettre cette version en production"
                >
                  <span class=${'bandeau-etat ' + (simulation ? 'simulation' : 'reel')}>
                    ${simulation ? 'Simulation' : 'Écriture réelle'}
                  </span>
                <//>
                <div class="modale-corps">
                  <table class="tableau tableau-resume">
                    <tbody>
                      <tr><th>Fichier</th><td class="mono">${fichier.chemin}</td></tr>
                      <tr>
                        <th>Version choisie</th>
                        <td class="mono">${choisie.demande}${choisie.sprint ? ' / ' + choisie.sprint : ''}</td>
                      </tr>
                      <tr>
                        <th>Datée du</th>
                        <td>
                          ${choisie.date ? new Date(choisie.date).toLocaleString('fr-FR') : formaterDate(choisie.mtimeMs)}
                        </td>
                      </tr>
                      <tr><th>Archivage de l'actuelle</th><td class="mono">${destination.chemin}</td></tr>
                    </tbody>
                  </table>
                  <div class="encart" style="margin-top:12px">
                    La version actuellement en production sera copiée dans le dossier de sprint ci-dessus
                    <strong>avant</strong> d'être remplacée, et un manifeste de restauration sera écrit.
                    L'opération est réversible depuis l'écran Historique.
                  </div>
                </div>
                <div class="modale-pied">
                  <label for="confirmation-version">
                    Saisissez le numéro de la demande (<span class="mono">${numero}</span>) :
                  </label>
                  <input
                    type="text"
                    id="confirmation-version"
                    class="mono"
                    style="width:90px"
                    autocomplete="off"
                    disabled=${occupe}
                    value=${saisie}
                    onInput=${(e) => setSaisie(e.target.value)}
                  />
                  <div style="flex:1"></div>
                  <button type="button" class="btn" disabled=${occupe} onClick=${() => setConfirmation(false)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    class="btn btn-accent"
                    disabled=${occupe || saisie.trim() !== numero}
                    onClick=${restaurer}
                  >
                    ${occupe ? 'En cours…' : simulation ? 'Simuler la remise en production' : 'Remettre en production'}
                  </button>
                </div>
              </div>
            </div>
          `
        : null}
    </div>
  `;
}
