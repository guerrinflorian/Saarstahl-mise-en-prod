import Prism from '../vendor/prism.js';

/**
 * Coloration syntaxique et structure du comparateur.
 *
 * Le texte complet de chaque côté est reconstitué puis tokenisé en une seule
 * passe : les constructions qui traversent plusieurs lignes (commentaires de
 * bloc, gabarits) restent correctes. Les jetons sont ensuite découpés ligne
 * par ligne et rattachés au numéro de ligne de leur côté, pour se superposer
 * aux couches déjà en place (mot à mot, blancs visibles).
 *
 * Deux services de plus que la simple couleur :
 *
 * - dans les fichiers JavaScript, un gabarit entre accents graves qui contient
 *   du HTML (composants Vue 2 : template: `<div>…</div>`) est tokenisé avec la
 *   grammaire markup, interpolations ${…} préservées en JavaScript ;
 * - chaque balise ouvrante est appariée à sa fermante, et des guides sont
 *   calculés pour tracer un trait de l'ouverture à la fermeture. Les traits
 *   suivent la structure réelle des balises, pas l'indentation : ils restent
 *   justes même quand le code est mal indenté.
 */

const LANGUES = [
  { motif: /\.(aspx|ascx|master|asax|ashx|asmx)$/i, id: 'aspnet', libelle: 'ASP.NET' },
  { motif: /\.cs$/i, id: 'csharp', libelle: 'C#' },
  { motif: /\.(js|mjs)$/i, id: 'javascript', libelle: 'JavaScript' },
  { motif: /\.vue$/i, id: 'markup', libelle: 'Vue' },
  { motif: /\.css$/i, id: 'css', libelle: 'CSS' },
  { motif: /\.(html?|xml|config|xsd|xsl|xslt|svg|resx|sitemap|browser|wsdl)$/i, id: 'markup', libelle: 'HTML/XML' },
  { motif: /\.sql$/i, id: 'sql', libelle: 'SQL' },
  { motif: /\.vb$/i, id: 'vbnet', libelle: 'VB.NET' },
  { motif: /\.json$/i, id: 'json', libelle: 'JSON' }
];

/** Au-delà, on renonce à colorer : le confort ne vaut pas une interface figée. */
const LIMITE_COLORATION = 1500000;

/** Balises HTML qui ne se ferment jamais. */
const BALISES_VIDES = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Au-delà, les traits deviennent du bruit. */
const MAX_GUIDES_PAR_LIGNE = 16;

const TAILLE_TABULATION = 4;

/** Langue Prism correspondant au chemin, ou null si on ne sait pas colorer. */
export function langueDe(chemin) {
  if (!chemin) return null;
  for (const langue of LANGUES) {
    if (langue.motif.test(chemin)) return langue;
  }
  return null;
}

/**
 * Coloration et guides de structure pour les deux côtés d'un diff.
 *
 * @param {Array} groupes groupes de lignes du diff (replis compris)
 * @param {string} langueId identifiant de grammaire Prism
 * @returns {{jetons:object, guides:object, structure:boolean}|null}
 *   - jetons.gauche / jetons.droite : numéro de ligne → intervalles
 *     [{debut, fin, classe}] relatifs au début de la ligne ;
 *   - guides.gauche / guides.droite : numéro de ligne → traits
 *     [{colonne, colonneGlyphes, fin}] en colonnes visuelles ;
 *   - structure : au moins un trait existe quelque part.
 *   Null si la coloration est impossible (grammaire absente, fichier trop gros).
 */
export function calculerColoration(groupes, langueId) {
  const grammaire = Prism.languages[langueId];
  if (!grammaire) return null;

  const resultat = { jetons: {}, guides: {}, structure: false };
  for (const cote of ['gauche', 'droite']) {
    const textes = [];
    const numeros = [];
    for (const groupe of groupes) {
      for (const ligne of groupe.lignes) {
        const cellule = ligne[cote];
        if (cellule) {
          textes.push(cellule.texte);
          numeros.push(cellule.numero);
        }
      }
    }
    const texte = textes.join('\n');
    if (texte.length > LIMITE_COLORATION) return null;

    const debutsLigne = [0];
    for (const t of textes) debutsLigne.push(debutsLigne[debutsLigne.length - 1] + t.length + 1);
    debutsLigne.pop();

    let plat;
    let balises;
    try {
      ({ plat, balises } = aplatir(Prism.tokenize(texte, grammaire), langueId));
    } catch (err) {
      return null;
    }
    plat.sort((a, b) => a.debut - b.debut);

    const parLigne = repartirParLigne(plat, debutsLigne, textes);
    const jetons = new Map();
    for (let i = 0; i < numeros.length; i += 1) jetons.set(numeros[i], parLigne[i] || []);
    resultat.jetons[cote] = jetons;

    const guidesParIndex = construireGuides(balises, debutsLigne, textes);
    const guides = new Map();
    for (const [index, liste] of guidesParIndex) {
      if (index < numeros.length) guides.set(numeros[index], liste);
    }
    resultat.guides[cote] = guides;
    if (guides.size) resultat.structure = true;
  }
  return resultat;
}

// ---------------------------------------------------------------------------
// Aplatissement : de l'arbre Prism à des intervalles absolus + liste de balises
// ---------------------------------------------------------------------------

function texteDe(jeton) {
  if (typeof jeton === 'string') return jeton;
  if (typeof jeton.content === 'string') return jeton.content;
  if (Array.isArray(jeton.content)) return jeton.content.map(texteDe).join('');
  return texteDe(jeton.content);
}

function classeDe(jeton) {
  let classe = 'code-' + jeton.type;
  if (jeton.alias) {
    const alias = Array.isArray(jeton.alias) ? jeton.alias : [jeton.alias];
    classe += alias.map((a) => ' code-' + a).join('');
  }
  return classe;
}

function aplatir(jetonsRacine, langueId) {
  const plat = [];
  const balises = [];
  const structurel = langueId === 'markup' || langueId === 'aspnet';
  let position = 0;

  function enregistrerBalise(brut, debut) {
    const trouve = brut.match(/^<\s*(\/?)\s*([a-zA-Z][\w:.-]*)/);
    if (!trouve) return;
    const nom = trouve[2].toLowerCase();
    const ferme = trouve[1] === '/';
    const seule = /\/>\s*$/.test(brut) || (!ferme && BALISES_VIDES.has(nom));
    balises.push({ nom, genre: ferme ? 'ferme' : seule ? 'seule' : 'ouvre', debut });
  }

  function marcher(liste, classeParent, balisesActives) {
    for (const jeton of liste) {
      if (typeof jeton === 'string') {
        if (classeParent) plat.push({ debut: position, fin: position + jeton.length, classe: classeParent });
        position += jeton.length;
        continue;
      }
      if (jeton.type === 'template-string' && langueId === 'javascript') {
        if (traiterGabarit(jeton)) continue;
      }
      if (balisesActives && jeton.type === 'tag') enregistrerBalise(texteDe(jeton), position);
      const classe = classeDe(jeton);
      if (typeof jeton.content === 'string') {
        plat.push({ debut: position, fin: position + jeton.content.length, classe });
        position += jeton.content.length;
      } else {
        marcher(Array.isArray(jeton.content) ? jeton.content : [jeton.content], classe, balisesActives);
      }
    }
  }

  /**
   * Gabarit entre accents graves contenant du HTML : la partie littérale est
   * tokenisée en markup (interpolations masquées par des espaces pour garder
   * toutes les positions), puis les interpolations sont parcourues en
   * JavaScript. Renvoie false si le gabarit n'est pas du HTML : le parcours
   * normal reprend la main.
   */
  function traiterGabarit(jeton) {
    const enfants = Array.isArray(jeton.content) ? jeton.content : [jeton.content];
    let masque = '';
    let litteral = '';
    const exclusions = [];
    const interpolations = [];
    let curseur = position;

    for (const enfant of enfants) {
      const brut = texteDe(enfant);
      const type = typeof enfant === 'string' ? null : enfant.type;
      if (type === 'interpolation') {
        interpolations.push({ jeton: enfant, debut: curseur });
        exclusions.push({ debut: curseur, fin: curseur + brut.length });
        masque += brut.replace(/[^\n]/g, ' ');
      } else if (type === 'template-punctuation') {
        exclusions.push({ debut: curseur, fin: curseur + brut.length });
        masque += ' '.repeat(brut.length);
      } else {
        masque += brut;
        litteral += brut;
      }
      curseur += brut.length;
    }

    if (!/^\s*</.test(litteral)) return false;

    const base = position;
    let jetonsMarkup;
    try {
      jetonsMarkup = Prism.tokenize(masque, Prism.languages.markup);
    } catch (err) {
      return false;
    }

    // Parcours du markup masqué : intervalles découpés hors interpolations.
    let positionMarkup = base;
    (function marcherMarkup(liste, classeParent) {
      for (const enfant of liste) {
        if (typeof enfant === 'string') {
          if (classeParent) deposerDecoupe(positionMarkup, positionMarkup + enfant.length, classeParent);
          positionMarkup += enfant.length;
          continue;
        }
        if (enfant.type === 'tag') enregistrerBalise(texteDe(enfant), positionMarkup);
        const classe = classeDe(enfant);
        if (typeof enfant.content === 'string') {
          deposerDecoupe(positionMarkup, positionMarkup + enfant.content.length, classe);
          positionMarkup += enfant.content.length;
        } else {
          marcherMarkup(Array.isArray(enfant.content) ? enfant.content : [enfant.content], classe);
        }
      }
    })(jetonsMarkup, null);

    function deposerDecoupe(debut, fin, classe) {
      let curseurLocal = debut;
      for (const exclusion of exclusions) {
        if (exclusion.fin <= curseurLocal || exclusion.debut >= fin) continue;
        if (exclusion.debut > curseurLocal) plat.push({ debut: curseurLocal, fin: exclusion.debut, classe });
        curseurLocal = Math.max(curseurLocal, exclusion.fin);
      }
      if (curseurLocal < fin) plat.push({ debut: curseurLocal, fin, classe });
    }

    // Accents graves et interpolations : parcours JavaScript normal.
    for (const enfant of enfants) {
      const brut = texteDe(enfant);
      const type = typeof enfant === 'string' ? null : enfant.type;
      if (type === 'template-punctuation') {
        plat.push({ debut: position, fin: position + brut.length, classe: 'code-string code-template-punctuation' });
        position += brut.length;
      } else if (type === 'interpolation') {
        marcher([enfant], null, false);
      } else {
        position += brut.length;
      }
    }
    return true;
  }

  marcher(jetonsRacine, null, structurel);
  return { plat, balises };
}

// ---------------------------------------------------------------------------
// Répartition des intervalles absolus sur les lignes
// ---------------------------------------------------------------------------

function repartirParLigne(plat, debutsLigne, textes) {
  const parLigne = textes.map(() => []);

  function ligneDe(offset) {
    let bas = 0;
    let haut = debutsLigne.length - 1;
    while (bas < haut) {
      const milieu = (bas + haut + 1) >> 1;
      if (debutsLigne[milieu] <= offset) bas = milieu;
      else haut = milieu - 1;
    }
    return bas;
  }

  for (const intervalle of plat) {
    let ligne = ligneDe(intervalle.debut);
    let debut = intervalle.debut;
    while (debut < intervalle.fin && ligne < textes.length) {
      const debutLigne = debutsLigne[ligne];
      const finLigne = debutLigne + textes[ligne].length;
      const morceauDebut = Math.max(debut, debutLigne) - debutLigne;
      const morceauFin = Math.min(intervalle.fin, finLigne) - debutLigne;
      if (morceauFin > morceauDebut) {
        parLigne[ligne].push({ debut: morceauDebut, fin: morceauFin, classe: intervalle.classe });
      }
      debut = finLigne + 1;
      ligne += 1;
    }
  }
  return parLigne;
}

// ---------------------------------------------------------------------------
// Guides d'ouverture et de fermeture
// ---------------------------------------------------------------------------

/**
 * Colonne visuelle d'un caractère : les tabulations s'étendent jusqu'au
 * multiple de 4 suivant en mode normal, et occupent 4 colonnes fixes en mode
 * « espaces visibles » (le glyphe → est suivi de trois espaces).
 */
function colonnesVisuelles(texteLigne, offset) {
  let colonne = 0;
  let colonneGlyphes = 0;
  for (let i = 0; i < offset && i < texteLigne.length; i += 1) {
    if (texteLigne[i] === '\t') {
      colonne += TAILLE_TABULATION - (colonne % TAILLE_TABULATION);
      colonneGlyphes += TAILLE_TABULATION;
    } else {
      colonne += 1;
      colonneGlyphes += 1;
    }
  }
  return { colonne, colonneGlyphes };
}

function construireGuides(balises, debutsLigne, textes) {
  const paires = [];
  const pile = [];
  for (const balise of balises) {
    if (balise.genre === 'ouvre') {
      pile.push(balise);
    } else if (balise.genre === 'ferme') {
      let i = pile.length - 1;
      while (i >= 0 && pile[i].nom !== balise.nom) i -= 1;
      if (i >= 0) {
        paires.push({ ouverte: pile[i], fermee: balise });
        pile.length = i;
      }
    }
  }

  function ligneDe(offset) {
    let bas = 0;
    let haut = debutsLigne.length - 1;
    while (bas < haut) {
      const milieu = (bas + haut + 1) >> 1;
      if (debutsLigne[milieu] <= offset) bas = milieu;
      else haut = milieu - 1;
    }
    return bas;
  }

  const carte = new Map();
  for (const paire of paires) {
    const ligneOuvre = ligneDe(paire.ouverte.debut);
    const ligneFerme = ligneDe(paire.fermee.debut);
    if (ligneFerme <= ligneOuvre) continue;
    const { colonne, colonneGlyphes } = colonnesVisuelles(
      textes[ligneOuvre],
      paire.ouverte.debut - debutsLigne[ligneOuvre]
    );
    for (let ligne = ligneOuvre + 1; ligne <= ligneFerme; ligne += 1) {
      let liste = carte.get(ligne);
      if (!liste) carte.set(ligne, (liste = []));
      const existante = liste.find((g) => g.colonne === colonne);
      if (existante) {
        if (ligne === ligneFerme) existante.fin = true;
        continue;
      }
      if (liste.length >= MAX_GUIDES_PAR_LIGNE) continue;
      liste.push({ colonne, colonneGlyphes, fin: ligne === ligneFerme });
    }
  }

  for (const liste of carte.values()) liste.sort((a, b) => a.colonne - b.colonne);
  return carte;
}
