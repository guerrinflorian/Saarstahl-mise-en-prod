import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import {
  FAMILLES,
  IconeDeplier,
  IconeDossier,
  IconeEntonnoir,
  IconeFichier,
  IconeLoupe,
  IconeReplier,
  IconeSoleil
} from './icones.js';

const html = htm.bind(h);

const MARQUEURS = { modifie: 'M', nouveau: '+', orphelin: '−', identique: '=' };
const LIBELLES = { modifie: 'modifié', nouveau: 'nouveau', orphelin: 'orphelin', identique: 'identique' };

/**
 * Aide.js - la documentation de l'outil, dans l'outil.
 *
 * Parti pris : montrer plutôt que décrire. Chaque élément d'interface est
 * reproduit ici avec ses vraies classes CSS, donc avec ses vraies couleurs et
 * ses vrais glyphes. Ce qui est expliqué ressemble exactement à ce qui est à
 * l'écran, et le jour où une couleur change, l'aide change avec elle.
 *
 * Les démonstrations sont inertes : les boutons et les cases reproduits ne
 * réagissent pas au clic (voir `.aide-demo` dans styles.css).
 */

const SOMMAIRE = [
  {
    titre: 'Découvrir',
    entrees: [
      ['principe', "À quoi sert l'outil"],
      ['plan', "L'écran en un coup d'œil"],
      ['parcours', 'Le parcours, étape par étape']
    ]
  },
  {
    titre: "L'écran Analyse",
    entrees: [
      ['statuts', 'Les quatre statuts'],
      ['icones', 'Les icônes de fichier'],
      ['filtres', 'Chercher et filtrer'],
      ['arbre', "L'arborescence et la sélection"],
      ['palette', 'Aller au fichier (Ctrl+P)'],
      ['comparateur', 'Le comparateur'],
      ['editeur', "L'éditeur intégré"],
      ['bandeau', 'Le bandeau du bas']
    ]
  },
  {
    titre: 'Mettre en production',
    entrees: [
      ['destination', 'La destination AVMDF'],
      ['controles', 'Les contrôles préalables'],
      ['rapport', 'Le rapport'],
      ['historique', 'Historique et retour arrière'],
      ['versions', "Les versions d'un fichier"]
    ]
  },
  {
    titre: 'Le reste',
    entrees: [
      ['bord', 'Le tableau de bord'],
      ['reglages', 'Les réglages'],
      ['raccourcis', 'Raccourcis clavier'],
      ['garanties', "Ce que l'outil garantit"],
      ['depannage', 'En cas de problème'],
      ['glossaire', 'Glossaire']
    ]
  }
];

// ---------------------------------------------------------------------------
// Briques d'écriture
// ---------------------------------------------------------------------------

function Section({ id, titre, chapeau, children }) {
  return html`
    <section class="aide-section" id=${'aide-' + id}>
      <h2>${titre}</h2>
      ${chapeau ? html`<p class="aide-chapeau">${chapeau}</p>` : null}
      ${children}
    </section>
  `;
}

/** Encadré qui présente un morceau d'interface reproduit à l'identique. */
function Demo({ legende, children, large }) {
  return html`
    <figure class=${'aide-demo' + (large ? ' aide-demo-large' : '')}>
      <div class="aide-demo-scene">${children}</div>
      ${legende ? html`<figcaption>${legende}</figcaption>` : null}
    </figure>
  `;
}

/** Touche du clavier. */
function T({ children }) {
  return html`<kbd class="aide-touche">${children}</kbd>`;
}

/** Étape numérotée du tutoriel. */
function Etape({ numero, titre, children }) {
  return html`
    <div class="aide-etape">
      <div class="aide-etape-numero">${numero}</div>
      <div class="aide-etape-corps">
        <h3>${titre}</h3>
        ${children}
      </div>
    </div>
  `;
}

/** Tableau « élément → ce que c'est → ce que ça fait ». */
function Repere({ lignes, entetes }) {
  return html`
    <table class="tableau aide-tableau">
      <thead>
        <tr>
          ${entetes.map((entete, index) => html`<th key=${index}>${entete}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${lignes.map(
          (ligne, index) => html`
            <tr key=${index}>
              ${ligne.map((cellule, colonne) => html`<td key=${colonne}>${cellule}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
}

/** Une ligne d'arborescence reproduite, à l'identique de l'écran Analyse. */
function LigneArbre({ statut, nom, dossier, ouvert, coche, partiel, actif, decalage = 0, compteurs }) {
  return html`
    <div class=${'ligne' + (dossier ? ' ligne-dossier' : '') + (actif ? ' actif' : '')}>
      ${decalage ? html`<span class="ligne-indent" style=${'width:' + decalage * 13 + 'px'}></span>` : null}
      <input
        type="checkbox"
        class="ligne-case"
        checked=${Boolean(coche)}
        ref=${(element) => {
          if (element) element.indeterminate = Boolean(partiel);
        }}
        readonly
        tabindex="-1"
      />
      <span class=${'chevron' + (dossier ? '' : ' chevron-vide')}>${dossier ? (ouvert ? '▾' : '▸') : ''}</span>
      ${dossier
        ? html`<${IconeDossier} ouvert=${ouvert} classe="icone-dossier" />`
        : html`<${IconeFichier} extension=${nom} />`}
      <span class=${'ligne-nom' + (dossier ? ' dossier' : '')}>${nom}</span>
      ${compteurs
        ? html`<span class="ligne-compteurs">
            ${compteurs.map(
              ([cle, nombre]) => html`
                <span class=${'compteur compteur-' + cle} key=${cle}>${MARQUEURS[cle]}${nombre}</span>
              `
            )}
          </span>`
        : html`<span class=${'ligne-statut marqueur marqueur-' + statut} title=${'Fichier ' + LIBELLES[statut]}>
            ${MARQUEURS[statut]}
          </span>`}
    </div>
  `;
}

/** Une pastille de statut de la barre de filtres. */
function PastilleStatut({ statut, nom, nombre, actif }) {
  return html`
    <span class=${'statut statut-' + statut + (actif ? ' actif' : '')}>
      <span class="statut-marqueur">${MARQUEURS[statut]}</span>
      <span class="statut-nom">${nom}</span>
      <span class="statut-nombre">${nombre}</span>
    </span>
  `;
}

/** Une ligne du comparateur reproduite. */
function LigneDiff({ numero, type, signe, children }) {
  const signes = { identique: ' ', ajout: '+', suppression: '−', modification: '~' };
  return html`
    <div class=${'diff-ligne diff-' + type}>
      <span class="diff-numero">${numero}</span>
      <span class="diff-signe">${signe !== undefined ? signe : signes[type]}</span>
      <span class="diff-texte">${children}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------

/**
 * Écran Aide. Sommaire à gauche, contenu défilant à droite ; le sommaire suit
 * la lecture.
 */
export function Aide({ onVue, onOuvrirReglages, onOuvrirHistorique, onOuvrirJournal }) {
  const conteneur = useRef(null);
  const [courante, setCourante] = useState('principe');

  function allerA(id) {
    const boite = conteneur.current;
    if (!boite) return;
    const cible = boite.querySelector('#aide-' + id);
    if (!cible) return;
    const haut = Math.max(0, cible.offsetTop - 14);
    // Le défilement doux aide à garder ses repères sur un saut court ; sur la
    // longueur du document il ne fait plus qu'attendre.
    const doux =
      Math.abs(haut - boite.scrollTop) < 2200 &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    boite.scrollTo({ top: haut, behavior: doux ? 'smooth' : 'auto' });
    setCourante(id);
  }

  // Le sommaire suit la lecture : la section en cours est celle dont le titre
  // vient de passer sous le haut du cadre.
  useEffect(() => {
    const boite = conteneur.current;
    if (!boite) return undefined;
    const surDefilement = () => {
      const sections = boite.querySelectorAll('.aide-section');
      let vue = null;
      for (const section of sections) {
        if (section.offsetTop - 70 <= boite.scrollTop) vue = section;
      }
      if (!vue && sections.length) vue = sections[0];
      if (vue) setCourante(vue.id.slice('aide-'.length));
    };
    boite.addEventListener('scroll', surDefilement, { passive: true });
    return () => boite.removeEventListener('scroll', surDefilement);
  }, []);

  return html`
    <div class="aide">
      <nav class="aide-sommaire" aria-label="Sommaire de l'aide">
        <div class="aide-sommaire-titre">Sommaire</div>
        ${SOMMAIRE.map(
          (groupe) => html`
            <div class="aide-groupe" key=${groupe.titre}>
              <div class="aide-groupe-titre">${groupe.titre}</div>
              ${groupe.entrees.map(
                ([id, libelle]) => html`
                  <button
                    type="button"
                    class=${'aide-lien' + (courante === id ? ' actif' : '')}
                    key=${id}
                    aria-current=${courante === id ? 'true' : 'false'}
                    onClick=${() => allerA(id)}
                  >
                    ${libelle}
                  </button>
                `
              )}
            </div>
          `
        )}
      </nav>

      <div class="aide-contenu" ref=${conteneur}>
        <!-- ================================================== Principe -->
        <${Section}
          id="principe"
          titre="À quoi sert l'outil"
          chapeau="Comparer vos sources locales à ce qui tourne réellement sur le serveur, archiver ce qui va être écrasé, puis copier. Rien de plus, mais rien de moins."
        >
          <div class="aide-flux">
            <div class="aide-flux-boite">
              <div class="aide-flux-titre">Votre poste</div>
              <div class="mono attenue">E:\\F Guerrin\\Process\\GPNET</div>
              <div class="aide-flux-note">Les sources, telles que vous venez de les modifier.</div>
            </div>
            <div class="aide-flux-fleche">
              <span class="aide-flux-verbe">Analyser</span>
              <span class="fleche">↔</span>
              <span class="aide-flux-note">Comparaison des deux arborescences, à profondeur illimitée.</span>
            </div>
            <div class="aide-flux-boite">
              <div class="aide-flux-titre">Production (IIS)</div>
              <div class="mono attenue">Z:\\GPNet</div>
              <div class="aide-flux-note">Ce que voient les utilisateurs en ce moment.</div>
            </div>
          </div>

          <div class="aide-flux aide-flux-bas">
            <div class="aide-flux-boite aide-flux-archive">
              <div class="aide-flux-titre">Archives AVMDF</div>
              <div class="mono attenue">Z:\\AvMdf\\AVMDF4611\\Sprint2</div>
              <div class="aide-flux-note">
                Avant chaque écrasement, la version de production part ici. C'est ce qui rend le
                retour arrière possible.
              </div>
            </div>
          </div>

          <p>
            L'outil travaille sur des <strong>fichiers</strong>, pas sur des livraisons compilées : il
            ne construit rien, ne redémarre rien, ne publie rien. Il lit, il compare, il archive, il
            copie. Chaque passage laisse une trace écrite.
          </p>

          <div class="encart">
            <strong>Trois racines suffisent à tout situer.</strong> La racine locale (vos sources), la
            racine de production (le lecteur réseau du serveur IIS) et la racine des archives AVMDF.
            Tous les chemins affichés dans l'application se déduisent de ces trois-là.
          </div>
        <//>

        <!-- ====================================================== Plan -->
        <${Section}
          id="plan"
          titre="L'écran en un coup d'œil"
          chapeau="Cliquez sur une zone du plan pour ouvrir son explication."
        >
          <div class="aide-plan">
            <button type="button" class="aide-zone aire-entete" onClick=${() => allerA('parcours')}>
              <span class="aide-numero">1</span>
              <span class="aide-zone-nom">En-tête</span>
              <span class="aide-zone-texte">
                Onglets, projet comparé, les deux chemins mis face à face, le bouton Analyser, puis
                Historique, Journal et Réglages.
              </span>
            </button>

            <button type="button" class="aide-zone aire-filtres" onClick=${() => allerA('filtres')}>
              <span class="aide-numero">2</span>
              <span class="aide-zone-nom">Recherche et filtres</span>
              <span class="aide-zone-texte">Réduire la liste à ce qui vous intéresse.</span>
            </button>

            <button type="button" class="aide-zone aire-arbre" onClick=${() => allerA('arbre')}>
              <span class="aide-numero">3</span>
              <span class="aide-zone-nom">Arborescence des écarts</span>
              <span class="aide-zone-texte">
                Un marqueur par fichier, une case à cocher par fichier et par dossier. C'est ici que
                se compose ce qui partira.
              </span>
            </button>

            <button type="button" class="aide-zone aire-ignores" onClick=${() => allerA('reglages')}>
              <span class="aide-numero">4</span>
              <span class="aide-zone-nom">Éléments ignorés</span>
              <span class="aide-zone-texte">Ce que les exclusions ont écarté, et pourquoi.</span>
            </button>

            <button type="button" class="aide-zone aire-diff" onClick=${() => allerA('comparateur')}>
              <span class="aide-numero">5</span>
              <span class="aide-zone-nom">Comparateur</span>
              <span class="aide-zone-texte">
                Local à gauche, production à droite, ou l'inverse. Ligne à ligne, mot à mot, blancs
                compris.
              </span>
            </button>

            <button type="button" class="aide-zone aire-bandeau" onClick=${() => allerA('bandeau')}>
              <span class="aide-numero">6</span>
              <span class="aide-zone-nom">Bandeau de mise en production</span>
              <span class="aide-zone-texte">
                Combien de fichiers, vers quelle demande, en simulation ou pour de vrai.
              </span>
            </button>
          </div>

          <h3>Les trois onglets</h3>
          <${Repere}
            entetes=${['Onglet', 'Ce qu\'on y fait']}
            lignes=${[
              [
                html`<button type="button" class="onglet actif">Analyse</button>`,
                "Comparer, examiner les écarts, choisir et mettre en production. C'est l'écran de travail."
              ],
              [
                html`<button type="button" class="onglet">Tableau de bord</button>`,
                'Ce que racontent les mises en production passées : volumes, projets, auteurs, points chauds.'
              ],
              [
                html`<button type="button" class="onglet">Aide</button>`,
                'Cette page.'
              ]
            ]}
          />

          <h3>Les boutons de l'en-tête</h3>
          <${Repere}
            entetes=${['Bouton', 'Effet']}
            lignes=${[
              [
                html`<button type="button" class="btn">Analyser</button>`,
                html`Compare les deux arborescences. Raccourci <${T}>F5<//>. Grisé tant qu'aucune cible n'est définie.`
              ],
              [
                html`<button type="button" class="btn">Annuler l'analyse</button>`,
                "Remplace « Analyser » pendant le parcours. L'analyse s'arrête et rien n'est conservé."
              ],
              [
                html`<button type="button" class="btn btn-plat">Historique</button>`,
                'Tous les déploiements retrouvés dans les archives, avec le retour arrière.'
              ],
              [
                html`<button type="button" class="btn btn-plat">Journal</button>`,
                "Le fil des événements de l'application, un fichier par jour."
              ],
              [
                html`<button type="button" class="btn btn-carre"><${IconeSoleil} /></button>`,
                html`Bascule entre le thème sombre et le thème clair. L'icône montre le thème vers
                  lequel elle emmène : un soleil quand on est en sombre, une lune quand on est en
                  clair. Le choix est mémorisé sur le poste.`
              ],
              [
                html`<button type="button" class="btn">⚙ Réglages</button>`,
                'Racines, projets, exclusions, options de comparaison et de déploiement.'
              ]
            ]}
          />

          <p class="attenue">
            Entre le panneau de gauche et le comparateur, une fine poignée verticale permet de
            régler la largeur. Un double-clic dessus rétablit la largeur d'origine, et le réglage
            survit au redémarrage.
          </p>
        <//>

        <!-- ================================================== Parcours -->
        <${Section}
          id="parcours"
          titre="Le parcours, étape par étape"
          chapeau="Le trajet complet d'une mise en production, du premier réglage à la vérification finale."
        >
          <${Etape} numero="1" titre="Vérifier les réglages (une seule fois)">
            <p>
              Ouvrez <strong>⚙ Réglages</strong>. Renseignez les trois racines, puis déclarez vos
              projets : un dossier local en face d'un dossier de production. Les noms n'ont pas
              besoin de se ressembler, <span class="mono">GPNET</span> côté local peut viser${' '}
              <span class="mono">GPNet</span> côté prod.
            </p>
            <p class="attenue">
              Un dossier local qui n'apparaît dans aucun projet ne sera jamais ni analysé, ni
              déployé.
            </p>
          </${Etape}>

          <${Etape} numero="2" titre="Choisir le projet">
            <p>
              Dans l'en-tête, la liste <strong>Projet</strong> ne propose que les projets actifs.
              Juste à côté, les deux chemins effectivement comparés sont affichés en toutes lettres.
              Relisez-les : c'est la dernière occasion de repérer une racine mal saisie.
            </p>
          </${Etape}>

          <${Etape} numero="3" titre="Analyser">
            <p>
              <strong>Analyser</strong> ou <${T}>F5<//>. L'outil parcourt les deux arborescences en
              entier, compare taille, date, puis contenu quand il y a un doute, et range le résultat
              en quatre statuts. Une barre de progression indique où il en est, et l'analyse peut
              être interrompue à tout moment.
            </p>
            <p class="attenue">
              Rien n'est écrit pendant une analyse : c'est une lecture, uniquement une lecture.
            </p>
          </${Etape}>

          <${Etape} numero="4" titre="Regarder ce qui a changé">
            <p>
              Cliquez sur un fichier : le comparateur s'ouvre à droite, vos sources locales à
              gauche et la production à droite. Parcourez les écarts avec <${T}>F8<//>. Ne cochez
              rien que vous n'ayez regardé.
            </p>
          </${Etape}>

          <${Etape} numero="5" titre="Cocher ce qui doit partir">
            <p>
              Cochez les fichiers, ou la case d'un dossier pour prendre toute la branche d'un coup.
              Seuls les fichiers <span class="marqueur marqueur-modifie">M</span> modifiés et${' '}
              <span class="marqueur marqueur-nouveau">+</span> nouveaux partent en production ; les${' '}
              <span class="marqueur marqueur-orphelin">−</span> orphelins relèvent d'une opération
              distincte.
            </p>
          </${Etape}>

          <${Etape} numero="6" titre="Choisir la destination d'archivage">
            <p>
              Dans le bandeau du bas, <strong>Choisir la destination…</strong>. Indiquez le numéro de
              la demande de travaux, puis le dossier de sprint qui recevra les versions écrasées.
              L'outil lit le contenu réel du dossier d'archives et propose le nom qui suit la
              convention déjà en place.
            </p>
            <p class="attenue">
              Étape facultative si ce passage ne mérite pas d'archive. Une feuille de style ou une
              retouche sans enjeu : décochez <strong>Archiver</strong> dans le bandeau et vous pouvez
              partir sans demande du tout. Le passage devient alors définitif et ne laisse de trace
              que dans le journal.
            </p>
          </${Etape}>

          <${Etape} numero="7" titre="Simuler">
            <p>
              Laissez <strong>Simulation</strong> cochée et lancez. Tout se déroule à l'identique,
              contrôles préalables et empreintes compris, mais <strong>aucun octet n'est écrit</strong>.
              Le rapport final vous dit exactement ce qui se serait passé.
            </p>
          </${Etape}>

          <${Etape} numero="8" titre="Mettre en production pour de vrai">
            <p>
              Décochez <strong>Simulation</strong> : le bandeau change de teinte et affiche${' '}
              <span class="bandeau-etat reel">Écriture réelle</span>. Relancez, relisez le
              récapitulatif, puis saisissez le numéro de la demande pour confirmer. Il n'y a pas de
              simple bouton « OK » : c'est une mise en production.
            </p>
          </${Etape}>

          <${Etape} numero="9" titre="Vérifier">
            <p>
              Le rapport s'affiche : fichiers remplacés, créés, en échec, lignes ajoutées et
              supprimées, et les liens vers le manifeste et le récapitulatif.
            </p>
            <p>
              En le fermant, <strong>l'arborescence est déjà à jour</strong> : les fichiers partis
              sont passés en <span class="marqueur marqueur-identique">=</span> identiques et ont
              donc quitté la liste, les orphelins supprimés ont disparu, et seuls les fichiers en
              échec restent visibles. Il n'y a plus rien à relancer.
            </p>
            <p class="attenue">
              Ce n'est pas une supposition : le manifeste enregistre l'empreinte de ce qui vient
              d'être écrit, l'outil s'en sert plutôt que de reparcourir des milliers de fichiers
              sur le réseau pour réapprendre ce qu'il vient de faire lui-même. Une analyse complète
              reste évidemment possible par <${T}>F5<//> si vous voulez repartir du disque.
            </p>
          </${Etape}>
        <//>

        <!-- ================================================== Statuts -->
        <${Section}
          id="statuts"
          titre="Les quatre statuts"
          chapeau="Tout part de là. Chaque fichier reçoit exactement un statut, et le statut décide de ce qu'on peut en faire."
        >
          <${Repere}
            entetes=${['Marqueur', 'Statut', 'Ce que ça veut dire', 'Peut partir ?']}
            lignes=${[
              [
                html`<span class="marqueur marqueur-modifie">M</span>`,
                'modifié',
                'Présent des deux côtés, mais le contenu diffère.',
                html`<span class="aide-oui">oui</span>, il remplace la version de production`
              ],
              [
                html`<span class="marqueur marqueur-nouveau">+</span>`,
                'nouveau',
                "Présent en local, absent de la production.",
                html`<span class="aide-oui">oui</span>, il est créé en production`
              ],
              [
                html`<span class="marqueur marqueur-orphelin">−</span>`,
                'orphelin',
                'Présent en production, absent en local.',
                html`<span class="aide-part">à part</span> : suppression, jamais mélangée à un déploiement`
              ],
              [
                html`<span class="marqueur marqueur-identique">=</span>`,
                'identique',
                'Même contenu des deux côtés. Masqué par défaut.',
                html`<span class="aide-non">non</span>, il n'y a rien à faire`
              ]
            ]}
          />

          <${Demo} legende="Un dossier porte le statut le plus « chaud » de ce qu'il contient, et rappelle le détail à droite.">
            <div class="aide-arbre">
              <${LigneArbre} dossier ouvert nom="GPNET" compteurs=${[['modifie', 3], ['nouveau', 1], ['orphelin', 1]]} />
              <${LigneArbre} decalage=${1} statut="modifie" nom="Default.aspx" coche />
              <${LigneArbre} decalage=${1} statut="nouveau" nom="Suivi.aspx" coche actif />
              <${LigneArbre} decalage=${1} statut="orphelin" nom="ObsoleteOld.aspx" />
              <${LigneArbre} decalage=${1} statut="identique" nom="Site.master" />
            </div>
          <//>

          <div class="encart encart-alerte">
            <strong>Un orphelin n'est pas forcément une erreur.</strong> Ce peut être un fichier
            légitimement produit sur le serveur, ou un reste d'une ancienne version. Regardez avant
            de supprimer : la suppression est une opération à part entière, avec son propre
            archivage et son propre manifeste.
          </div>

          <div class="encart">
            <strong>Pourquoi certains fichiers n'apparaissent jamais.</strong> Les exclusions les
            écartent des deux côtés : dossiers de compilation, métadonnées de Visual Studio,${' '}
            <span class="mono">web.config</span>, et le code-behind VB des pages
            (<span class="mono">*.aspx.vb</span>, <span class="mono">*.aspx.designer.vb</span>) qui
            existe en local mais n'est jamais déposé sur le serveur. Le panneau${' '}
            <strong>Éléments ignorés</strong>, en bas à gauche, en donne la liste et la raison.
          </div>
        <//>

        <!-- =================================================== Icônes -->
        <${Section}
          id="icones"
          titre="Les icônes de fichier"
          chapeau="Chaque fichier porte la forme et la teinte de sa famille. La liste couvre tout : ce qui n'entre dans aucune famille reçoit l'icône générique, jamais rien."
        >
          <${Repere}
            entetes=${['Icône', 'Famille', 'Extensions reconnues']}
            lignes=${FAMILLES.map((famille) => [
              html`<span class="aide-icone-vedette"><${IconeFichier} extension=${famille.exemple} /></span>`,
              famille.libelle,
              famille.extensions.length
                ? html`<span class="mono aide-extensions">
                    ${famille.extensions.map((extension) => '.' + extension).join('  ')}
                  </span>`
                : html`<span class="attenue">
                    Toute extension non listée ci-dessus, et les fichiers sans extension.
                  </span>`
            ])}
          />

          <${Demo} legende="La même arborescence, telle qu'elle apparaît à l'écran." large>
            <div class="aide-arbre">
              <${LigneArbre} dossier ouvert nom="GPNET" compteurs=${[['modifie', 4], ['nouveau', 2]]} />
              <${LigneArbre} decalage=${1} statut="modifie" nom="Default.aspx" />
              <${LigneArbre} decalage=${1} statut="modifie" nom="Recherche.aspx.vb" />
              <${LigneArbre} decalage=${1} statut="nouveau" nom="Suivi.vue" />
              <${LigneArbre} decalage=${1} statut="modifie" nom="site.css" />
              <${LigneArbre} decalage=${1} statut="modifie" nom="gpnet.js" />
              <${LigneArbre} decalage=${1} statut="identique" nom="Web.sitemap" />
              <${LigneArbre} decalage=${1} statut="nouveau" nom="Rapports.sql" />
              <${LigneArbre} decalage=${1} statut="identique" nom="logo.png" />
              <${LigneArbre} decalage=${1} statut="identique" nom="LISEZMOI" />
            </div>
          <//>

          <div class="encart">
            <strong>La couleur dit le type, pas l'état.</strong> Le statut d'un fichier ne se lit
            plus sur son icône mais sur son marqueur, tout à droite de la ligne. Les deux
            informations ont chacune leur colonne, et l'œil n'a plus à démêler l'une de l'autre.
          </div>

          <p class="attenue">
            Une extension composée se résout sur sa dernière partie, ce qui est le bon
            comportement : <span class="mono">Default.aspx.vb</span> est du code serveur, pas une
            page. Les teintes restent dans les deux familles de l'identité, vert et gris-bleu,
            comme la coloration syntaxique du comparateur ; seuls les fichiers qui ne se lisent
            pas, binaires et archives, empruntent le rouge sourd.
          </p>
        <//>

        <!-- ================================================== Filtres -->
        <${Section}
          id="filtres"
          titre="Chercher et filtrer"
          chapeau="Tous les filtres se combinent en ET logique. Le compteur du bas rappelle en permanence combien de fichiers sont masqués."
        >
          <${Demo}
            legende="La barre de filtres. « Identiques » est éteinte au départ : les pastilles éteintes gardent leur nombre, mais leurs fichiers sont masqués."
            large
          >
            <div class="filtres" style="border-bottom:none;max-width:360px">
              <div class="filtres-recherche">
                <${IconeLoupe} classe="filtres-loupe" />
                <input type="search" class="mono" placeholder="Rechercher un chemin…" readonly />
                <select class="filtres-mode"><option>contient</option></select>
              </div>
              <div class="statuts">
                <${PastilleStatut} statut="modifie" nom="Modifiés" nombre="12" actif />
                <${PastilleStatut} statut="nouveau" nom="Nouveaux" nombre="3" actif />
                <${PastilleStatut} statut="orphelin" nom="Orphelins" nombre="1" actif />
                <${PastilleStatut} statut="identique" nom="Identiques" nombre="804" />
              </div>
              <span class="filtres-avances">
                <span class="chevron">▸</span>
                <${IconeEntonnoir} />
                <span>Filtres avancés</span>
                <span class="pastille">1</span>
              </span>
              <div class="filtres-resume">
                <span><strong>16</strong> sur 820 fichiers</span>
                <div style="flex:1"></div>
                <button type="button" class="btn btn-mini btn-plat btn-carre"><${IconeDeplier} /></button>
                <button type="button" class="btn btn-mini btn-plat btn-carre"><${IconeReplier} /></button>
                <button type="button" class="btn btn-mini">Réinitialiser</button>
              </div>
            </div>
          <//>

          <${Repere}
            entetes=${['Contrôle', 'Ce qu\'il fait']}
            lignes=${[
              [
                'Champ de recherche',
                'Filtre sur le chemin relatif du fichier. Insensible aux accents et à la casse.'
              ],
              [
                html`Mode <span class="mono">contient</span>`,
                'La chaîne se trouve quelque part dans le chemin. Le mode ordinaire.'
              ],
              [
                html`Mode <span class="mono">regex</span>`,
                html`Expression régulière. Une expression invalide est signalée en rouge sous le champ, et la liste reste vide tant qu'elle n'est pas corrigée.`
              ],
              [
                html`Mode <span class="mono">glob</span>`,
                html`Motif à jokers : <span class="mono">*</span> et <span class="mono">?</span> ne traversent pas les séparateurs, <span class="mono">**</span> les traverse. Exemple : <span class="mono">**\\Controles\\*.ascx</span>.`
              ],
              [
                html`Pastilles de statut`,
                'Une par statut : le marqueur, le mot entier, le nombre de fichiers. Un clic allume ou éteint le statut. Éteinte, la pastille reste lisible mais ses fichiers disparaissent de la liste. « Identiques » est éteinte au départ.'
              ],
              [
                html`<span class="filtres-avances"><span class="chevron">▸</span><${IconeEntonnoir} /><span>Filtres avancés</span></span>`,
                html`Replié tant qu'on ne s'en sert pas : c'est là que se trouvent la recherche dans le contenu, les extensions, les dates et la restriction à un dossier. Une <span class="pastille">1</span> sur le repli indique le nombre de filtres avancés actifs, pour qu'aucun ne se cache.`
              ],
              [
                'Chercher aussi dans le contenu',
                'Lit le contenu des fichiers texte des deux côtés. Plus lent, forcément : une progression s\'affiche et le parcours peut être annulé.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Extensions ▾</button>`,
                'Restreint à certaines extensions, avec le nombre de fichiers pour chacune. Le bouton se teinte de vert quand un filtre est actif.'
              ],
              [
                'Liste de dates',
                "Ne garde que les fichiers modifiés localement depuis aujourd'hui, 7 jours, 30 jours, ou une date choisie."
              ],
              [
                'Restreindre à un dossier',
                'Ne garde qu\'une branche. Le champ propose les dossiers rencontrés pendant l\'analyse.'
              ],
              [
                html`<button type="button" class="btn btn-mini btn-plat btn-carre"><${IconeDeplier} /></button> <button type="button" class="btn btn-mini btn-plat btn-carre"><${IconeReplier} /></button>`,
                'Déplient ou replient toute l\'arborescence d\'un coup.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Réinitialiser</button>`,
                'Remet tous les filtres à leur état de départ. Grisé quand il n\'y a rien à remettre.'
              ]
            ]}
          />

          <div class="encart">
            <strong>Un filtre actif déplie l'arbre automatiquement.</strong> Sans cela, les fichiers
            trouvés resteraient cachés dans des dossiers repliés et la recherche donnerait
            l'impression de ne rien trouver.
          </div>

          <h3>Les filtres composent la sélection</h3>
          <p>
            Sous le résumé, <button type="button" class="btn btn-mini">☑ Cocher les affichés</button>${' '}
            coche d'un coup tout ce que les filtres laissent voir. C'est le geste qui prépare un
            passage en deux temps : « modifiés depuis 7 jours » puis un clic, et la sélection est
            faite. Déploiement et suppression ne sont jamais mélangés : si l'affichage contient les
            deux, ce sont les fichiers à déployer qui sont cochés.${' '}
            <button type="button" class="btn btn-mini btn-plat">Tout décocher</button> vide la
            sélection, où que soient les fichiers cochés.
          </p>
          <p class="attenue">
            Les fichiers <strong>masqués au clic droit</strong> pour l'analyse en cours sont
            rappelés ici par une pastille « N masqués · Rétablir » : un clic les fait revenir, et la
            prochaine analyse repart de toute façon au complet.
          </p>
        <//>

        <!-- =================================================== Arbre -->
        <${Section}
          id="arbre"
          titre="L'arborescence et la sélection"
          chapeau="Le panneau de gauche est la liste de tout ce qui diffère. C'est là que se compose la mise en production."
        >
          <${Demo} legende="Cocher un dossier coche toute sa branche. Une case à moitié remplie signale une branche partiellement sélectionnée." large>
            <div class="aide-arbre">
              <${LigneArbre} dossier ouvert nom="GPNET" partiel compteurs=${[['modifie', 2], ['nouveau', 1]]} />
              <${LigneArbre} decalage=${1} dossier ouvert nom="Controles" coche compteurs=${[['modifie', 2]]} />
              <${LigneArbre} decalage=${2} statut="modifie" nom="Entete.ascx" coche />
              <${LigneArbre} decalage=${2} statut="modifie" nom="Menu.ascx" coche />
              <${LigneArbre} decalage=${1} dossier nom="Scripts" compteurs=${[['nouveau', 1]]} />
            </div>
          <//>

          <h3>Une ligne, de gauche à droite</h3>
          <${Repere}
            entetes=${['Élément', 'Ce que c\'est']}
            lignes=${[
              ['Traits verticaux', 'Les guides d\'indentation. Un trait par niveau : ils disent d\'un coup d\'œil à quelle profondeur on se trouve.'],
              [
                html`<input type="checkbox" checked readonly tabindex="-1" />`,
                'La case de sélection. Cochée pour un fichier retenu, à moitié remplie pour un dossier dont une partie seulement est retenue.'
              ],
              [html`<span class="chevron">▸</span> <span class="chevron">▾</span>`, 'Le repli du dossier. Absent sur un fichier, mais la place est gardée pour que tout reste aligné.'],
              [
                html`<span class="icone-dossier" style="display:inline-flex"><${IconeDossier} /></span> <span class="icone-dossier" style="display:inline-flex"><${IconeDossier} ouvert /></span>`,
                'Dossier fermé, dossier ouvert. Toujours en gris : la couleur est réservée aux fichiers.'
              ],
              [
                html`<span class="aide-icones-ligne">
                  <${IconeFichier} extension=".aspx" />
                  <${IconeFichier} extension=".vb" />
                  <${IconeFichier} extension=".css" />
                  <${IconeFichier} extension=".js" />
                  <${IconeFichier} extension=".png" />
                </span>`,
                html`Le type de fichier, déduit de son extension : une forme et une teinte par famille. Voir la légende complète dans${' '}<strong>Les icônes de fichier</strong>.`
              ],
              ['Le nom', 'En gras pour un dossier, normal pour un fichier. Le chemin complet apparaît au survol.'],
              [
                html`<span class="marqueur marqueur-modifie">M</span>`,
                'Le marqueur de statut, rejeté tout à droite. Les noms restent alignés à gauche, et les marqueurs forment une colonne que l\'œil relit d\'un seul mouvement.'
              ],
              [
                html`<span class="ligne-compteurs" style="display:inline-flex"><span class="compteur compteur-modifie">M2</span><span class="compteur compteur-nouveau">+1</span></span>`,
                'Sur un dossier, le marqueur cède la place au détail de la branche : combien de modifiés, de nouveaux, d\'orphelins.'
              ]
            ]}
          />

          <${Repere}
            entetes=${['Geste', 'Effet']}
            lignes=${[
              ['Clic sur un fichier', 'Ouvre la comparaison dans le panneau de droite.'],
              ['Clic sur un dossier', 'Le déplie ou le replie.'],
              ['Clic sur une case à cocher', 'Ajoute ou retire le fichier de la sélection, sans ouvrir la comparaison.'],
              [
                'Case à cocher d\'un dossier',
                'Coche ou décoche toute la branche visible. Une branche déjà engagée conserve sa nature : jamais de mélange entre déploiement et suppression.'
              ],
              ['Clic droit sur un fichier ou un dossier', 'Ouvre le menu contextuel décrit ci-dessous. Il n\'est pas le même sur un fichier et sur un dossier.'],
              [html`<${T}>↑<//> <${T}>↓<//>`, 'Déplacent le curseur dans la liste.'],
              [html`<${T}>→<//> <${T}>←<//>`, 'Déplient et replient le dossier sous le curseur.'],
              [html`<${T}>Espace<//>`, 'Coche ou décoche la ligne sous le curseur, branche entière pour un dossier.'],
              [html`<${T}>Entrée<//>`, 'Ouvre la comparaison du fichier sous le curseur.'],
              [
                html`<${T}>Maj<//> + clic sur une case`,
                'Coche toute la plage depuis la dernière case cochée jusqu\'à celle-ci. Toujours cocher, jamais basculer : une plage se constitue, elle ne se devine pas. La règle de non-mélange déploiement / suppression s\'applique aussi ici.'
              ]
            ]}
          />

          <h3>Le menu du clic droit</h3>
          <${Demo} legende="Chaque côté a ses deux entrées : ouvrir le fichier, ou le montrer dans l'explorateur.">
            <div class="aide-menu">
              <div class="menu-titre mono">GPNET\\Controles\\Entete.ascx</div>
              <button type="button" class="menu-entree">Modifier la version locale</button>
              <button type="button" class="menu-entree">Ouvrir la version locale</button>
              <button type="button" class="menu-entree">Ouvrir la version production</button>
              <div class="menu-separateur"></div>
              <button type="button" class="menu-entree">Afficher le local dans l'explorateur</button>
              <button type="button" class="menu-entree">Afficher la production dans l'explorateur</button>
              <div class="menu-separateur"></div>
              <button type="button" class="menu-entree">Réanalyser ce fichier</button>
              <button type="button" class="menu-entree">Copier le chemin relatif</button>
              <button type="button" class="menu-entree">Voir les versions archivées</button>
              <div class="menu-separateur"></div>
              <button type="button" class="menu-entree">Masquer pour cette analyse</button>
              <button type="button" class="menu-entree danger">Exclure ce fichier</button>
            </div>
          <//>

          <${Repere}
            entetes=${['Entrée', 'Effet']}
            lignes=${[
              ['Modifier la version locale', 'Ouvre le fichier dans l\'éditeur intégré (voir la section dédiée).'],
              ['Ouvrir la version locale / production', 'Ouvre le fichier avec le programme associé sur votre poste. Grisé si le fichier n\'existe pas de ce côté.'],
              [
                'Afficher le local / la production dans l\'explorateur',
                html`Ouvre l'explorateur Windows sur le dossier contenant et y sélectionne le
                  fichier. Les deux côtés ont leur entrée : aucune ne se rabat sur l'autre, pour
                  qu'on sache toujours quelle arborescence on a sous les yeux. Grisée si le fichier
                  n'existe pas de ce côté.`
              ],
              [
                'Réanalyser ce fichier',
                'Relit la taille et l\'empreinte de ce seul fichier, des deux côtés, sans relancer toute l\'analyse. Le statut se recale immédiatement : après un verrou corrigé ou une retouche faite hors de l\'outil, inutile de relire tout le partage.'
              ],
              ['Copier le chemin relatif', 'Met le chemin dans le presse-papiers, prêt à coller dans un compte rendu.'],
              ['Voir les versions archivées', 'Toutes les versions « avant modification » de ce fichier retrouvées sous la racine AVMDF.'],
              [
                'Masquer pour cette analyse',
                'Écarte le fichier de la vue sans toucher aux réglages. La barre de filtres affiche « N masqués · Rétablir », et la prochaine analyse repart au complet. Pour faire le tri dans le bruit d\'un jour, sans rien engager.'
              ],
              [
                html`<span class="aide-danger-texte">Exclure ce fichier</span>`,
                'Ajoute son nom aux fichiers exclus des réglages. Effet immédiat sur les analyses suivantes, mais pas sur l\'analyse en cours.'
              ]
            ]}
          />

          <h3>Le clic droit sur un dossier</h3>
          <p>
            Un dossier a son propre menu. On y va voir le dossier réel de chaque côté, on copie son
            chemin, et surtout <strong>on l'écarte entièrement de la comparaison</strong> : un
            dossier de ressources générées, une réserve d'anciennes versions, un répertoire qui
            n'a pas à être comparé.
          </p>
          <${Demo} legende="Deux façons d'exclure, et la différence compte.">
            <div class="aide-menu">
              <div class="menu-titre mono">GPNET\\Controles\\Images</div>
              <button type="button" class="menu-entree">Afficher le dossier local dans l'explorateur</button>
              <button type="button" class="menu-entree">Afficher le dossier production dans l'explorateur</button>
              <div class="menu-separateur"></div>
              <button type="button" class="menu-entree">Copier le chemin relatif</button>
              <div class="menu-separateur"></div>
              <button type="button" class="menu-entree">Masquer cette branche pour cette analyse</button>
              <button type="button" class="menu-entree danger">Exclure ce dossier seulement ici</button>
              <button type="button" class="menu-entree danger">Exclure tous les dossiers « Images »</button>
            </div>
          <//>

          <${Repere}
            entetes=${['Entrée', 'Motif ajouté aux réglages', 'Portée']}
            lignes=${[
              [
                html`<span class="aide-danger-texte">Exclure ce dossier seulement ici</span>`,
                html`<span class="mono">Controles\\Images</span>`,
                'Ce dossier-là, à cet endroit-là. Les autres dossiers du même nom ailleurs dans l\'arborescence restent comparés.'
              ],
              [
                html`<span class="aide-danger-texte">Exclure tous les dossiers « … »</span>`,
                html`<span class="mono">Images</span>`,
                'Tout dossier portant ce nom, à n\'importe quelle profondeur, des deux côtés.'
              ]
            ]}
          />
          <p class="attenue">
            Sur un dossier de premier niveau, les deux motifs seraient identiques : une seule entrée
            est alors proposée. Le motif exact est rappelé au survol de l'entrée, puis dans la
            notification : c'est lui qu'on retrouvera dans <strong>Dossiers exclus</strong>, et
            c'est de là qu'on le retire pour revenir en arrière.
          </p>
          <div class="encart">
            <strong>Un dossier exclu n'est jamais parcouru</strong>, ni côté local ni côté
            production. Ce qu'il contient ne peut donc ni apparaître dans la liste, ni partir en
            production, ni être supprimé. L'analyse en cours ne bouge pas : relancez-la avec${' '}
            <${T}>F5<//> pour la voir se réduire.
          </div>

          <h3>Éléments ignorés</h3>
          <p>
            Sous l'arborescence, un bandeau repliable liste ce que le parcours a écarté : dossiers
            exclus, fichiers exclus, entrées illisibles. Chaque ligne indique le côté concerné et la
            raison. Un fichier qui « manque » à l'appel se retrouve presque toujours là.
          </p>
        <//>

        <!-- ================================================= Palette -->
        <${Section}
          id="palette"
          titre="Aller au fichier (Ctrl+P)"
          chapeau="Trois lettres, Entrée, et la comparaison s'ouvre. Le détour par les dossiers repliés de l'arborescence devient facultatif."
        >
          <p>
            <${T}>Ctrl<//> + <${T}>P<//> ouvre une palette au-dessus de l'analyse. Tapez un morceau
            du nom ou du chemin : la recherche est insensible à la casse et aux accents, et tolère
            les trous - <span class="mono">rchaspx</span> trouve${' '}
            <span class="mono">Principal\\Recherche.aspx</span>. Les lettres retenues sont
            surlignées dans chaque résultat.
          </p>
          <ul class="aide-liste">
            <li>
              Les correspondances exactes passent toujours devant les correspondances à trous, et le
              nom du fichier pèse plus lourd que son chemin.
            </li>
            <li>
              Palette vide, les fichiers s'ordonnent par statut : les écarts d'abord, les identiques
              en dernier.
            </li>
            <li>
              <${T}>↑<//> <${T}>↓<//> pour choisir, <${T}>Entrée<//> pour ouvrir la comparaison,${' '}
              <${T}>Échap<//> pour refermer.
            </li>
          </ul>
        <//>

        <!-- ============================================== Comparateur -->
        <${Section}
          id="comparateur"
          titre="Le comparateur"
          chapeau="Par défaut vos sources locales à gauche, ce qui va partir, et la production à droite, ce qui existe. Le bouton ⇄ intervertit les deux côtés, et le choix est mémorisé."
        >
          <${Demo} legende="Vue côte à côte, dans l'ordre par défaut. Les fragments surlignés en vert signalent ce qui change à l'intérieur de la ligne." large>
            <div class="aide-diff">
              <div class="aide-diff-colonne">
                <div class="diff-titre"><span>Local</span><span class="attenue mono">UTF-8 · CRLF</span></div>
                <${LigneDiff} numero="41" type="identique">  Dim total As Integer = 0<//>
                <${LigneDiff} numero="42" type="modification">  If <span class="fragment">quantiteReelle</span> > 0 Then<//>
                <${LigneDiff} numero="43" type="absente" signe="">${''}<//>
                <${LigneDiff} numero="44" type="identique">  End If<//>
              </div>
              <div class="aide-diff-colonne">
                <div class="diff-titre"><span>Production</span><span class="attenue mono">UTF-8 · CRLF</span></div>
                <${LigneDiff} numero="41" type="identique">  Dim total As Integer = 0<//>
                <${LigneDiff} numero="42" type="modification">  If <span class="fragment">quantite</span> > 0 Then<//>
                <${LigneDiff} numero="43" type="suppression">    total = total + 1<//>
                <${LigneDiff} numero="44" type="identique">  End If<//>
              </div>
            </div>
          <//>

          <div class="encart">
            <strong>Intervertir les colonnes ne change pas le sens des signes.</strong> La
            comparaison se calcule toujours dans le sens production → local :${' '}
            <span class="aide-signe plus">+</span> reste ce qui sera <strong>ajouté</strong> en
            production et <span class="aide-signe moins">−</span> ce qui en sera${' '}
            <strong>retiré</strong>, quel que soit l'ordre d'affichage. Seule la place des deux
            colonnes bouge. Le titre de chaque colonne dit toujours laquelle vous regardez.
          </div>
          <p class="attenue">
            Le bouton ⇄ n'apparaît que sur la comparaison de l'analyse, en vue côte à côte. Les
            comparaisons de l'historique et des versions archivées, qui n'opposent pas du local à
            de la production, gardent leur ordre propre.
          </p>

          <h3>Les signes en début de ligne</h3>
          <${Repere}
            entetes=${['Signe', 'Fond', 'Sens']}
            lignes=${[
              [html`<span class="aide-signe plus">+</span>`, 'vert sombre', 'Ligne ajoutée : elle n\'existe qu\'en local.'],
              [html`<span class="aide-signe moins">−</span>`, 'rouge sombre', 'Ligne supprimée : elle n\'existe qu\'en production.'],
              [html`<span class="aide-signe tilde">~</span>`, 'bleu-gris', 'Ligne modifiée : présente des deux côtés, contenu différent.'],
              [html`<span class="aide-signe espace">␣</span>`, 'bleu-gris', 'Seuls les blancs changent sur cette ligne. Le code, lui, est identique.'],
              [html`<span class="aide-signe">·</span>`, 'noirci', 'Aucune ligne de ce côté : la place est tenue pour garder les deux panneaux alignés.']
            ]}
          />

          <h3>Les boutons du comparateur</h3>
          <${Repere}
            entetes=${['Bouton', 'Effet']}
            lignes=${[
              [
                html`<button type="button" class="btn btn-mini btn-marque">✎ Modifier</button>`,
                'Ouvre la version locale dans l\'éditeur intégré, pour la retouche de dernière minute. Voir la section suivante.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Copier le diff</button>`,
                'Copie la comparaison affichée au format patch : une ligne par ligne, préfixée de son signe. Prêt à coller dans un message ou une demande de travaux.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Versions archivées</button>`,
                'Ouvre toutes les versions « avant modification » de ce fichier, et permet d\'en remettre une en production.'
              ],
              [
                html`<button type="button" class="btn btn-mini">¶ Espaces</button>`,
                html`Rend chaque blanc visible : <span class="blanc">·</span> espace, <span class="blanc">→   </span> tabulation, <span class="blanc">⍽</span> espace insécable. Les blancs en fin de ligne sont teintés en rouge.`
              ],
              [
                html`<button type="button" class="btn btn-mini btn-marque">Couleur</button>`,
                'Coloration syntaxique, déduite de l\'extension du fichier. Un fichier trop volumineux n\'est pas coloré, et le bouton le dit.'
              ],
              [
                html`<button type="button" class="btn btn-mini btn-marque">Guides</button>`,
                'Traits verticaux reliant chaque balise ouvrante à sa fermante, d\'après la structure réelle du code. N\'apparaît que sur les fichiers à balises.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Changement suivant (F8)</button>`,
                html`Saute au changement suivant. <${T}>Maj<//> + <${T}>F8<//> pour revenir en arrière.`
              ],
              [
                html`<button type="button" class="btn btn-mini">⇄ Inverser</button>`,
                'Intervertit les deux colonnes. Le titre de chaque colonne dit toujours laquelle vous regardez, et le choix est mémorisé d\'une session à l\'autre.'
              ],
              [
                html`<label class="case"><input type="checkbox" checked readonly tabindex="-1" /><span>Défilement lié</span></label>`,
                'Aligne le défilement des deux panneaux. À décocher pour examiner deux endroits éloignés.'
              ],
              [
                html`<button type="button" class="btn btn-mini">Unifié</button>`,
                'Bascule entre les deux colonnes et une colonne unique où suppressions et ajouts se suivent.'
              ],
              [
                html`<span><button type="button" class="btn btn-mini">A−</button> <button type="button" class="btn btn-mini">A+</button></span>`,
                'Réduit ou agrandit le corps de texte de la comparaison. Le choix est mémorisé d\'une session à l\'autre.'
              ]
            ]}
          />

          <h3>La mini-carte des changements</h3>
          <p>
            Le long du bord droit, une colonne de quelques pixels dessine la
            <strong>silhouette du fichier</strong> : un trait vert par bloc ajouté, rouge sourd par
            bloc supprimé, gris-bleu par bloc modifié, chacun à sa hauteur relative. D'un coup
            d'œil : où ça change, et combien. Un clic dans la colonne saute à l'endroit visé.
          </p>
          <p class="attenue">
            À l'ouverture d'un fichier, la vue se place d'elle-même sur le premier changement -
            c'est lui qu'on est venu voir - et <span class="aide-touche">F8</span> enchaîne sur le
            suivant.
          </p>

          <h3>Ce que l'en-tête vous dit d'autre</h3>
          <p>
            À côté du chemin, <span class="mono"><span class="plus">+12</span>
            <span class="moins">−4</span></span> donne le nombre de lignes ajoutées et supprimées.
            Sous chaque titre de colonne, l'encodage, les fins de ligne et le type d'indentation du
            fichier. Un bandeau d'avertissement apparaît quand ces trois-là diffèrent entre les deux
            côtés.
          </p>

          <${Demo} legende="Ces écarts sont signalés parce qu'ils font apparaître des différences qui n'en sont pas vraiment.">
            <div class="diff-alerte">
              <span>Encodages différents : Windows-1252 en production, UTF-8 en local.</span>
              <span>3 lignes ne diffèrent que par les blancs (marquées ␣).</span>
              <span class="attenue">La copie reste binaire : rien n'est ré-encodé.</span>
            </div>
          <//>

          <div class="encart">
            <strong>Le comparateur affiche, il ne transforme pas.</strong> Ce que vous voyez à droite
            est ce qui sera copié, octet pour octet. Aucune conversion d'encodage, aucune
            normalisation de fins de ligne, jamais.
          </div>

          <h3>Les cas particuliers</h3>
          <${Repere}
            entetes=${['Situation', 'Ce qui s\'affiche']}
            lignes=${[
              [
                'Fichier binaire',
                'Pas de comparaison ligne à ligne : un tableau taille / date / empreinte SHA-256 des deux côtés, et deux boutons pour ouvrir chaque version.'
              ],
              [
                'Fichier trop volumineux',
                'Au-delà de la limite d\'affichage, le comparateur propose d\'ouvrir les deux versions dans votre éditeur.'
              ],
              [
                'Très gros écart',
                'Au-delà de 6 000 lignes affichées, la vue est tronquée et le dit. Trop de lignes modifiées : le surlignage mot à mot se désactive de lui-même.'
              ],
              [
                html`<button type="button" class="diff-repli">⋯ 128 lignes identiques</button>`,
                'Les longues plages sans changement sont repliées. Un clic les déplie.'
              ]
            ]}
          />

          <p class="attenue">
            <${T}>Ctrl<//> + <${T}>F<//> ouvre une recherche dans la comparaison affichée, avec le
            compte des occurrences et deux flèches pour les parcourir. <${T}>Échap<//> la referme.
          </p>
        <//>

        <!-- ================================================== Éditeur -->
        <${Section}
          id="editeur"
          titre="L'éditeur intégré"
          chapeau="Le libellé oublié, le commentaire à retirer, la constante à corriger : la retouche de dernière minute se fait sans quitter l'outil, et sans risquer l'enveloppe du fichier."
        >
          <p>
            Le bouton <button type="button" class="btn btn-mini btn-marque">✎ Modifier</button> du
            comparateur - ou « Modifier la version locale » dans le clic droit de l'arborescence -
            ouvre la version <strong>locale</strong> du fichier en plein écran : numéros de ligne,
            coloration syntaxique, <${T}>Ctrl<//> + <${T}>S<//> pour enregistrer. La production et
            les archives, elles, ne s'éditent jamais.
          </p>

          <div class="encart">
            <strong>Le fichier ressort dans son enveloppe d'origine.</strong> Encodage, BOM et fins
            de ligne sont redétectés au moment d'écrire et conservés à l'identique : un fichier
            Windows-1252 reste en Windows-1252, un BOM reste un BOM. Le résultat est indiscernable
            d'une retouche faite dans Visual Studio.
          </div>

          <h3>Ce que l'éditeur refuse de faire</h3>
          <ul class="aide-liste">
            <li>
              <strong>Écrire un « ? » à la place d'un caractère.</strong> Si le fichier est en
              Windows-1252 et qu'un caractère saisi n'y existe pas (une flèche <span class="mono">→</span>,
              un émoji), l'enregistrement est refusé et les caractères fautifs sont nommés. À vous
              de les remplacer - l'outil ne change jamais l'encodage d'un fichier en douce.
            </li>
            <li>
              <strong>Écraser une modification faite ailleurs.</strong> Si le fichier a changé sur le
              disque depuis l'ouverture de l'éditeur - Visual Studio resté ouvert, par exemple -
              l'enregistrement est bloqué au lieu de faire disparaître ce travail.
            </li>
            <li>
              <strong>Éditer ce qui n'est pas du texte.</strong> Binaires et extensions hors de la
              liste « texte » des réglages restent l'affaire de leurs programmes.
            </li>
          </ul>

          <p>
            Après un enregistrement, l'analyse suit toute seule : le statut du fichier est recalculé
            sur ce qui vient d'être écrit - une retouche peut le faire passer à « identique », et il
            sort alors de la liste des écarts - et la comparaison affichée se recharge. Seule
            retouche jamais faite d'office : un fichier aux fins de ligne <em>mixtes</em> ressort
            uniformisé en CRLF, et l'éditeur l'annonce avant.
          </p>
        <//>

        <!-- ================================================== Bandeau -->
        <${Section}
          id="bandeau"
          titre="Le bandeau du bas"
          chapeau="L'état exact de ce qui part et où, visible en permanence. Il change de teinte dès que la simulation est désactivée."
        >
          <${Demo} legende="En simulation : le processus se déroule en entier, aucun octet n'est écrit." large>
            <footer class="bandeau aide-bandeau">
              <div class="bandeau-resume">
                <span class="bandeau-nombre">16</span>
                <span>fichiers sélectionnés</span>
                <span class="fleche">→</span>
                <button type="button" class="bandeau-destination mono">Z:\\AvMdf\\AVMDF4611\\Sprint2</button>
              </div>
              <div class="bandeau-actions">
                <span class="bandeau-etat simulation">Simulation</span>
                <label class="case"><input type="checkbox" checked readonly tabindex="-1" /><span>Simulation</span></label>
                <button type="button" class="btn btn-accent">Mettre en production</button>
              </div>
            </footer>
          <//>

          <${Demo} legende="En écriture réelle : le bandeau se teinte, et cette teinte est le seul rappel dont vous disposez." large>
            <footer class="bandeau reel aide-bandeau">
              <div class="bandeau-resume">
                <span class="bandeau-nombre">16</span>
                <span>fichiers sélectionnés</span>
                <span class="fleche">→</span>
                <button type="button" class="bandeau-destination mono">Z:\\AvMdf\\AVMDF4611\\Sprint2</button>
              </div>
              <div class="bandeau-actions">
                <span class="bandeau-etat reel">Écriture réelle</span>
                <label class="case"><input type="checkbox" checked readonly tabindex="-1" /><span>Archiver</span></label>
                <label class="case"><input type="checkbox" readonly tabindex="-1" /><span>Simulation</span></label>
                <button type="button" class="btn btn-accent">Mettre en production</button>
              </div>
            </footer>
          <//>

          <h3>Les deux cases</h3>
          <${Repere}
            entetes=${['Case', 'Cochée', 'Décochée']}
            lignes=${[
              [
                html`<label class="case"><input type="checkbox" checked readonly tabindex="-1" /><span>Simulation</span></label>`,
                "Tout le processus se déroule, le rapport complet est produit, aucun octet n'est écrit.",
                'Les fichiers partent réellement en production. Le bandeau se teinte en vert.'
              ],
              [
                html`<label class="case"><input type="checkbox" checked readonly tabindex="-1" /><span>Archiver</span></label>`,
                "La version de production est copiée dans le dossier de sprint avant d'être écrasée. C'est le comportement normal.",
                html`Rien n'est conservé de l'existant. Le bandeau affiche <span class="bandeau-etat sans-archive">Sans AVMDF</span> et <strong>le retour arrière devient impossible</strong> pour ce passage.`
              ]
            ]}
          />

          <h3>Le compteur s'ouvre : le plan de vol</h3>
          <p>
            Le compteur du bandeau est un bouton. Il déplie la <strong>liste exacte de ce qui
            part</strong> - marqueur de statut, chemin, taille - avec, pour chaque fichier, une
            croix pour le retirer de la sélection sans aller le rechercher dans l'arborescence.
            En tête, le volume total, <strong>Copier la liste</strong> (un chemin par ligne, prêt à
            coller dans un message d'annonce) et <strong>Tout décocher</strong>. C'est la dernière
            relecture avant d'appuyer sur le bouton.
          </p>

          <h3>Se passer de l'archivage AVMDF</h3>
          <p>
            Toutes les mises en production ne méritent pas leur dossier d'archives. Une feuille de
            style, une correction d'affichage, une retouche sans enjeu : décocher${' '}
            <strong>Archiver</strong> évite d'encombrer la demande de copies dont personne n'aura
            jamais besoin.
          </p>
          <p>
            <strong>La case gouverne tout le versant AVMDF.</strong> Décochée, la demande n'est plus
            demandée, plus lue, et plus rien ne s'écrit sous la racine des archives : ni les
            versions remplacées, ni le manifeste qui les recense. On ne vous demande plus d'ouvrir
            une demande de travaux pour pousser une feuille de style. Le dossier d'archives n'est
            même pas consulté, et le lecteur réseau peut être déconnecté sans que cela empêche quoi
            que ce soit.
          </p>
          <p class="attenue">
            Une destination choisie avant de décocher est simplement mise de côté : le bandeau
            affiche « aucun archivage » à sa place, et elle revient si la case est recochée. La
            confirmation ne parle alors plus de demande du tout et se valide en recopiant le nombre
            de fichiers.
          </p>
          <div class="encart encart-danger">
            <strong>Ce qui se perd, se perd.</strong> Sans copie de sauvegarde, il n'y a rien à
            remettre. Sans manifeste, le passage n'apparaît ni dans l'historique ni dans le tableau
            de bord : seul le journal en garde la ligne, et le rapport final reste affiché à
            l'écran. Dans le doute, laissez la case cochée.
          </div>
          <p class="attenue">
            La case revient d'elle-même à « cochée » après chaque mise en production réelle : le
            choix se refait à chaque passage, il ne se subit pas. Et si un lot mélange des fichiers
            sans enjeu et des fichiers à conserver, faites deux passages : c'est la seule façon de
            garder un manifeste dont on sait s'il est réversible ou non.
          </p>

          <h3>Quand le bouton reste grisé</h3>
          <p>
            La raison est toujours écrite juste à gauche du bouton. Il n'y en a que quatre :
          </p>
          <${Repere}
            entetes=${['Message', 'Ce qu\'il faut faire']}
            lignes=${[
              ['Cochez au moins un fichier dans l\'arborescence.', 'La sélection est vide.'],
              [
                'Ne mélangez pas déploiement et suppression : traitez les orphelins à part.',
                'Votre sélection contient à la fois des fichiers à déployer et des orphelins. Faites deux passages.'
              ],
              [
                'Choisissez d\'abord la demande et le dossier de sprint.',
                html`Aucune destination d'archivage n'est encore désignée. Ce blocage tombe si vous décochez${' '}<strong>Archiver</strong> : sans archive, la demande devient facultative.`
              ],
              [
                'La comparaison libre ne permet pas de mise en production.',
                'Le mode libre compare deux dossiers quelconques, hors du cadre AVMDF. Revenez aux projets pour déployer.'
              ]
            ]}
          />

          <p class="attenue">
            Quand la sélection ne contient que des orphelins, le bouton devient${' '}
            <span class="aide-danger-texte">Supprimer en production</span> et prend la teinte rouge.
            Le geste n'est pas le même, l'outil ne le laisse pas croire.
          </p>
        <//>

        <!-- ============================================== Destination -->
        <${Section}
          id="destination"
          titre="La destination AVMDF"
          chapeau="Où seront rangées les versions de production que vous allez écraser. Le contenu réel du dossier d'archives fait foi : la convention en place est détectée, jamais devinée."
        >
          <h3>La demande de travaux</h3>
          <p>
            Choisissez un numéro dans la liste des demandes existantes, ou saisissez-en un
            directement. Un numéro inconnu n'est pas une erreur : l'outil propose de créer le dossier${' '}
            <span class="mono">AVMDF&lt;numéro&gt;</span> sous la racine des archives, après
            confirmation.
          </p>

          <h3>Le dossier de sprint</h3>
          <p>
            C'est le sous-dossier qui recevra les fichiers de ce passage. L'outil regarde ce qui
            existe déjà dans la demande et vous propose le nom suivant.
          </p>
          <${Repere}
            entetes=${['Convention détectée', 'Ce que ça veut dire']}
            lignes=${[
              [html`<span class="mono">Sprint1, Sprint2…</span>`, 'La demande est organisée en sprints numérotés. Le suivant vous est proposé.'],
              [html`<span class="mono">_1, _2…</span>`, 'La demande utilise un suffixe numéroté. Même principe.'],
              ['ancienne organisation', 'Les fichiers sont posés directement à la racine de la demande. Ils ne sont pas touchés ; le nouveau dossier vient à côté.'],
              ['demande vide', 'Rien encore dedans : à vous de choisir la convention, elle vaudra pour la suite.'],
              [
                html`<span class="aide-alerte-texte">deux conventions mélangées</span>`,
                'Les deux coexistent déjà. Choisissez celle que vous voulez poursuivre et tenez-vous-y : l\'outil refuse de mélanger davantage.'
              ]
            ]}
          />

          <div class="encart encart-alerte">
            <strong>Si le dossier de sprint existe déjà et contient des fichiers</strong>, l'outil le
            signale sans l'interdire : un sprint peut légitimement être complété en plusieurs
            passages. Les archives déjà présentes ne sont jamais écrasées, la version « avant
            modification » d'origine est conservée.
          </div>

          <p>
            Le chemin résolu s'affiche en bas de l'écran avant validation. C'est exactement là que
            les fichiers seront rangés, avec leur arborescence relative reconstituée.
          </p>
        <//>

        <!-- ================================================= Contrôles -->
        <${Section}
          id="controles"
          titre="Les contrôles préalables"
          chapeau="Tout ce qui peut être vérifié avant la première écriture l'est. Mieux vaut échouer maintenant qu'à mi-parcours, la moitié des fichiers déployés."
        >
          <h3>Ce qui bloque</h3>
          <p>Un point bloquant refuse la mise en production. Sans exception.</p>
          <${Repere}
            entetes=${['Contrôle', 'Que faire']}
            lignes=${[
              ['Racine inaccessible', 'Le lecteur réseau n\'est pas connecté, ou vous n\'y avez pas accès. Reconnectez-le et relancez.'],
              ['Destination hors périmètre', 'Une écriture viserait un endroit hors de la racine de production ou hors des archives. Relancez une analyse.'],
              ['Écriture impossible dans le dossier de sauvegarde', 'Droits insuffisants sur le dossier d\'archives. Un fichier témoin est réellement créé puis effacé pour le vérifier.'],
              ['Fichier source disparu depuis l\'analyse', 'Quelque chose a bougé sur votre poste. Relancez une analyse.'],
              [
                'Fichier impossible à remplacer',
                html`L'outil a essayé d'ouvrir le fichier de production en écriture, sans rien modifier, et le système a dit non. Le message précise laquelle des trois causes c'est, et le code d'erreur. Voir${' '}<strong>En cas de problème</strong>.`
              ],
              [
                'Fichier changé en production depuis votre analyse',
                'Quelqu\'un d\'autre est passé par là. Relancez une analyse pour repartir de l\'état réel : écraser à l\'aveugle ferait perdre son travail.'
              ],
              ['Espace insuffisant', 'Libérez de la place sur le serveur.']
            ]}
          />

          <h3>Ce qui avertit</h3>
          <p>Un avertissement laisse passer, mais demande à être lu.</p>
          <${Repere}
            entetes=${['Avertissement', 'Ce qu\'il signifie']}
            lignes=${[
              [
                html`Remplacement de <span class="mono">web.config</span>`,
                'La chaîne de connexion et les réglages de production vont être écrasés par ceux de votre poste. C\'est presque toujours une erreur.'
              ],
              [
                'Archivage AVMDF écarté',
                'Vous avez décoché « Archiver » : les versions de production seront écrasées sans copie de sauvegarde, et ce passage ne pourra pas être annulé. La liste des fichiers concernés est donnée.'
              ],
              [
                'Sans archivage, ni manifeste ni récapitulatif',
                'Rien ne sera écrit dans les archives : ce passage n\'apparaîtra ni dans l\'historique ni dans le tableau de bord, seul le journal en gardera la ligne. Recochez « Archiver » si vous voulez le retrouver plus tard.'
              ],
              ['Fichier source modifié depuis l\'analyse', 'C\'est la version actuelle qui partira, pas celle que vous avez examinée.'],
              ['Espace disponible non mesurable', 'Le partage n\'a pas répondu à la question. Vérifiez à l\'œil qu\'il reste de la place.']
            ]}
          />

          <p>
            Un point bloquant corrigé ne force plus à tout refermer :${' '}
            <button type="button" class="btn btn-mini">Rejouer les contrôles</button>, dans l'encart
            rouge, refait toutes les vérifications sur place. Recycler le pool, déverrouiller le
            fichier, rejouer : la fenêtre de confirmation reste ouverte, la saisie du numéro aussi.
          </p>

          <h3>La confirmation</h3>
          <p>
            L'écran récapitule le projet, l'opération, l'auteur, la destination de production, le
            dossier de sauvegarde et le détail des fichiers avec leur volume. Pour valider, il faut${' '}
            <strong>saisir le numéro de la demande</strong>. C'est volontaire : un bouton unique
            s'appuie sans réfléchir, un numéro se recopie en regardant.
          </p>
          <p>
            Un champ <strong>Commentaire</strong>, facultatif, permet d'y dire en une phrase pourquoi
            ce passage part - « correctif recherche article », « écran stock ». Cette phrase suit
            ensuite le passage partout : dans le manifeste, dans le récapitulatif de traçabilité,
            dans l'historique et sur le tableau de bord.
          </p>
          <p class="attenue">
            Quand il n'y a pas de demande, parce que le passage se fait sans archivage, c'est le${' '}
            <strong>nombre de fichiers</strong> qu'on recopie. Le geste reste le même, et il oblige à
            relire ce qui part.
          </p>
        <//>

        <!-- ================================================== Rapport -->
        <${Section}
          id="rapport"
          titre="Le rapport"
          chapeau="Ce qui est parti, ce qui a échoué, et où sont les traces."
        >
          <${Demo} legende="Les chiffres de tête. « échecs » se teinte en rouge dès qu'il n'est plus à zéro." large>
            <div class="chiffres">
              <div class="chiffre"><span class="valeur">16</span><span>fichiers</span></div>
              <div class="chiffre"><span class="valeur">13</span><span>remplacés</span></div>
              <div class="chiffre"><span class="valeur">3</span><span>créés</span></div>
              <div class="chiffre"><span class="valeur">0</span><span>échecs</span></div>
              <div class="chiffre">
                <span class="valeur mono"><span class="plus">+284</span> <span class="moins">−97</span></span>
                <span>lignes</span>
              </div>
            </div>
          <//>

          <p>
            Puis le détail, fichier par fichier : l'action réalisée (remplacé, créé, supprimé,
            restauré), le compte de lignes, le nom de la sauvegarde et le résultat. Trois filtres en
            haut du tableau permettent de n'afficher que les réussites ou que les échecs. Le
            commentaire saisi à la confirmation est repris en tête du rapport.
          </p>

          <h3>Les traces écrites</h3>
          <${Repere}
            entetes=${['Fichier', 'Contenu']}
            lignes=${[
              [
                html`<span class="mono">_deploiement_&lt;horodatage&gt;.json</span>`,
                'Le manifeste. Chaque fichier avec son empreinte avant et après, sa taille, son archive, son éventuelle erreur. C\'est lui qui rend le retour arrière possible.'
              ],
              [
                html`<span class="mono">_recapitulatif.md</span>`,
                'La version lisible, complétée à chaque passage dans le sprint. C\'est le document à joindre à la demande de travaux.'
              ]
            ]}
          />
          <p class="attenue">
            Les deux sont déposés dans le dossier de sprint, à côté des versions archivées. Trois
            boutons du rapport permettent de les ouvrir ou de les montrer dans l'explorateur.
          </p>

          <div class="encart encart-danger">
            <strong>« archivés mais PAS remplacés »</strong> : la version de production a bien été
            sauvegardée, mais la copie a échoué juste après. La production est restée dans son état
            d'origine pour ces fichiers-là, et l'archive existe quand même. Rien n'est perdu, il faut
            simplement recommencer.
          </div>

          <p class="attenue">
            En simulation, aucun manifeste n'est écrit et le rapport le dit : « Aucun fichier n'a été
            écrit : ni en production, ni dans les archives, ni de manifeste. »
          </p>
        <//>

        <!-- =============================================== Historique -->
        <${Section}
          id="historique"
          titre="Historique et retour arrière"
          chapeau="Tous les manifestes retrouvés sous la racine d'archives, du plus récent au plus ancien."
        >
          <p>
            À gauche, la liste des déploiements avec la demande, le sprint, la date, l'auteur, le
            projet et le nombre de fichiers. Les étiquettes${' '}
            <span class="etiquette">retour arrière</span>,${' '}
            <span class="etiquette">suppression</span>,${' '}
            <span class="etiquette">simulation</span> et${' '}
            <span class="etiquette etiquette-danger">sans AVMDF</span> distinguent la nature de
            chaque passage, et le commentaire du passage s'affiche sous chaque entrée qui en porte
            un. À droite, le détail complet.
          </p>

          <p>
            En tête de liste, un champ de recherche filtre sur tout ce qu'on peut avoir en tête en
            rouvrant l'historique : numéro de demande, sprint, projet, auteur, commentaire, et
            jusqu'aux chemins des fichiers déployés - « qui a touché à
            <span class="mono"> Recherche.aspx</span> ? » se répond en tapant son nom. La case
            « Masquer les simulations » ne garde que les passages qui ont réellement écrit.
          </p>

          <h3>Voir ce qui a changé</h3>
          <p>
            Sur chaque ligne du détail, <strong>Voir ce qui a changé</strong> compare la sauvegarde
            à ce qui est actuellement en production. Utile pour répondre à la question « est-ce que
            ma modification est toujours là ? » longtemps après coup.
          </p>

          <h3>Vérifier l'état en production</h3>
          <p>
            <strong>Vérifier l'état en production</strong> répond à la question qui revient des
            semaines après un passage : « ma production est-elle toujours celle que j'ai
            livrée ? ». Chaque fichier du manifeste est re-hashé en production et confronté à
            l'empreinte enregistrée au moment du passage. Rien n'est écrit, nulle part.
          </p>
          <${Repere}
            entetes=${['Verdict', 'Sens']}
            lignes=${[
              [html`<span class="verdict verdict-conforme">intact</span>`, 'L\'empreinte actuelle est celle du manifeste : le fichier n\'a pas bougé depuis ce passage.'],
              [html`<span class="verdict verdict-modifie">modifié depuis</span>`, 'Le contenu a changé après ce passage - souvent un passage plus récent, parfois une retouche à la main. L\'historique dit lequel.'],
              [html`<span class="verdict verdict-absent">absent de la production</span>`, 'Le fichier livré ne se trouve plus sur le serveur.'],
              [html`<span class="verdict verdict-absent">réapparu</span>`, 'Un fichier supprimé par ce passage est revenu.'],
              [html`<span class="verdict verdict-modifie">invérifiable</span>`, 'Le fichier ne se laisse pas lire, ou le manifeste n\'a pas d\'empreinte pour lui.']
            ]}
          />
          <p class="attenue">
            Le même contrôle est proposé dans le rapport, juste après un passage réel : la
            vérification immédiate qui confirme que ce qui devait partir est bien arrivé.
          </p>

          <h3>Revenir en arrière</h3>
          <p>
            <span class="aide-danger-texte">Revenir en arrière</span> annule un déploiement : les
            fichiers remplacés sont remis depuis leur sauvegarde, les fichiers créés par ce passage
            sont supprimés de la production. Avant d'agir, l'outil affiche la liste complète des
            opérations et signale ce qui a changé en production depuis. Là encore, la confirmation
            passe par la saisie du numéro de demande, et un bouton${' '}
            <strong>Simuler</strong> permet de voir le résultat sans rien écrire.
          </p>
          <p class="attenue">
            Le bouton reste grisé sur les passages faits sans archivage AVMDF, et sur les
            simulations : dans les deux cas, il n'y a rien à restaurer.
          </p>
          <p class="attenue">
            Un retour arrière produit son propre manifeste, déposé à côté de celui du déploiement
            d'origine. Il est donc lui-même réversible. Un manifeste de simulation, lui, n'a rien
            écrit : il n'y a rien à annuler, et le bouton reste grisé.
          </p>
        <//>

        <!-- ================================================= Versions -->
        <${Section}
          id="versions"
          titre="Les versions archivées d'un fichier"
          chapeau="Toutes les versions « avant modification » d'un même fichier, toutes demandes et tous sprints confondus."
        >
          <p>
            Accessible par le clic droit dans l'arborescence, ou par le bouton${' '}
            <strong>Versions archivées</strong> du comparateur. Chaque version est datée, attribuée à
            une demande et à un sprint, et se compare à la production actuelle d'un simple clic.
          </p>
          <p>
            <strong>Remettre cette version en production</strong> demande d'abord une destination
            d'archivage : la version actuellement en production est copiée dans le dossier de sprint
            choisi <strong>avant</strong> d'être remplacée. Revenir à une version ancienne ne fait
            jamais perdre l'état courant, et l'opération produit son propre manifeste.
          </p>
        <//>

        <!-- ==================================================== Bord -->
        <${Section}
          id="bord"
          titre="Le tableau de bord"
          chapeau="Ce que racontent les manifestes du dossier d'archives. Les chiffres viennent du disque, pas d'une base : ce sont les traces réelles."
        >
          <${Repere}
            entetes=${['Tuile ou carte', 'Ce qu\'elle montre']}
            lignes=${[
              ['mises en production', 'Le nombre de passages réels, et le nombre de demandes concernées.'],
              ['fichiers déployés', 'Le total, et la moyenne par passage.'],
              ['lignes de code', 'Ajoutées et supprimées, sur les seuls fichiers texte.'],
              ['retours arrière', 'Et, en dessous, le nombre de suppressions d\'orphelins.'],
              ['fichiers en échec', 'Se teinte en rouge dès le premier. Renvoie vers l\'historique.'],
              ['dernière mise en production', 'La demande, le sprint, quand, par qui, sur quel projet.'],
              ['Activité des douze derniers mois', 'Une barre par mois. Le survol donne le détail.'],
              ['Par projet, par auteur', 'Répartition des passages et des fichiers.'],
              [
                'Fichiers les plus déployés',
                'Les points chauds : ce qui repart le plus souvent en production, avec la dernière demande et la dernière date.'
              ],
              ['Activité récente', 'Le fil des derniers passages, toutes natures confondues.']
            ]}
          />
          <div class="encart">
            <strong>Les simulations ne comptent pas.</strong> Elles sont dénombrées à part, en haut de
            l'écran, et n'entrent dans aucun total. Le tableau de bord ne montre que ce qui s'est
            réellement passé.
          </div>
        <//>

        <!-- ================================================= Réglages -->
        <${Section}
          id="reglages"
          titre="Les réglages"
          chapeau="Tout se fait sur un brouillon : rien n'est écrit tant que « Enregistrer » n'a pas été utilisé."
        >
          <h3>Le premier démarrage</h3>
          <p>
            Au tout premier lancement, l'application ne connaît ni vos sources ni votre production :
            elle ne les invente pas. Un écran d'accueil demande les trois racines, une bonne fois.
            Chaque chemin saisi est contrôlé pour de vrai - existence et lecture - et le résultat
            s'affiche dessous, avant même la première analyse.
          </p>
          <p class="attenue">
            Seule la racine des archives arrive préremplie, à${' '}
            <span class="mono">Z:\\AvMdf</span> : celle-là est la même pour tout le monde. Les deux
            autres dépendent du poste. Tout reste modifiable ici ensuite.
          </p>

          <${Repere}
            entetes=${['Section', 'Ce qu\'on y règle']}
            lignes=${[
              [
                'Racines',
                'Les trois points d\'ancrage : sources locales, production, archives AVMDF. Tout le reste s\'en déduit.'
              ],
              [
                'Projets',
                'L\'appariement explicite d\'un dossier local et d\'un dossier de production. Le chemin résolu s\'affiche sous chaque ligne. Un projet désactivé disparaît de la liste de l\'en-tête.'
              ],
              [
                'Dossiers exclus',
                html`Jamais parcourus, des deux côtés. Un nom seul (<span class="mono">obj</span>)
                  écarte tous les dossiers qui le portent ; un chemin
                  (<span class="mono">Controles\\Images</span>) n'écarte que celui-là. Jokers
                  acceptés : <span class="mono">_ReSharper*</span>. Le clic droit sur un dossier de
                  l'arborescence remplit cette liste sans passer par ici.`
              ],
              [
                'Fichiers exclus',
                html`Ni comparés, ni déployés : <span class="mono">*.pdb</span>, <span class="mono">*.aspx.vb</span>, <span class="mono">web.config</span>…`
              ],
              [
                'Extensions considérées comme du texte',
                'Détermine ce qui peut être comparé ligne à ligne. Tout le reste est traité comme binaire : taille, date et empreinte, sans diff.'
              ],
              [
                'Comparaison',
                'Ignorer les espaces, ignorer les différences de fins de ligne, et le nombre de lectures simultanées pendant l\'analyse.'
              ],
              [
                'Mise en production',
                'L\'auteur inscrit dans les manifestes, le démarrage en simulation, et le dépôt d\'un app_offline.htm pendant la copie.'
              ],
              [
                'Comparer deux dossiers libres',
                'Court-circuite les projets et compare deux dossiers quelconques, sans archivage AVMDF. Utile hors du cadre GPNet.'
              ],
              [
                'Fichier de réglages',
                html`L'emplacement du <span class="mono">config.json</span>. La version précédente est conservée à côté sous <span class="mono">config.precedent.json</span>.`
              ]
            ]}
          />

          <h3>Deux réglages qui méritent une explication</h3>
          <div class="encart encart-danger">
            <strong>Pourquoi web.config est exclu par défaut.</strong> Il contient la chaîne de
            connexion et les réglages propres à chaque environnement. Celui de développement ne vaut
            pas en production ; l'écraser coupe le site. Si vous le retirez des exclusions, chaque
            mise en production qui le concerne affichera un avertissement en rouge.
          </div>
          <div class="encart">
            <strong>Pourquoi le code-behind est exclu.</strong> Dans une application web compilée,${' '}
            <span class="mono">Default.aspx.vb</span> et son${' '}
            <span class="mono">Default.aspx.designer.vb</span> ne partent jamais sur le serveur :
            c'est la DLL du dossier <span class="mono">bin</span> qui les remplace. Ils existent en
            local et pas en production, et c'est normal. Sans exclusion, chaque analyse les
            remonterait en « nouveaux » alors qu'il n'y a rien à déployer.
          </div>

          <p class="attenue">
            Les erreurs sont signalées en rouge et empêchent l'enregistrement. Les avertissements,
            eux, laissent passer : ils signalent un choix inhabituel, pas une faute. Fermer avec des
            modifications en cours demande confirmation.
          </p>

          <div class="aide-actions">
            <button type="button" class="btn" onClick=${onOuvrirReglages}>Ouvrir les réglages</button>
            <button type="button" class="btn btn-plat" onClick=${onOuvrirHistorique}>Ouvrir l'historique</button>
            <button type="button" class="btn btn-plat" onClick=${onOuvrirJournal}>Ouvrir le journal</button>
          </div>
        <//>

        <!-- =============================================== Raccourcis -->
        <${Section}
          id="raccourcis"
          titre="Raccourcis clavier"
          chapeau="Les flèches et la barre d'espace agissent sur l'arborescence quand elle a le focus : cliquez une fois dans la liste."
        >
          <${Repere}
            entetes=${['Touche', 'Effet', 'Où']}
            lignes=${[
              [html`<${T}>F5<//>`, 'Lancer l\'analyse', 'Onglet Analyse'],
              [html`<${T}>Ctrl<//> + <${T}>P<//>`, 'Aller au fichier : la palette de recherche rapide', 'Onglet Analyse, après une analyse'],
              [html`<${T}>Ctrl<//> + <${T}>Entrée<//>`, 'Lancer la mise en production', 'Onglet Analyse, sélection valide'],
              [html`<${T}>↑<//> <${T}>↓<//>`, 'Déplacer le curseur', 'Arborescence'],
              [html`<${T}>→<//> <${T}>←<//>`, 'Déplier / replier un dossier', 'Arborescence'],
              [html`<${T}>Espace<//>`, 'Cocher / décocher la ligne ou la branche', 'Arborescence'],
              [html`<${T}>Entrée<//>`, 'Ouvrir la comparaison du fichier', 'Arborescence'],
              [html`<${T}>F8<//>`, 'Changement suivant', 'Comparateur'],
              [html`<${T}>Maj<//> + <${T}>F8<//>`, 'Changement précédent', 'Comparateur'],
              [html`<${T}>Ctrl<//> + <${T}>F<//>`, 'Chercher dans la comparaison affichée', 'Comparateur'],
              [html`<${T}>Ctrl<//> + <${T}>S<//>`, 'Enregistrer le fichier', 'Éditeur intégré'],
              [html`<${T}>Tab<//>`, 'Insérer une tabulation', 'Éditeur intégré'],
              [html`<${T}>Échap<//>`, 'Fermer la recherche, une confirmation, ou l\'écran ouvert', 'Partout'],
              ['Double-clic sur la poignée', 'Rétablir la largeur d\'origine du panneau de gauche', 'Onglet Analyse']
            ]}
          />
        <//>

        <!-- ================================================ Garanties -->
        <${Section}
          id="garanties"
          titre="Ce que l'outil garantit"
          chapeau="Les règles qui ne se négocient pas, et qui expliquent pourquoi certaines choses sont volontairement lentes ou insistantes."
        >
          <ul class="aide-liste">
            <li>
              <strong>Rien n'est écrasé sans avoir été archivé d'abord.</strong> Si l'archivage
              échoue, le fichier de production n'est pas touché. La seule exception est le
              renoncement explicite : décocher « Archiver » avant un passage, ce qui est alors
              inscrit dans le manifeste et interdit le retour arrière.
            </li>
            <li>
              <strong>La copie est binaire, octet pour octet.</strong> Aucun ré-encodage, aucune
              normalisation des fins de ligne. Le contenu qui arrive sur le serveur est exactement
              celui de vos sources.
            </li>
            <li>
              <strong>Le fichier de production porte la date de sa mise en production</strong>, pas
              celle de votre poste. Dans l'explorateur du serveur, la date répond ainsi à la
              question qu'on se pose vraiment : quand est-ce que c'est parti ? L'archive AVMDF,
              elle, garde la date que le fichier avait avant d'être remplacé, puisque c'est tout
              son intérêt. La comparaison ne s'en trouve pas faussée : elle se décide sur la taille
              puis sur l'empreinte, jamais sur la date.
            </li>
            <li>
              <strong>Toute destination est vérifiée avant la moindre écriture</strong> comme étant
              sous la racine de production ou sous la racine d'archives.
            </li>
            <li>
              <strong>Un fichier en échec n'interrompt pas les autres.</strong> Il est remonté dans
              le rapport final, avec sa raison.
            </li>
            <li>
              <strong>La version « avant modification » d'un sprint est celle du premier passage.</strong>${' '}
              Un second passage sur le même sprint ne l'écrase pas : l'état d'origine de la demande
              reste retrouvable.
            </li>
            <li>
              <strong>L'application démarre en simulation</strong>, et le bandeau change de teinte
              dès que ce n'est plus le cas.
            </li>
            <li>
              <strong>Toute écriture est confirmée par une saisie</strong> : le numéro de demande, ou
              le nombre de fichiers quand il n'y a pas de demande. Y compris les retours arrière et
              les remises en production d'une version ancienne.
            </li>
            <li>
              <strong>Tout est tracé</strong> : un manifeste et un récapitulatif dans le dossier de
              sprint, un journal quotidien côté application. Un passage fait sans archivage n'écrit
              rien dans les archives, mais le journal en garde la ligne, marquée ALERTE.
            </li>
          </ul>
        <//>

        <!-- ================================================ Dépannage -->
        <${Section}
          id="depannage"
          titre="En cas de problème"
          chapeau="Les situations qui reviennent, et ce qu'elles veulent dire."
        >
          <${Repere}
            entetes=${['Symptôme', 'Cause probable et remède']}
            lignes=${[
              [
                'Le bouton Analyser est grisé',
                'Aucune cible : pas de projet actif, ou une racine vide. Ouvrez les réglages.'
              ],
              [
                'L\'analyse ne trouve aucun écart',
                'C\'est peut-être vrai. Sinon, vérifiez que le projet vise bien les bons dossiers, et regardez le panneau Éléments ignorés : une exclusion trop large masque parfois tout un dossier.'
              ],
              [
                html`<strong>Analyse impossible</strong>, avec un dossier marqué${' '}
                  <span class="aide-danger-texte">✕</span>`,
                html`Un des deux dossiers ne se lit pas : introuvable, accès refusé, ou ce n'est pas
                  un dossier. L'analyse est refusée avant de commencer, exprès. Si elle partait quand
                  même, le côté illisible rendrait zéro fichier et tout l'autre côté ressortirait en
                  « nouveau » ou en « orphelin » : une liste énorme, parfaitement lisible et
                  parfaitement fausse. Le panneau indique lequel des deux bloque, et pourquoi.`
              ],
              [
                html`<strong>Ces deux dossiers n'ont aucun fichier en commun</strong>`,
                html`Presque toujours une erreur de cible : un projet qui vise le mauvais
                  sous-dossier de production. Le message compte les fichiers de chaque côté et
                  ceux qui portent le même chemin. Il ne bloque rien - un tout premier déploiement
                  ressemble à ça - mais si l'écran affiche des centaines d'orphelins, vérifiez le
                  projet avant de cocher quoi que ce soit.`
              ],
              [
                'Un fichier ressort modifié à chaque fois',
                'Souvent une histoire de fins de ligne ou d\'encodage. Ouvrez la comparaison : le bandeau d\'alerte le dit. Les options de comparaison permettent d\'ignorer les fins de ligne.'
              ],
              [
                'Des dizaines de fichiers « nouveaux » qui n\'ont rien à faire là',
                html`Des fichiers qui n'existent que côté développement. Clic droit dessus, « Exclure
                  ce fichier ». S'ils sont tous dans le même dossier, clic droit sur le dossier :
                  « Exclure ce dossier ». Les listes se modifient aussi à la main dans les réglages.`
              ],
              [
                html`<strong>ouvert par un autre programme</strong> (EBUSY)`,
                html`Quelqu'un le tient. Sur le serveur : Gestion de l'ordinateur, Outils système, Dossiers partagés, Fichiers ouverts, pour voir qui. Un éditeur resté ouvert sur le partage, un antivirus ou une sauvegarde en cours suffisent. Si c'est une DLL du dossier${' '}<span class="mono">bin</span>, c'est IIS lui-même : recyclez le pool d'applications ou activez le dépôt d'un app_offline.htm dans les réglages.`
              ],
              [
                html`<strong>en lecture seule</strong> (EPERM, EACCES)`,
                html`L'attribut « lecture seule » est posé sur le fichier. Clic droit, Propriétés, décochez la case, ou${' '}<span class="mono">attrib -R</span> sur le serveur. Arrive après une restauration de sauvegarde ou une copie mal réglée.`
              ],
              [
                html`<strong>droits insuffisants</strong> (EPERM, EACCES)`,
                'Vous pouvez lire le fichier mais pas le remplacer. Vos permissions NTFS sur le dossier ne vous accordent pas l\'écriture : faites-les ouvrir, ou déployez depuis un compte qui les a.'
              ],
              [
                'Fichier changé en production depuis votre analyse',
                'Quelqu\'un d\'autre a déployé entre-temps. Relancez une analyse : déployer par-dessus écraserait son travail sans que personne ne le voie.'
              ],
              [
                'La recherche dans le contenu est très lente',
                'Elle lit les fichiers des deux côtés, dont ceux du partage réseau. Réduisez d\'abord avec les autres filtres, ou annulez : le bouton est à côté de la progression.'
              ],
              [
                'L\'analyse est lente',
                'Le partage réseau SMB est le facteur limitant. Au-delà de 12 lectures simultanées, augmenter le réglage ralentit au lieu d\'accélérer.'
              ],
              [
                'Le tableau de bord est vide',
                'Il ne se remplit qu\'à partir des manifestes réels. Tant qu\'aucune mise en production réelle n\'a eu lieu, il n\'y a rien à montrer.'
              ],
              [
                'Les réglages semblent avoir été perdus',
                html`Le fichier était illisible : il a été mis de côté et les valeurs par défaut rechargées, avec une notification. La version précédente reste disponible sous <span class="mono">config.precedent.json</span>.`
              ]
            ]}
          />
          <p class="attenue">
            Le <strong>Journal</strong> conserve le fil des événements, un fichier par jour, avec les
            lignes ERREUR et ALERTE mises en évidence. C'est le premier endroit à regarder quand le
            comportement de l'outil surprend.
          </p>
        <//>

        <!-- ================================================ Glossaire -->
        <${Section} id="glossaire" titre="Glossaire">
          <${Repere}
            entetes=${['Terme', 'Définition']}
            lignes=${[
              ['AVMDF', 'Avant modification. Le dossier d\'archives où l\'outil dépose la version de production remplacée, juste avant de l\'écraser.'],
              [
                'Demande de travaux informatique',
                html`Le numéro qui identifie l'intervention. Il donne son nom au dossier <span class="mono">AVMDF&lt;numéro&gt;</span>, et c'est lui qu'on saisit pour confirmer une mise en production.`
              ],
              ['Sprint', 'Le sous-dossier d\'une demande qui reçoit les fichiers d\'un passage. Une demande peut en contenir plusieurs.'],
              ['Orphelin', 'Un fichier présent en production et absent en local.'],
              [
                'Manifeste',
                html`Le fichier <span class="mono">_deploiement_&lt;horodatage&gt;.json</span> écrit dans le dossier de sprint. Il recense chaque fichier, son empreinte avant et après, son archive. C'est lui qui rend le retour arrière possible.`
              ],
              ['Récapitulatif', html`<span class="mono">_recapitulatif.md</span>, la version lisible du manifeste, complétée à chaque passage dans le sprint.`],
              ['Contrôles préalables', 'Les vérifications passées avant la première écriture : racines, périmètre, droits, verrous, modifications concurrentes, espace disque.'],
              ['Simulation', 'Tout le processus se déroule et le rapport complet est produit, mais aucun octet n\'est écrit.'],
              ['Empreinte SHA-256', 'La signature du contenu d\'un fichier. Deux fichiers de même empreinte sont identiques octet pour octet.'],
              [
                'Fichier tenu',
                html`Un fichier qu'un programme garde ouvert : il se laisse lire mais refuse d'être remplacé. IIS ne tient que ce qu'il a chargé, la DLL du dossier${' '}<span class="mono">bin</span> et ses satellites ; une page, une feuille de style ou une image sont lues, envoyées et refermées. Un fichier statique bloqué vient donc presque toujours d'ailleurs : un éditeur, un antivirus, une sauvegarde.`
              ],
              [
                html`<span class="mono">app_offline.htm</span>`,
                'Un fichier déposé à la racine du site pour le mettre hors service le temps de la copie, puis retiré. Son contenu est réglable.'
              ],
              ['CRLF / LF', 'Les deux façons de terminer une ligne : Windows et Unix. Un fichier passé de l\'une à l\'autre paraît entièrement modifié si on ne l\'ignore pas.'],
              ['Comparaison libre', 'Comparer deux dossiers quelconques, hors de la liste des projets et sans archivage AVMDF.'],
              ['Code-behind', html`Le fichier VB associé à une page, <span class="mono">Default.aspx.vb</span>. Compilé dans la DLL du dossier <span class="mono">bin</span>, il n'est jamais déposé sur le serveur.`]
            ]}
          />

          <div class="aide-fin">
            <p>
              Il reste une question sans réponse ici ? Le <strong>Journal</strong> dit ce que
              l'application a fait, l'<strong>Historique</strong> dit ce qui est parti en production,
              et le récapitulatif de chaque sprint dit qui a déployé quoi, et quand.
            </p>
            <button type="button" class="btn btn-accent" onClick=${() => onVue('analyse')}>
              Revenir à l'analyse
            </button>
          </div>
        <//>
      </div>
    </div>
  `;
}
