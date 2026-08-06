import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import { formaterDate, formaterNombre, formaterOctets } from './arborescence.js';

const html = htm.bind(h);

const HAUTEUR_LIGNE = 18;
const MAX_LIGNES_AFFICHEES = 6000;

const SIGNES = { identique: ' ', ajout: '+', suppression: '−', modification: '~' };

const LIBELLES_INDENTATION = {
  tabulations: 'tabulations',
  espaces: 'espaces',
  mixte: 'indentation mixte',
  aucune: null
};

function lirePrefs() {
  try {
    return JSON.parse(localStorage.getItem('avmdf.diff')) || {};
  } catch (err) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Rendu des blancs : chaque espace, tabulation ou espace insécable devient un
// glyphe discret. La tabulation s'étale sur quatre colonnes pour conserver
// l'alignement du mode normal (tab-size: 4).
// ---------------------------------------------------------------------------

function glyphes(blancs) {
  let sortie = '';
  for (const caractere of blancs) {
    if (caractere === '\t') sortie += '→   ';
    else if (caractere === ' ') sortie += '⍽';
    else sortie += '·';
  }
  return sortie;
}

const MOTIF_BLANCS = /[ \t\u00a0]+/g;

/** Découpe un texte en morceaux, les suites de blancs rendues en glyphes atténués. */
function rendreBlancs(texte) {
  const morceaux = [];
  let position = 0;
  MOTIF_BLANCS.lastIndex = 0;
  let trouve;
  while ((trouve = MOTIF_BLANCS.exec(texte))) {
    if (trouve.index > position) morceaux.push(texte.slice(position, trouve.index));
    const enFin = trouve.index + trouve[0].length === texte.length;
    morceaux.push(
      html`<span class=${'blanc' + (enFin && trouve.index > 0 ? ' blanc-fin' : '')}>${glyphes(trouve[0])}</span>`
    );
    position = trouve.index + trouve[0].length;
  }
  if (position < texte.length) morceaux.push(texte.slice(position));
  return morceaux.length ? morceaux : ' ';
}

function contenu(cote, espacesVisibles) {
  if (!cote) return '';
  if (!cote.segments) {
    const texte = cote.texte === '' ? ' ' : cote.texte;
    return espacesVisibles ? rendreBlancs(texte) : texte;
  }
  return cote.segments.map((segment) => {
    const texte = espacesVisibles ? rendreBlancs(segment.texte) : segment.texte;
    return segment.change ? html`<span class="fragment">${texte}</span>` : texte;
  });
}

// ---------------------------------------------------------------------------

/**
 * Panneau droit : comparaison ligne à ligne.
 * Production à gauche - l'existant ; local à droite - ce qui va partir.
 *
 * La précision sur les blancs est un point d'honneur : les lignes qui ne
 * diffèrent que par les espaces sont signalées, et un mode d'affichage rend
 * chaque espace, tabulation et espace insécable visible.
 */
export function VueDiff({ diff, onOuvrirExterne, onNotifier, onVoirVersions }) {
  const prefs = useMemo(lirePrefs, []);
  const [unifie, setUnifie] = useState(() => Boolean(prefs.unifie));
  const [synchronise, setSynchronise] = useState(() => prefs.synchronise !== false);
  const [espacesVisibles, setEspacesVisibles] = useState(() => Boolean(prefs.espaces));
  const [replisOuverts, setReplisOuverts] = useState(() => new Set());
  const [recherche, setRecherche] = useState('');
  const [rechercheVisible, setRechercheVisible] = useState(false);
  const [positionTrouvee, setPositionTrouvee] = useState(0);
  const [changementCourant, setChangementCourant] = useState(-1);

  const panneauGauche = useRef(null);
  const panneauDroit = useRef(null);
  const champRecherche = useRef(null);
  const enSynchronisation = useRef(false);

  const donnees = diff.donnees;

  useEffect(() => {
    try {
      localStorage.setItem(
        'avmdf.diff',
        JSON.stringify({ unifie, synchronise, espaces: espacesVisibles })
      );
    } catch (err) {
      /* stockage local indisponible : les préférences ne survivront pas */
    }
  }, [unifie, synchronise, espacesVisibles]);

  useEffect(() => {
    setReplisOuverts(new Set());
    setChangementCourant(-1);
    setPositionTrouvee(0);
  }, [donnees && donnees.cle]);

  // Lignes réellement affichées, replis dépliés compris.
  const rangs = useMemo(() => {
    if (!donnees || donnees.type !== 'texte') return [];
    const sortie = [];
    donnees.groupes.forEach((groupe, index) => {
      if (groupe.type === 'repli' && !replisOuverts.has(index)) {
        sortie.push({ genre: 'repli', groupe, index });
        return;
      }
      for (const ligne of groupe.lignes) sortie.push({ genre: 'ligne', ligne });
    });
    return sortie;
  }, [donnees, replisOuverts]);

  const tronque = rangs.length > MAX_LIGNES_AFFICHEES;
  const rangsAffiches = tronque ? rangs.slice(0, MAX_LIGNES_AFFICHEES) : rangs;

  const changements = useMemo(
    () =>
      rangsAffiches
        .map((rang, index) => (rang.genre === 'ligne' && rang.ligne.type !== 'identique' ? index : -1))
        .filter((index) => index >= 0),
    [rangsAffiches]
  );

  const trouvees = useMemo(() => {
    const requete = recherche.trim().toLowerCase();
    if (!requete) return [];
    return rangsAffiches
      .map((rang, index) => {
        if (rang.genre !== 'ligne') return -1;
        const gauche = rang.ligne.gauche ? rang.ligne.gauche.texte.toLowerCase() : '';
        const droite = rang.ligne.droite ? rang.ligne.droite.texte.toLowerCase() : '';
        return gauche.includes(requete) || droite.includes(requete) ? index : -1;
      })
      .filter((index) => index >= 0);
  }, [rangsAffiches, recherche]);

  function allerA(index) {
    const haut = Math.max(0, index * HAUTEUR_LIGNE - 80);
    for (const panneau of [panneauGauche.current, panneauDroit.current]) {
      if (panneau) panneau.scrollTop = haut;
    }
  }

  function changementSuivant(sens) {
    if (!changements.length) return;
    let position = changements.findIndex((index) => index > changementCourant);
    if (sens < 0) {
      const precedents = changements.filter((index) => index < changementCourant);
      position = precedents.length ? changements.indexOf(precedents[precedents.length - 1]) : changements.length - 1;
    } else if (position === -1) {
      position = 0;
    }
    const cible = changements[position];
    setChangementCourant(cible);
    allerA(cible);
  }

  function trouveeSuivante(sens) {
    if (!trouvees.length) return;
    const suivante = (positionTrouvee + sens + trouvees.length) % trouvees.length;
    setPositionTrouvee(suivante);
    allerA(trouvees[suivante]);
  }

  // Raccourcis : F8 / Maj+F8 pour les changements, Ctrl+F pour la recherche.
  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key === 'F8') {
        evenement.preventDefault();
        changementSuivant(evenement.shiftKey ? -1 : 1);
      } else if (evenement.key === 'f' && (evenement.ctrlKey || evenement.metaKey)) {
        evenement.preventDefault();
        setRechercheVisible(true);
        setTimeout(() => champRecherche.current && champRecherche.current.focus(), 0);
      } else if (evenement.key === 'Escape' && rechercheVisible) {
        setRechercheVisible(false);
        setRecherche('');
      }
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  function surDefilement(autre) {
    return (evenement) => {
      if (!synchronise || unifie) return;
      if (enSynchronisation.current) {
        enSynchronisation.current = false;
        return;
      }
      const cible = autre.current;
      if (!cible || cible.scrollTop === evenement.target.scrollTop) return;
      enSynchronisation.current = true;
      cible.scrollTop = evenement.target.scrollTop;
    };
  }

  function basculerRepli(index) {
    const suivants = new Set(replisOuverts);
    if (suivants.has(index)) suivants.delete(index);
    else suivants.add(index);
    setReplisOuverts(suivants);
  }

  // --- États autres que « texte » -------------------------------------------

  if (diff.etat === 'vide') {
    return html`
      <div class="panneau panneau-droit">
        <div class="panneau-entete"><span>Comparaison</span></div>
        <div class="panneau-contenu">
          <div class="etat-vide">
            <div class="etat-vide-titre">Aucun fichier sélectionné</div>
            <div class="etat-vide-texte">
              La comparaison affiche la production à gauche et vos sources locales à droite.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (diff.etat === 'chargement') {
    return html`
      <div class="panneau panneau-droit">
        <div class="panneau-entete"><span>Comparaison</span></div>
        <div class="panneau-contenu">
          <div class="etat-vide"><div class="attenue">Lecture des deux versions…</div></div>
        </div>
      </div>
    `;
  }

  if (diff.etat === 'erreur') {
    return html`
      <div class="panneau panneau-droit">
        <div class="panneau-entete"><span>Comparaison</span></div>
        <div class="panneau-contenu">
          <div class="etat-vide">
            <div class="encart encart-danger" style="max-width:600px;text-align:left">
              <strong>${diff.erreur.message}</strong>
              ${diff.erreur.conseil ? html`<div style="margin-top:6px">${diff.erreur.conseil}</div>` : null}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const titreGauche = donnees.titreGauche || 'Production';
  const titreDroite = donnees.titreDroite || 'Local';
  const texteDiff = donnees.type === 'texte';
  const modifsEspaces = texteDiff ? donnees.compteurs.modificationsEspaces || 0 : 0;

  const sousTitre = (cote) => {
    if (!cote) return html`<span class="attenue">absent</span>`;
    const indentation = LIBELLES_INDENTATION[cote.indentation];
    return html`<span class="attenue mono">
      ${cote.encodage} · ${cote.finDeLigne}${indentation ? ' · ' + indentation : ''}
    </span>`;
  };

  return html`
    <div class="panneau panneau-droit">
      <div class="diff-entete">
        <span class="mono diff-chemin" title=${donnees.chemin}>${donnees.chemin}</span>
        ${texteDiff
          ? html`<span class="diff-compteurs mono">
              <span class="plus">+${formaterNombre(donnees.compteurs.ajoutees)}</span>
              <span class="moins">−${formaterNombre(donnees.compteurs.supprimees)}</span>
            </span>`
          : null}
        <div style="flex:1"></div>
        ${onVoirVersions
          ? html`<button
              type="button"
              class="btn btn-mini"
              title="Versions « avant modification » archivées de ce fichier"
              onClick=${onVoirVersions}
            >
              Versions archivées
            </button>`
          : null}
        ${texteDiff
          ? html`
              <button
                type="button"
                class=${'btn btn-mini' + (espacesVisibles ? ' btn-marque' : '')}
                title="Rendre visibles les espaces (·), tabulations (→) et espaces insécables (⍽)"
                aria-pressed=${espacesVisibles}
                onClick=${() => setEspacesVisibles(!espacesVisibles)}
              >
                ¶ Espaces
              </button>
              <button
                type="button"
                class="btn btn-mini"
                title="Changement précédent (Maj+F8) / suivant (F8)"
                disabled=${!changements.length}
                onClick=${() => changementSuivant(1)}
              >
                Changement suivant (F8)
              </button>
              <label class="case" title="Aligner le défilement des deux panneaux">
                <input type="checkbox" checked=${synchronise} onChange=${(e) => setSynchronise(e.target.checked)} />
                <span>Défilement lié</span>
              </label>
              <button type="button" class="btn btn-mini" onClick=${() => setUnifie(!unifie)}>
                ${unifie ? 'Côte à côte' : 'Unifié'}
              </button>
            `
          : null}
      </div>

      ${texteDiff && (donnees.ecartEncodage || donnees.ecartFinDeLigne || donnees.ecartIndentation || modifsEspaces)
        ? html`
            <div class="diff-alerte">
              ${donnees.ecartEncodage
                ? html`<span>Encodages différents : ${donnees.gauche.encodage} en production, ${donnees.droite.encodage} en local.</span>`
                : null}
              ${donnees.ecartFinDeLigne
                ? html`<span>Fins de ligne différentes : ${donnees.gauche.finDeLigne} / ${donnees.droite.finDeLigne}.</span>`
                : null}
              ${donnees.ecartIndentation
                ? html`<span>
                    ${'Indentation différente : ' +
                    LIBELLES_INDENTATION[donnees.gauche.indentation] +
                    ' en production, ' +
                    LIBELLES_INDENTATION[donnees.droite.indentation] +
                    ' en local.'}
                  </span>`
                : null}
              ${modifsEspaces
                ? html`<span>
                    ${modifsEspaces > 1
                      ? formaterNombre(modifsEspaces) + ' lignes ne diffèrent que par les blancs (marquées ␣).'
                      : '1 ligne ne diffère que par les blancs (marquée ␣).'}
                    ${!espacesVisibles
                      ? html`<button type="button" class="btn btn-mini" onClick=${() => setEspacesVisibles(true)}>
                          Afficher les espaces
                        </button>`
                      : null}
                  </span>`
                : null}
              <span class="attenue">La copie reste binaire : rien n'est ré-encodé.</span>
            </div>
          `
        : null}

      ${rechercheVisible
        ? html`
            <div class="diff-recherche">
              <input
                type="search"
                ref=${champRecherche}
                class="mono"
                placeholder="Chercher dans la comparaison affichée…"
                value=${recherche}
                onInput=${(e) => {
                  setRecherche(e.target.value);
                  setPositionTrouvee(0);
                }}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    trouveeSuivante(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span class="attenue mono">
                ${trouvees.length ? `${positionTrouvee + 1} / ${trouvees.length}` : 'aucune'}
              </span>
              <button type="button" class="btn btn-mini" disabled=${!trouvees.length} onClick=${() => trouveeSuivante(-1)}>↑</button>
              <button type="button" class="btn btn-mini" disabled=${!trouvees.length} onClick=${() => trouveeSuivante(1)}>↓</button>
              <button
                type="button"
                class="btn btn-mini btn-plat"
                onClick=${() => {
                  setRechercheVisible(false);
                  setRecherche('');
                }}
              >
                ✕
              </button>
            </div>
          `
        : null}

      ${donnees.type === 'binaire'
        ? html`<${VueBinaire} donnees=${donnees} onOuvrirExterne=${onOuvrirExterne} />`
        : donnees.type === 'volumineux'
          ? html`
              <div class="panneau-contenu">
                <div class="etat-vide">
                  <div class="etat-vide-titre">Fichier trop volumineux pour être comparé ici</div>
                  <div class="etat-vide-texte">
                    ${formaterOctets(donnees.taille)} - au-delà de ${formaterOctets(donnees.limite)}, l'affichage
                    ligne à ligne n'est plus lisible.
                  </div>
                  <div style="display:flex;gap:6px">
                    <button type="button" class="btn" onClick=${() => onOuvrirExterne('prod')}>
                      Ouvrir la version production
                    </button>
                    <button type="button" class="btn" onClick=${() => onOuvrirExterne('local')}>
                      Ouvrir la version locale
                    </button>
                  </div>
                </div>
              </div>
            `
          : donnees.type === 'vide'
            ? html`<div class="panneau-contenu">
                <div class="etat-vide"><div class="attenue">Ce fichier n'existe d'aucun côté.</div></div>
              </div>`
            : html`
                <div class=${'diff' + (unifie ? ' diff-unifie' : '')}>
                  ${unifie
                    ? html`
                        <div class="diff-colonne">
                          <div class="diff-titre">
                            <span>${titreGauche} → ${titreDroite}</span>
                            ${sousTitre(donnees.gauche)}
                          </div>
                          <div class="diff-lignes" ref=${panneauGauche}>
                            ${rangsAffiches.map(
                              (rang, index) =>
                                rang.genre === 'repli'
                                  ? html`<${Repli} key=${'r' + index} rang=${rang} onOuvrir=${basculerRepli} />`
                                  : html`<${LignesUnifiees}
                                      key=${'u' + index}
                                      ligne=${rang.ligne}
                                      espaces=${espacesVisibles}
                                      surligne=${trouvees[positionTrouvee] === index}
                                      courante=${changementCourant === index}
                                    />`
                            )}
                          </div>
                        </div>
                      `
                    : html`
                        <div class="diff-colonne">
                          <div class="diff-titre">
                            <span>${titreGauche}</span>
                            ${sousTitre(donnees.gauche)}
                          </div>
                          <div class="diff-lignes" ref=${panneauGauche} onScroll=${surDefilement(panneauDroit)}>
                            ${rangsAffiches.map(
                              (rang, index) =>
                                rang.genre === 'repli'
                                  ? html`<${Repli} key=${'rg' + index} rang=${rang} onOuvrir=${basculerRepli} />`
                                  : html`<${LigneCote}
                                      key=${'g' + index}
                                      cote=${rang.ligne.gauche}
                                      type=${rang.ligne.type}
                                      espaces=${espacesVisibles}
                                      espacesSeuls=${rang.ligne.espacesUniquement}
                                      surligne=${trouvees[positionTrouvee] === index}
                                      courante=${changementCourant === index}
                                    />`
                            )}
                          </div>
                        </div>

                        <div class="diff-colonne">
                          <div class="diff-titre">
                            <span>${titreDroite}</span>
                            ${sousTitre(donnees.droite)}
                          </div>
                          <div class="diff-lignes" ref=${panneauDroit} onScroll=${surDefilement(panneauGauche)}>
                            ${rangsAffiches.map(
                              (rang, index) =>
                                rang.genre === 'repli'
                                  ? html`<${Repli} key=${'rd' + index} rang=${rang} onOuvrir=${basculerRepli} />`
                                  : html`<${LigneCote}
                                      key=${'d' + index}
                                      cote=${rang.ligne.droite}
                                      type=${rang.ligne.type}
                                      espaces=${espacesVisibles}
                                      espacesSeuls=${rang.ligne.espacesUniquement}
                                      surligne=${trouvees[positionTrouvee] === index}
                                      courante=${changementCourant === index}
                                    />`
                            )}
                          </div>
                        </div>
                      `}
                </div>
                ${tronque
                  ? html`<div class="diff-pied">
                      Affichage limité aux ${formaterNombre(MAX_LIGNES_AFFICHEES)} premières lignes.
                      <button type="button" class="btn btn-mini" onClick=${() => onOuvrirExterne('local')}>
                        Ouvrir dans l'éditeur
                      </button>
                    </div>`
                  : null}
                ${donnees.surlignageOmis
                  ? html`<div class="diff-pied attenue">
                      Trop de lignes modifiées : le surlignage mot à mot est désactivé sur ce fichier.
                    </div>`
                  : null}
              `}
    </div>
  `;
}

// ---------------------------------------------------------------------------

function Repli({ rang, onOuvrir }) {
  return html`
    <button type="button" class="diff-repli" onClick=${() => onOuvrir(rang.index)}>
      ⋯ ${formaterNombre(rang.groupe.nombre)} lignes identiques
    </button>
  `;
}

function LigneCote({ cote, type, espaces, espacesSeuls, surligne, courante }) {
  // Une ligne absente d'un côté garde sa place, pour que les deux panneaux
  // restent alignés.
  const vide = !cote;
  const classes = ['diff-ligne', 'diff-' + (vide ? 'absente' : type)];
  if (surligne) classes.push('trouvee');
  if (courante) classes.push('courante');
  if (espacesSeuls) classes.push('espaces-seuls');

  const signe = vide ? '' : espacesSeuls && type === 'modification' ? '␣' : SIGNES[type];

  return html`
    <div class=${classes.join(' ')}>
      <span class="diff-numero">${vide ? '' : cote.numero}</span>
      <span
        class="diff-signe"
        title=${espacesSeuls ? 'Seuls les blancs changent sur cette ligne' : ''}
      >
        ${signe}
      </span>
      <span class="diff-texte">${vide ? '' : contenu(cote, espaces)}</span>
    </div>
  `;
}

function LignesUnifiees({ ligne, espaces, surligne, courante }) {
  if (ligne.type === 'modification') {
    return html`
      <div>
        <${LigneCote}
          cote=${ligne.gauche}
          type="suppression"
          espaces=${espaces}
          espacesSeuls=${ligne.espacesUniquement}
          surligne=${surligne}
          courante=${courante}
        />
        <${LigneCote}
          cote=${ligne.droite}
          type="ajout"
          espaces=${espaces}
          espacesSeuls=${ligne.espacesUniquement}
          surligne=${surligne}
          courante=${courante}
        />
      </div>
    `;
  }
  const cote = ligne.droite || ligne.gauche;
  return html`<${LigneCote}
    cote=${cote}
    type=${ligne.type}
    espaces=${espaces}
    surligne=${surligne}
    courante=${courante}
  />`;
}

function VueBinaire({ donnees, onOuvrirExterne }) {
  const ligne = (libelle, gauche, droite) => html`
    <tr>
      <th>${libelle}</th>
      <td class="mono">${gauche}</td>
      <td class="mono">${droite}</td>
    </tr>
  `;

  return html`
    <div class="panneau-contenu">
      <div class="binaire">
        <p class="attenue">
          Fichier binaire : pas de comparaison ligne à ligne. Voici de quoi trancher.
        </p>
        <table class="tableau">
          <thead>
            <tr>
              <th></th>
              <th>Production</th>
              <th>Local</th>
            </tr>
          </thead>
          <tbody>
            ${ligne('Taille', donnees.prod ? formaterOctets(donnees.prod.taille) : '-', donnees.local ? formaterOctets(donnees.local.taille) : '-')}
            ${ligne('Date', donnees.prod ? formaterDate(donnees.prod.mtimeMs) : '-', donnees.local ? formaterDate(donnees.local.mtimeMs) : '-')}
            ${ligne('SHA-256', donnees.hashProd || '-', donnees.hashLocal || '-')}
          </tbody>
        </table>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button type="button" class="btn" disabled=${!donnees.prod} onClick=${() => onOuvrirExterne('prod')}>
            Ouvrir la version production
          </button>
          <button type="button" class="btn" disabled=${!donnees.local} onClick=${() => onOuvrirExterne('local')}>
            Ouvrir la version locale
          </button>
        </div>
      </div>
    </div>
  `;
}
