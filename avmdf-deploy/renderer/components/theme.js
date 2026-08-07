/**
 * theme.js - choix du thème sombre ou clair.
 *
 * Le thème n'est qu'un attribut posé sur `<html>` : la feuille de style
 * redéfinit ses variables, aucune règle ne change. Il est mémorisé dans le
 * stockage local du poste, pas dans les réglages de l'application : c'est un
 * confort de lecture propre à qui regarde l'écran, pas un paramètre de
 * déploiement.
 *
 * La pose initiale, elle, est faite par `theme-initial.js` avant le premier
 * affichage (voir le commentaire de ce fichier).
 */

/** Même chaîne que dans `theme-initial.js`. */
export const CLE_THEME = 'avmdf.theme';

/** `fond` doit valoir exactement le `--fond` du thème dans styles.css. */
export const THEMES = [
  { cle: 'sombre', libelle: 'sombre', fond: '#16191c' },
  { cle: 'clair', libelle: 'clair', fond: '#e9edf1' }
];

const PAR_CLE = new Map(THEMES.map((theme) => [theme.cle, theme]));
const DEFAUT = 'sombre';

/** Thème mémorisé, ou le thème sombre à défaut. */
export function lireTheme() {
  try {
    const choix = localStorage.getItem(CLE_THEME);
    if (PAR_CLE.has(choix)) return choix;
  } catch (err) {
    /* stockage local indisponible */
  }
  return DEFAUT;
}

/** L'autre thème que celui passé. */
export function themeOppose(cle) {
  return cle === 'clair' ? 'sombre' : 'clair';
}

/**
 * Applique un thème : attribut sur la page, mémorisation, et accord du fond de
 * la fenêtre Electron - ce dernier est ce qui s'affiche pendant un
 * redimensionnement, avant que la page ne soit repeinte.
 *
 * @param {string} cle
 * @returns {string} le thème réellement appliqué
 */
export function appliquerTheme(cle) {
  const theme = PAR_CLE.get(cle) || PAR_CLE.get(DEFAUT);
  document.documentElement.setAttribute('data-theme', theme.cle);
  try {
    localStorage.setItem(CLE_THEME, theme.cle);
  } catch (err) {
    /* stockage local indisponible : le choix ne survivra pas à la fermeture */
  }
  if (window.avmdf && window.avmdf.systeme.fondFenetre) {
    window.avmdf.systeme.fondFenetre(theme.fond);
  }
  return theme.cle;
}
