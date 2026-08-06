/**
 * Aides d'affichage des chemins Windows.
 *
 * Le renderer ne fait que présenter : la résolution qui fait autorité est
 * celle de `electron/core/config.js` (`joindreWin`), côté processus principal.
 * Les deux implémentations doivent donner le même résultat.
 */

/**
 * Joint une racine et un dossier de projet. Une racine Windows (`Z:\…`) reçoit
 * des séparateurs Windows ; une racine POSIX garde les siens, pour que l'outil
 * reste exerçable ailleurs que sur le poste de production.
 */
export function joindreChemin(racine, relatif) {
  const brut = String(racine || '').trim();
  const base = brut.replace(/[\\/]+$/, '');
  const suite = String(relatif || '').trim().replace(/^[\\/]+/, '');
  if (!base) return suite;
  if (!suite) return brut;
  const windows = /^[a-z]:/i.test(brut) || brut.startsWith('\\\\') || brut.includes('\\');
  return base + (windows ? '\\' + suite.replace(/\//g, '\\') : '/' + suite.replace(/\\/g, '/'));
}

/**
 * Raccourcit un chemin trop long pour son emplacement, en gardant le début
 * (le lecteur) et la fin (ce qui identifie le dossier) : E:\…\Process\GPNET
 */
export function raccourcirChemin(chemin, maximum = 60) {
  const valeur = String(chemin || '');
  if (valeur.length <= maximum) return valeur;

  const morceaux = valeur.split('\\');
  if (morceaux.length <= 2) return valeur;

  const tete = morceaux[0];
  let queue = morceaux[morceaux.length - 1];
  for (let i = morceaux.length - 2; i > 0; i -= 1) {
    const essai = morceaux[i] + '\\' + queue;
    if (tete.length + 3 + essai.length > maximum) break;
    queue = essai;
  }
  return tete + '\\…\\' + queue;
}
