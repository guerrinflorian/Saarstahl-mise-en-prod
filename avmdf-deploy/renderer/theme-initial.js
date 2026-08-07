/*
 * theme-initial.js - pose le thème sur <html> avant le premier affichage.
 *
 * Script classique, chargé dans l'en-tête et donc exécuté avant que le corps
 * de la page ne soit peint. C'est tout l'intérêt : le module `app.js` est
 * différé, et s'il posait le thème lui-même, une fenêtre en thème clair
 * s'ouvrirait sur un éclair sombre à chaque démarrage.
 *
 * La clé de stockage est répétée dans `components/theme.js`, qui gère la
 * suite. Deux fichiers, une seule chaîne à garder d'accord - il n'y a pas de
 * moyen d'importer quoi que ce soit ici sans redevenir différé.
 */
(function () {
  var CLE = 'avmdf.theme';
  var choix = null;
  try {
    choix = localStorage.getItem(CLE);
  } catch (err) {
    /* stockage local indisponible : on retombe sur le thème sombre */
  }
  document.documentElement.setAttribute('data-theme', choix === 'clair' ? 'clair' : 'sombre');
})();
