import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { formaterDate, formaterNombre, formaterOctets } from './arborescence.js';

const html = htm.bind(h);

/**
 * ApercuBinaire.js - la comparaison des fichiers qui ne se lisent pas.
 *
 * Une icône, une image, un son ou une police ne se comparent pas ligne à
 * ligne : ils se regardent. Ce module affiche les deux versions côte à côte,
 * sait les superposer et soustraire leurs pixels, et pour les binaires sans
 * aperçu, montre le premier octet qui diffère. Tout part de l'enveloppe
 * préparée côté main (`donnees.binaire` et `donnees.apercu`) : rien n'est relu
 * ici, rien n'est modifié.
 */

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

/** Décode une URL de données sans passer par fetch : la CSP coupe connect-src. */
function octetsDeUrl(url) {
  const brut = atob(url.slice(url.indexOf(',') + 1));
  const octets = new Uint8Array(brut.length);
  for (let i = 0; i < brut.length; i += 1) octets[i] = brut.charCodeAt(i);
  return octets;
}

function chargerImage(url) {
  return new Promise((resoudre, rejeter) => {
    const image = new Image();
    image.onload = () => resoudre(image);
    image.onerror = () => rejeter(new Error('image indéchiffrable'));
    image.src = url;
  });
}

function hexa(octet) {
  return octet.toString(16).padStart(2, '0');
}

function ascii(octet) {
  return octet >= 32 && octet < 127 ? String.fromCharCode(octet) : '·';
}

// ---------------------------------------------------------------------------
// Images : côte à côte, superposition, différence pixel par pixel
// ---------------------------------------------------------------------------

const FONDS = [
  { cle: 'damier', libelle: 'Damier', titre: 'Fond en damier : les zones transparentes se voient' },
  { cle: 'clair', libelle: 'Clair', titre: 'Fond blanc' },
  { cle: 'sombre', libelle: 'Sombre', titre: 'Fond sombre : pour les icônes claires' }
];

const ZOOMS = [
  { cle: 'ajuste', libelle: 'Ajuster' },
  { cle: 1, libelle: '×1' },
  { cle: 2, libelle: '×2' },
  { cle: 4, libelle: '×4' }
];

/**
 * Compare deux images pixel par pixel, calées sur le coin haut gauche.
 * Les pixels identiques ressortent en gris estompé - la silhouette reste
 * lisible - et chaque pixel qui diffère est peint en rouge vif.
 */
async function calculerDifference(urlGauche, urlDroite) {
  const [imageGauche, imageDroite] = await Promise.all([chargerImage(urlGauche), chargerImage(urlDroite)]);
  const largeur = Math.max(imageGauche.naturalWidth || 1, imageDroite.naturalWidth || 1);
  const hauteur = Math.max(imageGauche.naturalHeight || 1, imageDroite.naturalHeight || 1);

  const pixelsDe = (image) => {
    const toile = document.createElement('canvas');
    toile.width = largeur;
    toile.height = hauteur;
    const contexte = toile.getContext('2d', { willReadFrequently: true });
    contexte.drawImage(image, 0, 0);
    return contexte.getImageData(0, 0, largeur, hauteur).data;
  };

  const gauche = pixelsDe(imageGauche);
  const droite = pixelsDe(imageDroite);

  const toile = document.createElement('canvas');
  toile.width = largeur;
  toile.height = hauteur;
  const contexte = toile.getContext('2d');
  const sortie = contexte.createImageData(largeur, hauteur);

  let differents = 0;
  for (let i = 0; i < gauche.length; i += 4) {
    const pareil =
      gauche[i] === droite[i] &&
      gauche[i + 1] === droite[i + 1] &&
      gauche[i + 2] === droite[i + 2] &&
      gauche[i + 3] === droite[i + 3];
    if (pareil) {
      const gris = Math.round(0.3 * gauche[i] + 0.59 * gauche[i + 1] + 0.11 * gauche[i + 2]);
      sortie.data[i] = gris;
      sortie.data[i + 1] = gris;
      sortie.data[i + 2] = gris;
      sortie.data[i + 3] = Math.round(gauche[i + 3] * 0.25);
    } else {
      differents += 1;
      sortie.data[i] = 232;
      sortie.data[i + 1] = 58;
      sortie.data[i + 2] = 82;
      sortie.data[i + 3] = 255;
    }
  }
  contexte.putImageData(sortie, 0, 0);

  return { url: toile.toDataURL(), differents, total: largeur * hauteur, largeur, hauteur };
}

export function ApercuImages({ apercu, titreGauche, titreDroite }) {
  const [mode, setMode] = useState('cote');
  const [fond, setFond] = useState('damier');
  const [zoom, setZoom] = useState('ajuste');
  const [opacite, setOpacite] = useState(50);
  const [dimensions, setDimensions] = useState({});
  const [difference, setDifference] = useState(null);

  const cotes = [
    { cle: 'gauche', titre: titreGauche, donnees: apercu.gauche },
    { cle: 'droite', titre: titreDroite, donnees: apercu.droite }
  ];
  const lesDeux = Boolean(apercu.gauche && apercu.gauche.url && apercu.droite && apercu.droite.url);

  // Les modes à deux images n'existent que quand les deux images existent.
  useEffect(() => {
    if (!lesDeux && mode !== 'cote') setMode('cote');
  }, [lesDeux, mode]);

  useEffect(() => {
    setDimensions({});
    setDifference(null);
    setMode('cote');
  }, [apercu]);

  useEffect(() => {
    if (mode !== 'difference' || difference || !lesDeux) return;
    let annule = false;
    setDifference({ etat: 'calcul' });
    calculerDifference(apercu.gauche.url, apercu.droite.url)
      .then((resultat) => {
        if (!annule) setDifference({ etat: 'pret', ...resultat });
      })
      .catch(() => {
        if (!annule) setDifference({ etat: 'echec' });
      });
    return () => {
      annule = true;
    };
  }, [mode, difference, lesDeux, apercu]);

  // Une URL de données peut être décodée avant que l'écouteur `load` ne soit
  // posé : le `ref` relève donc aussi les dimensions d'une image déjà
  // complète. Rendre le même objet d'état quand rien ne change coupe court à
  // toute boucle de rendu.
  const noterElement = (cle, image) => {
    if (!image || !image.complete || !image.naturalWidth) return;
    setDimensions((avant) => {
      const connues = avant[cle];
      if (connues && connues.largeur === image.naturalWidth && connues.hauteur === image.naturalHeight) return avant;
      return { ...avant, [cle]: { largeur: image.naturalWidth, hauteur: image.naturalHeight } };
    });
  };
  const noter = (cle) => (evenement) => noterElement(cle, evenement.target);
  const refImage = (cle) => (element) => noterElement(cle, element);

  const facteur = zoom === 'ajuste' ? null : zoom;
  const styleImage = (cle) => {
    if (!facteur) return '';
    const dims = dimensions[cle];
    if (!dims || !dims.largeur) return '';
    return `width:${dims.largeur * facteur}px;max-width:none;`;
  };
  const classeImage = 'apercu-image' + (facteur && facteur > 1 ? ' pixelise' : '') + (facteur ? '' : ' ajuste');

  const dimsGauche = dimensions.gauche;
  const dimsDroite = dimensions.droite;
  const dimensionsDifferentes = Boolean(
    dimsGauche &&
      dimsDroite &&
      (dimsGauche.largeur !== dimsDroite.largeur || dimsGauche.hauteur !== dimsDroite.hauteur)
  );

  const legende = (cle, donnees) => {
    const dims = dimensions[cle];
    return html`<div class="apercu-legende">
      ${dims ? html`<span class="mono">${formaterNombre(dims.largeur)} × ${formaterNombre(dims.hauteur)} px</span>` : null}
      <span>${formaterOctets(donnees.taille)}</span>
    </div>`;
  };

  const scene = (contenuScene) => html`<div class=${'apercu-scene fond-' + fond}>${contenuScene}</div>`;

  const groupeBoutons = (choix, actuel, changer) => html`
    <div class="apercu-groupe" role="group">
      ${choix.map(
        (option) => html`
          <button
            type="button"
            key=${option.cle}
            class=${'btn btn-mini' + (actuel === option.cle ? ' btn-marque' : '')}
            title=${option.titre || ''}
            aria-pressed=${actuel === option.cle}
            onClick=${() => changer(option.cle)}
          >
            ${option.libelle}
          </button>
        `
      )}
    </div>
  `;

  return html`
    <div class="apercu">
      <div class="apercu-outils">
        ${lesDeux
          ? groupeBoutons(
              [
                { cle: 'cote', libelle: 'Côte à côte' },
                {
                  cle: 'superpose',
                  libelle: 'Superposer',
                  titre: 'Les deux images l’une sur l’autre, calées sur le coin haut gauche ; le curseur dose la version visible'
                },
                {
                  cle: 'difference',
                  libelle: 'Différence',
                  titre: 'Chaque pixel qui diffère est peint en rouge ; ce qui est identique reste en gris estompé'
                }
              ],
              mode,
              setMode
            )
          : null}
        ${groupeBoutons(FONDS, fond, setFond)}
        ${groupeBoutons(ZOOMS, zoom, setZoom)}
      </div>

      ${dimensionsDifferentes
        ? html`<div class="apercu-note">
            Dimensions différentes : ${formaterNombre(dimsGauche.largeur)} × ${formaterNombre(dimsGauche.hauteur)}
            contre ${formaterNombre(dimsDroite.largeur)} × ${formaterNombre(dimsDroite.hauteur)} px. Superposition et
            différence sont calées sur le coin haut gauche.
          </div>`
        : null}

      ${mode === 'cote'
        ? html`<div class="apercu-cotes">
            ${cotes.map(
              (cote) => html`
                <div class="apercu-cote" key=${cote.cle}>
                  <div class="apercu-cote-titre">${cote.titre}</div>
                  ${!cote.donnees
                    ? scene(html`<span class="attenue">absent</span>`)
                    : cote.donnees.tropGros
                      ? scene(
                          html`<span class="attenue">
                            Trop volumineux pour un aperçu (${formaterOctets(cote.donnees.taille)}).
                          </span>`
                        )
                      : scene(
                          html`<img
                            class=${classeImage}
                            style=${styleImage(cote.cle)}
                            src=${cote.donnees.url}
                            alt=${'Aperçu ' + cote.titre}
                            ref=${refImage(cote.cle)}
                            onLoad=${noter(cote.cle)}
                          />`
                        )}
                  ${cote.donnees ? legende(cote.cle, cote.donnees) : null}
                </div>
              `
            )}
          </div>`
        : null}

      ${mode === 'superpose' && lesDeux
        ? html`
            <div class="apercu-opacite">
              <span>${titreGauche}</span>
              <input
                type="range"
                min="0"
                max="100"
                value=${opacite}
                onInput=${(evenement) => setOpacite(Number(evenement.target.value))}
              />
              <span>${titreDroite}</span>
              <span class="mono attenue">${opacite} %</span>
            </div>
            ${scene(html`
              <div class="apercu-pile">
                <img
                  class=${classeImage}
                  style=${styleImage('gauche')}
                  src=${apercu.gauche.url}
                  alt=${'Aperçu ' + titreGauche}
                  ref=${refImage('gauche')}
                  onLoad=${noter('gauche')}
                />
                <img
                  class=${classeImage + ' apercu-image-dessus'}
                  style=${styleImage('droite') + 'opacity:' + opacite / 100 + ';'}
                  src=${apercu.droite.url}
                  alt=${'Aperçu ' + titreDroite}
                  ref=${refImage('droite')}
                  onLoad=${noter('droite')}
                />
              </div>
            `)}
          `
        : null}

      ${mode === 'difference' && lesDeux
        ? html`
            ${difference && difference.etat === 'pret'
              ? html`<div class="apercu-diff-resume">
                  ${difference.differents === 0
                    ? html`<strong class="bon">Aucun pixel ne diffère.</strong>${' '}
                        <span class="attenue">
                          Les fichiers n'ont pas le même contenu, mais le rendu est le même : l'écart tient aux
                          métadonnées ou à l'encodage.
                        </span>`
                    : html`<strong class="mauvais">
                          ${formaterNombre(difference.differents) +
                          (difference.differents > 1 ? ' pixels diffèrent' : ' pixel diffère')}
                        </strong>${' '}
                        <span class="attenue">
                          ${'sur ' +
                          formaterNombre(difference.total) +
                          ' (' +
                          ((difference.differents / difference.total) * 100).toFixed(
                            difference.differents / difference.total < 0.001 ? 2 : 1
                          ) +
                          ' %), en rouge ci-dessous.'}
                        </span>`}
                </div>`
              : null}
            ${difference && difference.etat === 'echec'
              ? html`<div class="apercu-note">Différence impossible : une des deux images ne se décode pas.</div>`
              : null}
            ${difference && difference.etat === 'calcul'
              ? html`<div class="apercu-note">Calcul de la différence…</div>`
              : null}
            ${difference && difference.etat === 'pret'
              ? scene(
                  (() => {
                    // Sur une icône, un pixel fautif est invisible à l'échelle 1 :
                    // en « Ajuster », une petite différence est grossie d'office,
                    // en pixels nets.
                    const facteurDifference =
                      facteur || (difference.largeur < 96 ? Math.max(2, Math.round(192 / difference.largeur)) : null);
                    return html`<img
                      class=${'apercu-image' + (facteurDifference > 1 ? ' pixelise' : ' ajuste')}
                      style=${facteurDifference ? `width:${difference.largeur * facteurDifference}px;max-width:none;` : ''}
                      src=${difference.url}
                      alt="Différence pixel par pixel"
                    />`;
                  })()
                )
              : null}
          `
        : null}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sons et vidéos : deux lecteurs, une oreille
// ---------------------------------------------------------------------------

function ApercuMedia({ apercu, titreGauche, titreDroite }) {
  const cotes = [
    { cle: 'gauche', titre: titreGauche, donnees: apercu.gauche },
    { cle: 'droite', titre: titreDroite, donnees: apercu.droite }
  ];

  return html`
    <div class="apercu">
      <div class="apercu-cotes">
        ${cotes.map(
          (cote) => html`
            <div class="apercu-cote" key=${cote.cle}>
              <div class="apercu-cote-titre">${cote.titre}</div>
              ${!cote.donnees
                ? html`<div class="attenue">absent</div>`
                : cote.donnees.tropGros
                  ? html`<div class="attenue">Trop volumineux pour un aperçu (${formaterOctets(cote.donnees.taille)}).</div>`
                  : apercu.genre === 'video'
                    ? html`<video class="apercu-media" controls src=${cote.donnees.url}></video>`
                    : html`<audio class="apercu-media" controls src=${cote.donnees.url}></audio>`}
              ${cote.donnees ? html`<div class="apercu-legende"><span>${formaterOctets(cote.donnees.taille)}</span></div>` : null}
            </div>
          `
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Polices : le même texte composé dans chaque version
// ---------------------------------------------------------------------------

const PANGRAMME = 'Portez ce vieux whisky au juge blond qui fume. 0123456789';
const CARACTERES = 'àâçéèêëîïôùûü ÀÇÉÈÙ ß€@&%';

function ApercuPolice({ apercu, titreGauche, titreDroite }) {
  const [etat, setEtat] = useState('chargement');

  useEffect(() => {
    let annule = false;
    const chargees = [];
    setEtat('chargement');

    const chargerCote = async (cote, nom) => {
      if (!cote || !cote.url || cote.tropGros) return;
      const police = new FontFace(nom, octetsDeUrl(cote.url).buffer);
      await police.load();
      if (annule) return;
      document.fonts.add(police);
      chargees.push(police);
    };

    Promise.all([
      chargerCote(apercu.gauche, 'apercu-police-gauche'),
      chargerCote(apercu.droite, 'apercu-police-droite')
    ])
      .then(() => {
        if (!annule) setEtat('pret');
      })
      .catch(() => {
        if (!annule) setEtat('echec');
      });

    return () => {
      annule = true;
      for (const police of chargees) document.fonts.delete(police);
    };
  }, [apercu]);

  if (etat === 'echec') {
    return html`<div class="apercu-note">Aperçu impossible : une des deux polices ne se décode pas.</div>`;
  }

  const cotes = [
    { cle: 'gauche', titre: titreGauche, donnees: apercu.gauche, famille: 'apercu-police-gauche' },
    { cle: 'droite', titre: titreDroite, donnees: apercu.droite, famille: 'apercu-police-droite' }
  ];

  return html`
    <div class="apercu">
      <div class="apercu-cotes">
        ${cotes.map(
          (cote) => html`
            <div class="apercu-cote" key=${cote.cle}>
              <div class="apercu-cote-titre">${cote.titre}</div>
              ${!cote.donnees
                ? html`<div class="attenue">absent</div>`
                : etat === 'pret'
                  ? html`<div class="apercu-police-bloc" style=${'font-family:\'' + cote.famille + '\';'}>
                      <div class="apercu-police-grand">${PANGRAMME}</div>
                      <div class="apercu-police-petit">${CARACTERES}</div>
                    </div>`
                  : html`<div class="attenue">Chargement de la police…</div>`}
              ${cote.donnees ? html`<div class="apercu-legende"><span>${formaterOctets(cote.donnees.taille)}</span></div>` : null}
            </div>
          `
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Premier écart : la fenêtre d'octets autour de la première différence
// ---------------------------------------------------------------------------

function PremierEcart({ difference, titreGauche, titreDroite }) {
  const ligne = (titre, fenetre) => {
    const finVisible = fenetre.debut + fenetre.octets.length;
    return html`
      <div class="ecart-ligne mono">
        <span class="ecart-cote">${titre}</span>
        <span class="ecart-offset">${'0x' + fenetre.debut.toString(16).padStart(8, '0')}</span>
        <span>
          ${fenetre.octets.map(
            (octet, index) => html`<span
                key=${index}
                class=${'ecart-octet' + (fenetre.debut + index === difference.position ? ' differe' : '')}
              >${hexa(octet)}</span
              >${' '}`
          )}
          ${finVisible <= difference.position ? html`<span class="attenue">(fin du fichier)</span>` : null}
        </span>
        <span class="ecart-ascii">${fenetre.octets.map(ascii).join('')}</span>
      </div>
    `;
  };

  return html`
    <div class="ecart-octets">
      <div class="ecart-octets-titre">
        ${'Premier écart à l\'octet ' + formaterNombre(difference.position) + ' '}
        <span class="attenue mono">${'(0x' + difference.position.toString(16) + ')'}</span>
      </div>
      ${difference.finCommune
        ? html`<div class="apercu-note">
            Les ${formaterNombre(difference.position)} premiers octets sont identiques : un côté est exactement le
            début de l'autre, seul le plus long continue au-delà.
          </div>`
        : null}
      ${ligne(titreGauche, difference.gauche)}
      ${ligne(titreDroite, difference.droite)}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// La vue complète d'un fichier binaire
// ---------------------------------------------------------------------------

export function VueBinaire({ donnees, titreGauche, titreDroite, onOuvrirExterne }) {
  const fiche = donnees.binaire || null;
  const apercu = donnees.apercu || null;
  const identiques = fiche ? fiche.identiques : null;

  // Seule l'enveloppe de l'analyse porte `prod`/`local` : c'est elle qui sait
  // ouvrir les fichiers dans une application du poste.
  const ouvrable = donnees.prod !== undefined || donnees.local !== undefined;

  const verdict = () => {
    if (identiques === true) {
      return html`<div class="encart encart-succes binaire-verdict">
        <strong>Identiques octet pour octet.</strong> Les deux versions ont exactement le même contenu ; l'empreinte
        SHA-256 le confirme ci-dessous.
      </div>`;
    }
    if (identiques === false) {
      const memeTaille = fiche.gauche.taille === fiche.droite.taille;
      return html`<div class="encart encart-alerte binaire-verdict">
        <strong>Les deux versions diffèrent.</strong>${' '}
        ${memeTaille
          ? `Même taille, contenu différent : premier écart à l'octet ${formaterNombre(fiche.difference.position)}.`
          : `Tailles différentes : ${formaterOctets(fiche.gauche.taille)} contre ${formaterOctets(fiche.droite.taille)}.`}
      </div>`;
    }
    return html`<p class="attenue">Une seule version existe : rien à confronter, voici sa fiche.</p>`;
  };

  const ligne = (libelle, gauche, droite) => html`
    <tr>
      <th>${libelle}</th>
      <td class="mono">${gauche}</td>
      <td class="mono">${droite}</td>
    </tr>
  `;

  const valeur = (cote, champ) => {
    if (!cote) return '-';
    if (champ === 'taille') return formaterOctets(cote.taille);
    if (champ === 'date') return cote.date ? formaterDate(cote.date) : '-';
    return cote.sha256;
  };

  return html`
    <div class="panneau-contenu">
      <div class="binaire">
        ${verdict()}
        ${apercu && apercu.genre === 'image'
          ? html`<${ApercuImages} apercu=${apercu} titreGauche=${titreGauche} titreDroite=${titreDroite} />`
          : null}
        ${apercu && (apercu.genre === 'audio' || apercu.genre === 'video')
          ? html`<${ApercuMedia} apercu=${apercu} titreGauche=${titreGauche} titreDroite=${titreDroite} />`
          : null}
        ${apercu && apercu.genre === 'police'
          ? html`<${ApercuPolice} apercu=${apercu} titreGauche=${titreGauche} titreDroite=${titreDroite} />`
          : null}
        ${!apercu
          ? html`<p class="attenue">Fichier binaire : pas de comparaison ligne à ligne. Voici de quoi trancher.</p>`
          : null}
        ${fiche
          ? html`<table class="tableau">
              <thead>
                <tr>
                  <th></th>
                  <th>${titreGauche}</th>
                  <th>${titreDroite}</th>
                </tr>
              </thead>
              <tbody>
                ${ligne('Taille', valeur(fiche.gauche, 'taille'), valeur(fiche.droite, 'taille'))}
                ${ligne('Date', valeur(fiche.gauche, 'date'), valeur(fiche.droite, 'date'))}
                ${ligne('SHA-256', valeur(fiche.gauche, 'sha256'), valeur(fiche.droite, 'sha256'))}
              </tbody>
            </table>`
          : null}
        ${!apercu && fiche && fiche.difference
          ? html`<${PremierEcart} difference=${fiche.difference} titreGauche=${titreGauche} titreDroite=${titreDroite} />`
          : null}
        ${ouvrable
          ? html`<div style="display:flex;gap:6px;margin-top:12px">
              <button type="button" class="btn" disabled=${!donnees.prod} onClick=${() => onOuvrirExterne('prod')}>
                Ouvrir la version production
              </button>
              <button type="button" class="btn" disabled=${!donnees.local} onClick=${() => onOuvrirExterne('local')}>
                Ouvrir la version locale
              </button>
            </div>`
          : null}
      </div>
    </div>
  `;
}
