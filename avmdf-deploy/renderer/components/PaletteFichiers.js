import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import { IconeFichier } from './icones.js';
import { MARQUEURS, LIBELLES, formaterNombre } from './arborescence.js';
import { normaliser } from './filtres.js';

const html = htm.bind(h);

const MAXIMUM_AFFICHES = 60;

/** Priorité d'affichage à requête vide : les écarts d'abord. */
const ORDRE_STATUT = { modifie: 0, nouveau: 1, orphelin: 2, identique: 3 };

/**
 * Palette « Aller au fichier » (Ctrl+P) : taper trois lettres, Entrée, et la
 * comparaison s'ouvre. Le détour par l'arborescence et ses dossiers repliés
 * n'a plus rien d'obligatoire.
 *
 * La recherche est insensible à la casse et aux accents, et tolère les trous :
 * « rchaspx » trouve Recherche.aspx. Les correspondances exactes passent
 * toujours devant les correspondances à trous.
 */
export function PaletteFichiers({ fichiers, recents, onChoisir, onFermer }) {
  const [requete, setRequete] = useState('');
  const [position, setPosition] = useState(0);
  const champ = useRef(null);
  const liste = useRef(null);

  useEffect(() => {
    const minuteur = setTimeout(() => champ.current && champ.current.focus(), 0);
    return () => clearTimeout(minuteur);
  }, []);

  const resultats = useMemo(() => chercher(fichiers, requete, recents || []), [fichiers, requete, recents]);

  useEffect(() => {
    setPosition(0);
  }, [requete]);

  useEffect(() => {
    const element = liste.current && liste.current.children[position];
    if (element) element.scrollIntoView({ block: 'nearest' });
  }, [position]);

  function surTouche(evenement) {
    if (evenement.key === 'Escape') {
      evenement.preventDefault();
      onFermer();
    } else if (evenement.key === 'ArrowDown') {
      evenement.preventDefault();
      setPosition(Math.min(resultats.length - 1, position + 1));
    } else if (evenement.key === 'ArrowUp') {
      evenement.preventDefault();
      setPosition(Math.max(0, position - 1));
    } else if (evenement.key === 'Enter') {
      evenement.preventDefault();
      const choisi = resultats[position];
      if (choisi) {
        onChoisir(choisi.fichier);
        onFermer();
      }
    }
  }

  return html`
    <div class="voile palette-voile" onMouseDown=${(e) => e.target === e.currentTarget && onFermer()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Aller au fichier">
        <div class="palette-champ">
          <input
            type="text"
            ref=${champ}
            class="mono"
            placeholder="Aller au fichier… (nom ou chemin, les trous sont permis)"
            spellcheck="false"
            autocomplete="off"
            value=${requete}
            onInput=${(e) => setRequete(e.target.value)}
            onKeyDown=${surTouche}
          />
          <span class="attenue palette-nombre">
            ${formaterNombre(resultats.length)}${resultats.length === MAXIMUM_AFFICHES ? '+' : ''} fichier(s)
          </span>
        </div>
        <div class="palette-liste" ref=${liste}>
          ${resultats.map(
            (resultat, index) => html`
              <button
                type="button"
                class=${'palette-entree' + (index === position ? ' choisi' : '')}
                key=${resultat.fichier.cle}
                onMouseEnter=${() => setPosition(index)}
                onClick=${() => {
                  onChoisir(resultat.fichier);
                  onFermer();
                }}
              >
                <span
                  class=${'marqueur marqueur-' + resultat.fichier.statut}
                  title=${'Fichier ' + LIBELLES[resultat.fichier.statut]}
                >
                  ${MARQUEURS[resultat.fichier.statut]}
                </span>
                <${IconeFichier} extension=${resultat.fichier.extension || resultat.fichier.nom} />
                <span class="palette-chemin mono">${surligner(resultat.fichier.chemin, resultat.indices)}</span>
                ${resultat.recent ? html`<span class="etiquette">récent</span>` : null}
              </button>
            `
          )}
          ${!resultats.length
            ? html`<div class="palette-vide attenue">Aucun fichier ne correspond à « ${requete} ».</div>`
            : null}
        </div>
        <div class="palette-pied attenue">
          <span><span class="aide-touche">↑</span> <span class="aide-touche">↓</span> choisir</span>
          <span><span class="aide-touche">Entrée</span> comparer</span>
          <span><span class="aide-touche">Échap</span> fermer</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------

/**
 * @returns {Array<{fichier:object, indices:number[]|null}>} au plus
 *   MAXIMUM_AFFICHES entrées, les meilleures d'abord.
 */
function chercher(fichiers, requete, recents) {
  const aiguille = normaliser(requete.trim());

  if (!aiguille) {
    // Sans requête : les derniers fichiers comparés d'abord - c'est presque
    // toujours eux qu'on rouvre - puis les écarts, par statut.
    const rangRecent = new Map(recents.map((cle, index) => [cle, index]));
    return fichiers
      .slice()
      .sort((a, b) => {
        const recentA = rangRecent.has(a.cle) ? rangRecent.get(a.cle) : Infinity;
        const recentB = rangRecent.has(b.cle) ? rangRecent.get(b.cle) : Infinity;
        return (
          recentA - recentB ||
          (ORDRE_STATUT[a.statut] ?? 9) - (ORDRE_STATUT[b.statut] ?? 9) ||
          a.chemin.localeCompare(b.chemin, 'fr')
        );
      })
      .slice(0, MAXIMUM_AFFICHES)
      .map((fichier) => ({ fichier, indices: null, recent: rangRecent.has(fichier.cle) }));
  }

  const retenus = [];
  for (const fichier of fichiers) {
    const chemin = normaliser(fichier.chemin);
    const nom = normaliser(fichier.nom);

    const dansNom = nom.indexOf(aiguille);
    if (dansNom >= 0) {
      const depart = chemin.length - nom.length + dansNom;
      retenus.push({ fichier, rang: 0, poids: dansNom, indices: suite(depart, aiguille.length) });
      continue;
    }
    const dansChemin = chemin.indexOf(aiguille);
    if (dansChemin >= 0) {
      retenus.push({ fichier, rang: 1, poids: dansChemin, indices: suite(dansChemin, aiguille.length) });
      continue;
    }
    const trous = sousSequence(chemin, aiguille);
    if (trous) {
      retenus.push({ fichier, rang: 2, poids: trous[trous.length - 1] - trous[0], indices: trous });
    }
  }

  retenus.sort(
    (a, b) =>
      a.rang - b.rang ||
      a.poids - b.poids ||
      a.fichier.chemin.length - b.fichier.chemin.length ||
      a.fichier.chemin.localeCompare(b.fichier.chemin, 'fr')
  );
  return retenus.slice(0, MAXIMUM_AFFICHES);
}

function suite(depart, longueur) {
  const indices = [];
  for (let i = 0; i < longueur; i += 1) indices.push(depart + i);
  return indices;
}

/** Indices d'une correspondance à trous, ou null. Recherche gloutonne, suffisante ici. */
function sousSequence(chaine, aiguille) {
  const indices = [];
  let depuis = 0;
  for (const caractere of aiguille) {
    const trouve = chaine.indexOf(caractere, depuis);
    if (trouve === -1) return null;
    indices.push(trouve);
    depuis = trouve + 1;
  }
  return indices;
}

/**
 * Le chemin, avec les caractères retenus en évidence. La normalisation ne
 * change pas la longueur de la chaîne (accents décomposés mis à part, les
 * indices restent alignés pour les chemins Windows usuels).
 */
function surligner(chemin, indices) {
  if (!indices || !indices.length) return chemin;
  const marques = new Set(indices);
  const morceaux = [];
  let ordinaire = '';
  for (let i = 0; i < chemin.length; i += 1) {
    if (marques.has(i)) {
      if (ordinaire) {
        morceaux.push(ordinaire);
        ordinaire = '';
      }
      morceaux.push(html`<mark>${chemin[i]}</mark>`);
    } else {
      ordinaire += chemin[i];
    }
  }
  if (ordinaire) morceaux.push(ordinaire);
  return morceaux;
}
