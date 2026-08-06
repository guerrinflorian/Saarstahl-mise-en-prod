import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useCallback, useEffect, useRef, useState } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/**
 * Messages passagers affichés en bas à droite.
 * Les erreurs restent affichées jusqu'à fermeture manuelle : on ne fait pas
 * disparaître tout seul un message qui dit qu'une écriture a échoué.
 */
export function useNotifications() {
  const [liste, setListe] = useState([]);
  const compteur = useRef(0);
  const minuteurs = useRef(new Map());

  const retirer = useCallback((id) => {
    setListe((precedente) => precedente.filter((n) => n.id !== id));
    const minuteur = minuteurs.current.get(id);
    if (minuteur) {
      clearTimeout(minuteur);
      minuteurs.current.delete(id);
    }
  }, []);

  const notifier = useCallback(
    (notification) => {
      compteur.current += 1;
      const id = compteur.current;
      const complete = Object.assign({ type: 'info' }, notification, { id });
      setListe((precedente) => precedente.concat(complete));
      if (complete.type !== 'erreur') {
        minuteurs.current.set(
          id,
          setTimeout(() => retirer(id), complete.duree || 5000)
        );
      }
      return id;
    },
    [retirer]
  );

  /** Raccourci pour une réponse IPC `{ ok:false, erreur:{ message, conseil } }`. */
  const notifierEchec = useCallback(
    (reponse, titreParDefaut) => {
      const erreur = (reponse && reponse.erreur) || {};
      return notifier({
        type: 'erreur',
        titre: erreur.message || titreParDefaut || 'L\'opération a échoué.',
        texte: erreur.conseil || ''
      });
    },
    [notifier]
  );

  const minuteursActifs = minuteurs.current;
  useEffect(() => () => minuteursActifs.forEach((minuteur) => clearTimeout(minuteur)), [minuteursActifs]);

  return { liste, notifier, notifierEchec, retirer };
}

export function Notifications({ liste, onFermer }) {
  if (!liste.length) return null;
  return html`
    <div class="notifications" role="status" aria-live="polite">
      ${liste.map(
        (notification) => html`
          <div class="notification ${notification.type}" key=${notification.id}>
            <div class="notification-corps">
              <div class="notification-titre">${notification.titre}</div>
              ${notification.texte
                ? html`<div class="notification-texte">${notification.texte}</div>`
                : null}
            </div>
            <button
              type="button"
              class="btn btn-plat btn-icone btn-mini"
              title="Fermer ce message"
              aria-label="Fermer ce message"
              onClick=${() => onFermer(notification.id)}
            >
              ✕
            </button>
          </div>
        `
      )}
    </div>
  `;
}
