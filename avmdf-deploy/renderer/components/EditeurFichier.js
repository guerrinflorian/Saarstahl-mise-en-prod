import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import Prism from '../vendor/prism.js';
import { langueDe } from './coloration.js';
import { formaterNombre, formaterOctets } from './arborescence.js';

const html = htm.bind(h);

/** Au-delà, la coloration est coupée : la frappe doit rester instantanée. */
const LIMITE_COLORATION_EDITEUR = 400000;

/**
 * Éditeur intégré : la version locale d'un fichier, modifiable sans quitter
 * l'outil. C'est fait pour la retouche de dernière minute - le libellé oublié,
 * le commentaire à retirer - pas pour remplacer Visual Studio.
 *
 * Le rendu superpose deux couches parfaitement alignées : un `pre` colorié en
 * dessous, un `textarea` au texte transparent au-dessus. Le curseur et la
 * sélection viennent du textarea, la couleur vient du pre ; le défilement du
 * textarea est reporté sur le pre à chaque mouvement.
 *
 * L'enregistrement passe par le processus principal, qui réécrit le fichier
 * dans son enveloppe d'origine : encodage, BOM et fins de ligne conservés.
 */
export function EditeurFichier({ fichier, onFermer, onEnregistre, onEchec }) {
  const [etat, setEtat] = useState('chargement');
  const [erreur, setErreur] = useState(null);
  const [texte, setTexte] = useState('');
  const [initial, setInitial] = useState('');
  const [enveloppe, setEnveloppe] = useState(null);
  const [occupe, setOccupe] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [curseur, setCurseur] = useState({ ligne: 1, colonne: 1 });
  const [colorie, setColorie] = useState('');

  const zoneTexte = useRef(null);
  const calque = useRef(null);
  const gouttiere = useRef(null);
  const empreinte = useRef(null);

  const modifie = texte !== initial;
  const langue = useMemo(() => langueDe(fichier.chemin), [fichier.chemin]);

  // -- Chargement -----------------------------------------------------------
  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.fichier.lireLocal(fichier.cle);
      if (abandonne) return;
      if (!reponse.ok) {
        setErreur(reponse.erreur);
        setEtat('erreur');
        return;
      }
      // Le textarea travaille en \n ; l'enveloppe d'origine est réappliquée à
      // l'enregistrement par le processus principal.
      const normalise = reponse.texte.replace(/\r\n|\r/g, '\n');
      setTexte(normalise);
      setInitial(normalise);
      setEnveloppe({ encodage: reponse.encodage, finDeLigne: reponse.finDeLigne, taille: reponse.taille });
      empreinte.current = reponse.empreinte;
      setEtat('pret');
      setTimeout(() => zoneTexte.current && zoneTexte.current.focus(), 0);
    })();
    return () => {
      abandonne = true;
    };
  }, [fichier.cle]);

  // -- Coloration, légèrement différée pour ne jamais freiner la frappe -----
  useEffect(() => {
    if (etat !== 'pret') return undefined;
    if (!langue || texte.length > LIMITE_COLORATION_EDITEUR) {
      setColorie('');
      return undefined;
    }
    const minuteur = setTimeout(() => {
      const grammaire = Prism.languages[langue.id];
      if (!grammaire) {
        setColorie('');
        return;
      }
      try {
        setColorie(enHtml(Prism.tokenize(texte, grammaire)));
      } catch (err) {
        setColorie('');
      }
    }, 90);
    return () => clearTimeout(minuteur);
  }, [texte, langue, etat]);

  // -- Défilement : le textarea mène, le calque et la gouttière suivent -----
  function surDefilement(evenement) {
    const { scrollTop, scrollLeft } = evenement.target;
    if (calque.current) calque.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    if (gouttiere.current) gouttiere.current.style.transform = `translateY(${-scrollTop}px)`;
  }

  function surPosition(evenement) {
    const position = evenement.target.selectionStart || 0;
    const avant = evenement.target.value.slice(0, position);
    const dernierSaut = avant.lastIndexOf('\n');
    setCurseur({
      ligne: (avant.match(/\n/g) || []).length + 1,
      colonne: position - dernierSaut
    });
  }

  function surTouche(evenement) {
    if (evenement.key === 'Tab') {
      // `execCommand` plutôt qu'une réécriture de la valeur : l'annulation
      // (Ctrl+Z) du textarea reste intacte.
      evenement.preventDefault();
      document.execCommand('insertText', false, '\t');
    } else if (evenement.key === 's' && (evenement.ctrlKey || evenement.metaKey)) {
      evenement.preventDefault();
      if (modifie && !occupe) enregistrer();
    }
  }

  function demanderFermeture() {
    if (modifie) setConfirmation(true);
    else onFermer();
  }

  useEffect(() => {
    function surEchap(evenement) {
      if (evenement.key !== 'Escape') return;
      evenement.stopPropagation();
      if (confirmation) setConfirmation(false);
      else demanderFermeture();
    }
    window.addEventListener('keydown', surEchap, true);
    return () => window.removeEventListener('keydown', surEchap, true);
  });

  async function enregistrer() {
    setOccupe(true);
    const reponse = await window.avmdf.fichier.enregistrerLocal(fichier.cle, texte, empreinte.current);
    setOccupe(false);
    if (!reponse.ok) {
      onEchec(reponse);
      return;
    }
    setInitial(texte);
    empreinte.current = reponse.empreinte;
    onEnregistre(reponse);
  }

  const nombreLignes = useMemo(() => texte.split('\n').length, [texte]);
  const numeros = useMemo(() => {
    const sortie = [];
    for (let i = 1; i <= nombreLignes; i += 1) sortie.push(i);
    return sortie;
  }, [nombreLignes]);

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Éditeur de la version locale">
      <div class="modale modale-plein editeur">
        <div class="modale-entete">
          <h1>Modifier la version locale</h1>
          <span class="mono attenue editeur-chemin" title=${fichier.chemin}>${fichier.chemin}</span>
          ${modifie
            ? html`<span class="editeur-etat modifie" title="Des modifications ne sont pas enregistrées">Modifié</span>`
            : html`<span class="editeur-etat" title="Le fichier sur le disque est à jour">Enregistré</span>`}
          <div style="flex:1"></div>
          ${langue && texte.length > LIMITE_COLORATION_EDITEUR
            ? html`<span class="attenue">Fichier volumineux : coloration coupée.</span>`
            : null}
          <button type="button" class="btn btn-plat" onClick=${demanderFermeture}>Fermer ✕</button>
        </div>

        ${enveloppe && enveloppe.finDeLigne === 'mixte'
          ? html`<div class="diff-alerte">
              <span>
                Ce fichier mélange plusieurs fins de ligne. À l'enregistrement, elles seront uniformisées
                en CRLF - c'est le seul cas où l'éditeur retouche autre chose que ce que vous tapez.
              </span>
            </div>`
          : null}

        ${etat === 'chargement'
          ? html`<div class="panneau-contenu"><div class="etat-vide"><div class="attenue">Lecture du fichier…</div></div></div>`
          : null}
        ${etat === 'erreur'
          ? html`<div class="panneau-contenu">
              <div class="etat-vide">
                <div class="encart encart-danger" style="max-width:600px;text-align:left">
                  <strong>${erreur.message}</strong>
                  ${erreur.conseil ? html`<div style="margin-top:6px">${erreur.conseil}</div>` : null}
                </div>
              </div>
            </div>`
          : null}

        ${etat === 'pret'
          ? html`
              <div class="editeur-zone">
                <div class="editeur-gouttiere-cadre">
                  <div class="editeur-gouttiere" ref=${gouttiere}>
                    ${numeros.map((numero) => html`<div key=${numero}>${numero}</div>`)}
                  </div>
                </div>
                <div class="editeur-piste">
                  <pre class="editeur-calque" aria-hidden="true" ref=${calque}><code
                    dangerouslySetInnerHTML=${colorie ? { __html: colorie + '\n' } : null}
                  >${colorie ? null : texte + '\n'}</code></pre>
                  <textarea
                    class="editeur-saisie"
                    ref=${zoneTexte}
                    spellcheck="false"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    wrap="off"
                    value=${texte}
                    onInput=${(e) => {
                      setTexte(e.target.value);
                      surPosition(e);
                    }}
                    onScroll=${surDefilement}
                    onKeyDown=${surTouche}
                    onKeyUp=${surPosition}
                    onClick=${surPosition}
                  ></textarea>
                </div>
              </div>

              <div class="editeur-pied">
                <span class="mono attenue">
                  ${enveloppe.encodage +
                  ' · ' +
                  (enveloppe.finDeLigne === 'mixte' ? 'CRLF à l\'enregistrement' : enveloppe.finDeLigne) +
                  ' · ' +
                  formaterNombre(nombreLignes) +
                  ' lignes · ' +
                  formaterOctets(enveloppe.taille)}
                </span>
                <span class="mono attenue">Ln ${formaterNombre(curseur.ligne)}, Col ${formaterNombre(curseur.colonne)}</span>
                <div style="flex:1"></div>
                ${confirmation
                  ? html`
                      <span>Fermer sans enregistrer ? Les modifications seront perdues.</span>
                      <button type="button" class="btn" onClick=${() => setConfirmation(false)}>Continuer l'édition</button>
                      <button type="button" class="btn btn-danger" onClick=${onFermer}>Fermer sans enregistrer</button>
                    `
                  : html`
                      <span class="attenue">L'enregistrement conserve l'encodage, le BOM et les fins de ligne d'origine.</span>
                      <button type="button" class="btn" onClick=${demanderFermeture}>Fermer</button>
                      <button
                        type="button"
                        class="btn btn-accent"
                        disabled=${!modifie || occupe}
                        title="Ctrl+S"
                        onClick=${enregistrer}
                      >
                        ${occupe ? 'Enregistrement…' : 'Enregistrer'}
                      </button>
                    `}
              </div>
            `
          : null}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------

const ECHAPPEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function echapper(texte) {
  return texte.replace(/[&<>]/g, (c) => ECHAPPEMENTS[c]);
}

/**
 * Sérialise l'arbre de jetons Prism en HTML, avec les classes `code-*` de la
 * feuille de style - les mêmes teintes que le comparateur, pas le thème Prism.
 */
function enHtml(jetons) {
  let sortie = '';
  for (const jeton of jetons) {
    if (typeof jeton === 'string') {
      sortie += echapper(jeton);
      continue;
    }
    let classe = 'code-' + jeton.type;
    if (jeton.alias) {
      const alias = Array.isArray(jeton.alias) ? jeton.alias : [jeton.alias];
      classe += alias.map((a) => ' code-' + a).join('');
    }
    const contenu =
      typeof jeton.content === 'string'
        ? echapper(jeton.content)
        : enHtml(Array.isArray(jeton.content) ? jeton.content : [jeton.content]);
    sortie += '<span class="' + classe + '">' + contenu + '</span>';
  }
  return sortie;
}
