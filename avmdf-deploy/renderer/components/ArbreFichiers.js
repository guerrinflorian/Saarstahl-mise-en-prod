import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import { BarreFiltres } from './BarreFiltres.js';
import { IconeDossier, IconeFichier } from './icones.js';
import {
  MARQUEURS,
  LIBELLES,
  STATUTS,
  aplatir,
  estDeployable,
  etatSelection,
  fichiersDe,
  formaterNombre
} from './arborescence.js';

const html = htm.bind(h);

const HAUTEUR_LIGNE = 24;
const MARGE = 10;
const PAS_INDENTATION = 13;

/**
 * Panneau gauche : recherche, filtres, arborescence pliable et éléments ignorés.
 *
 * L'arbre est rendu par fenêtre glissante - seules les lignes visibles existent
 * dans le DOM - pour rester fluide bien au-delà de 5 000 fichiers.
 */
export function ArbreFichiers({
  analyse,
  cheminLocal,
  cheminProd,
  criteres,
  onCriteres,
  onReinitialiser,
  arbre,
  compteurs,
  extensions,
  dossiers,
  nombreAffiches,
  nombreTotal,
  nombreSelection,
  onCocherAffiches,
  onDecocherTout,
  nombreMasques,
  onRetablirMasques,
  rechercheContenu,
  ouverts,
  onOuverts,
  selection,
  onSelection,
  natureSelection,
  fichierActif,
  onChoisir,
  ignores,
  onAction,
  onAnalyser,
  onAnnuler
}) {
  const conteneur = useRef(null);
  const [defilement, setDefilement] = useState(0);
  const [hauteur, setHauteur] = useState(500);
  const [curseur, setCurseur] = useState(0);
  const [menu, setMenu] = useState(null);
  const [ignoresOuverts, setIgnoresOuverts] = useState(false);

  const lignes = useMemo(() => aplatir(arbre, ouverts), [arbre, ouverts]);

  useEffect(() => {
    const element = conteneur.current;
    if (!element) return undefined;
    const observateur = new ResizeObserver(() => setHauteur(element.clientHeight));
    observateur.observe(element);
    setHauteur(element.clientHeight);
    return () => observateur.disconnect();
  }, [arbre]);

  // Le curseur suit le fichier ouvert dans la comparaison.
  useLayoutEffect(() => {
    if (!fichierActif) return;
    const index = lignes.findIndex((ligne) => ligne.noeud.cle === fichierActif);
    if (index >= 0 && index !== curseur) setCurseur(index);
  }, [fichierActif, lignes]);

  function faireDefilerVers(index) {
    const element = conteneur.current;
    if (!element) return;
    const haut = index * HAUTEUR_LIGNE;
    const bas = haut + HAUTEUR_LIGNE;
    if (haut < element.scrollTop) element.scrollTop = haut;
    else if (bas > element.scrollTop + element.clientHeight) {
      element.scrollTop = bas - element.clientHeight;
    }
  }

  function basculerDossier(cle) {
    const suivants = new Set(ouverts);
    if (suivants.has(cle)) suivants.delete(cle);
    else suivants.add(cle);
    onOuverts(suivants);
  }

  function basculerFichier(fichier) {
    if (!estDeployable(fichier) && fichier.statut !== 'orphelin') return;
    const suivante = new Set(selection);
    if (suivante.has(fichier.cle)) suivante.delete(fichier.cle);
    else suivante.add(fichier.cle);
    onSelection(suivante);
  }

  /**
   * Cocher un dossier coche ses descendants - mais jamais de façon à mélanger
   * une mise en production et une suppression d'orphelins, qui sont deux
   * opérations distinctes. La nature déjà engagée par la sélection l'emporte ;
   * à sélection vide, on prend les fichiers à déployer, et les orphelins
   * seulement si la branche n'a que ça.
   */
  function basculerBranche(noeud) {
    const visibles = fichiersDe(noeud);
    const deployables = visibles.filter(estDeployable);
    const orphelins = visibles.filter((f) => f.statut === 'orphelin');

    let candidats;
    if (natureSelection === 'suppression') candidats = orphelins;
    else if (natureSelection === 'deploiement') candidats = deployables;
    else candidats = deployables.length ? deployables : orphelins;

    if (!candidats.length) return;
    const tousCoches = candidats.every((fichier) => selection.has(fichier.cle));
    const suivante = new Set(selection);
    for (const fichier of candidats) {
      if (tousCoches) suivante.delete(fichier.cle);
      else suivante.add(fichier.cle);
    }
    onSelection(suivante);
  }

  function surTouche(evenement) {
    if (!lignes.length) return;
    const ligne = lignes[curseur];
    switch (evenement.key) {
      case 'ArrowDown': {
        evenement.preventDefault();
        const suivant = Math.min(lignes.length - 1, curseur + 1);
        setCurseur(suivant);
        faireDefilerVers(suivant);
        break;
      }
      case 'ArrowUp': {
        evenement.preventDefault();
        const precedent = Math.max(0, curseur - 1);
        setCurseur(precedent);
        faireDefilerVers(precedent);
        break;
      }
      case 'ArrowRight':
        if (ligne && ligne.noeud.type === 'dossier' && !ouverts.has(ligne.noeud.cle)) {
          evenement.preventDefault();
          basculerDossier(ligne.noeud.cle);
        }
        break;
      case 'ArrowLeft':
        if (ligne && ligne.noeud.type === 'dossier' && ouverts.has(ligne.noeud.cle)) {
          evenement.preventDefault();
          basculerDossier(ligne.noeud.cle);
        }
        break;
      case ' ':
        evenement.preventDefault();
        if (!ligne) break;
        if (ligne.noeud.type === 'dossier') basculerBranche(ligne.noeud);
        else basculerFichier(ligne.noeud);
        break;
      case 'Enter':
        evenement.preventDefault();
        if (ligne && ligne.noeud.type === 'fichier') onChoisir(ligne.noeud);
        else if (ligne) basculerDossier(ligne.noeud.cle);
        break;
      default:
        break;
    }
  }

  const debut = Math.max(0, Math.floor(defilement / HAUTEUR_LIGNE) - MARGE);
  const fin = Math.min(lignes.length, Math.ceil((defilement + hauteur) / HAUTEUR_LIGNE) + MARGE);
  const visibles = lignes.slice(debut, fin);

  const enCours = analyse.etat === 'encours';
  const correspondance = analyse.resultat ? analyse.resultat.correspondance : null;

  return html`
    <div class="panneau panneau-gauche">
      <div class="panneau-entete">
        <span>Fichiers</span>
        <div style="flex:1"></div>
        ${analyse.resultat
          ? html`<span class="attenue mono" title="Durée de la dernière analyse">
              ${formaterNombre(analyse.resultat.fichiers.length)} fichiers ·
              ${(analyse.resultat.duree / 1000).toFixed(1)} s
            </span>`
          : null}
      </div>

      ${enCours ? html`<${Progression} progression=${analyse.progression} onAnnuler=${onAnnuler} />` : null}

      ${correspondance && correspondance.niveau !== 'ok'
        ? html`
            <div class="panneau-encart">
              <div class=${'encart ' + (correspondance.niveau === 'alerte' ? 'encart-danger' : 'encart-alerte')}>
                <strong>${correspondance.titre}</strong>
                <div>${correspondance.texte}</div>
              </div>
            </div>
          `
        : null}

      ${analyse.resultat
        ? html`
            <${BarreFiltres}
              criteres=${criteres}
              onCriteres=${onCriteres}
              onReinitialiser=${onReinitialiser}
              compteurs=${compteurs}
              extensions=${extensions}
              dossiers=${dossiers}
              nombreAffiches=${nombreAffiches}
              nombreTotal=${nombreTotal}
              nombreSelection=${nombreSelection}
              onCocherAffiches=${onCocherAffiches}
              onDecocherTout=${onDecocherTout}
              nombreMasques=${nombreMasques}
              onRetablirMasques=${onRetablirMasques}
              rechercheContenu=${rechercheContenu}
              onToutDeplier=${() => onOuverts('tout')}
              onToutReplier=${() => onOuverts(new Set())}
            />
          `
        : null}

      <div
        class="arbre"
        ref=${conteneur}
        tabindex="0"
        role="tree"
        aria-label="Écarts entre le local et la production"
        onScroll=${(e) => setDefilement(e.target.scrollTop)}
        onKeyDown=${surTouche}
      >
        ${!analyse.resultat && !enCours
          ? html`
              <div class="etat-vide">
                <div class="etat-vide-titre">
                  ${analyse.acces ? 'Analyse impossible' : 'Aucune analyse effectuée'}
                </div>
                <div class="etat-vide-texte">
                  ${analyse.acces
                    ? 'Un des deux dossiers ne se laisse pas lire. Rien n\'a été comparé : une analyse à moitié faite montrerait des écarts qui n\'existent pas.'
                    : 'L\'analyse compare récursivement, à profondeur illimitée :'}
                </div>
                ${analyse.acces
                  ? html`<${EtatAcces} acces=${analyse.acces} />`
                  : html`
                      <div class="mono etat-vide-texte" style="text-align:left">
                        <div>${cheminLocal || '-'}</div>
                        <div>${cheminProd || '-'}</div>
                      </div>
                    `}
                <button type="button" class="btn" disabled=${!cheminLocal || !cheminProd} onClick=${onAnalyser}>
                  ${analyse.acces ? 'Réessayer (F5)' : 'Analyser (F5)'}
                </button>
              </div>
            `
          : null}

        ${analyse.resultat && !lignes.length
          ? html`
              <div class="etat-vide">
                <div class="etat-vide-titre">
                  ${nombreTotal === 0
                    ? 'Aucun écart détecté entre local et prod.'
                    : 'Aucun fichier ne correspond aux filtres.'}
                </div>
                <div class="etat-vide-texte">
                  ${nombreTotal === 0
                    ? 'Les deux arborescences sont identiques, aux exclusions près.'
                    : `${formaterNombre(nombreTotal)} fichiers sont masqués par les filtres en cours.`}
                </div>
                ${nombreTotal > 0
                  ? html`<button type="button" class="btn" onClick=${onReinitialiser}>Réinitialiser les filtres</button>`
                  : null}
              </div>
            `
          : null}

        ${lignes.length
          ? html`
              <div class="arbre-piste" style=${`height:${lignes.length * HAUTEUR_LIGNE}px`}>
                ${visibles.map(
                  (ligne, position) => html`
                    <${Ligne}
                      key=${ligne.noeud.cle + ':' + ligne.noeud.type}
                      ligne=${ligne}
                      haut=${(debut + position) * HAUTEUR_LIGNE}
                      ouvert=${ouverts.has(ligne.noeud.cle)}
                      actif=${ligne.noeud.cle === fichierActif}
                      curseur=${debut + position === curseur}
                      selection=${selection}
                      onBasculerDossier=${basculerDossier}
                      onBasculerFichier=${basculerFichier}
                      onBasculerBranche=${basculerBranche}
                      onChoisir=${onChoisir}
                      onCurseur=${() => setCurseur(debut + position)}
                      onMenu=${(evenement, noeud) => {
                        evenement.preventDefault();
                        setMenu({ x: evenement.clientX, y: evenement.clientY, noeud });
                      }}
                    />
                  `
                )}
              </div>
            `
          : null}
      </div>

      ${ignores && ignores.length
        ? html`
            <div class="ignores">
              <button
                type="button"
                class="ignores-entete"
                aria-expanded=${ignoresOuverts}
                onClick=${() => setIgnoresOuverts(!ignoresOuverts)}
              >
                <span class="chevron">${ignoresOuverts ? '▾' : '▸'}</span>
                <span>Éléments ignorés</span>
                <span class="pastille">${formaterNombre(ignores.length)}</span>
              </button>
              ${ignoresOuverts
                ? html`
                    <div class="ignores-liste">
                      ${ignores.slice(0, 500).map(
                        (element, index) => html`
                          <div class="ignore" key=${index}>
                            <span class="mono">${element.chemin}</span>
                            <span class="attenue">${element.cote} · ${element.raison}</span>
                          </div>
                        `
                      )}
                      ${ignores.length > 500
                        ? html`<div class="attenue" style="padding:4px 8px">
                            … et ${formaterNombre(ignores.length - 500)} autres.
                          </div>`
                        : null}
                    </div>
                  `
                : null}
            </div>
          `
        : null}

      ${menu
        ? html`<${MenuContextuel}
            menu=${menu}
            onFermer=${() => setMenu(null)}
            onAction=${(action) => {
              onAction(action, menu.noeud);
              setMenu(null);
            }}
          />`
        : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------

function Progression({ progression, onAnnuler }) {
  const avancement = progression || {};
  const pourcentage =
    avancement.total && avancement.total > 0
      ? Math.min(100, Math.round(((avancement.faits || avancement.fichiers || 0) / avancement.total) * 100))
      : null;

  return html`
    <div class="progression">
      <div class="progression-ligne">
        <span>${avancement.libelle || 'Analyse en cours'}</span>
        <span class="mono attenue">
          ${avancement.total
            ? `${formaterNombre(avancement.faits || avancement.fichiers || 0)} / ${formaterNombre(avancement.total)}`
            : formaterNombre(avancement.fichiers || 0) + ' fichiers'}
        </span>
        <div style="flex:1"></div>
        <button type="button" class="btn btn-mini" onClick=${onAnnuler}>Annuler</button>
      </div>
      <div class="jauge">
        <div
          class=${'jauge-remplissage' + (pourcentage === null ? ' indetermine' : '')}
          style=${pourcentage === null ? '' : `width:${pourcentage}%`}
        ></div>
      </div>
    </div>
  `;
}

/**
 * État des deux racines après un refus d'analyse : les deux côtés sont
 * toujours montrés, celui qui va comme celui qui bloque. Savoir que le local
 * répond bien fait autant avancer que de savoir que la production refuse.
 */
function EtatAcces({ acces }) {
  return html`
    <div class="acces">
      ${acces.cotes.map(
        (cote) => html`
          <div class=${'acces-cote' + (cote.ok ? '' : ' en-echec')} key=${cote.role}>
            <span class="acces-marque" aria-hidden="true">${cote.ok ? '✓' : '✕'}</span>
            <div class="acces-corps">
              <div class="acces-titre">${cote.titre || cote.libelle}</div>
              <div class="mono acces-chemin">${cote.chemin || '(non renseigné)'}</div>
              ${cote.ok
                ? html`<div class="acces-raison">Lisible.</div>`
                : html`<div class="acces-raison">Il ${cote.probleme}. ${cote.conseil}</div>`}
            </div>
          </div>
        `
      )}
    </div>
  `;
}

function Ligne({
  ligne,
  haut,
  ouvert,
  actif,
  curseur,
  selection,
  onBasculerDossier,
  onBasculerFichier,
  onBasculerBranche,
  onChoisir,
  onCurseur,
  onMenu
}) {
  const { noeud, profondeur } = ligne;
  const estDossier = noeud.type === 'dossier';
  const etat = estDossier ? etatSelection(noeud, selection) : null;
  const coche = estDossier ? etat === 'complet' : selection.has(noeud.cle);
  const cochable = estDossier ? etat !== 'vide' || fichiersDe(noeud).some(estDeployable) : true;

  const classes = ['ligne'];
  if (estDossier) classes.push('ligne-dossier');
  if (actif) classes.push('actif');
  if (curseur) classes.push('curseur');
  if (noeud.statut) classes.push('statut-' + noeud.statut);

  return html`
    <div
      class=${classes.join(' ')}
      style=${`top:${haut}px`}
      role="treeitem"
      aria-expanded=${estDossier ? ouvert : undefined}
      aria-selected=${actif}
      title=${noeud.chemin}
      onMouseDown=${onCurseur}
      onClick=${() => (estDossier ? onBasculerDossier(noeud.cle) : onChoisir(noeud))}
      onContextMenu=${(evenement) => onMenu(evenement, noeud)}
    >
      ${profondeur
        ? html`<span class="ligne-indent" style=${`width:${profondeur * PAS_INDENTATION}px`}></span>`
        : null}

      <input
        type="checkbox"
        class="ligne-case"
        checked=${coche}
        disabled=${!cochable}
        aria-label=${'Sélectionner ' + noeud.chemin}
        ref=${(element) => {
          if (element) element.indeterminate = etat === 'partiel';
        }}
        onClick=${(evenement) => evenement.stopPropagation()}
        onChange=${() => (estDossier ? onBasculerBranche(noeud) : onBasculerFichier(noeud))}
      />

      <span class=${'chevron' + (estDossier ? '' : ' chevron-vide')}>
        ${estDossier ? (ouvert ? '▾' : '▸') : ''}
      </span>

      ${estDossier
        ? html`<${IconeDossier} ouvert=${ouvert} classe="icone-dossier" />`
        : html`<${IconeFichier} extension=${noeud.extension || noeud.nom} />`}

      <span class=${'ligne-nom' + (estDossier ? ' dossier' : '')}>${noeud.nom}</span>

      ${estDossier
        ? html`<span class="ligne-compteurs">
            ${STATUTS.filter((statut) => noeud.compteurs[statut] > 0).map(
              (statut) => html`
                <span class=${'compteur compteur-' + statut} key=${statut} title=${LIBELLES[statut]}>
                  ${MARQUEURS[statut]}${formaterNombre(noeud.compteurs[statut])}
                </span>
              `
            )}
          </span>`
        : html`<span
            class=${'ligne-statut marqueur marqueur-' + noeud.statut}
            title=${'Fichier ' + LIBELLES[noeud.statut]}
          >
            ${MARQUEURS[noeud.statut]}
          </span>`}
    </div>
  `;
}

/**
 * Les deux côtés sont toujours proposés, chacun le sien : un fichier modifié
 * existe des deux, et on veut aller voir l'un ou l'autre. Celui qui n'existe
 * pas est grisé plutôt qu'absent, pour que le statut se lise là aussi.
 */
function entreesFichier(fichier) {
  return [
    {
      action: 'modifier',
      libelle: 'Modifier la version locale',
      titre: 'Ouvre l\'éditeur intégré. L\'encodage et les fins de ligne du fichier sont conservés.',
      actif: Boolean(fichier.local)
    },
    { action: 'ouvrirLocal', libelle: 'Ouvrir la version locale', actif: Boolean(fichier.local) },
    { action: 'ouvrirProd', libelle: 'Ouvrir la version production', actif: Boolean(fichier.prod) },
    { separateur: true },
    {
      action: 'revelerLocal',
      libelle: "Afficher le local dans l'explorateur",
      actif: Boolean(fichier.local)
    },
    {
      action: 'revelerProd',
      libelle: "Afficher la production dans l'explorateur",
      actif: Boolean(fichier.prod)
    },
    { separateur: true },
    {
      action: 'rafraichir',
      libelle: 'Réanalyser ce fichier',
      titre:
        'Relit la taille et l\'empreinte de ce seul fichier, des deux côtés, sans relancer toute l\'analyse. ' +
        'Utile après avoir corrigé un verrou ou modifié le fichier hors de l\'outil.',
      actif: true
    },
    { action: 'copier', libelle: 'Copier le chemin relatif', actif: true },
    { action: 'versions', libelle: 'Voir les versions archivées', actif: true },
    { separateur: true },
    {
      action: 'masquer',
      libelle: 'Masquer pour cette analyse',
      titre:
        'Écarte ce fichier de la vue sans toucher aux réglages. « Rétablir » dans la barre de filtres le fait revenir ; la prochaine analyse repart au complet.',
      actif: true
    },
    {
      action: 'exclure',
      libelle: 'Exclure ce fichier',
      titre: `Ajoute « ${fichier.nom} » aux fichiers exclus des réglages.`,
      actif: true,
      danger: true
    }
  ];
}

/**
 * Sur un dossier, l'exclusion se pose de deux façons, et la différence compte :
 * par nom, elle écarte tous les dossiers qui le portent, à n'importe quelle
 * profondeur ; par chemin, elle n'écarte que celui-ci. Les deux motifs sont
 * montrés en toutes lettres, parce que c'est eux qu'on retrouvera dans les
 * réglages.
 *
 * À la racine, chemin et nom sont la même chaîne : une seule entrée alors, il
 * n'y a rien à départager.
 */
function entreesDossier(dossier) {
  const exclusions =
    dossier.chemin === dossier.nom
      ? [
          {
            action: 'exclureDossierNom',
            libelle: 'Exclure ce dossier',
            titre:
              `Ajoute le motif « ${dossier.nom} » aux dossiers exclus. ` +
              'Tout dossier portant ce nom sera écarté, à n\'importe quelle profondeur.',
            actif: true,
            danger: true
          }
        ]
      : [
          {
            action: 'exclureDossierChemin',
            libelle: 'Exclure ce dossier seulement ici',
            titre: `Ajoute le motif « ${dossier.chemin} » aux dossiers exclus.`,
            actif: true,
            danger: true
          },
          {
            action: 'exclureDossierNom',
            libelle: `Exclure tous les dossiers « ${dossier.nom} »`,
            titre:
              `Ajoute le motif « ${dossier.nom} » aux dossiers exclus. ` +
              'Tout dossier portant ce nom sera écarté, à n\'importe quelle profondeur.',
            actif: true,
            danger: true
          }
        ];

  return [
    { action: 'revelerLocal', libelle: "Afficher le dossier local dans l'explorateur", actif: true },
    {
      action: 'revelerProd',
      libelle: "Afficher le dossier production dans l'explorateur",
      actif: true
    },
    { separateur: true },
    { action: 'copier', libelle: 'Copier le chemin relatif', actif: true },
    { separateur: true },
    {
      action: 'masquer',
      libelle: 'Masquer cette branche pour cette analyse',
      titre:
        'Écarte tous les fichiers de ce dossier de la vue, sans toucher aux réglages. « Rétablir » dans la barre de filtres les fait revenir.',
      actif: true
    },
    ...exclusions
  ];
}

function MenuContextuel({ menu, onFermer, onAction }) {
  const boite = useRef(null);

  useEffect(() => {
    const surClic = (evenement) => {
      if (boite.current && !boite.current.contains(evenement.target)) onFermer();
    };
    const surTouche = (evenement) => {
      if (evenement.key === 'Escape') onFermer();
    };
    document.addEventListener('mousedown', surClic);
    document.addEventListener('keydown', surTouche);
    return () => {
      document.removeEventListener('mousedown', surClic);
      document.removeEventListener('keydown', surTouche);
    };
  }, [onFermer]);

  const noeud = menu.noeud;
  const entrees = noeud.type === 'dossier' ? entreesDossier(noeud) : entreesFichier(noeud);

  return html`
    <div class="menu" ref=${boite} style=${`left:${menu.x}px;top:${menu.y}px`} role="menu">
      <div class="menu-titre mono">${noeud.chemin}</div>
      ${entrees.map((entree, index) =>
        entree.separateur
          ? html`<div class="menu-separateur" key=${'separateur' + index} role="separator"></div>`
          : html`
              <button
                type="button"
                class=${'menu-entree' + (entree.danger ? ' danger' : '')}
                key=${entree.action}
                disabled=${!entree.actif}
                title=${entree.titre || ''}
                role="menuitem"
                onClick=${() => onAction(entree.action)}
              >
                ${entree.libelle}
              </button>
            `
      )}
    </div>
  `;
}
