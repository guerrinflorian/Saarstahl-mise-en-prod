import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';

const html = htm.bind(h);

/**
 * icones.js - petites icônes vectorielles dessinées sur une grille de 16.
 *
 * Tracées au trait et en `currentColor` : la couleur vient de la classe qui
 * porte l'icône, jamais de l'icône elle-même. Aucune police ni fichier
 * extérieur, la politique de sécurité du contenu interdit les deux.
 *
 * Chaque famille de fichier a sa forme et sa teinte, et la liste couvre tout :
 * ce qui n'est reconnu par aucune famille tombe sur « inconnu », jamais sur du
 * vide. Les teintes restent dans les deux familles de l'identité, vert et
 * gris-bleu, comme la coloration syntaxique du comparateur ; seuls les
 * fichiers qui ne se lisent pas (binaires, archives) empruntent le rouge sourd.
 */

function svg(classe, enfants) {
  return html`
    <svg class=${'icone' + (classe ? ' ' + classe : '')} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      ${enfants}
    </svg>
  `;
}

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------

/** Dossier fermé, ou entrouvert quand la branche est dépliée. */
export function IconeDossier({ ouvert, classe }) {
  if (ouvert) {
    return svg(
      classe,
      html`
        <path d="M2.2 12.2V4.3a.6.6 0 0 1 .6-.6h3.1l1.2 1.5h6a.6.6 0 0 1 .6.6v1" />
        <path d="M2.2 12.2 3.9 8a.6.6 0 0 1 .55-.35h9.65a.5.5 0 0 1 .46.7l-1.7 4.2a.6.6 0 0 1-.55.35H2.8a.6.6 0 0 1-.6-.7z" />
      `
    );
  }
  return svg(
    classe,
    html`<path d="M2.2 12.2V4.3a.6.6 0 0 1 .6-.6h3.1l1.2 1.5h6a.6.6 0 0 1 .6.6v6.4a.6.6 0 0 1-.6.6H2.8a.6.6 0 0 1-.6-.6z" />`
  );
}

// ---------------------------------------------------------------------------
// Familles de fichiers
// ---------------------------------------------------------------------------

/**
 * L'ordre compte pour l'affichage de la légende, pas pour la résolution :
 * chaque extension n'appartient qu'à une seule famille.
 */
export const FAMILLES = [
  {
    cle: 'page',
    libelle: 'Pages et balisage',
    exemple: '.aspx',
    extensions: [
      'aspx', 'ascx', 'master', 'asax', 'ashx', 'asmx', 'svc', 'axd',
      'html', 'htm', 'xhtml', 'cshtml', 'vbhtml', 'razor'
    ],
    dessin: () => html`<path d="M6 4.4 2.7 8 6 11.6" /><path d="M10 4.4 13.3 8 10 11.6" />`
  },
  {
    cle: 'code',
    libelle: 'Code serveur',
    exemple: '.vb',
    extensions: ['vb', 'cs', 'fs', 'vbs', 'cls', 'bas', 'java', 'py', 'php', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp'],
    dessin: () => html`
      <path d="M6.4 3.2c-1.1 0-1.5.5-1.5 1.4v1.5c0 .9-.5 1.4-1.3 1.5v.8c.8.1 1.3.6 1.3 1.5v1.5c0 .9.4 1.4 1.5 1.4" />
      <path d="M9.6 3.2c1.1 0 1.5.5 1.5 1.4v1.5c0 .9.5 1.4 1.3 1.5v.8c-.8.1-1.3.6-1.3 1.5v1.5c0 .9-.4 1.4-1.5 1.4" />
    `
  },
  {
    cle: 'script',
    libelle: 'Scripts navigateur',
    exemple: '.js',
    extensions: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'coffee'],
    dessin: () => html`
      <path d="M6.4 3.2c-1.1 0-1.5.5-1.5 1.4v1.5c0 .9-.5 1.4-1.3 1.5v.8c.8.1 1.3.6 1.3 1.5v1.5c0 .9.4 1.4 1.5 1.4" />
      <path d="M9.6 3.2c1.1 0 1.5.5 1.5 1.4v1.5c0 .9.5 1.4 1.3 1.5v.8c-.8.1-1.3.6-1.3 1.5v1.5c0 .9-.4 1.4-1.5 1.4" />
      <circle cx="8" cy="8" r="0.9" />
    `
  },
  {
    cle: 'composant',
    libelle: 'Composants Vue',
    exemple: '.vue',
    extensions: ['vue', 'svelte'],
    dessin: () => html`
      <path d="M2.6 3.9h2.6L8 9.3l2.8-5.4h2.6L8 13.3z" />
      <path d="M6 3.9 8 7.5l2-3.6" />
    `
  },
  {
    cle: 'style',
    libelle: 'Feuilles de style',
    exemple: '.css',
    extensions: ['css', 'less', 'scss', 'sass', 'styl', 'skin'],
    dessin: () => html`
      <path d="M10.4 2.7 13.3 5.6 7.6 11.3 4.7 8.4z" />
      <path d="M4.7 8.4 3 13l4.6-1.7" />
    `
  },
  {
    cle: 'donnees',
    libelle: 'Données et configuration',
    exemple: '.config',
    extensions: [
      'xml', 'config', 'json', 'json5', 'resx', 'sitemap', 'browser', 'settings',
      'yml', 'yaml', 'toml', 'ini', 'props', 'targets', 'csproj', 'vbproj', 'sln',
      'xsd', 'xsl', 'xslt', 'wsdl', 'nuspec', 'editorconfig', 'gitignore', 'gitattributes'
    ],
    dessin: () => html`
      <circle cx="3.5" cy="4.7" r="0.85" />
      <circle cx="3.5" cy="8" r="0.85" />
      <circle cx="3.5" cy="11.3" r="0.85" />
      <path d="M6.1 4.7h6.6M6.1 8h6.6M6.1 11.3h6.6" />
    `
  },
  {
    cle: 'requete',
    libelle: 'Bases de données',
    exemple: '.sql',
    extensions: ['sql', 'mdf', 'ldf', 'db', 'sqlite', 'bak', 'dbo'],
    dessin: () => html`
      <path d="M3.5 4.3c0-.9 2-1.6 4.5-1.6s4.5.7 4.5 1.6-2 1.6-4.5 1.6-4.5-.7-4.5-1.6z" />
      <path d="M3.5 4.3v7.4c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6V4.3" />
      <path d="M3.5 8c0 .9 2 1.6 4.5 1.6s4.5-.7 4.5-1.6" />
    `
  },
  {
    cle: 'terminal',
    libelle: 'Scripts de commande',
    exemple: '.bat',
    extensions: ['bat', 'cmd', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh'],
    dessin: () => html`
      <path d="M2.7 3.4h10.6v9.2H2.7z" />
      <path d="M5 6.4 6.9 8.3 5 10.2" />
      <path d="M8.6 10.4h2.6" />
    `
  },
  {
    cle: 'image',
    libelle: 'Images',
    exemple: '.png',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'tif', 'tiff', 'psd', 'ai'],
    dessin: () => html`
      <path d="M2.7 3.6h10.6v8.8H2.7z" />
      <circle cx="5.7" cy="6.2" r="1" />
      <path d="M2.7 10.6 6.2 7.6l2.4 2.1 2.1-1.8 2.6 2.3" />
    `
  },
  {
    cle: 'texte',
    libelle: 'Textes et journaux',
    exemple: '.txt',
    extensions: ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rtf', 'nfo', 'lst'],
    dessin: () => html`<path d="M3.4 4.3h9.2M3.4 7h9.2M3.4 9.7h9.2M3.4 12.4h5.4" />`
  },
  {
    cle: 'tableur',
    libelle: 'Tableurs',
    exemple: '.xlsx',
    extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods'],
    dessin: () => html`
      <path d="M2.9 3.6h10.2v8.8H2.9z" />
      <path d="M2.9 6.5h10.2M2.9 9.5h10.2M6.3 3.6v8.8M9.7 3.6v8.8" />
    `
  },
  {
    cle: 'document',
    libelle: 'Documents',
    exemple: '.pdf',
    extensions: ['pdf', 'doc', 'docx', 'odt', 'ppt', 'pptx', 'odp', 'vsd', 'vsdx', 'one', 'msg', 'eml'],
    dessin: () => html`
      <path d="M9.2 2.4H5a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.2z" />
      <path d="M9.2 2.4v2.2a.6.6 0 0 0 .6.6H12" />
      <path d="M6.1 8.6h3.8M6.1 10.8h3.8" />
    `
  },
  {
    cle: 'archive',
    libelle: 'Archives',
    exemple: '.zip',
    extensions: ['zip', 'rar', '7z', 'cab', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'iso', 'nupkg', 'jar'],
    dessin: () => html`
      <path d="M2.8 5.7h10.4v7H2.8z" />
      <path d="M2.8 5.7 4.3 3.3h7.4l1.5 2.4" />
      <path d="M6.9 8.3h2.2v2.3H6.9z" />
    `
  },
  {
    cle: 'binaire',
    libelle: 'Binaires et exécutables',
    exemple: '.dll',
    extensions: ['dll', 'exe', 'pdb', 'msi', 'com', 'bin', 'so', 'dylib', 'obj', 'lib', 'cache', 'suo', 'user'],
    dessin: () => html`
      <path d="M4.6 4.6h6.8v6.8H4.6z" />
      <path d="M6.9 6.9h2.2v2.2H6.9z" />
      <path d="M6.7 4.6V3.1M9.3 4.6V3.1M6.7 12.9v-1.5M9.3 12.9v-1.5M4.6 6.7H3.1M4.6 9.3H3.1M12.9 6.7h-1.5M12.9 9.3h-1.5" />
    `
  },
  {
    cle: 'police',
    libelle: 'Polices',
    exemple: '.woff',
    extensions: ['woff', 'woff2', 'ttf', 'otf', 'eot', 'fon'],
    dessin: () => html`<path d="M4 12.6 8 3.4l4 9.2" /><path d="M5.6 9.4h4.8" />`
  },
  {
    cle: 'media',
    libelle: 'Sons et vidéos',
    exemple: '.mp4',
    extensions: ['mp4', 'mp3', 'wav', 'avi', 'wmv', 'mov', 'mkv', 'ogg', 'webm', 'flac', 'm4a', 'wma'],
    dessin: () => html`
      <circle cx="8" cy="8" r="5.3" />
      <path d="M6.7 5.6 10.5 8l-3.8 2.4z" />
    `
  },
  {
    cle: 'inconnu',
    libelle: 'Tout le reste',
    exemple: 'sans extension',
    extensions: [],
    dessin: () => html`
      <path d="M9.1 2.3H5.2a1 1 0 0 0-1 1v9.4a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1V5.2z" />
      <path d="M9.1 2.3v2.3a.6.6 0 0 0 .6.6h2.1" />
    `
  }
];

const PAR_EXTENSION = new Map();
const PAR_CLE = new Map();
for (const famille of FAMILLES) {
  PAR_CLE.set(famille.cle, famille);
  for (const extension of famille.extensions) PAR_EXTENSION.set(extension, famille);
}

const INCONNU = PAR_CLE.get('inconnu');

/**
 * Famille d'un fichier, d'après son extension. Accepte aussi bien un nom
 * complet (`Default.aspx`) qu'une extension (`.aspx` ou `aspx`).
 *
 * Les extensions composées se résolvent sur la dernière partie, ce qui est le
 * bon comportement : `Default.aspx.vb` est du code, pas une page.
 *
 * @param {string} quoi
 * @returns {object} toujours une famille, « inconnu » à défaut
 */
export function familleDe(quoi) {
  const texte = String(quoi || '').toLowerCase();
  const point = texte.lastIndexOf('.');
  const extension = point >= 0 ? texte.slice(point + 1) : texte.replace(/^\./, '');
  return PAR_EXTENSION.get(extension) || INCONNU;
}

/**
 * Icône d'un fichier. `extension` accepte `.css`, `css` ou un nom complet ;
 * sans rien, c'est l'icône générique.
 */
export function IconeFichier({ extension, classe }) {
  const famille = extension ? familleDe(extension) : INCONNU;
  return svg('icone-fichier famille-' + famille.cle + (classe ? ' ' + classe : ''), famille.dessin());
}

// ---------------------------------------------------------------------------
// Icônes d'interface
// ---------------------------------------------------------------------------

/** Deux chevrons vers le bas : tout déplier. */
export function IconeDeplier({ classe }) {
  return svg(classe, html`<path d="M4.5 4.2 8 7.4l3.5-3.2M4.5 9 8 12.2 11.5 9" />`);
}

/** Deux chevrons vers le haut : tout replier. */
export function IconeReplier({ classe }) {
  return svg(classe, html`<path d="M4.5 7.4 8 4.2l3.5 3.2M4.5 12.2 8 9l3.5 3.2" />`);
}

/** Loupe, pour le champ de recherche. */
export function IconeLoupe({ classe }) {
  return svg(classe, html`<circle cx="7.2" cy="7.2" r="3.9" /><path d="M10.2 10.2 13.4 13.4" />`);
}

/** Entonnoir, pour les filtres avancés. */
export function IconeEntonnoir({ classe }) {
  return svg(classe, html`<path d="M2.6 3.4h10.8l-4.2 4.9v4.6l-2.4-1.4V8.3z" />`);
}

/** Soleil : le thème clair, celui vers lequel le bouton emmène. */
export function IconeSoleil({ classe }) {
  return svg(
    classe,
    html`
      <circle cx="8" cy="8" r="3.1" />
      <path
        d="M8 1.3v1.7M8 13v1.7M1.3 8h1.7M13 8h1.7M3.35 3.35l1.2 1.2M11.45 11.45l1.2 1.2M12.65 3.35l-1.2 1.2M4.55 11.45l-1.2 1.2"
      />
    `
  );
}

/** Croissant de lune : le thème sombre. */
export function IconeLune({ classe }) {
  return svg(classe, html`<path d="M13.1 9.7A5.8 5.8 0 0 1 6.3 2.9 5.75 5.75 0 1 0 13.1 9.7z" />`);
}

/** Croix de fermeture. */
export function IconeCroix({ classe }) {
  return svg(classe, html`<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />`);
}

/** Coche simple. */
export function IconeCoche({ classe }) {
  return svg(classe, html`<path d="M3.2 8.6 6.4 11.8 12.8 4.6" />`);
}

/** Rond d'information. */
export function IconeInfo({ classe }) {
  return svg(classe, html`<circle cx="8" cy="8" r="5.6" /><path d="M8 7.4v3.4M8 5.1v.2" />`);
}

/** Triangle d'avertissement. */
export function IconeAlerte({ classe }) {
  return svg(
    classe,
    html`<path d="M8 2.8 14 12.6a.5.5 0 0 1-.43.75H2.43A.5.5 0 0 1 2 12.6z" /><path d="M8 6.6v3M8 11.4v.2" />`
  );
}

/** Rond barré : l'échec. */
export function IconeEchec({ classe }) {
  return svg(classe, html`<circle cx="8" cy="8" r="5.6" /><path d="M5.9 5.9 10.1 10.1M10.1 5.9 5.9 10.1" />`);
}

/** Horloge qui revient : l'historique. */
export function IconeHistorique({ classe }) {
  return svg(
    classe,
    html`
      <path d="M2.9 8a5.1 5.1 0 1 0 1.5-3.6" />
      <path d="M2.9 2.6v2.2h2.2" />
      <path d="M8 5.4V8l2 1.5" />
    `
  );
}

/** Lignes horodatées : le journal. */
export function IconeJournal({ classe }) {
  return svg(
    classe,
    html`
      <path d="M3.2 2.9h9.6v10.2H3.2z" />
      <path d="M5.3 5.6h5.4M5.3 8h5.4M5.3 10.4h3.2" />
    `
  );
}

/** Engrenage : les réglages. */
export function IconeEngrenage({ classe }) {
  return svg(
    classe,
    html`
      <circle cx="8" cy="8" r="2" />
      <path
        d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"
      />
    `
  );
}

/** Flèche qui part vers le serveur : la mise en production. */
export function IconeExpedier({ classe }) {
  return svg(
    classe,
    html`
      <path d="M8 11V3.4" />
      <path d="M4.8 6.4 8 3.2l3.2 3.2" />
      <path d="M3 11.2v1.6a.6.6 0 0 0 .6.6h8.8a.6.6 0 0 0 .6-.6v-1.6" />
    `
  );
}

/** Boîte d'archives : l'AVMDF. */
export function IconeArchiveBoite({ classe }) {
  return svg(
    classe,
    html`
      <path d="M2.6 3.2h10.8v2.6H2.6z" />
      <path d="M3.4 5.8v6.4a.6.6 0 0 0 .6.6h8a.6.6 0 0 0 .6-.6V5.8" />
      <path d="M6.4 8.2h3.2" />
    `
  );
}

/** Feuillets empilés : les versions successives d'un fichier. */
export function IconeCouches({ classe }) {
  return svg(
    classe,
    html`
      <path d="M8 2.6 14 5.6 8 8.6 2 5.6z" />
      <path d="M2.6 8.6 8 11.3l5.4-2.7" />
      <path d="M2.6 11.2 8 13.9l5.4-2.7" />
    `
  );
}

/** Crayon : l'éditeur intégré. */
export function IconeCrayon({ classe }) {
  return svg(
    classe,
    html`
      <path d="M10.6 2.8 13.2 5.4 6 12.6l-3.4.8.8-3.4z" />
      <path d="M9.4 4 12 6.6" />
    `
  );
}
