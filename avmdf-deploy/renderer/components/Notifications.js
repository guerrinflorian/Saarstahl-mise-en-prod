import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useCallback, useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { IconeAlerte, IconeCoche, IconeEchec, IconeInfo } from './icones.js';

const html = htm.bind(h);

const ICONES = { succes: IconeCoche, erreur: IconeEchec, alerte: IconeAlerte, info: IconeInfo };

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

  // Le survol suspend la disparition : on ne retire pas un message que
  // quelqu'un est en train de lire. Au départ de la souris, le compte repart
  // de zéro - et la jauge avec lui, remontée via son numéro de relance.
  const suspendre = useCallback((id) => {
    const minuteur = minuteurs.current.get(id);
    if (minuteur) {
      clearTimeout(minuteur);
      minuteurs.current.delete(id);
    }
  }, []);

  const reprendre = useCallback(
    (id) => {
      setListe((precedente) =>
        precedente.map((notification) => {
          if (notification.id !== id || notification.type === 'erreur') return notification;
          minuteurs.current.set(
            id,
            setTimeout(() => retirer(id), notification.duree || 5000)
          );
          return { ...notification, relance: (notification.relance || 0) + 1 };
        })
      );
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

  return { liste, notifier, notifierEchec, retirer, suspendre, reprendre };
}

export function Notifications({ liste, onFermer, onSuspendre, onReprendre }) {
  if (!liste.length) return null;
  return html`
    <div class="notifications" role="status" aria-live="polite">
      ${liste.map((notification) => {
        const Icone = ICONES[notification.type] || IconeInfo;
        return html`
          <div
            class="notification ${notification.type}"
            key=${notification.id}
            onMouseEnter=${onSuspendre ? () => onSuspendre(notification.id) : null}
            onMouseLeave=${onReprendre ? () => onReprendre(notification.id) : null}
          >
            <span class="notification-icone" aria-hidden="true"><${Icone} /></span>
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
            ${notification.type !== 'erreur'
              ? html`<span
                  class="notification-jauge"
                  key=${'jauge' + (notification.relance || 0)}
                  style=${'animation-duration:' + (notification.duree || 5000) + 'ms'}
                ></span>`
              : null}
          </div>
        `;
      })}
    </div>
  `;
}
