import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { VueDiff } from './VueDiff.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_ACTION = {
  remplacement: 'remplacé',
  creation: 'créé',
  suppression: 'supprimé',
  restauration: 'restauré'
};

function formaterHorodatage(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('fr-FR');
}

/**
 * Écran Historique : tous les manifestes trouvés sous la racine d'archives,
 * du plus récent au plus ancien, avec comparaison et retour arrière.
 */
export function Historique({ onFermer, onEchec, onNotifier, onRapport }) {
  const [etat, setEtat] = useState('chargement');
  const [manifestes, setManifestes] = useState([]);
  const [erreurs, setErreurs] = useState([]);
  const [choisi, setChoisi] = useState(null);
  const [diff, setDiff] = useState(null);
  const [restauration, setRestauration] = useState(null);
  const [saisie, setSaisie] = useState('');
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    (async () => {
      const reponse = await window.avmdf.historique.lister();
      if (!reponse.ok) {
        setEtat('erreur');
        onEchec(reponse);
        return;
      }
      setManifestes(reponse.manifestes);
      setErreurs(reponse.erreurs);
      setEtat('pret');
      if (reponse.manifestes.length) setChoisi(reponse.manifestes[0]);
    })();
  }, []);

  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key !== 'Escape') return;
      if (diff) setDiff(null);
      else if (restauration) setRestauration(null);
      else onFermer();
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  async function voirCeQuiAChange(fichier) {
    setDiff({ etat: 'chargement' });
    const reponse = await window.avmdf.historique.comparer(choisi.chemin, fichier.chemin);
    if (!reponse.ok) {
      setDiff(null);
      onEchec(reponse);
      return;
    }
    setDiff({ etat: 'pret', donnees: reponse.diff });
  }

  async function preparerRetour() {
    setOccupe(true);
    const reponse = await window.avmdf.historique.preparerRestauration(choisi.chemin);
    setOccupe(false);
    if (!reponse.ok) {
      onEchec(reponse);
      return;
    }
    setSaisie('');
    setRestauration(reponse.preparation);
  }

  async function lancerRetour(simulation) {
    setOccupe(true);
    const reponse = await window.avmdf.historique.restaurer(choisi.chemin, simulation);
    setOccupe(false);
    if (!reponse.ok) {
      onEchec(reponse);
      if (reponse.preparation) setRestauration(reponse.preparation);
      return;
    }
    setRestauration(null);
    onRapport(reponse);
  }

  const numero = choisi ? String(choisi.demande || '').replace(/\D/g, '') : '';

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Historique des déploiements">
      <div class="modale modale-plein">
        <div class="modale-entete">
          <h1>Historique</h1>
          <span class="attenue">${formaterNombre(manifestes.length)} déploiement(s) retrouvé(s)</span>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-plat" onClick=${onFermer}>Fermer ✕</button>
        </div>

        ${etat === 'chargement'
          ? html`<div class="modale-corps"><div class="attenue">Lecture des manifestes…</div></div>`
          : html`
              <div class="historique">
                <div class="historique-liste">
                  ${manifestes.length === 0
                    ? html`<div class="etat-vide">
                        <div class="etat-vide-titre">Aucun déploiement enregistré</div>
                        <div class="etat-vide-texte">
                          Les manifestes apparaîtront ici dès la première mise en production réelle.
                        </div>
                      </div>`
                    : null}
                  ${manifestes.map(
                    (manifeste) => html`
                      <button
                        type="button"
                        class=${'historique-entree' + (choisi && choisi.chemin === manifeste.chemin ? ' choisi' : '')}
                        key=${manifeste.chemin}
                        onClick=${() => {
                          setChoisi(manifeste);
                          setRestauration(null);
                        }}
                      >
                        <div class="historique-ligne1">
                          <span class="mono">${manifeste.demande} / ${manifeste.sprint}</span>
                          ${manifeste.operation === 'restauration'
                            ? html`<span class="etiquette">retour arrière</span>`
                            : manifeste.operation === 'suppression'
                              ? html`<span class="etiquette">suppression</span>`
                              : null}
                          ${manifeste.archivage === false
                            ? html`<span class="etiquette etiquette-danger">sans AVMDF</span>`
                            : null}
                          ${manifeste.simulation ? html`<span class="etiquette">simulation</span>` : null}
                        </div>
                        <div class="historique-ligne2 attenue">
                          ${formaterHorodatage(manifeste.date)} · ${manifeste.auteur || '-'} · ${manifeste.projet}
                        </div>
                        <div class="historique-ligne2 attenue">
                          ${formaterNombre(manifeste.resume.total)} fichier(s)
                          ${manifeste.resume.echecs
                            ? html`<span class="rouge"> · ${formaterNombre(manifeste.resume.echecs)} échec(s)</span>`
                            : null}
                        </div>
                      </button>
                    `
                  )}
                  ${erreurs.length
                    ? html`<div class="encart encart-alerte" style="margin:8px">
                        ${formaterNombre(erreurs.length)} dossier(s) ou manifeste(s) illisibles.
                        <ul class="mono">
                          ${erreurs.slice(0, 5).map((erreur) => html`<li key=${erreur}>${erreur}</li>`)}
                        </ul>
                      </div>`
                    : null}
                </div>

                <div class="historique-detail">
                  ${!choisi
                    ? html`<div class="etat-vide"><div class="attenue">Choisissez un déploiement.</div></div>`
                    : html`
                        <div class="modale-corps">
                          <table class="tableau tableau-resume">
                            <tbody>
                              <tr><th>Demande</th><td class="mono">${choisi.demande} / ${choisi.sprint}</td></tr>
                              <tr><th>Date</th><td>${formaterHorodatage(choisi.date)}</td></tr>
                              <tr><th>Auteur</th><td>${choisi.auteur || '-'}</td></tr>
                              <tr><th>Projet</th><td>${choisi.projet}</td></tr>
                              <tr><th>Production</th><td class="mono">${choisi.racineProd}</td></tr>
                              <tr><th>Sauvegarde</th><td class="mono">${choisi.dossierSauvegarde}</td></tr>
                              <tr><th>Manifeste</th><td class="mono">${choisi.chemin}</td></tr>
                            </tbody>
                          </table>

                          ${choisi.simulation
                            ? html`<div class="encart" style="margin:12px 0">
                                Ce manifeste vient d'une simulation : aucun fichier n'a été écrit, il n'y a rien à
                                annuler.
                              </div>`
                            : null}

                          ${choisi.archivage === false && !choisi.simulation
                            ? html`<div class="encart encart-danger" style="margin:12px 0">
                                <strong>Passage effectué sans archivage AVMDF.</strong>
                                Les versions remplacées n'ont pas été conservées : il n'y a rien à restaurer.
                                Le tableau ci-dessous garde l'empreinte de ce qui a été écrasé, et les fichiers
                                créés par ce passage peuvent toujours être retirés à la main.
                              </div>`
                            : null}

                          <div style="display:flex;gap:6px;margin:12px 0">
                            <button
                              type="button"
                              class="btn btn-danger"
                              disabled=${choisi.simulation || choisi.archivage === false || occupe}
                              title=${choisi.archivage === false
                                ? 'Aucune version archivée : ce déploiement ne peut pas être annulé'
                                : ''}
                              onClick=${preparerRetour}
                            >
                              Revenir en arrière
                            </button>
                            <button type="button" class="btn btn-mini" onClick=${() => window.avmdf.systeme.reveler(choisi.chemin)}>
                              Afficher dans l'explorateur
                            </button>
                          </div>

                          <table class="tableau tableau-fichiers">
                            <thead>
                              <tr><th>Fichier</th><th>Action</th><th>Lignes</th><th>Résultat</th><th></th></tr>
                            </thead>
                            <tbody>
                              ${choisi.fichiers.map(
                                (fichier) => html`
                                  <tr key=${fichier.chemin} class=${fichier.erreur ? 'en-echec' : ''}>
                                    <td class="mono">${fichier.chemin}</td>
                                    <td>${LIBELLES_ACTION[fichier.action] || fichier.action}</td>
                                    <td class="mono">
                                      ${fichier.lignesAjoutees === null
                                        ? '-'
                                        : `+${fichier.lignesAjoutees} −${fichier.lignesSupprimees}`}
                                    </td>
                                    <td>${fichier.erreur ? html`<span class="rouge">${fichier.erreur}</span>` : 'ok'}</td>
                                    <td>
                                      <button
                                        type="button"
                                        class="btn btn-mini btn-plat"
                                        title="Comparer la sauvegarde et la version actuellement en production"
                                        onClick=${() => voirCeQuiAChange(fichier)}
                                      >
                                        Voir ce qui a changé
                                      </button>
                                    </td>
                                  </tr>
                                `
                              )}
                            </tbody>
                          </table>
                        </div>
                      `}
                </div>
              </div>
            `}
      </div>

      ${restauration
        ? html`
            <div class="voile" role="dialog" aria-modal="true" aria-label="Confirmation du retour arrière">
              <div class="modale modale-moyenne">
                <div class="modale-entete"><h1>Revenir en arrière</h1></div>
                <div class="modale-corps">
                  ${restauration.bloquants.map(
                    (probleme) => html`
                      <div class="encart encart-danger" style="margin-bottom:10px" key=${probleme.code}>
                        <strong>${probleme.message}</strong>
                        <div class="attenue">${probleme.conseil}</div>
                        ${probleme.fichiers && probleme.fichiers.length
                          ? html`<ul class="mono">
                              ${probleme.fichiers.slice(0, 10).map((chemin) => html`<li key=${chemin}>${chemin}</li>`)}
                            </ul>`
                          : null}
                      </div>
                    `
                  )}
                  ${restauration.avertissements.map(
                    (probleme) => html`
                      <div class="encart encart-alerte" style="margin-bottom:10px" key=${probleme.code}>
                        <strong>${probleme.message}</strong>
                        <div class="attenue">${probleme.conseil}</div>
                        ${probleme.fichiers && probleme.fichiers.length
                          ? html`<ul class="mono">
                              ${probleme.fichiers.slice(0, 10).map((chemin) => html`<li key=${chemin}>${chemin}</li>`)}
                            </ul>`
                          : null}
                      </div>
                    `
                  )}

                  <p>
                    ${formaterNombre(restauration.operations.filter((o) => o.action === 'restauration').length)}
                    fichier(s) seront restaurés depuis la sauvegarde et
                    ${formaterNombre(restauration.operations.filter((o) => o.action === 'suppression').length)}
                    fichier(s) créés par ce déploiement seront supprimés de la production.
                  </p>
                  <div class="liste-fichiers mono">
                    ${restauration.operations.map(
                      (operation) => html`
                        <div key=${operation.chemin}>
                          <span class="attenue">${operation.action === 'suppression' ? '−' : '↩'}</span>
                          ${operation.chemin}
                        </div>
                      `
                    )}
                  </div>
                </div>
                <div class="modale-pied">
                  <label for="confirmation-retour">
                    Saisissez le numéro de la demande (<span class="mono">${numero}</span>) :
                  </label>
                  <input
                    type="text"
                    id="confirmation-retour"
                    class="mono"
                    style="width:90px"
                    autocomplete="off"
                    disabled=${!restauration.ok || occupe}
                    value=${saisie}
                    onInput=${(e) => setSaisie(e.target.value)}
                  />
                  <div style="flex:1"></div>
                  <button type="button" class="btn" disabled=${occupe} onClick=${() => setRestauration(null)}>Annuler</button>
                  <button
                    type="button"
                    class="btn"
                    disabled=${!restauration.ok || saisie.trim() !== numero || occupe}
                    onClick=${() => lancerRetour(true)}
                  >
                    Simuler
                  </button>
                  <button
                    type="button"
                    class="btn btn-accent"
                    disabled=${!restauration.ok || saisie.trim() !== numero || occupe}
                    onClick=${() => lancerRetour(false)}
                  >
                    ${occupe ? 'En cours…' : 'Revenir en arrière'}
                  </button>
                </div>
              </div>
            </div>
          `
        : null}

      ${diff
        ? html`
            <div class="voile" role="dialog" aria-modal="true" aria-label="Comparaison avec la production actuelle">
              <div class="modale modale-plein">
                <div class="modale-entete">
                  <h1>Sauvegarde ↔ production actuelle</h1>
                  <div style="flex:1"></div>
                  <button type="button" class="btn btn-plat" onClick=${() => setDiff(null)}>Fermer ✕</button>
                </div>
                <div class="historique-diff">
                  <${VueDiff} diff=${diff} onOuvrirExterne=${() => {}} onNotifier=${onNotifier} inversable=${false} />
                </div>
              </div>
            </div>
          `
        : null}
    </div>
  `;
}
