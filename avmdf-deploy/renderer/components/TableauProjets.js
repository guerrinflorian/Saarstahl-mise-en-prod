import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { joindreChemin } from './chemins.js';

const html = htm.bind(h);

/**
 * Tableau éditable des projets : nom, dossier local, dossier de production,
 * activation, réordonnancement.
 *
 * Les dossiers sont relatifs aux racines : c'est cet appariement qui règle le
 * fait que les noms ne correspondent pas un pour un (GPNET ↔ GPNet).
 */
export function TableauProjets({ projets, racines, erreurPour, onChange }) {
  function modifier(index, champ, valeur) {
    const copie = projets.slice();
    copie[index] = Object.assign({}, copie[index], { [champ]: valeur });
    onChange(copie);
  }

  function deplacer(index, sens) {
    const cible = index + sens;
    if (cible < 0 || cible >= projets.length) return;
    const copie = projets.slice();
    const [element] = copie.splice(index, 1);
    copie.splice(cible, 0, element);
    onChange(copie);
  }

  function retirer(index) {
    onChange(projets.filter((_, i) => i !== index));
  }

  function ajouter() {
    onChange(
      projets.concat({
        id: 'p_' + crypto.randomUUID().slice(0, 8),
        nom: '',
        dossierLocal: '',
        dossierProd: '',
        actif: true
      })
    );
  }

  return html`
    <div class="projets">
      <div class="projets-entete">
        <span>Actif</span>
        <span>Nom</span>
        <span>Dossier local</span>
        <span>Dossier production</span>
        <span></span>
      </div>

      ${projets.length === 0
        ? html`<div class="rien" style="padding:8px 2px">
            Aucun projet : ajoutez-en un pour pouvoir lancer une analyse.
          </div>`
        : null}

      ${projets.map((projet, index) => {
        const erreurNom = erreurPour(`projets[${index}].nom`);
        const erreurLocal = erreurPour(`projets[${index}].dossierLocal`);
        const erreurProd = erreurPour(`projets[${index}].dossierProd`);
        return html`
          <div class=${'projet' + (projet.actif ? '' : ' projet-inactif')} key=${projet.id}>
            <div class="projet-ligne">
              <div style="display:flex;justify-content:center">
                <input
                  type="checkbox"
                  checked=${projet.actif}
                  aria-label=${'Projet ' + (projet.nom || index + 1) + ' actif'}
                  title="Un projet inactif n'apparaît pas dans la liste déroulante"
                  onChange=${(evenement) => modifier(index, 'actif', evenement.target.checked)}
                />
              </div>
              <input
                type="text"
                value=${projet.nom}
                spellcheck="false"
                placeholder="GPNet"
                class=${erreurNom ? 'invalide' : ''}
                title=${erreurNom ? erreurNom.message : 'Nom affiché dans la liste des projets'}
                aria-label=${'Nom du projet ' + (index + 1)}
                onInput=${(evenement) => modifier(index, 'nom', evenement.target.value)}
              />
              <input
                type="text"
                class=${'mono' + (erreurLocal ? ' invalide' : '')}
                value=${projet.dossierLocal}
                spellcheck="false"
                placeholder="GPNET"
                title=${erreurLocal ? erreurLocal.message : 'Dossier relatif à la racine locale'}
                aria-label=${'Dossier local du projet ' + (projet.nom || index + 1)}
                onInput=${(evenement) => modifier(index, 'dossierLocal', evenement.target.value)}
              />
              <input
                type="text"
                class=${'mono' + (erreurProd ? ' invalide' : '')}
                value=${projet.dossierProd}
                spellcheck="false"
                placeholder="GPNet"
                title=${erreurProd ? erreurProd.message : 'Dossier relatif à la racine de production'}
                aria-label=${'Dossier de production du projet ' + (projet.nom || index + 1)}
                onInput=${(evenement) => modifier(index, 'dossierProd', evenement.target.value)}
              />
              <div class="projet-actions">
                <button
                  type="button"
                  class="btn btn-plat btn-icone btn-mini"
                  title="Monter"
                  aria-label=${'Monter ' + (projet.nom || 'ce projet')}
                  disabled=${index === 0}
                  onClick=${() => deplacer(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="btn btn-plat btn-icone btn-mini"
                  title="Descendre"
                  aria-label=${'Descendre ' + (projet.nom || 'ce projet')}
                  disabled=${index === projets.length - 1}
                  onClick=${() => deplacer(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="btn btn-plat btn-icone btn-mini btn-danger"
                  title="Supprimer ce projet"
                  aria-label=${'Supprimer ' + (projet.nom || 'ce projet')}
                  onClick=${() => retirer(index)}
                >
                  ✕
                </button>
              </div>
            </div>
            <div class="projet-resolu mono">
              <span>${joindreChemin(racines.locale, projet.dossierLocal)}</span>
              <span class="fleche">→</span>
              <span>${joindreChemin(racines.prod, projet.dossierProd)}</span>
            </div>
          </div>
        `;
      })}

      <div>
        <button type="button" class="btn" onClick=${ajouter}>+ Ajouter un projet</button>
      </div>
    </div>
  `;
}
