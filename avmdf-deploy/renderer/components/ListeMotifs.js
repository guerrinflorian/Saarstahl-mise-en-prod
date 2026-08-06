import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/**
 * Liste éditable de motifs (dossiers exclus, fichiers exclus, extensions).
 * Chaque entrée est modifiable sur place ; le doublon est refusé sans bruit.
 *
 * @param {object} props
 * @param {string[]} props.valeurs
 * @param {(valeurs:string[]) => void} props.onChange
 * @param {string} [props.placeholder]
 * @param {(valeur:string) => string} [props.transformer] normalisation à la saisie
 */
export function ListeMotifs({ valeurs, onChange, placeholder, transformer, etiquette }) {
  const [saisie, setSaisie] = useState('');

  const normaliser = (valeur) => (transformer ? transformer(valeur.trim()) : valeur.trim());

  function ajouter() {
    const propre = normaliser(saisie);
    if (!propre) return;
    const existe = valeurs.some((v) => v.toLowerCase() === propre.toLowerCase());
    if (!existe) onChange(valeurs.concat(propre));
    setSaisie('');
  }

  function modifier(index, valeur) {
    const copie = valeurs.slice();
    copie[index] = valeur;
    onChange(copie);
  }

  function retirer(index) {
    onChange(valeurs.filter((_, i) => i !== index));
  }

  return html`
    <div>
      <div class="liste-motifs" role="list" aria-label=${etiquette || 'Liste de motifs'}>
        ${valeurs.length === 0 ? html`<span class="rien">Liste vide</span>` : null}
        ${valeurs.map(
          (valeur, index) => html`
            <span class="motif" role="listitem" key=${'m' + index}>
              <input
                type="text"
                value=${valeur}
                spellcheck="false"
                size=${Math.max(valeur.length, 4)}
                aria-label=${'Motif : ' + valeur}
                onInput=${(evenement) => modifier(index, evenement.target.value)}
                onBlur=${(evenement) => modifier(index, normaliser(evenement.target.value))}
              />
              <button
                type="button"
                title=${'Retirer ' + valeur}
                aria-label=${'Retirer ' + valeur}
                onClick=${() => retirer(index)}
              >
                ✕
              </button>
            </span>
          `
        )}
      </div>
      <div class="liste-ajout">
        <input
          type="text"
          value=${saisie}
          spellcheck="false"
          placeholder=${placeholder || 'Ajouter…'}
          aria-label=${'Ajouter à : ' + (etiquette || 'la liste')}
          onInput=${(evenement) => setSaisie(evenement.target.value)}
          onKeyDown=${(evenement) => {
            if (evenement.key === 'Enter') {
              evenement.preventDefault();
              ajouter();
            }
          }}
        />
        <button type="button" class="btn" onClick=${ajouter} disabled=${!saisie.trim()}>Ajouter</button>
      </div>
    </div>
  `;
}
