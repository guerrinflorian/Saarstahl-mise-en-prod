import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_OPERATION = {
  deploiement: 'mise en production',
  suppression: 'suppression',
  restauration: 'retour arrière'
};

function formaterHorodatage(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function ilYA(iso) {
  if (!iso) return '';
  const ecart = Date.now() - Date.parse(iso);
  if (Number.isNaN(ecart) || ecart < 0) return '';
  const minutes = Math.floor(ecart / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return 'il y a ' + minutes + ' min';
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return 'il y a ' + heures + ' h';
  const jours = Math.floor(heures / 24);
  if (jours < 31) return 'il y a ' + jours + ' jour' + (jours > 1 ? 's' : '');
  const mois = Math.floor(jours / 30.4);
  return 'il y a ' + mois + ' mois';
}

/**
 * Tableau de bord : tout ce que racontent les manifestes du dossier d'archives.
 *
 * Les chiffres viennent du disque, pas d'une base : ce sont les traces réelles
 * des mises en production. Les simulations sont comptées à part et n'entrent
 * dans aucun total.
 */
export function TableauDeBord({ onEchec, onOuvrirHistorique }) {
  const [etat, setEtat] = useState('chargement');
  const [stats, setStats] = useState(null);
  const [racine, setRacine] = useState('');

  async function charger() {
    setEtat('chargement');
    const reponse = await window.avmdf.statistiques.calculer();
    if (!reponse.ok) {
      setEtat('erreur');
      onEchec(reponse);
      return;
    }
    setStats(reponse.stats);
    setRacine(reponse.racine);
    setEtat('pret');
  }

  useEffect(() => {
    charger();
  }, []);

  if (etat === 'chargement') {
    return html`
      <div class="bord">
        <div class="etat-vide"><div class="attenue">Lecture du dossier d'archives…</div></div>
      </div>
    `;
  }

  if (etat === 'erreur' || !stats) {
    return html`
      <div class="bord">
        <div class="etat-vide">
          <div class="etat-vide-titre">Statistiques indisponibles</div>
          <div class="etat-vide-texte">
            Le dossier d'archives n'a pas pu être lu. Vérifiez la racine AVMDF dans les réglages,
            puis réessayez.
          </div>
          <button type="button" class="btn" onClick=${charger}>Réessayer</button>
        </div>
      </div>
    `;
  }

  const t = stats.totaux;
  const vide = t.deploiements === 0 && t.restaurations === 0 && t.suppressions === 0;

  if (vide) {
    return html`
      <div class="bord">
        <div class="etat-vide">
          <div class="etat-vide-titre">Aucune mise en production enregistrée</div>
          <div class="etat-vide-texte">
            Le tableau de bord se remplit tout seul à partir des manifestes écrits dans
            <span class="mono"> ${racine}</span>. Dès votre première mise en production réelle,
            les chiffres apparaissent ici.
          </div>
          ${t.simulations
            ? html`<div class="attenue">
                ${formaterNombre(t.simulations)} simulation${t.simulations > 1 ? 's' : ''} trouvée${t.simulations > 1 ? 's' : ''},
                non comptée${t.simulations > 1 ? 's' : ''} dans les totaux.
              </div>`
            : null}
        </div>
      </div>
    `;
  }

  return html`
    <div class="bord">
      <div class="bord-entete">
        <div>
          <h1>Tableau de bord</h1>
          <span class="attenue">
            Établi depuis les manifestes de <span class="mono">${racine}</span>
            ${t.simulations
              ? ' · ' + formaterNombre(t.simulations) + ' simulation' + (t.simulations > 1 ? 's' : '') + ' non comptée' + (t.simulations > 1 ? 's' : '')
              : ''}
          </span>
        </div>
        <button type="button" class="btn" onClick=${charger}>Actualiser</button>
      </div>

      <div class="tuiles">
        <div class="tuile">
          <span class="tuile-valeur">${formaterNombre(t.deploiements)}</span>
          <span class="tuile-libelle">mises en production</span>
          <span class="tuile-detail">${formaterNombre(t.demandes)} demande${t.demandes > 1 ? 's' : ''}</span>
        </div>
        <div class="tuile">
          <span class="tuile-valeur">${formaterNombre(t.fichiersDeployes)}</span>
          <span class="tuile-libelle">fichiers déployés</span>
          <span class="tuile-detail">
            ${t.deploiements ? '≈ ' + Math.round(t.fichiersDeployes / t.deploiements) + ' par passage' : ''}
          </span>
        </div>
        <div class="tuile">
          <span class="tuile-valeur tuile-lignes">
            <span class="plus">+${formaterNombre(t.lignesAjoutees)}</span>
            <span class="moins">−${formaterNombre(t.lignesSupprimees)}</span>
          </span>
          <span class="tuile-libelle">lignes de code</span>
          <span class="tuile-detail">sur les fichiers texte</span>
        </div>
        <div class="tuile">
          <span class="tuile-valeur">${formaterNombre(t.restaurations)}</span>
          <span class="tuile-libelle">retours arrière</span>
          <span class="tuile-detail">${formaterNombre(t.suppressions)} suppression${t.suppressions > 1 ? 's' : ''} d'orphelins</span>
        </div>
        <div class=${'tuile' + (t.echecs ? ' tuile-danger' : '')}>
          <span class="tuile-valeur">${formaterNombre(t.echecs)}</span>
          <span class="tuile-libelle">fichiers en échec</span>
          <span class="tuile-detail">${t.echecs ? 'voir l\'historique' : 'aucun incident'}</span>
        </div>
        ${stats.dernier
          ? html`
              <div class="tuile tuile-large">
                <span class="tuile-libelle">dernière mise en production</span>
                <span class="tuile-texte mono">${stats.dernier.demande} / ${stats.dernier.sprint}</span>
                <span class="tuile-detail">
                  ${ilYA(stats.dernier.date)} · ${stats.dernier.projet} · ${stats.dernier.auteur || '-'}
                  · ${formaterNombre(stats.dernier.fichiers)} fichier${stats.dernier.fichiers > 1 ? 's' : ''}
                </span>
              </div>
            `
          : null}
      </div>

      <div class="bord-grille">
        <section class="carte carte-large">
          <h2>Activité des douze derniers mois</h2>
          <${GraphiqueMensuel} donnees=${stats.parMois} />
        </section>

        <section class="carte">
          <h2>Par projet</h2>
          ${stats.parProjet.length
            ? html`<${BarresHorizontales}
                lignes=${stats.parProjet.map((p) => ({
                  libelle: p.nom,
                  valeur: p.deploiements,
                  detail: formaterNombre(p.fichiers) + ' fichiers'
                }))}
              />`
            : html`<div class="rien">Rien à afficher.</div>`}
          <h2 style="margin-top:18px">Par auteur</h2>
          ${stats.parAuteur.length
            ? html`<${BarresHorizontales}
                lignes=${stats.parAuteur.map((a) => ({
                  libelle: a.nom,
                  valeur: a.deploiements,
                  detail: formaterNombre(a.fichiers) + ' fichiers'
                }))}
              />`
            : html`<div class="rien">Rien à afficher.</div>`}
        </section>

        <section class="carte">
          <h2>Fichiers les plus déployés</h2>
          <p class="carte-aide">
            Les points chauds du projet : ce qui repart le plus souvent en production.
          </p>
          ${stats.fichiersChauds.length
            ? html`
                <div class="chauds">
                  ${stats.fichiersChauds.map(
                    (fichier) => html`
                      <div class="chaud" key=${fichier.chemin} title=${fichier.chemin}>
                        <div class="chaud-ligne">
                          <span class="mono chaud-nom">${fichier.chemin}</span>
                          <span class="chaud-nombre">${formaterNombre(fichier.passages)}×</span>
                        </div>
                        <div class="chaud-barre">
                          <div
                            class="chaud-remplissage"
                            style=${'width:' + Math.round((fichier.passages / stats.fichiersChauds[0].passages) * 100) + '%'}
                          ></div>
                        </div>
                        <div class="chaud-detail attenue">
                          ${fichier.derniereDemande || ''} · ${ilYA(fichier.derniereFois)}
                          ${fichier.lignesAjoutees || fichier.lignesSupprimees
                            ? ' · +' + formaterNombre(fichier.lignesAjoutees) + ' −' + formaterNombre(fichier.lignesSupprimees)
                            : ''}
                        </div>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<div class="rien">Rien à afficher.</div>`}
        </section>

        <section class="carte">
          <h2>Activité récente</h2>
          <div class="recents">
            ${stats.recents.map(
              (entree, index) => html`
                <div class="recent" key=${index}>
                  <span class=${'recent-point ' + entree.operation}></span>
                  <div class="recent-corps">
                    <div class="recent-ligne">
                      <span class="mono">${entree.demande} / ${entree.sprint}</span>
                      <span class="etiquette">${LIBELLES_OPERATION[entree.operation] || entree.operation}</span>
                      ${entree.echecs
                        ? html`<span class="etiquette etiquette-danger">${entree.echecs} échec${entree.echecs > 1 ? 's' : ''}</span>`
                        : null}
                    </div>
                    <div class="attenue recent-detail">
                      ${formaterHorodatage(entree.date)} · ${entree.projet} · ${entree.auteur || '-'}
                      · ${formaterNombre(entree.total)} fichier${entree.total > 1 ? 's' : ''}
                    </div>
                    ${entree.commentaire
                      ? html`<div class="recent-commentaire">« ${entree.commentaire} »</div>`
                      : null}
                  </div>
                </div>
              `
            )}
          </div>
          <button type="button" class="btn btn-plat" style="margin-top:10px" onClick=${onOuvrirHistorique}>
            Ouvrir l'historique complet
          </button>
        </section>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------

/** Barres mensuelles en SVG : déploiements par mois, nombre de fichiers en dessous. */
function GraphiqueMensuel({ donnees }) {
  const LARGEUR = 720;
  const HAUTEUR = 168;
  const BAS = 138;
  const HAUT = 18;
  const maximum = Math.max(1, ...donnees.map((d) => d.deploiements));
  const pas = LARGEUR / donnees.length;
  const largeurBarre = Math.min(40, pas * 0.52);

  const graduations = [];
  const nombreTraits = Math.min(4, maximum);
  for (let i = 1; i <= nombreTraits; i += 1) {
    graduations.push(Math.round((maximum / nombreTraits) * i));
  }

  return html`
    <svg
      viewBox=${'0 0 ' + LARGEUR + ' ' + HAUTEUR}
      class="graphique"
      role="img"
      aria-label="Mises en production par mois"
    >
      ${[...new Set(graduations)].map((valeur) => {
        const y = BAS - (valeur / maximum) * (BAS - HAUT);
        return html`
          <g key=${'g' + valeur}>
            <line x1="26" y1=${y} x2=${LARGEUR} y2=${y} class="graphique-trait" />
            <text x="20" y=${y + 3} class="graphique-graduation" text-anchor="end">${valeur}</text>
          </g>
        `;
      })}
      <line x1="26" y1=${BAS} x2=${LARGEUR} y2=${BAS} class="graphique-axe" />
      ${donnees.map((mois, index) => {
        const x = index * pas + (pas - largeurBarre) / 2 + 13;
        const hauteur = mois.deploiements === 0 ? 0 : Math.max(3, (mois.deploiements / maximum) * (BAS - HAUT));
        const centre = index * pas + pas / 2 + 13;
        return html`
          <g key=${mois.cle}>
            ${mois.deploiements > 0
              ? html`
                  <rect x=${x} y=${BAS - hauteur} width=${largeurBarre} height=${hauteur} rx="2" class="graphique-barre">
                    <title>${mois.libelle} ${mois.annee} : ${mois.deploiements} mise(s) en production, ${mois.fichiers} fichier(s)</title>
                  </rect>
                  <text x=${centre} y=${BAS - hauteur - 5} class="graphique-valeur" text-anchor="middle">
                    ${mois.deploiements}
                  </text>
                `
              : html`<rect x=${x} y=${BAS - 2} width=${largeurBarre} height="2" rx="1" class="graphique-barre-vide"></rect>`}
            <text x=${centre} y=${BAS + 15} class="graphique-mois" text-anchor="middle">${mois.libelle}</text>
            ${mois.libelle === 'janv.'
              ? html`<text x=${centre} y=${BAS + 27} class="graphique-annee" text-anchor="middle">${mois.annee}</text>`
              : null}
          </g>
        `;
      })}
    </svg>
  `;
}

/** Répartition simple : libellé, barre proportionnelle, valeur. */
function BarresHorizontales({ lignes }) {
  const maximum = Math.max(1, ...lignes.map((l) => l.valeur));
  return html`
    <div class="repartition">
      ${lignes.map(
        (ligne) => html`
          <div class="repartition-ligne" key=${ligne.libelle}>
            <span class="repartition-libelle" title=${ligne.libelle}>${ligne.libelle}</span>
            <div class="repartition-piste">
              <div class="repartition-barre" style=${'width:' + Math.round((ligne.valeur / maximum) * 100) + '%'}></div>
            </div>
            <span class="repartition-valeur">${formaterNombre(ligne.valeur)}</span>
            <span class="repartition-detail attenue">${ligne.detail || ''}</span>
          </div>
        `
      )}
    </div>
  `;
}
