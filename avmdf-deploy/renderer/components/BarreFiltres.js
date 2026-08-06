import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { MARQUEURS, LIBELLES, STATUTS, formaterNombre } from './arborescence.js';
import { MODE_CONTIENT, MODE_GLOB, MODE_REGEX, creerFiltreTexte, estVierge } from './filtres.js';

const html = htm.bind(h);

const CHOIX_DATE = [
  { valeur: '', libelle: 'toutes dates' },
  { valeur: 'aujourdhui', libelle: "aujourd'hui" },
  { valeur: '7jours', libelle: '7 derniers jours' },
  { valeur: '30jours', libelle: '30 derniers jours' },
  { valeur: 'choisie', libelle: 'depuis une date…' }
];

/** Petit panneau qui se referme au clic à l'extérieur ou sur Échap. */
function Popover({ libelle, actif, children, titre }) {
  const [ouvert, setOuvert] = useState(false);
  const conteneur = useRef(null);

  useEffect(() => {
    if (!ouvert) return undefined;
    const surClic = (evenement) => {
      if (conteneur.current && !conteneur.current.contains(evenement.target)) setOuvert(false);
    };
    const surTouche = (evenement) => {
      if (evenement.key === 'Escape') setOuvert(false);
    };
    document.addEventListener('mousedown', surClic);
    document.addEventListener('keydown', surTouche);
    return () => {
      document.removeEventListener('mousedown', surClic);
      document.removeEventListener('keydown', surTouche);
    };
  }, [ouvert]);

  return html`
    <div class="popover-hote" ref=${conteneur}>
      <button
        type="button"
        class=${'btn btn-mini' + (actif ? ' btn-marque' : '')}
        title=${titre || ''}
        aria-expanded=${ouvert}
        onClick=${() => setOuvert(!ouvert)}
      >
        ${libelle} ▾
      </button>
      ${ouvert ? html`<div class="popover">${children}</div>` : null}
    </div>
  `;
}

/**
 * Barre de recherche et de filtres. Tout se combine en ET logique, et le
 * bandeau du bas rappelle en permanence combien de fichiers sont masqués.
 */
export function BarreFiltres({
  criteres,
  onCriteres,
  compteurs,
  extensions,
  dossiers,
  nombreAffiches,
  nombreTotal,
  rechercheContenu,
  onReinitialiser,
  onToutDeplier,
  onToutReplier
}) {
  const filtre = creerFiltreTexte(criteres.requete, criteres.mode);
  const [dateChoisie, setDateChoisie] = useState('');
  const [choixDate, setChoixDate] = useState('');

  const majStatut = (statut, valeur) =>
    onCriteres({ ...criteres, statuts: { ...criteres.statuts, [statut]: valeur } });

  const majExtension = (extension, valeur) => {
    const actuelles = criteres.extensions ? new Set(criteres.extensions) : new Set(extensions.map((e) => e.extension));
    if (valeur) actuelles.add(extension);
    else actuelles.delete(extension);
    onCriteres({ ...criteres, extensions: actuelles.size === extensions.length ? null : actuelles });
  };

  const surChoixDate = (valeur) => {
    setChoixDate(valeur);
    if (valeur !== 'choisie') {
      const jour = 24 * 60 * 60 * 1000;
      const maintenant = Date.now();
      const depuis =
        valeur === 'aujourdhui'
          ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
          : valeur === '7jours'
            ? maintenant - 7 * jour
            : valeur === '30jours'
              ? maintenant - 30 * jour
              : null;
      onCriteres({ ...criteres, depuis });
    }
  };

  return html`
    <div class="filtres">
      <div class="filtres-ligne">
        <input
          type="search"
          class="filtres-recherche mono"
          placeholder="Rechercher dans les chemins…"
          spellcheck="false"
          aria-label="Rechercher"
          value=${criteres.requete}
          onInput=${(e) => onCriteres({ ...criteres, requete: e.target.value })}
        />
        <select
          value=${criteres.mode}
          aria-label="Mode de recherche"
          title="Mode de recherche"
          onChange=${(e) => onCriteres({ ...criteres, mode: e.target.value })}
        >
          <option value=${MODE_CONTIENT}>contient</option>
          <option value=${MODE_REGEX}>regex</option>
          <option value=${MODE_GLOB}>glob</option>
        </select>
      </div>

      ${!filtre.valide ? html`<div class="filtres-erreur">${filtre.erreur}</div>` : null}

      <label class="case filtres-contenu" title="Lit le contenu des fichiers texte des deux côtés">
        <input
          type="checkbox"
          checked=${criteres.dansLeContenu}
          onChange=${(e) => onCriteres({ ...criteres, dansLeContenu: e.target.checked })}
        />
        <span>Chercher aussi dans le contenu des fichiers</span>
      </label>
      ${rechercheContenu && rechercheContenu.enCours
        ? html`<div class="filtres-avancement mono">
            Lecture ${formaterNombre(rechercheContenu.faits)} / ${formaterNombre(rechercheContenu.total)}
            <button type="button" class="btn btn-mini btn-plat" onClick=${rechercheContenu.onAnnuler}>Annuler</button>
          </div>`
        : null}
      ${rechercheContenu && !rechercheContenu.enCours && rechercheContenu.trouves !== null
        ? html`<div class="filtres-avancement attenue">
            ${formaterNombre(rechercheContenu.trouves)} fichier(s) contiennent cette chaîne.
          </div>`
        : null}

      <div class="filtres-statuts">
        ${STATUTS.map(
          (statut) => html`
            <label class=${'bascule bascule-' + statut} key=${statut} title=${'Afficher les fichiers ' + LIBELLES[statut] + 's'}>
              <input
                type="checkbox"
                checked=${Boolean(criteres.statuts[statut])}
                onChange=${(e) => majStatut(statut, e.target.checked)}
              />
              <span class="marqueur">${MARQUEURS[statut]}</span>
              <span class="bascule-nombre">${formaterNombre(compteurs[statut] || 0)}</span>
            </label>
          `
        )}
      </div>

      <div class="filtres-ligne">
        <${Popover}
          libelle="ext"
          titre="Filtrer par extension"
          actif=${Boolean(criteres.extensions)}
        >
          <div class="popover-entete">
            <button type="button" class="btn btn-mini btn-plat" onClick=${() => onCriteres({ ...criteres, extensions: null })}>
              Toutes
            </button>
            <button type="button" class="btn btn-mini btn-plat" onClick=${() => onCriteres({ ...criteres, extensions: new Set() })}>
              Aucune
            </button>
          </div>
          <div class="popover-liste">
            ${extensions.map(
              (entree) => html`
                <label class="case" key=${entree.extension}>
                  <input
                    type="checkbox"
                    checked=${!criteres.extensions || criteres.extensions.has(entree.extension)}
                    onChange=${(e) => majExtension(entree.extension, e.target.checked)}
                  />
                  <span class="mono">${entree.extension || '(sans extension)'}</span>
                  <span class="attenue">${formaterNombre(entree.nombre)}</span>
                </label>
              `
            )}
          </div>
        <//>

        <select
          value=${choixDate}
          aria-label="Modifiés localement depuis"
          title="Modifiés localement depuis"
          class=${criteres.depuis ? 'marque' : ''}
          onChange=${(e) => surChoixDate(e.target.value)}
        >
          ${CHOIX_DATE.map((choix) => html`<option value=${choix.valeur} key=${choix.valeur}>${choix.libelle}</option>`)}
        </select>
        ${choixDate === 'choisie'
          ? html`<input
              type="date"
              value=${dateChoisie}
              aria-label="Date de début"
              onInput=${(e) => {
                setDateChoisie(e.target.value);
                onCriteres({ ...criteres, depuis: e.target.value ? new Date(e.target.value).getTime() : null });
              }}
            />`
          : null}

        <input
          type="text"
          class=${'filtres-dossier mono' + (criteres.dossier ? ' marque' : '')}
          list="liste-dossiers"
          placeholder="dossier…"
          spellcheck="false"
          aria-label="Restreindre à un dossier"
          value=${criteres.dossier}
          onInput=${(e) => onCriteres({ ...criteres, dossier: e.target.value })}
        />
        <datalist id="liste-dossiers">
          ${dossiers.slice(0, 400).map((dossier) => html`<option value=${dossier} key=${dossier}></option>`)}
        </datalist>
      </div>

      <div class="filtres-resume">
        <span>
          <strong>${formaterNombre(nombreAffiches)}</strong> fichiers affichés sur ${formaterNombre(nombreTotal)}
        </span>
        <div style="flex:1"></div>
        <button type="button" class="btn btn-mini btn-plat" title="Tout déplier" onClick=${onToutDeplier}>Tout déplier</button>
        <button type="button" class="btn btn-mini btn-plat" title="Tout replier" onClick=${onToutReplier}>Tout replier</button>
        <button
          type="button"
          class="btn btn-mini"
          disabled=${estVierge(criteres)}
          onClick=${() => {
            setChoixDate('');
            setDateChoisie('');
            onReinitialiser();
          }}
        >
          Réinitialiser
        </button>
      </div>
    </div>
  `;
}
