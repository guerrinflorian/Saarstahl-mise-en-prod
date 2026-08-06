import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

const LIBELLES_CONVENTION = {
  sprint: 'sprints numérotés (Sprint1, Sprint2…)',
  suffixe: 'suffixe numéroté (_1, _2…)',
  historique: 'ancienne organisation : fichiers directement à la racine',
  vide: 'ticket vide',
  mixte: 'deux conventions mélangées'
};

/**
 * Choix du ticket AVMDF et du dossier de sprint qui recevra les versions
 * écrasées. Le contenu réel de Z:\AvMdf fait foi : la convention en place est
 * détectée, jamais devinée.
 */
export function PanneauDestination({ destination, onValider, onFermer, onEchec }) {
  const [tickets, setTickets] = useState([]);
  const [racine, setRacine] = useState('');
  const [saisieTicket, setSaisieTicket] = useState(destination ? destination.ticket : '');
  const [saisieSprint, setSaisieSprint] = useState(destination ? destination.sprint : '');
  const [inspection, setInspection] = useState(null);
  const [etatSprint, setEtatSprint] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [creationDemandee, setCreationDemandee] = useState(false);
  const [filtreTicket, setFiltreTicket] = useState('');

  useEffect(() => {
    let abandonne = false;
    (async () => {
      const reponse = await window.avmdf.avmdf.tickets();
      if (abandonne) return;
      setChargement(false);
      if (!reponse.ok) {
        onEchec(reponse);
        return;
      }
      setTickets(reponse.tickets);
      setRacine(reponse.racine);
      if (!saisieTicket && reponse.tickets.length) setSaisieTicket(reponse.tickets[0].nom);
    })();
    return () => {
      abandonne = true;
    };
  }, []);

  // Inspection du ticket saisi : convention en place et nom proposé.
  useEffect(() => {
    const ticket = saisieTicket.trim();
    if (!ticket) {
      setInspection(null);
      return undefined;
    }
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.avmdf.inspecter(ticket);
      if (abandonne) return;
      if (!reponse.ok) {
        setInspection({ erreur: reponse.erreur.message });
        return;
      }
      setInspection({ ...reponse.inspection, ticket: reponse.ticket });
      setCreationDemandee(false);
      if (!destination || destination.ticket !== reponse.ticket.nom) {
        setSaisieSprint(reponse.inspection.proposition);
      }
    }, 250);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [saisieTicket]);

  // État du dossier de sprint visé.
  useEffect(() => {
    if (!inspection || !inspection.ticket || !saisieSprint.trim()) {
      setEtatSprint(null);
      return undefined;
    }
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.avmdf.inspecterSprint(inspection.ticket.nom, saisieSprint.trim());
      if (abandonne) return;
      setEtatSprint(reponse.ok ? reponse : { erreur: reponse.erreur.message });
    }, 250);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [inspection && inspection.ticket && inspection.ticket.nom, saisieSprint]);

  async function creerTicket() {
    const reponse = await window.avmdf.avmdf.creerTicket(saisieTicket.trim());
    if (!reponse.ok) {
      onEchec(reponse);
      return;
    }
    setCreationDemandee(false);
    setSaisieTicket(reponse.ticket.nom);
  }

  const ticketExiste = inspection && inspection.existe && !inspection.erreur;
  const ticketNom = inspection && inspection.ticket ? inspection.ticket.nom : null;
  const cheminResolu = etatSprint && !etatSprint.erreur ? etatSprint.chemin : null;
  const incompatible = etatSprint && etatSprint.compatible && !etatSprint.compatible.compatible;
  const sprintOccupe = etatSprint && etatSprint.etat && etatSprint.etat.existe && !etatSprint.etat.vide;

  const listeFiltree = filtreTicket.trim()
    ? tickets.filter((t) => t.nom.toLowerCase().includes(filtreTicket.trim().toLowerCase()))
    : tickets;

  const valide = Boolean(ticketNom && cheminResolu && !incompatible);

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
            <h2>Ticket</h2>
            ${chargement ? html`<div class="attenue">Lecture du dossier d'archives…</div>` : null}
            <div class="champs">
              <div class="champ">
                <label for="filtre-ticket">Tickets existants</label>
                <div class="champ-corps">
                  <input
                    type="search"
                    id="filtre-ticket"
                    class="mono"
                    style="max-width:140px"
                    placeholder="4611"
                    value=${filtreTicket}
                    onInput=${(e) => setFiltreTicket(e.target.value)}
                  />
                  <select
                    size="1"
                    style="min-width:180px"
                    value=${ticketNom || ''}
                    aria-label="Choisir un ticket existant"
                    onChange=${(e) => setSaisieTicket(e.target.value)}
                  >
                    ${listeFiltree.length === 0 ? html`<option value="">aucun ticket</option>` : null}
                    ${listeFiltree.map((ticket) => html`<option value=${ticket.nom} key=${ticket.nom}>${ticket.nom}</option>`)}
                  </select>
                  <span class="attenue">${formaterNombre(tickets.length)} ticket(s)</span>
                </div>
              </div>

              <div class="champ">
                <label for="saisie-ticket">Ou numéro à saisir</label>
                <div class="champ-corps">
                  <input
                    type="text"
                    id="saisie-ticket"
                    class="mono"
                    style="max-width:200px"
                    placeholder="4611"
                    spellcheck="false"
                    value=${saisieTicket}
                    onInput=${(e) => setSaisieTicket(e.target.value)}
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
                    <strong>Le ticket ${ticketNom} n'existe pas encore.</strong>
                    <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
                      ${creationDemandee
                        ? html`
                            <span>Créer le dossier ${ticketNom} dans ${racine} ?</span>
                            <button type="button" class="btn btn-mini" onClick=${() => setCreationDemandee(false)}>
                              Annuler
                            </button>
                            <button type="button" class="btn btn-mini btn-accent" onClick=${creerTicket}>
                              Créer le ticket
                            </button>
                          `
                        : html`<button type="button" class="btn btn-mini" onClick=${() => setCreationDemandee(true)}>
                            Créer ${ticketNom}
                          </button>`}
                    </div>
                  </div>
                `
              : null}

            ${ticketExiste
              ? html`
                  <div class=${'encart' + (inspection.convention === 'mixte' ? ' encart-alerte' : '')} style="margin-top:10px">
                    <strong>Convention détectée :</strong> ${LIBELLES_CONVENTION[inspection.convention]}.
                    ${inspection.convention === 'historique'
                      ? html`<div style="margin-top:4px">
                          Ce ticket utilise l'ancienne organisation : ${formaterNombre(inspection.fichiersRacine)}
                          fichier(s) sont posés à sa racine. Ils ne seront pas touchés ; le nouveau dossier vient à côté.
                        </div>`
                      : null}
                    ${inspection.convention === 'mixte'
                      ? html`<div style="margin-top:4px">
                          Les deux conventions coexistent déjà dans ce ticket. Choisissez celle que vous voulez
                          poursuivre, et tenez-vous-y.
                        </div>`
                      : null}
                  </div>
                `
              : null}
          </section>

          <section class="section">
            <h2>Dossier de sprint</h2>
            ${ticketExiste && inspection.sprints.length
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
            title=${valide ? '' : 'Choisissez un ticket et un nom de dossier valide'}
            onClick=${() => onValider({ ticket: ticketNom, sprint: saisieSprint.trim(), chemin: cheminResolu })}
          >
            Choisir cette destination
          </button>
        </div>
      </div>
    </div>
  `;
}
