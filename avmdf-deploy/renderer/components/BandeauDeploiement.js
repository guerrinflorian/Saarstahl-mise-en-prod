import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { Interrupteur } from './Champs.js';
import { IconeFichier } from './icones.js';
import { LIBELLES, MARQUEURS, formaterNombre, formaterOctets } from './arborescence.js';

const html = htm.bind(h);

/**
 * Bandeau bas : l'état exact de ce qui part et où, visible en permanence.
 * Il change de teinte dès que la simulation est désactivée.
 *
 * La suppression d'orphelins est une opération distincte de la mise en
 * production : on ne mélange pas les deux dans un même passage.
 */
export function BandeauDeploiement({
  simulation,
  onSimulation,
  archiver,
  onArchiver,
  selection,
  fichiers,
  destination,
  modeLibre,
  operation,
  occupe,
  onChoisirDestination,
  onDeployer,
  onRetirer,
  onDecocherTout,
  onChoisir,
  onNotifier
}) {
  const [planOuvert, setPlanOuvert] = useState(false);
  const boitePlan = useRef(null);

  // Le plan se referme au clic à l'extérieur, sur Échap, et dès que la
  // sélection se vide.
  useEffect(() => {
    if (!planOuvert) return undefined;
    const surClic = (evenement) => {
      if (boitePlan.current && !boitePlan.current.contains(evenement.target)) setPlanOuvert(false);
    };
    const surTouche = (evenement) => {
      if (evenement.key === 'Escape') setPlanOuvert(false);
    };
    document.addEventListener('mousedown', surClic);
    document.addEventListener('keydown', surTouche);
    return () => {
      document.removeEventListener('mousedown', surClic);
      document.removeEventListener('keydown', surTouche);
    };
  }, [planOuvert]);

  useEffect(() => {
    if (planOuvert && (!fichiers || !fichiers.length)) setPlanOuvert(false);
  }, [planOuvert, fichiers]);
  const reel = !simulation;
  const total = selection.deployables + selection.orphelins;
  const mixte = operation === 'mixte';
  const suppression = operation === 'suppression';

  // La case « Archiver » gouverne tout le versant AVMDF. Décochée, il n'y a
  // plus rien à ranger : la destination n'est ni exigée ni utilisée, et un
  // choix fait auparavant est simplement mis de côté. Personne ne devrait
  // avoir à ouvrir une demande pour pousser une feuille de style, ni pour
  // supprimer de vieux fichiers morts. Pour une suppression, le renoncement
  // pèse plus lourd (l'orphelin n'existe qu'en production) : l'avertissement
  // et la confirmation le disent en rouge.
  const avecArchivage = archiver;

  const raisonBlocage = modeLibre
    ? 'La comparaison libre ne permet pas de mise en production.'
    : total === 0
      ? 'Cochez au moins un fichier dans l\'arborescence.'
      : mixte
        ? 'Ne mélangez pas déploiement et suppression : traitez les orphelins à part.'
        : !destination && avecArchivage
          ? 'Choisissez d\'abord la demande et le dossier de sprint.'
          : '';

  const libelleAction = suppression ? 'Supprimer en production' : 'Mettre en production';

  const sousLibelle =
    selection.deployables && selection.orphelins
      ? formaterNombre(selection.deployables) + ' à déployer · ' + formaterNombre(selection.orphelins) + ' orphelins'
      : suppression
        ? 'suppression d\'orphelins'
        : Object.entries(selection.parStatut || {})
            .filter(([, nombre]) => nombre > 0)
            .map(([statut, nombre]) => MARQUEURS[statut] + ' ' + formaterNombre(nombre))
            .join(' · ');

  const tailleTotale = (fichiers || []).reduce(
    (somme, fichier) => somme + (fichier.local ? fichier.local.taille : fichier.prod ? fichier.prod.taille : 0),
    0
  );

  return html`
    <footer class=${'bandeau' + (reel ? ' reel' : '')}>
      <div class="bandeau-resume">
        <button
          type="button"
          class="bandeau-vol"
          disabled=${total === 0}
          aria-expanded=${planOuvert}
          title=${total === 0 ? 'Aucun fichier sélectionné' : 'Voir la liste exacte de ce qui part'}
          onClick=${() => setPlanOuvert(!planOuvert)}
        >
          <span class="bandeau-nombre">${formaterNombre(total)}</span>
          <span class="bandeau-libelles">
            <span class="bandeau-libelle">
              ${total > 1 ? 'fichiers sélectionnés' : 'fichier sélectionné'}
              ${total > 0 ? html`<span class="chevron">${planOuvert ? '▾' : '▴'}</span>` : null}
            </span>
            ${total > 0 && sousLibelle
              ? html`<span class="bandeau-sous">${sousLibelle}</span>`
              : html`<span class="bandeau-sous">rien à faire partir</span>`}
          </span>
        </button>
        <span class="fleche">→</span>
        ${!avecArchivage
          ? html`<span
              class="bandeau-destination attenue"
              title="« Archiver » est décoché : aucune version ne part dans les archives, et aucune destination n'est utilisée. Recochez la case pour retrouver la demande et le sprint."
            >
              aucun archivage
            </span>`
          : destination
            ? html`<button
                type="button"
                class="bandeau-destination mono"
                title="Changer la destination"
                onClick=${onChoisirDestination}
              >
                ${destination.chemin}
              </button>`
            : html`<button
                type="button"
                class="btn btn-mini"
                disabled=${modeLibre}
                title=${modeLibre ? 'Indisponible en comparaison libre' : 'Choisir la demande et le sprint'}
                onClick=${onChoisirDestination}
              >
                Choisir la destination…
              </button>`}
      </div>

      <div class="bandeau-actions">
        ${raisonBlocage ? html`<span class="attenue bandeau-raison">${raisonBlocage}</span>` : null}
        ${!archiver
          ? html`<span
              class="bandeau-etat sans-archive"
              title=${suppression
                ? 'Aucune copie de sauvegarde : la suppression sera définitive, le contenu ne survivra nulle part'
                : 'Aucune copie de sauvegarde : ce passage ne pourra pas être annulé'}
            >
              Sans AVMDF
            </span>`
          : null}
        <span class=${'bandeau-etat ' + (reel ? 'reel' : 'simulation')}>
          ${reel ? 'Écriture réelle' : 'Simulation'}
        </span>
        <span class="bandeau-separation" aria-hidden="true"></span>
        <${Interrupteur}
          libelle="Archiver"
          coche=${archiver}
          attention
          titre=${suppression
            ? 'Copier le fichier dans le dossier de sprint avant de le supprimer. Décoché, la suppression est définitive : un orphelin n\'existe qu\'en production, son contenu ne sera conservé nulle part.'
            : 'Copier la version de production dans le dossier de sprint avant de l\'écraser. Décoché, rien n\'est conservé et le retour arrière devient impossible.'}
          onChange=${onArchiver}
        />
        <${Interrupteur}
          libelle="Simulation"
          coche=${simulation}
          titre="En simulation, le rapport complet est produit mais aucun octet n'est écrit"
          onChange=${onSimulation}
        />
        <button
          type="button"
          class=${'btn ' + (operation === 'suppression' ? 'btn-danger' : 'btn-accent')}
          disabled=${Boolean(raisonBlocage) || occupe}
          title=${raisonBlocage || 'Ctrl+Entrée'}
          onClick=${onDeployer}
        >
          ${occupe ? 'En cours…' : libelleAction}
        </button>
      </div>

      ${planOuvert && fichiers && fichiers.length
        ? html`
            <div class="bandeau-plan" ref=${boitePlan} role="dialog" aria-label="Ce qui part">
              <div class="bandeau-plan-entete">
                <span class="surtitre">Plan de vol</span>
                <strong>${formaterNombre(fichiers.length)} fichier${fichiers.length > 1 ? 's' : ''}</strong>
                <span class="attenue">· ${formaterOctets(tailleTotale)}</span>
                <div style="flex:1"></div>
                <button
                  type="button"
                  class="btn btn-mini"
                  title="Copie la liste des chemins dans le presse-papiers, un par ligne"
                  onClick=${async () => {
                    await window.avmdf.systeme.copier(fichiers.map((fichier) => fichier.chemin).join('\r\n'));
                    if (onNotifier) {
                      onNotifier({
                        type: 'succes',
                        titre: 'Liste copiée.',
                        texte: formaterNombre(fichiers.length) + ' chemin(s), un par ligne.',
                        duree: 2500
                      });
                    }
                  }}
                >
                  Copier la liste
                </button>
                <button type="button" class="btn btn-mini btn-plat" onClick=${onDecocherTout}>
                  Tout décocher
                </button>
              </div>
              <div class="bandeau-plan-liste">
                ${fichiers.map(
                  (fichier) => html`
                    <div
                      class="bandeau-plan-ligne"
                      key=${fichier.cle}
                      title=${'Ouvrir la comparaison de ' + fichier.chemin}
                      onClick=${() => {
                        if (onChoisir) {
                          onChoisir(fichier);
                          setPlanOuvert(false);
                        }
                      }}
                    >
                      <span class=${'marqueur marqueur-' + fichier.statut} title=${'Fichier ' + LIBELLES[fichier.statut]}>
                        ${MARQUEURS[fichier.statut]}
                      </span>
                      <${IconeFichier} extension=${fichier.extension || fichier.nom} />
                      <span class="mono bandeau-plan-chemin">${fichier.chemin}</span>
                      <span class="attenue bandeau-plan-taille">
                        ${formaterOctets(fichier.local ? fichier.local.taille : fichier.prod ? fichier.prod.taille : 0)}
                      </span>
                      <button
                        type="button"
                        class="btn btn-mini btn-plat btn-carre"
                        title="Retirer ce fichier de la sélection"
                        aria-label=${'Retirer ' + fichier.chemin}
                        onClick=${(evenement) => {
                          evenement.stopPropagation();
                          onRetirer(fichier.cle);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  `
                )}
              </div>
            </div>
          `
        : null}
    </footer>
  `;
}

/** Compte la sélection par nature, pour le bandeau et le choix d'opération. */
export function resumerSelection(fichiers, selection) {
  let deployables = 0;
  let orphelins = 0;
  const parStatut = {};
  for (const fichier of fichiers) {
    if (!selection.has(fichier.cle)) continue;
    parStatut[fichier.statut] = (parStatut[fichier.statut] || 0) + 1;
    if (fichier.statut === 'orphelin') orphelins += 1;
    else deployables += 1;
  }
  return { deployables, orphelins, parStatut };
}

export function operationDe(selection) {
  if (selection.deployables && selection.orphelins) return 'mixte';
  if (selection.orphelins) return 'suppression';
  return 'deploiement';
}

export { LIBELLES, MARQUEURS };
