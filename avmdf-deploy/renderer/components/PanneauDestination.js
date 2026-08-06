import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_CONVENTION = {
  sprint: 'sprints numérotés (Sprint1, Sprint2…)',
  suffixe: 'suffixe numéroté (_1, _2…)',
  historique: 'ancienne organisation : fichiers directement à la racine',
  vide: 'demande vide',
  mixte: 'deux conventions mélangées'
};

/**
 * Choix de la demande AVMDF et du dossier de sprint qui recevra les versions
 * écrasées. Le contenu réel de Z:\AvMdf fait foi : la convention en place est
 * détectée, jamais devinée.
 */
export function PanneauDestination({ destination, onValider, onFermer, onEchec }) {
  const [demandes, setDemandes] = useState([]);
  const [racine, setRacine] = useState('');
  const [saisieDemande, setSaisieDemande] = useState(destination ? destination.demande : '');
  const [saisieSprint, setSaisieSprint] = useState(destination ? destination.sprint : '');
  const [inspection, setInspection] = useState(null);
  const [etatSprint, setEtatSprint] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [creationDemandee, setCreationDemandee] = useState(false);
  const [filtreDemande, setFiltreDemande] = useState('');

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.avmdf.demandes();
      if (abandonne) return;
      setChargement(false);
      if (!reponse.ok) {
        onEchec(reponse);
        return;
      }
      setDemandes(reponse.demandes);
      setRacine(reponse.racine);
      if (!saisieDemande && reponse.demandes.length) setSaisieDemande(reponse.demandes[0].nom);
    })();
    return () => {
      abandonne = true;
    };
  }, []);

  // Inspection de la demande saisie : convention en place et nom proposé.
  useEffect(() => {
    const demande = saisieDemande.trim();
    if (!demande) {
      setInspection(null);
      return undefined;
    }
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.avmdf.inspecter(demande);
      if (abandonne) return;
      if (!reponse.ok) {
        setInspection({ erreur: reponse.erreur.message });
        return;
      }
      setInspection({ ...reponse.inspection, demande: reponse.demande });
      setCreationDemandee(false);
      if (!destination || destination.demande !== reponse.demande.nom) {
        setSaisieSprint(reponse.inspection.proposition);
      }
    }, 250);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [saisieDemande]);

  // État du dossier de sprint visé.
  useEffect(() => {
    if (!inspection || !inspection.demande || !saisieSprint.trim()) {
      setEtatSprint(null);
      return undefined;
    }
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.avmdf.inspecterSprint(inspection.demande.nom, saisieSprint.trim());
      if (abandonne) return;
      setEtatSprint(reponse.ok ? reponse : { erreur: reponse.erreur.message });
    }, 250);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [inspection && inspection.demande && inspection.demande.nom, saisieSprint]);

  async function creerDemande() {
    const reponse = await window.avmdf.avmdf.creerDemande(saisieDemande.trim());
    if (!reponse.ok) {
      onEchec(reponse);
      return;
    }
    setCreationDemandee(false);
    setSaisieDemande(reponse.demande.nom);
  }

  const demandeExiste = inspection && inspection.existe && !inspection.erreur;
  const demandeNom = inspection && inspection.demande ? inspection.demande.nom : null;
  const cheminResolu = etatSprint && !etatSprint.erreur ? etatSprint.chemin : null;
  const incompatible = etatSprint && etatSprint.compatible && !etatSprint.compatible.compatible;
  const sprintOccupe = etatSprint && etatSprint.etat && etatSprint.etat.existe && !etatSprint.etat.vide;

  const listeFiltree = filtreDemande.trim()
    ? demandes.filter((t) => t.nom.toLowerCase().includes(filtreDemande.trim().toLowerCase()))
    : demandes;

  const valide = Boolean(demandeNom && cheminResolu && !incompatible);

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Destination de l'archivage">
      <div class="modale modale-moyenne">
        <div class="modale-entete">
          <h1>Destination de l'archivage</h1>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-plat" onClick=${onFermer}>Fermer ✕</button>
        </div>

        <div class="modale-corps">
          <p class="section-aide">
            Les versions écrasées en production seront copiées ici, avec leur arborescence relative.
            Contenu lu directement dans <span class="mono">${racine}</span>.
          </p>

          <section class="section">
            <h2>Demande de travaux</h2>
            ${chargement ? html`<div class="attenue">Lecture du dossier d'archives…</div>` : null}
            <div class="champs">
              <div class="champ">
                <label for="filtre-demande">Demandes existants</label>
                <div class="champ-corps">
                  <input
                    type="search"
                    id="filtre-demande"
                    class="mono"
                    style="max-width:140px"
                    placeholder="4611"
                    value=${filtreDemande}
                    onInput=${(e) => setFiltreDemande(e.target.value)}
                  />
                  <select
                    size="1"
                    style="min-width:180px"
                    value=${demandeNom || ''}
                    aria-label="Choisir une demande existante"
                    onChange=${(e) => setSaisieDemande(e.target.value)}
                  >
                    ${listeFiltree.length === 0 ? html`<option value="">aucune demande</option>` : null}
                    ${listeFiltree.map((demande) => html`<option value=${demande.nom} key=${demande.nom}>${demande.nom}</option>`)}
                  </select>
                  <span class="attenue">${formaterNombre(demandes.length)} demande(s)</span>
                </div>
              </div>

              <div class="champ">
                <label for="saisie-demande">Ou numéro à saisir</label>
                <div class="champ-corps">
                  <input
                    type="text"
                    id="saisie-demande"
                    class="mono"
                    style="max-width:200px"
                    placeholder="4611"
                    spellcheck="false"
                    value=${saisieDemande}
                    onInput=${(e) => setSaisieDemande(e.target.value)}
                  />
                </div>
                ${inspection && inspection.erreur
                  ? html`<div class="champ-erreur">${inspection.erreur}</div>`
                  : null}
              </div>
            </div>

            ${inspection && !inspection.erreur && !inspection.existe
              ? html`
                  <div class="encart encart-alerte" style="margin-top:10px">
                    <strong>La demande ${demandeNom} n'existe pas encore.</strong>
                    <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
                      ${creationDemandee
                        ? html`
                            <span>Créer le dossier ${demandeNom} dans ${racine} ?</span>
                            <button type="button" class="btn btn-mini" onClick=${() => setCreationDemandee(false)}>
                              Annuler
                            </button>
                            <button type="button" class="btn btn-mini btn-accent" onClick=${creerDemande}>
                              Créer la demande
                            </button>
                          `
                        : html`<button type="button" class="btn btn-mini" onClick=${() => setCreationDemandee(true)}>
                            Créer ${demandeNom}
                          </button>`}
                    </div>
                  </div>
                `
              : null}

            ${demandeExiste
              ? html`
                  <div class=${'encart' + (inspection.convention === 'mixte' ? ' encart-alerte' : '')} style="margin-top:10px">
                    <strong>Convention détectée :</strong> ${LIBELLES_CONVENTION[inspection.convention]}.
                    ${inspection.convention === 'historique'
                      ? html`<div style="margin-top:4px">
                          Cette demande utilise l'ancienne organisation : ${formaterNombre(inspection.fichiersRacine)}
                          fichier(s) sont posés à sa racine. Ils ne seront pas touchés ; le nouveau dossier vient à côté.
                        </div>`
                      : null}
                    ${inspection.convention === 'mixte'
                      ? html`<div style="margin-top:4px">
                          Les deux conventions coexistent déjà dans cette demande. Choisissez celle que vous voulez
                          poursuivre, et tenez-vous-y.
                        </div>`
                      : null}
                  </div>
                `
              : null}
          </section>

          <section class="section">
            <h2>Dossier de sprint</h2>
            ${demandeExiste && inspection.sprints.length
              ? html`
                  <div class="sprints">
                    ${inspection.sprints.map(
                      (sprint) => html`
                        <button
                          type="button"
                          class=${'sprint' + (sprint.nom === saisieSprint.trim() ? ' choisi' : '')}
                          key=${sprint.nom}
                          onClick=${() => setSaisieSprint(sprint.nom)}
                        >
                          ${sprint.nom}
                        </button>
                      `
                    )}
                  </div>
                `
              : null}

            <div class="champs" style="margin-top:8px">
              <div class="champ">
                <label for="saisie-sprint">Nom du dossier</label>
                <div class="champ-corps">
                  <input
                    type="text"
                    id="saisie-sprint"
                    class=${'mono' + (incompatible ? ' invalide' : '')}
                    spellcheck="false"
                    value=${saisieSprint}
                    onInput=${(e) => setSaisieSprint(e.target.value)}
                  />
                  ${inspection && inspection.proposition
                    ? html`<button type="button" class="btn" onClick=${() => setSaisieSprint(inspection.proposition)}>
                        Proposition : ${inspection.proposition}
                      </button>`
                    : null}
                </div>
                ${etatSprint && etatSprint.erreur ? html`<div class="champ-erreur">${etatSprint.erreur}</div>` : null}
              </div>
            </div>

            ${incompatible
              ? html`<div class="encart encart-danger" style="margin-top:10px">
                  <strong>Conventions mélangées.</strong> ${etatSprint.compatible.message}
                </div>`
              : null}

            ${sprintOccupe
              ? html`<div class="encart encart-alerte" style="margin-top:10px">
                  <strong>Ce dossier existe déjà et contient ${formaterNombre(etatSprint.etat.fichiers)} fichier(s)
                  et ${formaterNombre(etatSprint.etat.dossiers)} dossier(s).</strong>
                  <div style="margin-top:4px">
                    Complétez-vous ce sprint, ou vous êtes-vous trompé de numéro ? Les archives déjà présentes ne
                    seront pas écrasées : la version « avant modification » d'origine est conservée.
                  </div>
                </div>`
              : null}

            ${cheminResolu
              ? html`
                  <div class="destination-resolue">
                    <span class="attenue">Destination :</span>
                    <span class="mono">${cheminResolu}</span>
                  </div>
                `
              : null}
          </section>
        </div>

        <div class="modale-pied">
          <div style="flex:1"></div>
          <button type="button" class="btn" onClick=${onFermer}>Annuler</button>
          <button
            type="button"
            class="btn btn-accent"
            disabled=${!valide}
            title=${valide ? '' : 'Choisissez une demande et un nom de dossier valide'}
            onClick=${() => onValider({ demande: demandeNom, sprint: saisieSprint.trim(), chemin: cheminResolu })}
          >
            Choisir cette destination
          </button>
        </div>
      </div>
    </div>
  `;
}
