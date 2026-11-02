import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../vendor/hooks.module.js';
import { Interrupteur } from './Champs.js';
import { EnTeteModale } from './Modale.js';
import { PanneauDestination } from './PanneauDestination.js';
import { VueDiff } from './VueDiff.js';
import { GardeRendu } from './GardeRendu.js';
import { LIBELLES, MARQUEURS, formaterDate, formaterNombre, formaterOctets } from './arborescence.js';
import {
  IconeAlerte,
  IconeArchiveBoite,
  IconeCoche,
  IconeCouches,
  IconeEchec,
  IconeEngrenage,
  IconeExpedier,
  IconeServeur
} from './icones.js';

const html = htm.bind(h);

/**
 * Espace WebServices : la mise en production d'un WS en quatre temps, sans
 * passer par « Publier » ni recompiler en Debug après coup.
 *
 *   1. version     : la version locale (My Project) doit dépasser celle en prod ;
 *   2. compilation : MSBuild en Release, vers un dossier temporaire ;
 *   3. comparaison : ce qui change dans le bin, Web.config et Global.asax à part ;
 *   4. mise en prod : dossier complet archivé sous AVMDF, puis copie.
 *
 * Plusieurs WS peuvent partir dans le même passage, sous la même demande et
 * le même sprint.
 */

const LIBELLES_ETAT = {
  pret: 'prêt',
  'version-identique': 'version identique',
  'version-ancienne': 'version plus ancienne',
  'version-inconnue': 'version à vérifier'
};

function formaterDuree(ms) {
  if (!ms && ms !== 0) return '-';
  const secondes = Math.round(ms / 1000);
  if (secondes < 60) return `${secondes} s`;
  return `${Math.floor(secondes / 60)} min ${String(secondes % 60).padStart(2, '0')} s`;
}

/** Deux numéros de version différents ? (parties manquantes = 0) */
function webservicesVersionDifferente(a, b) {
  const parties = (v) => String(v || '').split('.').map((x) => Number.parseInt(x, 10) || 0).concat([0, 0, 0, 0]).slice(0, 4);
  const x = parties(a);
  const y = parties(b);
  return x.some((n, i) => n !== y[i]);
}

function etatCompilation(compilation, enCours) {
  if (enCours) return { classe: 'encours', texte: 'compilation…' };
  if (!compilation) return null;
  if (compilation.annule) return { classe: 'echec', texte: 'annulée' };
  if (!compilation.ok) return { classe: 'echec', texte: 'échec' };
  if (compilation.comparaison && compilation.comparaison.erreur) return { classe: 'echec', texte: 'comparaison impossible' };
  return { classe: 'ok', texte: 'compilé' };
}

/** Les WS cochés, prêts à partir : compilés, comparés, avec au moins un fichier coché. */
function preparerEnvoi(cochesListe, compilations, selections) {
  const prets = [];
  const manquants = [];
  for (const nom of cochesListe) {
    const compilation = compilations[nom];
    const selection = selections[nom];
    if (!compilation || !compilation.ok || !compilation.comparaison || compilation.comparaison.erreur) {
      manquants.push({ nom, raison: 'pas encore compilé' });
    } else if (!selection || !selection.size) {
      manquants.push({ nom, raison: 'aucun fichier coché' });
    } else {
      prets.push({ nom, cles: Array.from(selection) });
    }
  }
  return { prets, manquants };
}

export function EspaceWebServices({ simulation, onSimulation, notifier, notifierEchec, onOuvrirReglages, onOuvrirHistorique, onRacines }) {
  const [inventaire, setInventaire] = useState({ etat: 'chargement', donnees: null });
  const [coches, setCoches] = useState(() => new Set());
  const [actif, setActif] = useState(null);
  const [compilations, setCompilations] = useState({});
  const [selections, setSelections] = useState({});
  const [journaux, setJournaux] = useState({});
  const [enCompilation, setEnCompilation] = useState(null);
  const [fileCompilation, setFileCompilation] = useState([]);
  const [destination, setDestination] = useState(null);
  const [archiver, setArchiver] = useState(true);
  const [pause, setPause] = useState(false);
  const [destinationOuverte, setDestinationOuverte] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [rapport, setRapport] = useState(null);
  const [diff, setDiff] = useState(null);
  const [bibliothequesOuvertes, setBibliothequesOuvertes] = useState(false);
  const [menu, setMenu] = useState(null);
  const [matrice, setMatrice] = useState(null);
  const [tests, setTests] = useState({});
  const arretDemande = useRef(false);

  // -- Inventaire -------------------------------------------------------------
  const charger = useCallback(
    async (options = {}) => {
      setInventaire((precedent) => ({ ...precedent, etat: 'chargement' }));
      const reponse = await window.avmdf.webservices.lister(options);
      if (!reponse.ok) {
        setInventaire({ etat: 'erreur', donnees: null, erreur: reponse.erreur });
        return;
      }
      setInventaire({ etat: 'pret', donnees: reponse });
      if (onRacines) onRacines(reponse.racines);
      // Chaque WS est interrogé en fond : la version qu'IIS a réellement
      // chargée, et le mode de compilation, s'affichent dès qu'ils arrivent.
      if (reponse.urlTest) {
        for (const ws of reponse.webservices) {
          setTests((t) => ({ ...t, [ws.nom]: { enCours: true } }));
          window.avmdf.webservices.tester(ws.nom, { silencieux: true, delai: 15000 }).then((r) => {
            setTests((t) => ({ ...t, [ws.nom]: r.ok ? r.test : null }));
          });
        }
      }
      // Les compilations encore en mémoire côté processus principal sont
      // reprises : changer d'onglet ne fait rien perdre.
      const reprises = {};
      for (const ws of reponse.webservices) if (ws.compilation) reprises[ws.nom] = ws.compilation;
      setCompilations((precedentes) => {
        const suivantes = {};
        for (const ws of reponse.webservices) {
          if (reprises[ws.nom]) suivantes[ws.nom] = reprises[ws.nom];
          else if (precedentes[ws.nom] && !precedentes[ws.nom].ok) suivantes[ws.nom] = precedentes[ws.nom];
        }
        return suivantes;
      });
      setSelections((precedentes) => {
        const suivantes = {};
        for (const [nom, compilation] of Object.entries(reprises)) {
          suivantes[nom] =
            precedentes[nom] || new Set(compilation.comparaison ? compilation.comparaison.selection : []);
        }
        return suivantes;
      });
      setCoches((precedentes) => {
        const valides = new Set(reponse.webservices.filter((w) => w.selectionnable).map((w) => w.nom));
        return new Set(Array.from(precedentes).filter((nom) => valides.has(nom)));
      });
      setActif((precedent) =>
        precedent && reponse.webservices.some((w) => w.nom === precedent)
          ? precedent
          : reponse.webservices.length
            ? reponse.webservices[0].nom
            : null
      );
    },
    []
  );

  useEffect(() => {
    charger();
  }, [charger]);

  useEffect(() => {
    const desabonner = window.avmdf.webservices.surJournal(({ nom, lignes }) => {
      setJournaux((precedents) => {
        const suite = (precedents[nom] || []).concat(lignes);
        return { ...precedents, [nom]: suite.length > 3000 ? suite.slice(-3000) : suite };
      });
    });
    return desabonner;
  }, []);

  const webservices = inventaire.donnees ? inventaire.donnees.webservices : [];
  const parNom = useMemo(() => new Map(webservices.map((w) => [w.nom, w])), [webservices]);
  const wsActif = actif ? parNom.get(actif) : null;
  const cochesListe = webservices.filter((w) => coches.has(w.nom)).map((w) => w.nom);
  const envoi = preparerEnvoi(cochesListe, compilations, selections);

  // -- Compilation ------------------------------------------------------------
  async function compilerListe(noms) {
    if (!noms.length || enCompilation) return;
    arretDemande.current = false;
    setFileCompilation(noms);
    let reussies = 0;
    const echecs = [];
    for (const nom of noms) {
      if (arretDemande.current) break;
      setEnCompilation(nom);
      setActif(nom);
      setJournaux((precedents) => ({ ...precedents, [nom]: [] }));
      const reponse = await window.avmdf.webservices.compiler(nom);
      setFileCompilation((file) => file.filter((n) => n !== nom));
      if (!reponse.ok) {
        echecs.push(nom);
        setCompilations((precedentes) => ({
          ...precedentes,
          [nom]: { nom, ok: false, erreur: reponse.erreur.message, conseil: reponse.erreur.conseil, erreurs: [] }
        }));
        continue;
      }
      const compilation = reponse.compilation;
      setCompilations((precedentes) => ({ ...precedentes, [nom]: compilation }));
      setSelections((precedentes) => ({
        ...precedentes,
        [nom]: new Set(compilation.comparaison ? compilation.comparaison.selection : [])
      }));
      if (compilation.ok && !(compilation.comparaison && compilation.comparaison.erreur)) reussies += 1;
      else echecs.push(nom);
    }
    setEnCompilation(null);
    setFileCompilation([]);
    if (echecs.length) {
      notifier({
        type: 'erreur',
        titre: `${echecs.length} compilation(s) en échec.`,
        texte: echecs.join(', ') + ' - le détail est dans le journal de compilation, à droite.'
      });
    } else if (reussies) {
      notifier({
        type: 'succes',
        titre: reussies > 1 ? `${reussies} WebServices compilés.` : `${noms[0]} compilé.`,
        texte: 'Vérifiez les fichiers cochés, puis mettez en production.',
        duree: 5000
      });
    }
  }

  function arreterCompilation() {
    arretDemande.current = true;
    window.avmdf.webservices.annulerCompilation();
  }

  // -- Mise en production -----------------------------------------------------
  const parametresPassage = (extra = {}) => ({
    webservices: envoi.prets,
    demande: archiver && destination ? destination.demande : null,
    sprint: archiver && destination ? destination.sprint : extra.sprint || null,
    archiver,
    simulation,
    appOffline: pause,
    ...extra
  });

  async function lancerControles() {
    if (archiver && !destination) {
      setDestinationOuverte(true);
      return;
    }
    setConfirmation({ etape: 'controle' });
    const reponse = await window.avmdf.webservices.preflight(parametresPassage());
    if (!reponse.ok) {
      setConfirmation(null);
      notifierEchec(reponse, 'Contrôles impossibles.');
      return;
    }
    setConfirmation({ etape: 'pret', reponse });
  }

  async function confirmer(commentaire) {
    const reponseControle = confirmation.reponse;
    setConfirmation({ ...confirmation, etape: 'execution' });
    const reponse = await window.avmdf.webservices.executer(
      parametresPassage({ commentaire, sprint: reponseControle.destination.sprint })
    );
    if (!reponse.ok) {
      if (reponse.controles) {
        setConfirmation({ etape: 'pret', reponse: { ...reponseControle, controles: reponse.controles, ok: false } });
      } else {
        setConfirmation(null);
      }
      notifierEchec(reponse, 'Mise en production interrompue.');
      return;
    }
    setConfirmation(null);
    setRapport({ ...reponse, destination: reponseControle.destination });

    if (!reponse.simulation) {
      // Comme pour le front : la destination ne survit pas à un passage réel.
      setDestination(null);
      setArchiver(true);
      setPause(false);
      const partis = reponse.resultats.filter((r) => r.manifeste).map((r) => r.nom);
      setCoches((precedentes) => new Set(Array.from(precedentes).filter((nom) => !partis.includes(nom))));
      setCompilations((precedentes) => {
        const suivantes = { ...precedentes };
        for (const nom of partis) delete suivantes[nom];
        return suivantes;
      });
      charger();
    }
  }

  async function ouvrirMatrice() {
    setMatrice({ etat: 'chargement' });
    const reponse = await window.avmdf.webservices.matrice();
    if (!reponse.ok) {
      setMatrice(null);
      notifierEchec(reponse, 'Lecture des DLL impossible.');
      return;
    }
    setMatrice({ etat: 'pret', donnees: reponse.matrice });
  }

  async function tester(nom) {
    setTests((t) => ({ ...t, [nom]: { enCours: true } }));
    const reponse = await window.avmdf.webservices.tester(nom);
    if (!reponse.ok) {
      setTests((t) => ({ ...t, [nom]: null }));
      notifierEchec(reponse, 'Test impossible.');
      return;
    }
    setTests((t) => ({ ...t, [nom]: reponse.test }));
    const infos = reponse.test.infos;
    notifier({
      type: reponse.test.ok && !(infos && infos.mode === 'DEBUG') ? 'succes' : 'erreur',
      titre: reponse.test.ok
        ? infos
          ? `${nom} répond : version ${infos.version}${infos.mode ? ', ' + infos.mode : ''}.`
          : `${nom} répond.`
        : `${nom} ne répond pas.`,
      texte: `${reponse.test.url} : ${reponse.test.statut ? 'HTTP ' + reponse.test.statut : reponse.test.erreur} en ${Math.round(reponse.test.duree / 100) / 10} s`
    });
  }

  async function actionMenu(action, ws) {
    const dernier = ws.passages && ws.passages[0];
    let reponse = { ok: true };
    if (action === 'compiler') compilerListe([ws.nom]);
    else if (action === 'cocher' || action === 'decocher') {
      setCoches((precedentes) => {
        const suivantes = new Set(precedentes);
        if (action === 'cocher') suivantes.add(ws.nom);
        else suivantes.delete(ws.nom);
        return suivantes;
      });
    } else if (action === 'assemblyinfo') reponse = await window.avmdf.systeme.ouvrir(ws.versionLocaleFichier);
    else if (action === 'projet') reponse = await window.avmdf.systeme.reveler(ws.projet);
    else if (action === 'prod') reponse = await window.avmdf.systeme.reveler(ws.dossierProd);
    else if (action === 'archive' && dernier) reponse = await window.avmdf.systeme.reveler(dernier.dossierSauvegarde);
    else if (action === 'historique') onOuvrirHistorique();
    else if (action === 'tester') tester(ws.nom);
    else if (action === 'copier') {
      const texte = `${ws.nom} ${ws.versionProd || '?'} -> ${ws.versionLocale || '?'}`;
      reponse = await window.avmdf.systeme.copier(texte);
      if (reponse.ok) notifier({ type: 'succes', titre: 'Copié.', texte, duree: 2500 });
    }
    if (!reponse.ok) notifierEchec(reponse, 'Action impossible.');
  }

  async function ouvrirDiff(nom, fichier) {
    const reponse = await window.avmdf.webservices.diff(nom, fichier.cle);
    if (!reponse.ok) {
      notifierEchec(reponse, 'Comparaison impossible.');
      return;
    }
    setDiff({ nom, donnees: reponse.diff });
  }

  // -- Rendu ------------------------------------------------------------------
  const donnees = inventaire.donnees;
  const msbuild = donnees ? donnees.msbuild : null;
  const reel = !simulation;
  const compilables = cochesListe.filter((nom) => parNom.get(nom) && parNom.get(nom).selectionnable);
  const raisonMep = !cochesListe.length
    ? 'Cochez au moins un WebService à gauche.'
    : envoi.manquants.length
      ? envoi.manquants.map((m) => `${m.nom} : ${m.raison}`).join(' · ')
      : archiver && !destination
        ? 'Choisissez d\'abord la demande et le dossier de sprint.'
        : null;

  return html`
    <div class="corps ws-corps">
      <section class="panneau panneau-gauche" aria-label="WebServices">
        <div class="panneau-entete">
          <span>WebServices</span>
          ${donnees ? html`<span class="attenue">${formaterNombre(webservices.length)}</span>` : null}
          <div style="flex:1"></div>
          <button
            type="button"
            class="btn btn-mini btn-plat"
            disabled=${inventaire.etat === 'chargement' || Boolean(enCompilation)}
            title="Relire les versions et rechercher MSBuild de nouveau"
            onClick=${() => charger({ rafraichirMsbuild: true })}
          >
            ${inventaire.etat === 'chargement' ? 'Lecture…' : 'Recharger'}
          </button>
          <button
            type="button"
            class="btn btn-mini btn-plat"
            disabled=${!donnees || !webservices.length}
            title="Version de chaque DLL partagée (DefinitionGlobale, Outils…) dans chaque WebService en production"
            onClick=${ouvrirMatrice}
          >
            DLL partagées
          </button>
        </div>

        ${donnees
          ? html`<div class="panneau-encart">
              ${msbuild && msbuild.chemin
                ? html`<div class="ws-msbuild attenue" title=${msbuild.chemin}>
                    <${IconeEngrenage} />
                    <span>MSBuild ${msbuild.version ? html`<span class="mono">${msbuild.version}</span>` : null}</span>
                    <span class="mono ws-msbuild-chemin">${msbuild.chemin}</span>
                  </div>`
                : html`<div class="encart encart-danger">
                    <strong>MSBuild introuvable.</strong> ${msbuild ? msbuild.erreur : ''}
                    <div style="margin-top:6px">
                      <button type="button" class="btn btn-mini" onClick=${onOuvrirReglages}>Ouvrir les réglages</button>
                    </div>
                  </div>`}
              ${donnees.erreurs.length
                ? html`<div class="encart encart-alerte" style="margin-top:6px">
                    ${donnees.erreurs.map((e) => html`<div key=${e}>${e}</div>`)}
                  </div>`
                : null}
            </div>`
          : null}

        <div class="panneau-contenu">
          ${inventaire.etat === 'erreur'
            ? html`<div class="etat-vide">
                <div class="etat-vide-titre">${inventaire.erreur.message}</div>
                <div class="etat-vide-texte">${inventaire.erreur.conseil}</div>
                <button type="button" class="btn" onClick=${onOuvrirReglages}>Ouvrir les réglages</button>
              </div>`
            : !donnees
              ? html`<div class="etat-vide"><div class="etat-vide-texte">Lecture des WebServices…</div></div>`
              : !webservices.length
                ? html`<div class="etat-vide">
                    <div class="etat-vide-icone"><${IconeServeur} /></div>
                    <div class="etat-vide-titre">Aucun WebService trouvé.</div>
                    <div class="etat-vide-texte">
                      L'outil cherche, dans <span class="mono">${donnees.racines.locale}</span>, les dossiers de projet
                      qui ont un dossier du même nom dans <span class="mono">${donnees.racines.prod}</span>.
                    </div>
                    <button type="button" class="btn" onClick=${onOuvrirReglages}>Vérifier les réglages</button>
                  </div>`
                : html`
                    <div class="ws-liste" role="list">
                      ${webservices.map((ws) => {
                        const compilation = compilations[ws.nom];
                        const etatC = etatCompilation(compilation, enCompilation === ws.nom);
                        const enFile = fileCompilation.includes(ws.nom) && enCompilation !== ws.nom;
                        return html`
                          <div
                            role="listitem"
                            key=${ws.nom}
                            class=${'ws-ligne' + (actif === ws.nom ? ' actif' : '') + (ws.selectionnable ? '' : ' bloque')}
                            onClick=${() => setActif(ws.nom)}
                            onContextMenu=${(e) => {
                              e.preventDefault();
                              setActif(ws.nom);
                              setMenu({ ws, x: e.clientX, y: e.clientY });
                            }}
                            title="Clic droit : ouvrir, montrer, compiler…"
                          >
                            <input
                              type="checkbox"
                              aria-label=${'Mettre en production ' + ws.nom}
                              checked=${coches.has(ws.nom)}
                              disabled=${!ws.selectionnable || Boolean(enCompilation)}
                              title=${ws.selectionnable ? 'Inclure ce WebService dans le passage' : ws.raison}
                              onClick=${(e) => e.stopPropagation()}
                              onChange=${(e) =>
                                setCoches((precedentes) => {
                                  const suivantes = new Set(precedentes);
                                  if (e.target.checked) suivantes.add(ws.nom);
                                  else suivantes.delete(ws.nom);
                                  return suivantes;
                                })}
                            />
                            <div class="ws-ligne-corps">
                              <div class="ws-ligne-nom">${ws.nom}</div>
                              <div class="ws-ligne-versions mono">
                                <span title="Version en production">${ws.versionProd || '?'}</span>
                                <span class="fleche">→</span>
                                <span
                                  class=${ws.etat === 'pret' ? 'ws-version-neuve' : ws.etat === 'version-inconnue' ? '' : 'rouge'}
                                  title="Version locale (My Project)"
                                >
                                  ${ws.versionLocale || '?'}
                                </span>
                              </div>
                            </div>
                            <div class="ws-ligne-etats">
                              <span class=${'ws-etat ws-etat-' + ws.etat} title=${ws.raison || ''}>${LIBELLES_ETAT[ws.etat] || ws.etat}</span>
                              ${tests[ws.nom] && !tests[ws.nom].enCours && !tests[ws.nom].ok
                                ? html`<span class="ws-etat ws-etat-version-ancienne" title=${tests[ws.nom].url + ' : ' + (tests[ws.nom].erreur || '')}>ne répond pas</span>`
                                : tests[ws.nom] && tests[ws.nom].infos && tests[ws.nom].infos.mode === 'DEBUG'
                                  ? html`<span class="ws-etat ws-etat-version-ancienne" title="Le WS en production annonce un mode de compilation DEBUG">DEBUG en prod</span>`
                                  : null}
                              ${etatC
                                ? html`<span class=${'ws-compil ws-compil-' + etatC.classe}>${etatC.texte}</span>`
                                : enFile
                                  ? html`<span class="ws-compil">en attente</span>`
                                  : null}
                            </div>
                          </div>
                        `;
                      })}
                    </div>

                    ${donnees.bibliotheques.length
                      ? html`<div class="ws-bibliotheques">
                          <button
                            type="button"
                            class="btn btn-mini btn-plat"
                            onClick=${() => setBibliothequesOuvertes(!bibliothequesOuvertes)}
                          >
                            ${bibliothequesOuvertes ? '▾' : '▸'} ${formaterNombre(donnees.bibliotheques.length)} projet(s) sans dossier en production
                          </button>
                          ${bibliothequesOuvertes
                            ? html`<div class="ws-bibliotheques-liste">
                                <p class="attenue">
                                  Ces projets ne partent jamais seuls. Une bibliothèque (OutilsWebService, OutilCryptage…)
                                  est recompilée avec chaque WebService qui l'utilise, et sa DLL à jour part dans le bin de
                                  celui-ci.
                                </p>
                                ${donnees.bibliotheques.map(
                                  (b) => html`<div class="ws-bibliotheque" key=${b.nom} title=${b.raison}>
                                    <span class="mono">${b.nom}</span>
                                    <span class="attenue">${b.web ? 'application web absente de la production' : 'bibliothèque'}</span>
                                  </div>`
                                )}
                              </div>`
                            : null}
                        </div>`
                      : null}
                  `}
        </div>
      </section>

      <section class="panneau panneau-droit ws-detail" aria-label="Détail du WebService">
        ${wsActif
          ? html`<${DetailWebService}
              ws=${wsActif}
              configuration=${donnees.configuration}
              compilation=${compilations[wsActif.nom]}
              enCours=${enCompilation === wsActif.nom}
              occupe=${Boolean(enCompilation)}
              journal=${journaux[wsActif.nom] || (compilations[wsActif.nom] && compilations[wsActif.nom].lignes) || []}
              selection=${selections[wsActif.nom] || new Set()}
              coche=${coches.has(wsActif.nom)}
              onCocher=${() => setCoches((precedentes) => new Set(precedentes).add(wsActif.nom))}
              onSelection=${(suivante) => setSelections((precedentes) => ({ ...precedentes, [wsActif.nom]: suivante }))}
              onCompiler=${() => compilerListe([wsActif.nom])}
              onArreter=${arreterCompilation}
              onDiff=${(fichier) => ouvrirDiff(wsActif.nom, fichier)}
              onReveler=${(chemin) => window.avmdf.systeme.reveler(chemin)}
              urlTest=${donnees.urlTest}
              tfsActif=${donnees.tfsActif}
              test=${tests[wsActif.nom]}
              onTester=${() => tester(wsActif.nom)}
            />`
          : html`<div class="etat-vide">
              <div class="etat-vide-icone"><${IconeServeur} /></div>
              <div class="etat-vide-titre">Mise en production des WebServices</div>
              <div class="etat-vide-texte">
                Cochez un ou plusieurs WebServices, compilez-les, vérifiez les fichiers qui changent, puis mettez en
                production. Le dossier complet de chaque WS est archivé sous AVMDF avant la moindre copie.
              </div>
            </div>`}
      </section>
    </div>

    <footer class=${'bandeau' + (reel ? ' reel' : '')}>
      <div class="bandeau-resume">
        <span class="bandeau-nombre">${formaterNombre(cochesListe.length)}</span>
        <div class="bandeau-libelles">
          <span class="bandeau-libelle">
            WebService${cochesListe.length > 1 ? 's' : ''} coché${cochesListe.length > 1 ? 's' : ''}
            ${envoi.prets.length && envoi.prets.length !== cochesListe.length
              ? html`<span class="attenue"> · ${envoi.prets.length} prêt(s)</span>`
              : null}
          </span>
          <span class="bandeau-sous bandeau-destination" title=${destination ? destination.chemin : ''}>
            ${!archiver
              ? 'passage mineur → AVMDFMINEUR'
              : destination
                ? `${destination.demande} / ${destination.sprint} / <WS>`
                : 'aucune destination choisie'}
          </span>
        </div>
        ${archiver
          ? html`<button type="button" class="btn btn-mini" disabled=${Boolean(confirmation)} onClick=${() => setDestinationOuverte(true)}>
              <${IconeArchiveBoite} /> ${destination ? 'Changer' : 'Choisir la destination…'}
            </button>`
          : null}
      </div>

      <div class="bandeau-actions">
        <span class=${'bandeau-etat ' + (reel ? 'reel' : 'simulation')}>${reel ? 'Écriture réelle' : 'Simulation'}</span>
        <span class="bandeau-separation" aria-hidden="true"></span>
        <${Interrupteur}
          libelle="Archiver"
          coche=${archiver}
          attention=${true}
          onChange=${setArchiver}
          titre="Décoché : passage sans numéro de demande, archivé quand même dans AVMDFMINEUR."
        />
        <${Interrupteur} libelle="Simulation" coche=${simulation} onChange=${onSimulation} titre="Tout se déroule, rien n'est écrit." />
        <${Interrupteur}
          libelle="Pause du WS"
          coche=${pause}
          onChange=${setPause}
          titre="Dépose app_offline.htm pendant la copie : le WS répond « maintenance » quelques secondes au lieu de démarrer avec un mélange d'anciennes et de nouvelles DLL. Retiré à la fin, même en cas d'erreur."
        />
        ${enCompilation
          ? html`<button type="button" class="btn" onClick=${arreterCompilation}>Arrêter la compilation</button>`
          : html`<button
              type="button"
              class="btn"
              disabled=${!compilables.length}
              title=${compilables.length ? 'Compile en Release chaque WS coché, l\'un après l\'autre' : 'Cochez au moins un WebService prêt'}
              onClick=${() => compilerListe(compilables)}
            >
              <${IconeEngrenage} /> Compiler${compilables.length > 1 ? ` (${compilables.length})` : ''}
            </button>`}
        <button
          type="button"
          class="btn btn-accent"
          disabled=${Boolean(raisonMep) || Boolean(enCompilation) || Boolean(confirmation)}
          title=${raisonMep || ''}
          onClick=${lancerControles}
        >
          <${IconeExpedier} /> Mettre en production${envoi.prets.length > 1 ? ` (${envoi.prets.length})` : ''}
        </button>
      </div>
    </footer>

    ${menu
      ? html`<${MenuWebService}
          key=${menu.ws.nom + '@' + menu.x + 'x' + menu.y}
          menu=${menu}
          coche=${coches.has(menu.ws.nom)}
          occupe=${Boolean(enCompilation)}
          urlTest=${donnees && donnees.urlTest}
          onFermer=${() => setMenu(null)}
          onAction=${(action) => {
            const ws = menu.ws;
            setMenu(null);
            actionMenu(action, ws);
          }}
        />`
      : null}

    ${destinationOuverte
      ? html`<${PanneauDestination}
          destination=${destination}
          onValider=${(choix) => {
            setDestination(choix);
            setDestinationOuverte(false);
            notifier({ type: 'succes', titre: 'Destination choisie.', texte: choix.chemin + '\\<WS>', duree: 4000 });
          }}
          onFermer=${() => setDestinationOuverte(false)}
          onEchec=${(reponse) => notifierEchec(reponse, 'Lecture du dossier d\'archives impossible.')}
        />`
      : null}

    ${confirmation
      ? html`<${ConfirmationWebServices}
          etat=${confirmation}
          onConfirmer=${confirmer}
          onRejouer=${lancerControles}
          onFermer=${() => setConfirmation(null)}
        />`
      : null}

    ${rapport
      ? html`<${RapportWebServices}
          rapport=${rapport}
          onFermer=${() => setRapport(null)}
          onReveler=${(chemin) => window.avmdf.systeme.reveler(chemin)}
          onOuvrirHistorique=${() => {
            setRapport(null);
            onOuvrirHistorique();
          }}
        />`
      : null}

    ${matrice
      ? html`<${MatriceDll} matrice=${matrice} onFermer=${() => setMatrice(null)} />`
      : null}

    ${diff
      ? html`<div class="voile" role="dialog" aria-modal="true" aria-label="Écart avec la production">
          <div class="modale modale-plein">
            <${EnTeteModale}
              icone=${IconeCouches}
              surtitre=${'WebService ' + diff.nom}
              titre="Production ↔ compilé"
              onFermer=${() => setDiff(null)}
            />
            <div class="historique-diff">
              <${GardeRendu}>
                <${VueDiff} diff=${diff.donnees} onOuvrirExterne=${() => {}} onNotifier=${notifier} inversable=${false} />
              <//>
            </div>
          </div>
        </div>`
      : null}
  `;
}

// ---------------------------------------------------------------------------
// Détail d'un WebService
// ---------------------------------------------------------------------------

function DetailWebService({
  ws,
  configuration,
  compilation,
  enCours,
  occupe,
  journal,
  selection,
  coche,
  onCocher,
  onSelection,
  onCompiler,
  onArreter,
  onDiff,
  onReveler,
  urlTest,
  tfsActif,
  test,
  onTester
}) {
  const [journalOuvert, setJournalOuvert] = useState(false);
  const [passagesOuverts, setPassagesOuverts] = useState(false);
  const [sourcesOuvertes, setSourcesOuvertes] = useState(false);
  const dernierPassage = ws.passages && ws.passages.length ? ws.passages[0] : null;

  // Les DLL nécessaires dépendent de ce qui est coché : recalculé à chaque
  // changement de sélection, côté processus principal où tout est en mémoire.
  const [references, setReferences] = useState(null);
  useEffect(() => {
    if (!compilation || !compilation.ok || !compilation.comparaison) {
      setReferences(null);
      return undefined;
    }
    let abandonne = false;
    window.avmdf.webservices.references(ws.nom, Array.from(selection)).then((reponse) => {
      if (!abandonne && reponse.ok) setReferences(reponse.references);
    });
    return () => {
      abandonne = true;
    };
  }, [compilation, selection, ws.nom]);
  const [identiquesOuverts, setIdentiquesOuverts] = useState(false);
  const [conservesOuverts, setConservesOuverts] = useState(false);
  const boiteJournal = useRef(null);

  useEffect(() => {
    if (enCours) setJournalOuvert(true);
  }, [enCours]);

  useEffect(() => {
    if (compilation && !compilation.ok) setJournalOuvert(true);
  }, [compilation]);

  useEffect(() => {
    if (journalOuvert && boiteJournal.current) boiteJournal.current.scrollTop = boiteJournal.current.scrollHeight;
  }, [journal, journalOuvert]);

  const comparaison = compilation && compilation.ok ? compilation.comparaison : null;
  const fichiers = comparaison ? comparaison.fichiers : [];
  const aDeployer = fichiers.filter((f) => f.statut !== 'identique');
  const identiques = fichiers.filter((f) => f.statut === 'identique');
  const etapeVersion = ws.etat === 'pret' ? 'ok' : ws.etat === 'version-inconnue' ? 'alerte' : 'echec';
  const etapeCompilation = enCours ? 'encours' : !compilation ? 'attente' : compilation.ok ? 'ok' : 'echec';
  const etapeComparaison = !comparaison ? 'attente' : comparaison.erreur ? 'echec' : 'ok';

  function basculer(cle, valeur) {
    const suivante = new Set(selection);
    if (valeur) suivante.add(cle);
    else suivante.delete(cle);
    onSelection(suivante);
  }

  const toutCoche = aDeployer.length > 0 && aDeployer.every((f) => selection.has(f.cle));

  return html`
    <div class="ws-detail-entete">
      <div class="ws-detail-titre">
        <span class="surtitre">WebService</span>
        <h2>${ws.nom}</h2>
      </div>
      <div class="ws-detail-chemins mono">
        <span title=${ws.projet}>${ws.projet}</span>
        <span class="fleche">→</span>
        <span title=${ws.dossierProd}>${ws.dossierProd}</span>
      </div>
      <div style="flex:1"></div>
      ${urlTest
        ? html`<button
            type="button"
            class="btn btn-plat"
            disabled=${test && test.enCours}
            title="Appelle l'adresse de test du WebService en production"
            onClick=${onTester}
          >
            ${test && test.enCours
              ? 'Test…'
              : test
                ? html`<span class=${test.ok ? 'compteur-nouveau' : 'rouge'}>${test.ok ? '● répond' : '● ne répond pas'}</span>`
                : 'Tester'}
          </button>`
        : null}
      ${enCours
        ? html`<button type="button" class="btn" onClick=${onArreter}>Arrêter</button>`
        : html`<button
            type="button"
            class="btn"
            disabled=${!ws.selectionnable || occupe}
            title=${ws.selectionnable ? `Compiler en ${configuration} dans un dossier temporaire` : ws.raison}
            onClick=${onCompiler}
          >
            <${IconeEngrenage} /> ${compilation ? 'Recompiler' : 'Compiler'}
          </button>`}
    </div>

    <div class="panneau-contenu ws-detail-corps">
      <ol class="ws-etapes">
        <li class=${'ws-etape ' + etapeVersion}>
          <${PuceEtape} etat=${etapeVersion} numero="1" />
          <div class="ws-etape-corps">
            <div class="ws-etape-titre">Version</div>
            <div class="ws-versions">
              <div>
                <span class="attenue">En production</span>
                <span class="mono ws-version">${ws.versionProd || '?'}</span>
              </div>
              <span class="fleche">→</span>
              <div>
                <span class="attenue">Locale (My Project)</span>
                <span class=${'mono ws-version' + (ws.etat === 'pret' ? ' ws-version-neuve' : '')}>${ws.versionLocale || '?'}</span>
              </div>
            </div>
            <div class="ws-infos attenue">
              ${test && test.infos
                ? html`<div>
                    Chargée par IIS (api/Informations) :
                    <span class=${'mono' + (test.infos.mode === 'DEBUG' ? ' rouge' : '')}>
                      ${test.infos.version}${test.infos.mode ? ' · ' + test.infos.mode : ''}
                    </span>
                    ${ws.versionProd && webservicesVersionDifferente(test.infos.version, ws.versionProd)
                      ? html`<span class="rouge"> · différente de la DLL en production (${ws.versionProd}) : IIS n'a peut-être pas rechargé le WS</span>`
                      : null}
                    ${test.infos.mode === 'DEBUG' ? html`<span class="rouge"> · le WS tourne en DEBUG en production</span>` : null}
                  </div>`
                : test && !test.enCours && !test.ok
                  ? html`<div class="rouge">Ne répond pas : ${test.url} (${test.erreur || 'HTTP ' + test.statut})</div>`
                  : null}
              ${ws.dateProd
                ? html`<div>DLL en production datée du <span class="mono">${formaterDate(ws.dateProd)}</span></div>`
                : null}
              ${dernierPassage
                ? html`<div>
                    Dernier passage par MEPFront : <span class="mono">${formaterDate(new Date(dernierPassage.date).getTime())}</span>
                    ${dernierPassage.auteur ? html` par <strong>${dernierPassage.auteur}</strong>` : null}
                    · <span class="mono">${dernierPassage.demande}</span>
                    ${dernierPassage.versionApres
                      ? html` · version <span class="mono">${dernierPassage.versionAvant || '?'} → ${dernierPassage.versionApres}</span>`
                      : null}
                    ${dernierPassage.operation === 'restauration' ? html` · <span class="etiquette">retour arrière</span>` : null}
                    ${dernierPassage.commentaire ? html`<div class="ws-commentaire">« ${dernierPassage.commentaire} »</div>` : null}
                  </div>`
                : html`<div>Aucun passage par MEPFront pour ce WebService : les mises en production précédentes ont été faites à la main.</div>`}
            </div>

            ${ws.passages && ws.passages.length > 1
              ? html`<div style="margin-top:4px">
                  <button type="button" class="btn btn-mini btn-plat" onClick=${() => setPassagesOuverts(!passagesOuverts)}>
                    ${passagesOuverts ? '▾' : '▸'} ${formaterNombre(ws.passages.length)} derniers passages
                  </button>
                  ${passagesOuverts
                    ? html`<table class="tableau ws-passages">
                        <tbody>
                          ${ws.passages.map(
                            (p) => html`<tr key=${p.chemin}>
                              <td class="mono">${formaterDate(new Date(p.date).getTime())}</td>
                              <td>${p.auteur || '-'}</td>
                              <td class="mono">${p.demande} / ${p.sprint}</td>
                              <td class="mono">${p.versionApres ? `${p.versionAvant || '?'} → ${p.versionApres}` : '-'}</td>
                              <td>${p.operation === 'restauration' ? 'retour arrière' : `${p.fichiers} fichier(s)`}</td>
                            </tr>`
                          )}
                        </tbody>
                      </table>`
                    : null}
                </div>`
              : null}

            ${ws.dateProd
              ? html`<div style="margin-top:4px">
                  ${ws.sourcesModifiees.total
                    ? html`<button type="button" class="btn btn-mini btn-plat" onClick=${() => setSourcesOuvertes(!sourcesOuvertes)}>
                        ${sourcesOuvertes ? '▾' : '▸'} ${formaterNombre(ws.sourcesModifiees.total)} fichier(s) source modifié(s) depuis la mise en production
                      </button>`
                    : html`<span class="attenue">Aucun fichier source modifié depuis la date de la DLL en production.</span>`}
                  ${sourcesOuvertes && ws.sourcesModifiees.total
                    ? html`<div class="liste-fichiers mono">
                        <div class="attenue" style="font-family:inherit">
                          D'après la date des fichiers : une récupération TFS peut aussi rajeunir un fichier inchangé.
                        </div>
                        ${ws.sourcesModifiees.fichiers.map(
                          (f) => html`<div key=${f.chemin}>
                            <span style="flex:1">${f.chemin}</span>
                            <span class="attenue">${formaterDate(f.mtimeMs)}</span>
                          </div>`
                        )}
                        ${ws.sourcesModifiees.total > ws.sourcesModifiees.fichiers.length
                          ? html`<div class="attenue">… et ${ws.sourcesModifiees.total - ws.sourcesModifiees.fichiers.length} autres</div>`
                          : null}
                      </div>`
                    : null}
                </div>`
              : null}

            ${ws.raison
              ? html`<div class=${'encart ' + (etapeVersion === 'echec' ? 'encart-danger' : 'encart-alerte')} style="margin-top:8px">
                  ${ws.raison}
                  ${etapeVersion === 'echec'
                    ? html`<div class="attenue" style="margin-top:4px">
                        Une fois le numéro changé et enregistré dans Visual Studio, cliquez sur « Recharger » en haut à gauche.
                      </div>`
                    : null}
                </div>`
              : null}
          </div>
        </li>

        <li class=${'ws-etape ' + etapeCompilation}>
          <${PuceEtape} etat=${etapeCompilation} numero="2" />
          <div class="ws-etape-corps">
            <div class="ws-etape-titre">
              Compilation ${configuration}
              ${compilation && !enCours && compilation.duree !== undefined
                ? html`<span class="attenue"> · ${formaterDuree(compilation.duree)}</span>`
                : null}
              ${compilation && compilation.avertissements
                ? html`<span class="attenue"> · ${formaterNombre(compilation.avertissements)} avertissement(s)</span>`
                : null}
            </div>
            ${enCours
              ? html`<div class="attenue">MSBuild travaille… Votre projet de développement n'est pas touché : tout part dans un dossier temporaire.</div>`
              : !compilation
                ? html`<div class="attenue">
                    Pas encore compilé. La compilation se fait en ${configuration} dans un dossier temporaire : le bin de votre
                    projet reste en Debug, inutile de recompiler après.
                  </div>`
                : compilation.ok
                  ? html`<div>
                      Version compilée <span class="mono ws-version-neuve">${compilation.versionCompilee || '?'}</span>
                      ${compilation.sortie
                        ? html` · <button type="button" class="btn btn-mini btn-plat" onClick=${() => onReveler(compilation.sortie)}>Ouvrir le dossier compilé</button>`
                        : null}
                    </div>`
                  : html`<div class="encart encart-danger">
                      <strong>${compilation.erreur || 'La compilation a échoué.'}</strong>
                      ${compilation.conseil ? html`<div>${compilation.conseil}</div>` : null}
                      ${compilation.erreurs && compilation.erreurs.length
                        ? html`<ul class="mono">
                            ${compilation.erreurs.slice(0, 8).map((e, i) => html`<li key=${i}>${e}</li>`)}
                          </ul>`
                        : null}
                    </div>`}

            ${compilation && compilation.paquets && compilation.paquets.manquants && compilation.paquets.manquants.length
              ? html`<div class="encart encart-alerte" style="margin-top:8px">
                  <strong>${compilation.paquets.manquants.length} paquet(s) NuGet absent(s)</strong>
                  ${compilation.paquets.dossierPaquets ? html` de <span class="mono">${compilation.paquets.dossierPaquets}</span>` : null}.
                  Si la compilation échoue, ouvrez la solution dans Visual Studio : clic droit sur la solution → « Restaurer les packages NuGet ».
                  <ul class="mono">${compilation.paquets.manquants.slice(0, 6).map((p) => html`<li key=${p}>${p}</li>`)}</ul>
                </div>`
              : null}

            ${compilation && compilation.binLocalModifie && compilation.binLocalModifie.length
              ? html`<div class="encart encart-alerte" style="margin-top:8px">
                  <strong>Le bin de votre projet de développement a changé pendant la compilation</strong>
                  (${compilation.binLocalModifie.length} fichier(s)). Cela ne devrait pas arriver : recompilez le projet en Debug dans
                  Visual Studio par précaution.
                </div>`
              : null}

            ${compilation && compilation.ok && tfsActif
              ? !compilation.tfs
                ? null
                : !compilation.tfs.ok
                  ? html`<div class="attenue" style="margin-top:8px">TFS : vérification impossible (${compilation.tfs.erreur}).</div>`
                  : compilation.tfs.changements.length
                    ? html`<div class="encart encart-alerte" style="margin-top:8px">
                        <strong>${compilation.tfs.changements.length} fichier(s) non archivé(s) dans TFS</strong>, compilé(s) dans ce qui va
                        partir. Archivez-les, sinon le prochain qui récupère les sources et republie effacera ces modifications.
                        <ul class="mono">
                          ${compilation.tfs.changements.slice(0, 12).map((c) => html`<li key=${c.chemin} title=${c.chemin}>${c.nom} <span class="attenue">(${c.changement})</span></li>`)}
                          ${compilation.tfs.changements.length > 12 ? html`<li>… et ${compilation.tfs.changements.length - 12} autres</li>` : null}
                        </ul>
                      </div>`
                    : html`<div class="attenue" style="margin-top:8px">TFS : tout est archivé (WebService et bibliothèques qu'il utilise).</div>`
              : null}

            ${journal.length || enCours
              ? html`<div style="margin-top:6px">
                  <button type="button" class="btn btn-mini btn-plat" onClick=${() => setJournalOuvert(!journalOuvert)}>
                    ${journalOuvert ? '▾' : '▸'} Journal de compilation (${formaterNombre(journal.length)} ligne(s))
                  </button>
                  ${journalOuvert
                    ? html`<pre class="ws-journal mono" ref=${boiteJournal}>${journal.map(
                        (ligne, i) =>
                          html`<div
                            key=${i}
                            class=${/:\s*(error|erreur)\s/i.test(ligne)
                              ? 'ws-journal-erreur'
                              : /:\s*(warning|avertissement)\s/i.test(ligne)
                                ? 'ws-journal-avertissement'
                                : ''}
                          >${ligne || ' '}</div>`
                      )}</pre>`
                    : null}
                </div>`
              : null}
          </div>
        </li>

        <li class=${'ws-etape ' + etapeComparaison}>
          <${PuceEtape} etat=${etapeComparaison} numero="3" />
          <div class="ws-etape-corps">
            <div class="ws-etape-titre">
              Fichiers à mettre en production
              ${comparaison && !comparaison.erreur
                ? html`<span class="attenue"> · ${formaterNombre(selection.size)} coché(s) sur ${formaterNombre(aDeployer.length)}</span>`
                : null}
            </div>
            ${!comparaison
              ? html`<div class="attenue">La comparaison avec la production se fait juste après la compilation.</div>`
              : comparaison.erreur
                ? html`<div class="encart encart-danger">${comparaison.erreur}</div>`
                : html`
                    ${!aDeployer.length
                      ? html`<div class="encart">Le résultat compilé est identique à la production : rien à mettre en production.</div>`
                      : html`<table class="tableau ws-fichiers">
                          <thead>
                            <tr>
                              <th style="width:24px">
                                <input
                                  type="checkbox"
                                  aria-label="Tout cocher"
                                  checked=${toutCoche}
                                  onChange=${(e) =>
                                    onSelection(
                                      e.target.checked
                                        ? new Set(aDeployer.filter((f) => !f.sensible || selection.has(f.cle)).map((f) => f.cle))
                                        : new Set()
                                    )}
                                  title="Tout cocher (sauf Web.config et Global.asax, qui se cochent un par un)"
                                />
                              </th>
                              <th>Fichier</th>
                              <th>État</th>
                              <th>Version</th>
                              <th style="text-align:right">Production</th>
                              <th style="text-align:right">Compilé</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            ${aDeployer.map(
                              (f) => html`
                                <tr key=${f.cle} class=${f.sensible ? 'ws-sensible' : ''}>
                                  <td>
                                    <input
                                      type="checkbox"
                                      aria-label=${'Mettre en production ' + f.chemin}
                                      checked=${selection.has(f.cle)}
                                      onChange=${(e) => basculer(f.cle, e.target.checked)}
                                    />
                                  </td>
                                  <td class="mono">
                                    ${f.chemin}
                                    ${f.sensible
                                      ? html`<div class="ws-sensible-note">
                                          Configuration de production : décoché par défaut. Regardez l'écart avant de le cocher.
                                        </div>`
                                      : null}
                                  </td>
                                  <td>
                                    <span class=${'compteur compteur-' + f.statut}>${MARQUEURS[f.statut]} ${LIBELLES[f.statut]}</span>
                                  </td>
                                  <td class="mono ws-version-dll">
                                    ${f.versionLocale || f.versionProd
                                      ? f.versionProd === f.versionLocale
                                        ? html`<span class="attenue" title="Même numéro, contenu recompilé">${f.versionLocale}</span>`
                                        : html`<span title="Version en production → version compilée">
                                            ${f.versionProd || '-'} → <span class="ws-version-neuve">${f.versionLocale || '-'}</span>
                                          </span>`
                                      : html`<span class="attenue">-</span>`}
                                  </td>
                                  <td class="mono attenue" style="text-align:right" title=${f.dateProd ? 'En production depuis le ' + formaterDate(f.dateProd) : ''}>
                                    ${f.tailleProd === null ? '-' : formaterOctets(f.tailleProd)}
                                  </td>
                                  <td class="mono" style="text-align:right">${formaterOctets(f.tailleLocale)}</td>
                                  <td style="text-align:right">
                                    <button type="button" class="btn btn-mini" onClick=${() => onDiff(f)}>
                                      ${f.texte ? 'Voir l\'écart' : 'Comparer'}
                                    </button>
                                  </td>
                                </tr>
                              `
                            )}
                          </tbody>
                        </table>`}

                    ${aDeployer.length && !coche
                      ? html`<div class="encart encart-alerte" style="margin-top:8px">
                          Ce WebService n'est pas coché dans la liste : il ne partira pas.
                          <button type="button" class="btn btn-mini" style="margin-left:8px" onClick=${onCocher}>Le cocher</button>
                        </div>`
                      : null}

                    <${ControlesWebService} comparaison=${comparaison} references=${references} />

                    ${identiques.length
                      ? html`<div style="margin-top:8px">
                          <button type="button" class="btn btn-mini btn-plat" onClick=${() => setIdentiquesOuverts(!identiquesOuverts)}>
                            ${identiquesOuverts ? '▾' : '▸'} ${formaterNombre(identiques.length)} fichier(s) identique(s) à la production, ignoré(s)
                          </button>
                          ${identiquesOuverts
                            ? html`<div class="liste-fichiers mono">
                                ${identiques.map((f) => html`<div key=${f.cle}><span class="marqueur marqueur-identique">=</span>${f.chemin}</div>`)}
                              </div>`
                            : null}
                        </div>`
                      : null}

                    ${comparaison.conserves.length
                      ? html`<div style="margin-top:4px">
                          <button type="button" class="btn btn-mini btn-plat" onClick=${() => setConservesOuverts(!conservesOuverts)}>
                            ${conservesOuverts ? '▾' : '▸'} ${formaterNombre(comparaison.conserves.length)} fichier(s) présent(s) seulement en production, conservé(s)
                          </button>
                          ${conservesOuverts
                            ? html`<div class="liste-fichiers mono">
                                <div class="attenue" style="font-family:inherit">Jamais supprimés par l'outil.</div>
                                ${comparaison.conserves.map((c) => html`<div key=${c}><span class="marqueur marqueur-orphelin">−</span>${c}</div>`)}
                              </div>`
                            : null}
                        </div>`
                      : null}
                  `}
          </div>
        </li>
      </ol>
    </div>
  `;
}

function PuceEtape({ etat, numero }) {
  return html`<span class=${'ws-puce ' + etat} aria-hidden="true">
    ${etat === 'ok' ? html`<${IconeCoche} />` : etat === 'echec' ? html`<${IconeEchec} />` : etat === 'alerte' ? html`<${IconeAlerte} />` : numero}
  </span>`;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

function ListeProblemes({ problemes, classe, titre }) {
  if (!problemes.length) return null;
  return html`
    <div class=${'encart ' + classe} style="margin-bottom:12px">
      <strong>${titre}</strong>
      ${problemes.map(
        (p, i) => html`<div class="probleme" key=${i}>
          <div>${p.message}</div>
          ${p.conseil ? html`<div class="attenue">${p.conseil}</div>` : null}
          ${p.fichiers && p.fichiers.length
            ? html`<ul class="mono">
                ${p.fichiers.slice(0, 8).map((c) => html`<li key=${c}>${c}</li>`)}
                ${p.fichiers.length > 8 ? html`<li>… et ${p.fichiers.length - 8} autres</li>` : null}
              </ul>`
            : null}
        </div>`
      )}
    </div>
  `;
}

function ConfirmationWebServices({ etat, onConfirmer, onRejouer, onFermer }) {
  const [saisie, setSaisie] = useState('');
  const [commentaire, setCommentaire] = useState('');

  if (etat.etape === 'controle') {
    return html`
      <div class="voile" role="dialog" aria-modal="true" aria-label="Contrôles en cours">
        <div class="modale modale-moyenne">
          <${EnTeteModale} icone=${IconeExpedier} surtitre="WebServices" titre="Contrôles en cours…" onFermer=${onFermer} />
          <div class="modale-corps">
            <div class="attenue">
              Accès à la production et aux archives, fichiers verrouillés, versions, place disponible… Rien n'est écrit.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const reponse = etat.reponse;
  const occupe = etat.etape === 'execution';
  const bloquants = reponse.controles.flatMap((c) => c.bloquants);
  const avertissements = reponse.controles.flatMap((c) => c.avertissements);
  const totalFichiers = reponse.controles.reduce((t, c) => t + c.resume.fichiers.length, 0);
  const numeroDemande = reponse.destination.mineur ? '' : String(reponse.destination.demande || '').replace(/\D/g, '');
  const aRecopier = numeroDemande || String(totalFichiers);
  const libelleSaisie = numeroDemande ? 'le numéro de la demande' : 'le nombre de fichiers';
  const peutPartir = reponse.ok && saisie.trim() === aRecopier && !occupe;

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="Confirmation de mise en production des WebServices">
      <div class="modale modale-large">
        <${EnTeteModale}
          icone=${IconeExpedier}
          surtitre="WebServices"
          titre=${reponse.controles.length > 1 ? `Mettre en production ${reponse.controles.length} WebServices` : `Mettre en production ${reponse.controles[0].nom}`}
          onFermer=${occupe ? null : onFermer}
        >
          <span class=${'bandeau-etat ' + (reponse.simulation ? 'simulation' : 'reel')}>
            ${reponse.simulation ? 'Simulation' : 'Écriture réelle'}
          </span>
        <//>

        <div class="modale-corps">
          ${bloquants.length
            ? html`<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
                <button type="button" class="btn btn-mini" disabled=${occupe} onClick=${onRejouer}>Rejouer les contrôles</button>
              </div>`
            : null}
          <${ListeProblemes}
            problemes=${bloquants}
            classe="encart-danger"
            titre=${`${bloquants.length} point(s) bloquant(s) - la mise en production est refusée.`}
          />
          <${ListeProblemes} problemes=${avertissements} classe="encart-alerte" titre=${`${avertissements.length} avertissement(s)`} />

          <div class="mission-papiers" style="margin-bottom:10px">
            ${reponse.destination.mineur
              ? html`<span class="mission-demande sans mono">sans demande</span>`
              : html`<span class="mission-demande mono">${reponse.destination.demande}</span>`}
            <span class="attenue">sprint <span class="mono">${reponse.destination.sprint}</span></span>
            <span style="flex:1"></span>
            ${reponse.appOffline
              ? html`<span class="etiquette">pause du WS pendant la copie</span>`
              : html`<span class="attenue">sans pause du WS</span>`}
          </div>

          ${reponse.controles.map(
            (c) => html`<div class=${'ws-carte' + (c.ok ? '' : ' en-echec')} key=${c.nom}>
              <div class="ws-carte-entete">
                <span class="ws-carte-nom">${c.nom}</span>
                <span class="mono">
                  ${c.resume.versionProd || '?'} <span class="fleche">→</span>
                  <span class="ws-version-neuve">${c.resume.versionCompilee || '?'}</span>
                </span>
                <span style="flex:1"></span>
                ${Object.entries(c.resume.parStatut)
                  .filter(([, n]) => n)
                  .map(
                    ([statut, n]) => html`<span class=${'compteur compteur-' + statut} key=${statut}>
                      ${MARQUEURS[statut]} ${n} ${LIBELLES[statut]}${n > 1 ? 's' : ''}
                    </span>`
                  )}
                <span class="attenue mono">${formaterOctets(c.resume.octets)}</span>
              </div>
              <div class="ws-carte-trajet attenue">
                <div><${IconeArchiveBoite} /> dossier complet archivé dans <span class="mono">${c.resume.dossierSauvegarde}</span></div>
                <div><${IconeExpedier} /> copié dans <span class="mono">${c.resume.racineProd}</span></div>
              </div>
              <div class="liste-fichiers mono">
                ${c.resume.fichiers.map(
                  (f) => html`<div key=${f.chemin}>
                    <span class=${'marqueur marqueur-' + f.statut}>${MARQUEURS[f.statut]}</span>
                    <span style="flex:1" class=${f.sensible ? 'rouge' : ''}>${f.chemin}</span>
                    <span class="attenue">${formaterOctets(f.taille)}</span>
                  </div>`
                )}
              </div>
            </div>`
          )}

          <div class="champ-commentaire">
            <label for="commentaire-ws">Commentaire <span class="attenue">(facultatif)</span></label>
            <input
              type="text"
              id="commentaire-ws"
              maxlength="600"
              placeholder="Pourquoi ce passage part : correctif chargement, nouvelle route…"
              autocomplete="off"
              disabled=${occupe}
              value=${commentaire}
              onInput=${(e) => setCommentaire(e.target.value)}
            />
          </div>

          ${reponse.simulation
            ? html`<div class="encart" style="margin-top:14px">
                <strong>Mode simulation.</strong> Tout se déroule et le rapport est produit, mais rien n'est écrit, ni en
                production ni dans les archives. Décochez « Simulation » dans le bandeau du bas pour déployer réellement.
              </div>`
            : null}
        </div>

        <div class="modale-pied">
          <label for="confirmation-ws" class=${'confirmation-libelle' + (reponse.ok ? '' : ' attenue')}>
            Pour confirmer, recopiez ${libelleSaisie}
            <span class="confirmation-tampon mono">${aRecopier}</span>
          </label>
          <input
            type="text"
            id="confirmation-ws"
            class="mono"
            style="width:90px"
            autocomplete="off"
            spellcheck="false"
            disabled=${!reponse.ok || occupe}
            value=${saisie}
            onInput=${(e) => setSaisie(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter' && peutPartir) onConfirmer(commentaire);
            }}
          />
          <div style="flex:1"></div>
          <button type="button" class="btn" disabled=${occupe} onClick=${onFermer}>Annuler</button>
          <button type="button" class="btn btn-accent" disabled=${!peutPartir} onClick=${() => onConfirmer(commentaire)}>
            ${occupe ? 'En cours…' : reponse.simulation ? 'Lancer la simulation' : 'Mettre en production'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

const LIBELLES_ACTION = { remplacement: 'remplacé', creation: 'créé', suppression: 'supprimé', restauration: 'restauré' };

function RapportWebServices({ rapport, onFermer, onReveler, onOuvrirHistorique }) {
  const echecs = rapport.resultats.filter((r) => r.erreur || (r.rapport && r.rapport.echecs));
  const titre = rapport.simulation
    ? 'Simulation terminée'
    : echecs.length
      ? 'Mise en production terminée avec des échecs'
      : 'Mise en production terminée';

  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label=${titre}>
      <div class="modale modale-large">
        <${EnTeteModale} icone=${IconeExpedier} danger=${echecs.length > 0} surtitre="WebServices" titre=${titre} onFermer=${onFermer}>
          ${rapport.simulation ? html`<span class="bandeau-etat simulation">Simulation</span>` : null}
        <//>
        <div class="modale-corps">
          ${rapport.resultats.map((r) => {
            const manifeste = r.manifeste;
            const ws = manifeste && manifeste.webservice;
            const appOffline = manifeste && manifeste.appOffline;
            return html`<div class=${'ws-carte' + (r.erreur || (r.rapport && r.rapport.echecs) ? ' en-echec' : '')} key=${r.nom}>
              <div class="ws-carte-entete">
                <span class="ws-carte-nom">${r.nom}</span>
                ${ws
                  ? html`<span class="mono">${ws.versionAvant || '?'} <span class="fleche">→</span> <span class="ws-version-neuve">${ws.versionApres || '?'}</span></span>`
                  : null}
                <span style="flex:1"></span>
                ${r.rapport
                  ? html`<span class="attenue">
                      ${r.rapport.remplacements} remplacé(s) · ${r.rapport.creations} créé(s)
                      ${r.rapport.echecs ? html` · <span class="rouge">${r.rapport.echecs} en échec</span>` : null}
                    </span>`
                  : null}
              </div>
              ${r.erreur ? html`<div class="encart encart-danger" style="margin:6px 0">${r.erreur}</div>` : null}
              ${r.test
                ? r.test.ok
                  ? r.test.versionOk === false || (r.test.infos && r.test.infos.mode === 'DEBUG')
                    ? html`<div class="encart encart-danger" style="margin:6px 0">
                        <strong>Le WebService répond, mais annonce la version ${r.test.infos.version}${r.test.infos.mode ? ' en ' + r.test.infos.mode : ''}</strong>
                        ${r.test.versionOk === false ? html` au lieu de ${r.test.versionAttendue}` : null}.
                        ${r.test.versionOk === false
                          ? ' IIS n\'a peut-être pas encore rechargé la DLL : retestez dans quelques secondes (bouton « Tester »), sinon recyclez le pool d\'applications.'
                          : ' Le WS a été compilé en DEBUG : vérifiez la configuration dans Réglages → WebServices.'}
                      </div>`
                    : html`<div class="encart encart-succes" style="margin:6px 0">
                        <strong>Le WebService répond</strong>
                        ${r.test.infos
                          ? html` et annonce la version <span class="mono">${r.test.infos.version}</span>${r.test.infos.mode ? ' en ' + r.test.infos.mode : ''} : la nouvelle DLL tourne.`
                          : html` (HTTP ${r.test.statut}).`}
                        <span class="attenue"> ${Math.round(r.test.duree / 100) / 10} s · <span class="mono">${r.test.url}</span></span>
                      </div>`
                  : html`<div class="encart encart-danger" style="margin:6px 0">
                      <strong>Le WebService ne répond pas</strong> (${r.test.statut ? 'HTTP ' + r.test.statut : r.test.erreur}) :
                      <span class="mono">${r.test.url}</span>. Regardez le journal d'événements IIS, ou revenez en arrière depuis
                      l'historique (bouton en bas).
                    </div>`
                : null}
              ${appOffline && appOffline.erreurRetrait
                ? html`<div class="encart encart-danger" style="margin:6px 0">
                    <strong>app_offline.htm n'a pas pu être retiré : le WS est resté en maintenance.</strong>
                    Supprimez-le à la main dans <span class="mono">${manifeste.racineProd}</span> (${appOffline.erreurRetrait}).
                  </div>`
                : null}
              ${r.archive
                ? html`<div class="ws-carte-trajet attenue">
                    <div>
                      <${IconeArchiveBoite} /> archive du dossier complet :
                      ${formaterNombre(r.archive.copies)} fichier(s) ${rapport.simulation ? 'à copier' : 'copié(s)'}
                      ${r.archive.conserves ? html`, ${formaterNombre(r.archive.conserves)} déjà archivé(s) et gardé(s)` : null}
                      ${manifeste
                        ? html` · <button type="button" class="btn btn-mini btn-plat" disabled=${rapport.simulation} onClick=${() => onReveler(manifeste.dossierSauvegarde)}>Ouvrir l'archive</button>`
                        : null}
                    </div>
                  </div>`
                : null}
              ${manifeste
                ? html`<table class="tableau tableau-fichiers" style="margin-top:6px">
                    <tbody>
                      ${manifeste.fichiers.map(
                        (f) => html`<tr key=${f.chemin} class=${f.erreur ? 'en-echec' : ''}>
                          <td class="mono">${f.chemin}</td>
                          <td>${LIBELLES_ACTION[f.action] || f.action}</td>
                          <td>${f.erreur ? html`<span class="rouge">${f.erreur}</span>` : html`<span class="compteur-nouveau">ok</span>`}</td>
                        </tr>`
                      )}
                    </tbody>
                  </table>`
                : null}
              ${r.chemins && r.chemins.manifeste
                ? html`<div style="margin-top:6px">
                    <button type="button" class="btn btn-mini btn-plat" onClick=${() => onReveler(r.chemins.manifeste)}>Voir le manifeste</button>
                  </div>`
                : null}
            </div>`;
          })}
          ${!rapport.simulation
            ? html`<div class="encart" style="margin-top:10px">
                Chaque WebService a son manifeste : il apparaît dans l'historique, d'où l'on peut vérifier la production ou
                revenir en arrière en un clic.
              </div>`
            : null}
        </div>
        <div class="modale-pied">
          <div style="flex:1"></div>
          ${!rapport.simulation ? html`<button type="button" class="btn" onClick=${onOuvrirHistorique}>Ouvrir l'historique</button>` : null}
          <button type="button" class="btn btn-accent" onClick=${onFermer}>Fermer</button>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Menu clic droit d'un WebService
// ---------------------------------------------------------------------------

const MARGE_MENU = 8;

function MenuWebService({ menu, coche, occupe, urlTest, onFermer, onAction }) {
  const boite = useRef(null);
  const [position, setPosition] = useState(null);
  const ws = menu.ws;
  const dernier = ws.passages && ws.passages[0];

  // Mesuré invisible, puis recalé pour tenir entier dans la fenêtre : même
  // mécanique que le menu de l'arborescence du front.
  useLayoutEffect(() => {
    const element = boite.current;
    if (!element) return;
    const cadre = element.getBoundingClientRect();
    setPosition({
      x: Math.max(MARGE_MENU, Math.min(menu.x, window.innerWidth - cadre.width - MARGE_MENU)),
      y: Math.max(MARGE_MENU, Math.min(menu.y, window.innerHeight - cadre.height - MARGE_MENU))
    });
  }, []);

  useEffect(() => {
    const surClic = (e) => {
      if (boite.current && !boite.current.contains(e.target)) onFermer();
    };
    const surTouche = (e) => {
      if (e.key === 'Escape') onFermer();
    };
    document.addEventListener('mousedown', surClic);
    document.addEventListener('keydown', surTouche);
    return () => {
      document.removeEventListener('mousedown', surClic);
      document.removeEventListener('keydown', surTouche);
    };
  }, [onFermer]);

  const entrees = [
    { action: 'compiler', libelle: 'Compiler', actif: ws.selectionnable && !occupe, titre: ws.selectionnable ? '' : ws.raison },
    coche
      ? { action: 'decocher', libelle: 'Retirer du passage', actif: !occupe }
      : { action: 'cocher', libelle: 'Ajouter au passage', actif: ws.selectionnable && !occupe, titre: ws.selectionnable ? '' : ws.raison },
    { separateur: true },
    { action: 'assemblyinfo', libelle: 'Ouvrir AssemblyInfo (numéro de version)', actif: Boolean(ws.versionLocaleFichier) },
    { action: 'projet', libelle: 'Montrer le projet dans l\'explorateur', actif: true },
    { action: 'prod', libelle: 'Montrer le dossier de production', actif: true },
    {
      action: 'archive',
      libelle: 'Montrer la dernière archive AVMDF',
      actif: Boolean(dernier && dernier.dossierSauvegarde),
      titre: dernier ? dernier.dossierSauvegarde : 'Aucun passage par MEPFront pour ce WebService'
    },
    { separateur: true },
    { action: 'tester', libelle: 'Tester : le WebService répond-il ?', actif: Boolean(urlTest), titre: urlTest ? '' : 'Renseignez l\'adresse de test dans Réglages → WebServices' },
    { action: 'historique', libelle: 'Ouvrir l\'historique', actif: true },
    { action: 'copier', libelle: 'Copier « nom version prod -> version locale »', actif: true }
  ];

  return html`
    <div
      class="menu"
      ref=${boite}
      style=${position ? `left:${position.x}px;top:${position.y}px` : 'left:0px;top:0px;visibility:hidden'}
      role="menu"
    >
      <div class="menu-titre mono">${ws.nom}</div>
      ${entrees.map((entree, index) =>
        entree.separateur
          ? html`<div class="menu-separateur" key=${'s' + index} role="separator"></div>`
          : html`<button
              type="button"
              class="menu-entree"
              key=${entree.action}
              disabled=${!entree.actif}
              title=${entree.titre || ''}
              role="menuitem"
              onClick=${() => onAction(entree.action)}
            >
              ${entree.libelle}
            </button>`
      )}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Contrôles affichés à l'étape 3 : Web.config, API, DLL nécessaires
// ---------------------------------------------------------------------------

function ControlesWebService({ comparaison, references }) {
  const config = comparaison.config;
  const api = comparaison.api;
  const manquantes = config
    ? config.appSettings.manquantesEnProd.map((k) => ['appSettings', k]).concat(config.connectionStrings.manquantesEnProd.map((k) => ['connectionStrings', k]))
    : [];
  const enTrop = config
    ? config.appSettings.seulementEnProd.map((k) => ['appSettings', k]).concat(config.connectionStrings.seulementEnProd.map((k) => ['connectionStrings', k]))
    : [];

  return html`
    <div class="ws-controles">
      <div class="ws-controle">
        <div class="ws-controle-titre">Web.config : clés</div>
        ${!config
          ? html`<div class="attenue">Pas de Web.config dans la compilation.</div>`
          : config.prodAbsent
            ? html`<div class="attenue">Pas de Web.config en production.</div>`
            : manquantes.length
              ? html`<div class="encart encart-alerte">
                  <strong>${manquantes.length} clé(s) à ajouter à la main dans le Web.config de production</strong>, avec les valeurs de
                  production : elles existent en développement mais pas en production.
                  <ul class="mono">${manquantes.map(([section, k]) => html`<li key=${section + k}>${k} <span class="attenue">(${section})</span></li>`)}</ul>
                </div>`
              : html`<div class="attenue">Toutes les clés du Web.config compilé existent en production (seuls les noms sont comparés, jamais les valeurs).</div>`}
        ${enTrop.length
          ? html`<div class="attenue" style="margin-top:4px">
              ${enTrop.length} clé(s) n'existent qu'en production, c'est souvent normal :${' '}
              <span class="mono">${enTrop.map(([, k]) => k).join(', ')}</span>
            </div>`
          : null}
        ${config && config.sourceExterne
          ? html`<div class="attenue" style="margin-top:4px">Une section est dans un fichier séparé (configSource) : elle n'est pas comparée.</div>`
          : null}
      </div>

      <div class="ws-controle">
        <div class="ws-controle-titre">API exposée</div>
        ${!api
          ? html`<div class="attenue">API non lue (DLL du WebService absente ou illisible).</div>`
          : api.sansProd
            ? html`<div class="attenue">${api.total} méthode(s) exposée(s) ; pas de version en production à comparer.</div>`
            : !api.ajoutees.length && !api.retirees.length
              ? html`<div class="attenue">Aucune méthode exposée ajoutée ni retirée (${api.total} au total).</div>`
              : html`<div class="ws-api mono">
                  ${api.retirees.map((m) => html`<div key=${'-' + m} class="rouge" title="Retirée ou paramètres changés : un client qui l'appelle encore aura une erreur">− ${m}</div>`)}
                  ${api.ajoutees.map((m) => html`<div key=${'+' + m} class="compteur-nouveau">+ ${m}</div>`)}
                </div>
                <div class="attenue" style="margin-top:4px">
                  Contrôleurs et services, méthodes publiques ; (n) = nombre de paramètres.
                </div>`}
      </div>

      <div class="ws-controle">
        <div class="ws-controle-titre">DLL nécessaires</div>
        ${references === null
          ? html`<div class="attenue">Vérification…</div>`
          : references.length
            ? html`<div class="encart encart-alerte">
                <strong>${references.length} DLL nécessaire(s) absente(s) ou dans une autre version</strong> dans le bin de production,
                avec les fichiers cochés. Cochez la DLL si elle est dans la liste, ou prévoyez une redirection de version dans le Web.config.
                <ul class="mono">
                  ${references.map(
                    (r) => html`<li key=${r.dll + r.reference}>
                      ${r.reference} ${r.attendue} ${r.trouvee ? html`<span class="attenue">(en prod : ${r.trouvee})</span>` : html`<span class="rouge">(absente)</span>`}
                      <span class="attenue"> ← ${r.dll}</span>
                    </li>`
                  )}
                </ul>
              </div>`
            : html`<div class="attenue">Chaque DLL cochée trouvera ses dépendances dans le bin de production.</div>`}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tableau des DLL partagées
// ---------------------------------------------------------------------------

function MatriceDll({ matrice, onFermer }) {
  const donnees = matrice.donnees;
  return html`
    <div class="voile" role="dialog" aria-modal="true" aria-label="DLL partagées entre WebServices">
      <div class="modale modale-large">
        <${EnTeteModale} icone=${IconeServeur} surtitre="WebServices en production" titre="DLL partagées" onFermer=${onFermer} />
        <div class="modale-corps">
          ${matrice.etat === 'chargement'
            ? html`<div class="attenue">Lecture des bin de production…</div>`
            : !donnees.dlls.length
              ? html`<div class="attenue">Aucune DLL commune à plusieurs WebServices (hors bibliothèques tierces).</div>`
              : html`
                  <p class="attenue" style="margin-top:0">
                    Version de chaque DLL présente dans au moins deux WebServices (hors System, Microsoft, Newtonsoft, Syncfusion…).
                    Les lignes en rouge n'ont pas la même version partout.
                  </p>
                  <div style="overflow:auto">
                    <table class="tableau ws-matrice">
                      <thead>
                        <tr>
                          <th>DLL</th>
                          ${donnees.webservices.map((nom) => html`<th key=${nom}>${nom}</th>`)}
                        </tr>
                      </thead>
                      <tbody>
                        ${donnees.dlls.map((dll) => {
                          const versions = Object.values(dll.versions).filter(Boolean);
                          const frequences = new Map();
                          for (const v of versions) frequences.set(v, (frequences.get(v) || 0) + 1);
                          const majoritaire = [...frequences.entries()].sort((a, b) => b[1] - a[1])[0];
                          return html`<tr key=${dll.nom} class=${dll.divergent ? 'ws-divergent' : ''}>
                            <td class="mono">${dll.nom}</td>
                            ${donnees.webservices.map((nom) => {
                              const v = dll.versions[nom];
                              return html`<td key=${nom} class=${'mono' + (v && majoritaire && v !== majoritaire[0] ? ' rouge' : '')}>
                                ${v || html`<span class="attenue">-</span>`}
                              </td>`;
                            })}
                          </tr>`;
                        })}
                      </tbody>
                    </table>
                  </div>
                `}
        </div>
      </div>
    </div>
  `;
}
