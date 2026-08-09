import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import Prism from '../vendor/prism.js';
import { langueDe } from './coloration.js';
import { formaterNombre, formaterOctets } from './arborescence.js';
import { EnTeteModale } from './Modale.js';
import { IconeCrayon } from './icones.js';

const html = htm.bind(h);

/** Au-delà, la coloration est coupée : la frappe doit rester instantanée. */
const LIMITE_COLORATION_EDITEUR = 150000;

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
  const [recherche, setRecherche] = useState(null);
  const [aiguille, setAiguille] = useState('');
  const [remplacement, setRemplacement] = useState('');
  const [positionOccurrence, setPositionOccurrence] = useState(0);

  const zoneTexte = useRef(null);
  const calque = useRef(null);
  const calqueMarques = useRef(null);
  const gouttiere = useRef(null);
  const champRecherche = useRef(null);
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

  // -- Coloration, calculée dans le même rendu que la frappe ----------------
  //
  // Synchrone à dessein : un calque colorié en retard d'une frappe ferait
  // apparaître, l'espace d'un instant, un texte qui n'est plus le bon sous le
  // curseur. Sous la limite de taille, la tokenisation tient largement dans le
  // budget d'une frappe ; au-delà, on renonce à la couleur, jamais à la
  // fluidité.
  const colorie = useMemo(() => {
    if (etat !== 'pret' || !langue || texte.length > LIMITE_COLORATION_EDITEUR) return '';
    const grammaire = Prism.languages[langue.id];
    if (!grammaire) return '';
    try {
      return enHtml(Prism.tokenize(texte, grammaire));
    } catch (err) {
      return '';
    }
  }, [texte, langue, etat]);

  // -- Défilement : le textarea mène, les calques et la gouttière suivent ---
  function surDefilement(evenement) {
    const { scrollTop, scrollLeft } = evenement.target;
    if (calque.current) calque.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    if (calqueMarques.current) calqueMarques.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    if (gouttiere.current) gouttiere.current.style.transform = `translateY(${-scrollTop}px)`;
  }

  // -- Recherche et remplacement --------------------------------------------
  //
  // Les occurrences vivent dans un calque de plus, sous la coloration : le
  // textarea garde le curseur, le calque montre où sont les trouvailles.

  const occurrences = useMemo(() => {
    if (!recherche || !aiguille) return [];
    const sortie = [];
    const meule = texte.toLowerCase();
    const motif = aiguille.toLowerCase();
    let depuis = 0;
    while (sortie.length < 5000) {
      const trouve = meule.indexOf(motif, depuis);
      if (trouve === -1) break;
      sortie.push(trouve);
      depuis = trouve + Math.max(1, motif.length);
    }
    return sortie;
  }, [texte, aiguille, recherche]);

  useEffect(() => {
    setPositionOccurrence((precedente) => Math.max(0, Math.min(precedente, occurrences.length - 1)));
  }, [occurrences.length]);

  const marquesHtml = useMemo(() => {
    if (!occurrences.length) return '';
    let sortie = '';
    let position = 0;
    occurrences.forEach((debut, index) => {
      sortie += echapper(texte.slice(position, debut));
      sortie +=
        '<mark class="editeur-marque' +
        (index === positionOccurrence ? ' courante' : '') +
        '">' +
        echapper(texte.slice(debut, debut + aiguille.length)) +
        '</mark>';
      position = debut + aiguille.length;
    });
    sortie += echapper(texte.slice(position));
    return sortie;
  }, [occurrences, positionOccurrence, texte, aiguille]);

  // Un calque qui apparaît après coup doit rattraper le défilement en cours.
  useEffect(() => {
    if (zoneTexte.current) surDefilement({ target: zoneTexte.current });
  }, [marquesHtml]);

  function allerOccurrence(index) {
    if (!occurrences.length) return;
    const borne = (index + occurrences.length) % occurrences.length;
    setPositionOccurrence(borne);
    const debut = occurrences[borne];
    const zone = zoneTexte.current;
    if (!zone) return;
    const ligne = (texte.slice(0, debut).match(/\n/g) || []).length;
    zone.scrollTop = Math.max(0, ligne * 18 - zone.clientHeight / 2);
    zone.setSelectionRange(debut, debut + aiguille.length);
    surDefilement({ target: zone });
  }

  function remplacerOccurrence() {
    if (!occurrences.length) return;
    const debut = occurrences[positionOccurrence];
    const zone = zoneTexte.current;
    if (!zone) return;
    // `execCommand` plutôt qu'une réécriture de la valeur : chaque
    // remplacement reste une étape d'annulation (Ctrl+Z) à part entière.
    zone.focus();
    zone.setSelectionRange(debut, debut + aiguille.length);
    document.execCommand('insertText', false, remplacement);
  }

  function remplacerTout() {
    if (!occurrences.length) return;
    const zone = zoneTexte.current;
    if (!zone) return;
    const motif = new RegExp(aiguille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const nouveau = texte.replace(motif, remplacement.replace(/\$/g, '$$$$'));
    zone.focus();
    zone.setSelectionRange(0, texte.length);
    document.execCommand('insertText', false, nouveau);
  }

  useEffect(() => {
    function surRaccourci(evenement) {
      if ((evenement.ctrlKey || evenement.metaKey) && (evenement.key === 'f' || evenement.key === 'h')) {
        evenement.preventDefault();
        evenement.stopPropagation();
        setRecherche({ remplacer: evenement.key === 'h' });
        setTimeout(() => champRecherche.current && champRecherche.current.focus(), 0);
      }
    }
    window.addEventListener('keydown', surRaccourci, true);
    return () => window.removeEventListener('keydown', surRaccourci, true);
  }, []);

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
    } else if (evenement.key === 'Enter') {
      // La nouvelle ligne hérite du retrait de la précédente : dans un .aspx
      // indenté à quatre niveaux, revenir à la marge à chaque Entrée userait
      // n'importe qui.
      evenement.preventDefault();
      const zone = evenement.target;
      const avant = zone.value.slice(0, zone.selectionStart);
      const debutLigne = avant.lastIndexOf('\n') + 1;
      const retrait = (avant.slice(debutLigne).match(/^[ \t]*/) || [''])[0];
      document.execCommand('insertText', false, '\n' + retrait);
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
      else if (recherche) setRecherche(null);
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
        <${EnTeteModale}
          icone=${IconeCrayon}
          surtitre="Sources locales"
          titre="Modifier la version locale"
          onFermer=${demanderFermeture}
        >
          <span class="mono attenue editeur-chemin" title=${fichier.chemin}>${fichier.chemin}</span>
          ${modifie
            ? html`<span class="editeur-etat modifie" title="Des modifications ne sont pas enregistrées">Modifié</span>`
            : html`<span class="editeur-etat" title="Le fichier sur le disque est à jour">Enregistré</span>`}
          ${langue && texte.length > LIMITE_COLORATION_EDITEUR
            ? html`<span class="attenue">Fichier volumineux : coloration coupée.</span>`
            : null}
        <//>

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

        ${etat === 'pret' && recherche
          ? html`
              <div class="editeur-recherche">
                <input
                  type="search"
                  ref=${champRecherche}
                  class="mono"
                  placeholder="Rechercher… (Entrée : suivante, Maj+Entrée : précédente)"
                  value=${aiguille}
                  onInput=${(e) => {
                    setAiguille(e.target.value);
                    setPositionOccurrence(0);
                  }}
                  onKeyDown=${(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      allerOccurrence(positionOccurrence + (e.shiftKey ? -1 : 1));
                    }
                  }}
                />
                <span class="attenue mono">
                  ${occurrences.length ? positionOccurrence + 1 + ' / ' + occurrences.length : 'aucune'}
                </span>
                <button type="button" class="btn btn-mini" disabled=${!occurrences.length} onClick=${() => allerOccurrence(positionOccurrence - 1)}>↑</button>
                <button type="button" class="btn btn-mini" disabled=${!occurrences.length} onClick=${() => allerOccurrence(positionOccurrence + 1)}>↓</button>
                ${recherche.remplacer
                  ? html`
                      <input
                        type="text"
                        class="mono"
                        placeholder="Remplacer par…"
                        value=${remplacement}
                        onInput=${(e) => setRemplacement(e.target.value)}
                        onKeyDown=${(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            remplacerOccurrence();
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="btn btn-mini"
                        disabled=${!occurrences.length}
                        title="Remplace l'occurrence en surbrillance. Chaque remplacement est une étape d'annulation."
                        onClick=${remplacerOccurrence}
                      >
                        Remplacer
                      </button>
                      <button
                        type="button"
                        class="btn btn-mini"
                        disabled=${!occurrences.length}
                        title="Remplace toutes les occurrences d'un coup. Un seul Ctrl+Z ramène tout."
                        onClick=${remplacerTout}
                      >
                        Tout (${formaterNombre(occurrences.length)})
                      </button>
                    `
                  : html`<button type="button" class="btn btn-mini btn-plat" onClick=${() => setRecherche({ remplacer: true })}>
                      Remplacer…
                    </button>`}
                <div style="flex:1"></div>
                <button
                  type="button"
                  class="btn btn-mini btn-plat"
                  title="Fermer la recherche (Échap)"
                  onClick=${() => setRecherche(null)}
                >
                  ✕
                </button>
              </div>
            `
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
                  ${marquesHtml
                    ? html`<pre
                        class="editeur-calque editeur-marques"
                        aria-hidden="true"
                        ref=${calqueMarques}
                        dangerouslySetInnerHTML=${{ __html: marquesHtml + '\n' }}
                      ></pre>`
                    : null}
                  <pre class="editeur-calque" aria-hidden="true" ref=${calque}><code
                    dangerouslySetInnerHTML=${{ __html: (colorie || echapper(texte)) + '\n' }}
                  ></code></pre>
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
