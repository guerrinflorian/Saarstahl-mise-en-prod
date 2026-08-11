import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/** Durée du fondu de sortie, accordée à la transition CSS de .intro. */
const DUREE_FONDU = 450;

/** Garde-fou : au-delà, l'intro s'efface même si la vidéo n'a rien dit. */
const DUREE_MAX = 20000;

/**
 * Rideau de lancement : la vidéo d'introduction joue par-dessus l'application
 * qui se charge derrière, puis s'efface en fondu à la fin de la lecture.
 *
 * Toutes les portes de sortie mènent au même fondu : fin de la vidéo, Échap,
 * clic sur « Passer », erreur de lecture, lecture refusée, ou vingt secondes
 * sans nouvelle - une intro ne retient jamais l'outil en otage.
 */
export function IntroVideo() {
  // lecture → fondu → fini (démonté)
  const [phase, setPhase] = useState('lecture');
  const video = useRef(null);

  const terminer = () => setPhase((actuelle) => (actuelle === 'lecture' ? 'fondu' : actuelle));

  useEffect(() => {
    const element = video.current;
    if (element) {
      // La lecture automatique n'est due qu'aux vidéos muettes : le silence
      // est posé en propriété avant de demander la lecture, et un refus
      // quand même (politique, codec) efface l'intro au lieu de la figer.
      element.muted = true;
      const lecture = element.play();
      if (lecture && lecture.catch) lecture.catch(terminer);
    }
    const surTouche = (evenement) => {
      if (evenement.key === 'Escape') terminer();
    };
    document.addEventListener('keydown', surTouche);
    const garde = setTimeout(terminer, DUREE_MAX);
    return () => {
      document.removeEventListener('keydown', surTouche);
      clearTimeout(garde);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'fondu') return undefined;
    const minuteur = setTimeout(() => setPhase('fini'), DUREE_FONDU);
    return () => clearTimeout(minuteur);
  }, [phase]);

  if (phase === 'fini') return null;

  return html`
    <div class=${'intro' + (phase === 'fondu' ? ' intro-fondu' : '')} role="presentation">
      <video
        ref=${video}
        class="intro-video"
        src="assets/intro_video.mp4"
        autoplay
        muted
        playsinline
        onEnded=${terminer}
        onError=${terminer}
      ></video>
      <button type="button" class="intro-passer" onClick=${terminer}>Passer</button>
    </div>
  `;
}
