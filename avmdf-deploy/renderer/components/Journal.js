import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { formaterNombre } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeJournal } from './icones.js';

const html = htm.bind(h);

/** Journal quotidien : une ligne par événement, la plus récente en premier. */
export function Journal({ onFermer, onEchec }) {
  const [fichiers, setFichiers] = useState([]);
  const [dossier, setDossier] = useState('');
  const [choisi, setChoisi] = useState(null);
  const [lignes, setLignes] = useState([]);
  const [filtre, setFiltre] = useState('');
  const [niveau, setNiveau] = useState('tous');
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    (async () => {
      const reponse = await window.avmdf.journal.lister();
      setChargement(false);
      if (!reponse.ok) {
        onEchec(reponse);
        return;
      }
      setFichiers(reponse.fichiers);
      setDossier(reponse.dossier);
      if (reponse.fichiers.length) setChoisi(reponse.fichiers[0].nom);
    })();
  }, []);

  useEffect(() => {
    if (!choisi) return;
    (async () => {
      const reponse = await window.avmdf.journal.lire(choisi);
      if (!reponse.ok) {
        onEchec(reponse);
        setLignes([]);
        return;
      }
      setLignes(reponse.lignes);
    })();
  }, [choisi]);

  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key === 'Escape') onFermer();
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [onFermer]);

  const aiguille = filtre.trim().toLowerCase();
  const parNiveau = { tous: lignes.length, alerte: 0, erreur: 0 };
  for (const ligne of lignes) {
    const n = niveauDe(ligne).trim();
    if (n) parNiveau[n] += 1;
  }
  const affichees = lignes.filter((ligne) => {
    if (niveau !== 'tous' && niveauDe(ligne).trim() !== niveau) return false;
    return !aiguille || ligne.toLowerCase().includes(aiguille);
  });

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Journal">
      <div class="modale modale-large">
        <${EnTeteModale} icone=${IconeJournal} surtitre="Application" titre="Journal des événements" onFermer=${onFermer}>
          <span class="attenue mono">${dossier}</span>
          <button type="button" class="btn btn-mini" onClick=${() => window.avmdf.journal.ouvrirDossier()}>
            Ouvrir le dossier
          </button>
        <//>

        <div class="modale-corps">
          <div class="filtres-ligne" style="margin-bottom:8px">
            <select value=${choisi || ''} aria-label="Jour" onChange=${(e) => setChoisi(e.target.value)}>
              ${fichiers.length === 0 ? html`<option value="">aucun journal</option>` : null}
              ${fichiers.map((fichier) => html`<option value=${fichier.nom} key=${fichier.nom}>${fichier.jour}</option>`)}
            </select>
            ${[
              ['tous', 'Tout (' + formaterNombre(parNiveau.tous) + ')'],
              ['alerte', 'Alertes (' + formaterNombre(parNiveau.alerte) + ')'],
              ['erreur', 'Erreurs (' + formaterNombre(parNiveau.erreur) + ')']
            ].map(
              ([valeur, libelle]) => html`
                <button
                  type="button"
                  class=${'btn btn-mini' + (niveau === valeur ? ' btn-marque' : '')}
                  key=${valeur}
                  onClick=${() => setNiveau(valeur)}
                >
                  ${libelle}
                </button>
              `
            )}
            <input
              type="search"
              class="mono"
              style="flex:1"
              placeholder="Filtrer les lignes…"
              value=${filtre}
              onInput=${(e) => setFiltre(e.target.value)}
            />
            <span class="attenue">${formaterNombre(affichees.length)} ligne(s)</span>
          </div>

          ${chargement ? html`<div class="attenue">Lecture…</div>` : null}
          ${!chargement && !fichiers.length
            ? html`<div class="etat-vide">
                <div class="etat-vide-titre">Aucun journal pour l'instant</div>
                <div class="etat-vide-texte">Le premier événement en créera un.</div>
              </div>`
            : null}

          <div class="journal">
            ${affichees.map(
              (ligne, index) => html`
                <div class=${'journal-ligne' + niveauDe(ligne)} key=${index}>${ligne}</div>
              `
            )}
          </div>
        </div>

        <div class="modale-pied">
          <div style="flex:1"></div>
          <button type="button" class="btn" onClick=${onFermer}>Fermer</button>
        </div>
      </div>
    </div>
  `;
}

function niveauDe(ligne) {
  if (ligne.includes(' ERREUR')) return ' erreur';
  if (ligne.includes(' ALERTE')) return ' alerte';
  return '';
}
