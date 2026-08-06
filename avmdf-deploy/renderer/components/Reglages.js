import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useEffect, useMemo, useState } from '../vendor/hooks.module.js';
import { Case, Champ, ChampDossier } from './Champs.js';
import { ListeMotifs } from './ListeMotifs.js';
import { TableauProjets } from './TableauProjets.js';

const html = htm.bind(h);

const CONTROLE_VIDE = { erreurs: [], avertissements: [] };

/**
 * Écran Réglages. Travaille sur un brouillon : rien n'est écrit tant que
 * « Enregistrer » n'a pas été utilisé.
 */
export function Reglages({
  config,
  infos,
  defauts,
  onEnregistrer,
  onReinitialiser,
  onComparaisonLibre,
  onFermer,
  onEchec
}) {
  const [brouillon, setBrouillon] = useState(() => structuredClone(config));
  const [controle, setControle] = useState(CONTROLE_VIDE);
  const [confirmation, setConfirmation] = useState(null);
  const [occupe, setOccupe] = useState(false);

  const modifie = useMemo(
    () => JSON.stringify(brouillon) !== JSON.stringify(config),
    [brouillon, config]
  );

  // Contrôle de cohérence par le processus principal : une seule source de
  // vérité pour les règles, y compris l'avertissement sur web.config.
  useEffect(() => {
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.config.verifier(brouillon);
      if (!abandonne && reponse.ok) setControle(reponse.controle);
    }, 200);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [brouillon]);

  // Sans tableau de dépendances : l'écouteur est réinstallé à chaque rendu pour
  // que `demanderFermeture` voie toujours l'état « modifié » courant.
  useEffect(() => {
    function surTouche(evenement) {
      if (evenement.key === 'Escape') {
        evenement.preventDefault();
        demanderFermeture();
      }
    }
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  });

  const erreurPour = (champ) => controle.erreurs.find((e) => e.champ === champ);
  const avertissementPour = (champ) => controle.avertissements.find((a) => a.champ === champ);
  const webConfigDecouvert = Boolean(avertissementPour('exclusions.fichiers'));

  function majRacine(cle, valeur) {
    setBrouillon((precedent) => ({
      ...precedent,
      racines: { ...precedent.racines, [cle]: valeur }
    }));
  }

  function majOption(cle, valeur) {
    setBrouillon((precedent) => ({
      ...precedent,
      options: { ...precedent.options, [cle]: valeur }
    }));
  }

  function majAppOffline(cle, valeur) {
    setBrouillon((precedent) => ({
      ...precedent,
      options: {
        ...precedent.options,
        appOffline: { ...precedent.options.appOffline, [cle]: valeur }
      }
    }));
  }

  function majLibre(cle, valeur) {
    setBrouillon((precedent) => ({
      ...precedent,
      comparaisonLibre: { ...precedent.comparaisonLibre, [cle]: valeur }
    }));
  }

  function demanderFermeture() {
    if (modifie) setConfirmation('fermer');
    else onFermer();
  }

  async function enregistrer() {
    setOccupe(true);
    const reponse = await onEnregistrer(brouillon);
    setOccupe(false);
    if (reponse && reponse.controle) setControle(reponse.controle);
    return reponse;
  }

  async function comparerDossiersLibres() {
    const reponse = await enregistrer();
    if (reponse && reponse.ok) onComparaisonLibre(brouillon.comparaisonLibre);
  }

  async function reinitialiser() {
    setOccupe(true);
    const reponse = await onReinitialiser();
    setOccupe(false);
    setConfirmation(null);
    if (reponse && reponse.ok) setBrouillon(structuredClone(reponse.config));
  }

  const libre = brouillon.comparaisonLibre;
  const libreComplet = Boolean(libre.dossierA.trim() && libre.dossierB.trim());

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Réglages">
      <div class="reglages">
        <div class="reglages-entete">
          <h1>Réglages</h1>
          <span class="attenue">
            ${modifie ? 'Modifications non enregistrées' : 'À jour'}
          </span>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-plat" onClick=${demanderFermeture}>Fermer ✕</button>
        </div>

        <div class="reglages-corps">
          ${controle.erreurs.length
            ? html`
                <div class="encart encart-danger" style="margin-bottom:16px">
                  <strong>${controle.erreurs.length} point(s) à corriger avant d'enregistrer</strong>
                  <ul>
                    ${controle.erreurs.map((erreur) => html`<li key=${erreur.champ}>${erreur.message}</li>`)}
                  </ul>
                </div>
              `
            : null}

          <!-- Racines ------------------------------------------------------ -->
          <section class="section">
            <h2>Racines</h2>
            <p class="section-aide">
              Les trois points d'ancrage de l'outil. Tous les dossiers de projet et toutes les
              destinations d'archivage sont résolus à partir d'eux.
            </p>
            <div class="champs">
              <${ChampDossier}
                libelle="Racine locale"
                valeur=${brouillon.racines.locale}
                erreur=${(erreurPour('racines.locale') || {}).message}
                aide="Dossier de vos sources, celui qui contient GPNET, WebService…"
                titreDialogue="Choisir la racine locale"
                onChange=${(valeur) => majRacine('locale', valeur)}
                onErreur=${onEchec}
              />
              <${ChampDossier}
                libelle="Racine de production"
                valeur=${brouillon.racines.prod}
                erreur=${(erreurPour('racines.prod') || {}).message}
                aide="Lecteur réseau du serveur IIS, par exemple Z:\\ "
                titreDialogue="Choisir la racine de production"
                onChange=${(valeur) => majRacine('prod', valeur)}
                onErreur=${onEchec}
              />
              <${ChampDossier}
                libelle="Racine des archives AVMDF"
                valeur=${brouillon.racines.avmdf}
                erreur=${(erreurPour('racines.avmdf') || {}).message}
                aide="Dossier « avant modification », un sous-dossier par ticket."
                titreDialogue="Choisir la racine AVMDF"
                onChange=${(valeur) => majRacine('avmdf', valeur)}
                onErreur=${onEchec}
              />
            </div>
          </section>

          <!-- Projets ------------------------------------------------------ -->
          <section class="section">
            <h2>Projets</h2>
            <p class="section-aide">
              Appariement explicite entre un dossier local et un dossier de production. Les noms
              n'ont pas besoin de correspondre : <span class="mono">GPNET</span> côté local peut
              viser <span class="mono">GPNet</span> côté prod. Un dossier local absent d'ici n'est
              jamais analysé ni déployé.
            </p>
            <${TableauProjets}
              projets=${brouillon.projets}
              racines=${brouillon.racines}
              erreurPour=${erreurPour}
              onChange=${(projets) => setBrouillon((precedent) => ({ ...precedent, projets }))}
            />
          </section>

          <!-- Exclusions --------------------------------------------------- -->
          <section class="section">
            <h2>Dossiers exclus</h2>
            <p class="section-aide">
              Jamais parcourus, des deux côtés. Les jokers <span class="mono">*</span> et
              <span class="mono">?</span> sont acceptés (<span class="mono">_ReSharper*</span>).
            </p>
            <${ListeMotifs}
              etiquette="Dossiers exclus"
              valeurs=${brouillon.exclusions.dossiers}
              placeholder="obj, node_modules, _ReSharper*…"
              onChange=${(dossiers) =>
                setBrouillon((precedent) => ({
                  ...precedent,
                  exclusions: { ...precedent.exclusions, dossiers }
                }))}
            />
            ${defauts
              ? html`<div style="margin-top:6px">
                  <button
                    type="button"
                    class="btn btn-plat btn-mini"
                    onClick=${() =>
                      setBrouillon((precedent) => ({
                        ...precedent,
                        exclusions: {
                          ...precedent.exclusions,
                          dossiers: defauts.exclusions.dossiers.slice()
                        }
                      }))}
                  >
                    Rétablir la liste par défaut
                  </button>
                </div>`
              : null}
          </section>

          <section class="section">
            <h2>Fichiers exclus</h2>
            <p class="section-aide">
              Ni comparés, ni déployés. Les jokers sont acceptés (<span class="mono">*.pdb</span>).
            </p>
            <${ListeMotifs}
              etiquette="Fichiers exclus"
              valeurs=${brouillon.exclusions.fichiers}
              placeholder="*.pdb, Thumbs.db…"
              onChange=${(fichiers) =>
                setBrouillon((precedent) => ({
                  ...precedent,
                  exclusions: { ...precedent.exclusions, fichiers }
                }))}
            />
            ${defauts
              ? html`<div style="margin-top:6px">
                  <button
                    type="button"
                    class="btn btn-plat btn-mini"
                    onClick=${() =>
                      setBrouillon((precedent) => ({
                        ...precedent,
                        exclusions: {
                          ...precedent.exclusions,
                          fichiers: defauts.exclusions.fichiers.slice()
                        }
                      }))}
                  >
                    Rétablir la liste par défaut
                  </button>
                </div>`
              : null}

            ${webConfigDecouvert
              ? html`
                  <div class="encart encart-danger" style="margin-top:10px">
                    <strong>web.config n'est plus exclu.</strong> Il sera comparé et pourra être
                    déployé. Chaque mise en production qui le concerne affichera un avertissement
                    en rouge : la chaîne de connexion et les réglages de production seront écrasés
                    par ceux de votre poste.
                  </div>
                `
              : html`
                  <div class="encart" style="margin-top:10px">
                    <strong>Pourquoi web.config est exclu par défaut :</strong> il contient la
                    chaîne de connexion et les réglages propres à chaque environnement. Celui de
                    développement ne vaut pas en production ; l'écraser coupe le site.
                  </div>
                `}
          </section>

          <!-- Extensions texte --------------------------------------------- -->
          <section class="section">
            <h2>Extensions considérées comme du texte</h2>
            <p class="section-aide">
              Détermine ce qui peut être comparé ligne à ligne. Tout le reste est traité comme
              binaire : taille, date et empreinte, sans diff.
            </p>
            <${ListeMotifs}
              etiquette="Extensions texte"
              valeurs=${brouillon.extensionsTexte}
              placeholder=".aspx"
              transformer=${(valeur) => {
                const propre = valeur.toLowerCase();
                if (!propre) return '';
                return propre.startsWith('.') ? propre : '.' + propre;
              }}
              onChange=${(extensionsTexte) => setBrouillon((precedent) => ({ ...precedent, extensionsTexte }))}
            />
            ${avertissementPour('extensionsTexte')
              ? html`<div class="encart encart-alerte" style="margin-top:10px">
                  ${avertissementPour('extensionsTexte').message}
                </div>`
              : null}
          </section>

          <!-- Options ------------------------------------------------------ -->
          <section class="section">
            <h2>Comparaison</h2>
            <div class="ligne-options">
              <${Case}
                libelle="Ignorer les espaces dans la comparaison"
                coche=${brouillon.options.ignorerEspaces}
                titre="Une ligne qui ne diffère que par l'indentation est considérée comme identique"
                onChange=${(valeur) => majOption('ignorerEspaces', valeur)}
              />
              <${Case}
                libelle="Ignorer les différences de fins de ligne (CRLF / LF)"
                coche=${brouillon.options.ignorerFinsDeLigne}
                titre="Un fichier passé de CRLF à LF n'apparaît pas comme entièrement modifié"
                onChange=${(valeur) => majOption('ignorerFinsDeLigne', valeur)}
              />
            </div>
            <div class="champs">
              <${Champ}
                libelle="Lectures simultanées"
                aide="Nombre de fichiers lus en parallèle pendant l'analyse. Au-delà de 12, un partage réseau SMB ralentit au lieu d'accélérer."
              >
                <input
                  type="number"
                  min="1"
                  max="32"
                  style="width:80px"
                  value=${brouillon.options.lecturesSimultanees}
                  onInput=${(evenement) =>
                    majOption('lecturesSimultanees', Number.parseInt(evenement.target.value, 10) || 1)}
                />
              <//>
            </div>
            ${avertissementPour('options.lecturesSimultanees')
              ? html`<div class="encart encart-alerte" style="margin-top:6px">
                  ${avertissementPour('options.lecturesSimultanees').message}
                </div>`
              : null}
          </section>

          <section class="section">
            <h2>Mise en production</h2>
            <div class="champs">
              <${Champ} libelle="Auteur" aide="Nom inscrit dans les manifestes et les récapitulatifs de traçabilité.">
                <input
                  type="text"
                  style="max-width:260px"
                  spellcheck="false"
                  value=${brouillon.options.auteur}
                  onInput=${(evenement) => majOption('auteur', evenement.target.value)}
                />
                ${infos && infos.utilisateur
                  ? html`<button
                      type="button"
                      class="btn"
                      title=${'Reprendre la session Windows : ' + infos.utilisateur}
                      onClick=${() => majOption('auteur', infos.utilisateur)}
                    >
                      Reprendre ${infos.utilisateur}
                    </button>`
                  : null}
              <//>
            </div>
            <div class="ligne-options" style="margin-top:10px">
              <${Case}
                libelle="Démarrer en mode simulation"
                coche=${brouillon.options.simulation}
                titre="En simulation, tout le processus se déroule et le rapport est produit, mais aucun octet n'est écrit"
                onChange=${(valeur) => majOption('simulation', valeur)}
              />
              <${Case}
                libelle="Déposer un app_offline.htm pendant la copie"
                coche=${brouillon.options.appOffline.actif}
                titre="Le fichier est déposé à la racine du site avant la copie, puis retiré après"
                onChange=${(valeur) => majAppOffline('actif', valeur)}
              />
            </div>
            ${brouillon.options.appOffline.actif
              ? html`
                  <div style="margin-top:8px">
                    <label class="attenue" for="contenu-app-offline">Contenu du app_offline.htm</label>
                    <textarea
                      id="contenu-app-offline"
                      rows="8"
                      style="width:100%;margin-top:4px"
                      spellcheck="false"
                      value=${brouillon.options.appOffline.contenu}
                      onInput=${(evenement) => majAppOffline('contenu', evenement.target.value)}
                    ></textarea>
                    ${defauts
                      ? html`<button
                          type="button"
                          class="btn btn-plat btn-mini"
                          style="margin-top:4px"
                          onClick=${() => majAppOffline('contenu', defauts.options.appOffline.contenu)}
                        >
                          Rétablir le contenu par défaut
                        </button>`
                      : null}
                  </div>
                `
              : null}
          </section>

          <!-- Comparaison libre -------------------------------------------- -->
          <section class="section">
            <h2>Comparer deux dossiers libres</h2>
            <p class="section-aide">
              Court-circuite la liste des projets et compare deux dossiers quelconques, sans
              archivage AVMDF. Utile hors du cadre GPNet.
            </p>
            <div class="champs">
              <${ChampDossier}
                libelle="Dossier A (référence)"
                valeur=${libre.dossierA}
                titreDialogue="Choisir le dossier A"
                aide="Affiché à gauche, comme la production."
                onChange=${(valeur) => majLibre('dossierA', valeur)}
                onErreur=${onEchec}
              />
              <${ChampDossier}
                libelle="Dossier B (à comparer)"
                valeur=${libre.dossierB}
                titreDialogue="Choisir le dossier B"
                aide="Affiché à droite, comme les sources locales."
                onChange=${(valeur) => majLibre('dossierB', valeur)}
                onErreur=${onEchec}
              />
            </div>
            <div style="margin-top:10px">
              <button
                type="button"
                class="btn"
                disabled=${!libreComplet || occupe}
                title=${libreComplet ? '' : 'Choisissez les deux dossiers'}
                onClick=${comparerDossiersLibres}
              >
                Comparer deux dossiers libres
              </button>
            </div>
          </section>

          <!-- Fichier de réglages ------------------------------------------ -->
          <section class="section">
            <h2>Fichier de réglages</h2>
            <p class="section-aide">
              Les réglages sont enregistrés dans ce fichier ; la version précédente est conservée à
              côté sous <span class="mono">config.precedent.json</span>.
            </p>
            <div class="mono attenue" style="word-break:break-all">
              ${infos ? infos.cheminConfig : ''}
            </div>
            <div style="margin-top:8px;display:flex;gap:6px">
              <button type="button" class="btn" onClick=${() => window.avmdf.config.revelerFichier()}>
                Ouvrir le dossier
              </button>
              <button type="button" class="btn btn-danger" onClick=${() => setConfirmation('reinitialiser')}>
                Réinitialiser tous les réglages
              </button>
            </div>
          </section>
        </div>

        <div class="reglages-pied">
          ${confirmation === 'fermer'
            ? html`
                <span class="grandir">Fermer sans enregistrer ? Les modifications seront perdues.</span>
                <button type="button" class="btn" onClick=${() => setConfirmation(null)}>Continuer l'édition</button>
                <button type="button" class="btn btn-danger" onClick=${onFermer}>Fermer sans enregistrer</button>
              `
            : confirmation === 'reinitialiser'
              ? html`
                  <span class="grandir">
                    Remettre tous les réglages à leurs valeurs par défaut ? Racines, projets et
                    exclusions actuels seront perdus.
                  </span>
                  <button type="button" class="btn" onClick=${() => setConfirmation(null)}>Annuler</button>
                  <button type="button" class="btn btn-danger" disabled=${occupe} onClick=${reinitialiser}>
                    Réinitialiser
                  </button>
                `
              : html`
                  <span class="grandir attenue">
                    ${controle.avertissements.length
                      ? controle.avertissements.length + ' avertissement(s) - l\'enregistrement reste possible.'
                      : ''}
                  </span>
                  <button type="button" class="btn" onClick=${demanderFermeture}>Fermer</button>
                  <button
                    type="button"
                    class="btn"
                    disabled=${occupe || !modifie || controle.erreurs.length > 0}
                    title=${controle.erreurs.length ? 'Corrigez les points signalés en rouge' : ''}
                    onClick=${enregistrer}
                  >
                    ${occupe ? 'Enregistrement…' : 'Enregistrer'}
                  </button>
                `}
        </div>
      </div>
    </div>
  `;
}
