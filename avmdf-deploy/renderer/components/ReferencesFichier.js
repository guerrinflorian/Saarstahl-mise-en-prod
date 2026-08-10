import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { EnTeteModale } from './Modale.js';
import { IconeLoupe } from './icones.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_COTE = { local: 'local', production: 'production', 'les deux': 'les deux côtés' };

/**
 * Les références d'un fichier : qui l'utilise (script src, registres ASPX,
 * CodeFile, gabarits de composant, url() de CSS…), et ce qu'il utilise
 * lui-même. Chaque mention est montrée avec sa ligne : c'est une recherche
 * textuelle du nom, assumée comme telle, et la ligne permet de juger.
 */
export function ReferencesFichier({ fichier, onFermer, onChoisir, onEchec }) {
  const [etat, setEtat] = useState({ chargement: true, utilisePar: [], utilise: [] });

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.references.fichier(fichier.cle);
      if (abandonne) return;
      if (!reponse.ok) {
        onEchec(reponse);
        onFermer();
        return;
      }
      setEtat({ chargement: false, utilisePar: reponse.utilisePar, utilise: reponse.utilise });
    })();
    return () => {
      abandonne = true;
    };
  }, [fichier.cle]);

  useEffect(() => {
    const surTouche = (evenement) => {
      if (evenement.key === 'Escape') onFermer();
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [onFermer]);

  const utilisateurs = new Set(etat.utilisePar.map((entree) => entree.cle)).size;
  const utilises = new Set(etat.utilise.map((entree) => entree.cle)).size;

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Références du fichier">
      <div class="modale modale-large">
        <${EnTeteModale} icone=${IconeLoupe} surtitre="Références" titre="Qui utilise ce fichier" onFermer=${onFermer}>
          <span class="mono attenue">${fichier.chemin}</span>
        <//>

        <div class="modale-corps">
          ${etat.chargement
            ? html`<p class="attenue">Lecture de l'index…</p>`
            : html`
                <${Section}
                  titre=${'Utilisé par ' +
                  (utilisateurs
                    ? formaterNombre(utilisateurs) + ' fichier' + (utilisateurs > 1 ? 's' : '')
                    : 'personne')}
                  vide="Aucune mention de ce fichier dans les fichiers analysés. S'il n'est pas non plus chargé dynamiquement (nom construit par le code, configuration IIS…), c'est un candidat au ménage."
                  entrees=${etat.utilisePar}
                  onChoisir=${onChoisir}
                />
                <${Section}
                  titre=${'Utilise ' +
                  (utilises ? formaterNombre(utilises) + ' fichier' + (utilises > 1 ? 's' : '') : 'aucun fichier connu')}
                  vide="Ce fichier ne mentionne aucun autre fichier de l'analyse."
                  entrees=${etat.utilise}
                  onChoisir=${onChoisir}
                />
                <p class="attenue refs-methode">
                  Recherche du nom exact, insensible à la casse, dans le contenu des fichiers texte des
                  deux côtés ; pour un nom de composant, la forme balise est cherchée aussi
                  (vjc-Gestion-Code-Acier se retrouve en ${'<'}vjc-gestion-code-acier${'>'}). Un nom
                  construit dynamiquement par le code ne peut pas être vu ici.
                </p>
              `}
        </div>

        <div class="modale-pied">
          <div style="flex:1"></div>
          <button type="button" class="btn btn-accent" onClick=${onFermer}>Fermer (Échap)</button>
        </div>
      </div>
    </div>
  `;
}

function Section({ titre, vide, entrees, onChoisir }) {
  if (!entrees.length) {
    return html`
      <div class="refs-section">
        <h3>${titre}</h3>
        <div class="encart">${vide}</div>
      </div>
    `;
  }
  return html`
    <div class="refs-section">
      <h3>${titre}</h3>
      ${entrees.map(
        (entree) => html`
          <div class="refs-groupe" key=${entree.cle + '|' + entree.cote}>
            <button
              type="button"
              class="refs-fichier"
              title="Ouvrir la comparaison de ce fichier"
              onClick=${() => onChoisir(entree.cle)}
            >
              <span class="mono">${entree.chemin}</span>
              <span class="refs-cote">${LIBELLES_COTE[entree.cote] || entree.cote}</span>
            </button>
            ${entree.lignes.map(
              (ligne) => html`
                <div class="refs-ligne" key=${ligne.numero}>
                  <span class="refs-numero mono">${formaterNombre(ligne.numero)}</span>
                  <span class="mono refs-extrait">${ligne.extrait}</span>
                </div>
              `
            )}
          </div>
        `
      )}
    </div>
  `;
}
