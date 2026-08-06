import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useId } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/** Ligne de formulaire : libellé à gauche, contenu à droite, aide dessous. */
export function Champ({ libelle, pour, aide, erreur, children }) {
  return html`
    <div class="champ">
      <label for=${pour}>${libelle}</label>
      <div class="champ-corps">${children}</div>
      ${erreur ? html`<div class="champ-erreur">${erreur}</div>` : null}
      ${!erreur && aide ? html`<div class="champ-aide">${aide}</div>` : null}
    </div>
  `;
}

/** Champ texte pour un chemin, avec sélecteur de dossier natif. */
export function ChampDossier({ libelle, valeur, aide, erreur, titreDialogue, onChange, onErreur }) {
  const identifiant = useId();

  async function parcourir() {
    const reponse = await window.avmdf.dialogue.choisirDossier({
      titre: titreDialogue || libelle,
      cheminInitial: valeur
    });
    if (!reponse.ok) {
      if (onErreur) onErreur(reponse);
      return;
    }
    if (!reponse.annule) onChange(reponse.chemin);
  }

  return html`
    <${Champ} libelle=${libelle} pour=${identifiant} aide=${aide} erreur=${erreur}>
      <input
        type="text"
        id=${identifiant}
        class=${erreur ? 'invalide' : ''}
        spellcheck="false"
        value=${valeur}
        onInput=${(evenement) => onChange(evenement.target.value)}
      />
      <button type="button" class="btn" onClick=${parcourir}>Parcourir…</button>
    <//>
  `;
}

/** Case à cocher avec son libellé cliquable. */
export function Case({ libelle, coche, onChange, titre, desactive }) {
  return html`
    <label class="case" title=${titre || ''}>
      <input
        type="checkbox"
        checked=${coche}
        disabled=${Boolean(desactive)}
        onChange=${(evenement) => onChange(evenement.target.checked)}
      />
      <span>${libelle}</span>
    </label>
  `;
}
