import Prism from '../vendor/prism.js';

/**
 * Coloration syntaxique du comparateur.
 *
 * Le texte complet de chaque côté est reconstitué puis tokenisé en une seule
 * passe : les constructions qui traversent plusieurs lignes (commentaires de
 * bloc, chaînes verbatim) restent correctes. Les jetons sont ensuite découpés
 * ligne par ligne et rattachés au numéro de ligne de leur côté, ce qui permet
 * de les superposer aux couches déjà en place (mot à mot, blancs visibles).
 */

const LANGUES = [
  { motif: /\.(aspx|ascx|master|asax|ashx|asmx)$/i, id: 'aspnet', libelle: 'ASP.NET' },
  { motif: /\.cs$/i, id: 'csharp', libelle: 'C#' },
  { motif: /\.(js|mjs)$/i, id: 'javascript', libelle: 'JavaScript' },
  { motif: /\.css$/i, id: 'css', libelle: 'CSS' },
  { motif: /\.(html?|xml|config|xsd|xsl|xslt|svg|resx|sitemap|browser|wsdl)$/i, id: 'markup', libelle: 'HTML/XML' },
  { motif: /\.sql$/i, id: 'sql', libelle: 'SQL' },
  { motif: /\.vb$/i, id: 'vbnet', libelle: 'VB.NET' },
  { motif: /\.json$/i, id: 'json', libelle: 'JSON' }
];

/** Au-delà, on renonce à colorer : le confort ne vaut pas une interface figée. */
const LIMITE_COLORATION = 1500000;

/** Langue Prism correspondant au chemin, ou null si on ne sait pas colorer. */
export function langueDe(chemin) {
  if (!chemin) return null;
  for (const langue of LANGUES) {
    if (langue.motif.test(chemin)) return langue;
  }
  return null;
}

/**
 * Jetons de coloration pour les deux côtés d'un diff.
 *
 * @param {Array} groupes groupes de lignes du diff (replis compris)
 * @param {string} langueId identifiant de grammaire Prism
 * @returns {{gauche:Map, droite:Map}|null} numéro de ligne → intervalles
 *   [{debut, fin, classe}] relatifs au début de la ligne, ou null si la
 *   coloration est impossible (grammaire absente, fichier trop gros).
 */
export function calculerJetons(groupes, langueId) {
  const grammaire = Prism.languages[langueId];
  if (!grammaire) return null;

  const resultat = {};
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

    let parLigne;
    try {
      parLigne = decouperParLigne(Prism.tokenize(texte, grammaire));
    } catch (err) {
      return null;
    }
    const carte = new Map();
    for (let i = 0; i < numeros.length; i += 1) {
      carte.set(numeros[i], parLigne[i] || []);
    }
    resultat[cote] = carte;
  }
  return resultat;
}

/**
 * Aplati l'arbre de jetons Prism en intervalles par ligne. Un jeton qui
 * chevauche un saut de ligne est découpé ; la classe la plus interne gagne.
 */
function decouperParLigne(jetons) {
  const parLigne = [[]];
  let ligne = 0;
  let colonne = 0;

  function deposer(morceau, classe) {
    let reste = morceau;
    let saut;
    while ((saut = reste.indexOf('\n')) !== -1) {
      if (saut > 0 && classe) parLigne[ligne].push({ debut: colonne, fin: colonne + saut, classe });
      ligne += 1;
      parLigne[ligne] = [];
      colonne = 0;
      reste = reste.slice(saut + 1);
    }
    if (reste.length && classe) parLigne[ligne].push({ debut: colonne, fin: colonne + reste.length, classe });
    colonne += reste.length;
  }

  function parcourir(liste, classeParent) {
    for (const jeton of liste) {
      if (typeof jeton === 'string') {
        deposer(jeton, classeParent);
        continue;
      }
      let classe = 'code-' + jeton.type;
      if (jeton.alias) {
        const alias = Array.isArray(jeton.alias) ? jeton.alias : [jeton.alias];
        classe += alias.map((a) => ' code-' + a).join('');
      }
      if (typeof jeton.content === 'string') deposer(jeton.content, classe);
      else if (Array.isArray(jeton.content)) parcourir(jeton.content, classe);
      else parcourir([jeton.content], classe);
    }
  }

  parcourir(jetons, null);
  return parLigne;
}
