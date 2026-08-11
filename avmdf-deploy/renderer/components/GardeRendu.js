import { h, Component, Fragment } from '../vendor/preact.module.js';

/**
 * Filet de sécurité du rendu : si une erreur éclate pendant l'affichage du
 * sous-arbre qu'il enveloppe (le cas vécu : insertBefore de Preact sur un
 * pointeur DOM périmé, au dépliage des replis du comparateur), le sous-arbre
 * est remonté à neuf au lieu de laisser l'écran mort. On perd l'état local du
 * sous-arbre (replis dépliés, position), jamais l'analyse ni la sélection.
 *
 * L'erreur reste tracée en console : un rétablissement silencieux qui
 * n'avoue rien empêcherait de corriger la cause le jour où elle se montre.
 */
export class GardeRendu extends Component {
  constructor(props) {
    super(props);
    this.state = { generation: 0 };
  }

  componentDidCatch(erreur) {
    console.error('[avmdf] affichage rétabli après une erreur de rendu :', erreur);
    this.setState({ generation: this.state.generation + 1 });
  }

  render(props, etat) {
    // La clé change à chaque rétablissement : Preact abandonne l'ancien
    // sous-arbre, DOM compris, et reconstruit depuis zéro.
    return h(Fragment, { key: 'generation' + etat.generation }, props.children);
  }
}
