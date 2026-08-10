import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useCallback, useEffect, useState } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/**
 * Écran de premier démarrage : le minimum pour que l'outil soit LE SIEN.
 *
 * Quatre questions, dans l'ordre où on se les pose : qui livre, d'où partent
 * les fichiers, où ils arrivent, et quel projet on apparie. Rien n'est deviné,
 * rien n'est prérempli avec les habitudes d'un autre poste : une valeur
 * inventée donnerait l'illusion d'une application déjà réglée, et la première
 * analyse partirait sur un chemin qui n'existe pas.
 *
 * Chaque chemin saisi est contrôlé pour de vrai - existence et lecture - et le
 * résultat s'affiche à côté. Rien n'oblige à corriger : un partage réseau peut
 * être arrêté au moment où l'on s'installe, et l'adresse être juste quand
 * même.
 */
export function Bienvenue({ config, defauts, onEnregistrer, onOuvrirReglages }) {
  const [auteur, setAuteur] = useState(() => config.options.auteur || '');
  const [racines, setRacines] = useState(() => ({
    locale: config.racines.locale || '',
    prod: config.racines.prod || '',
    avmdf: config.racines.avmdf || (defauts ? defauts.racines.avmdf : '')
  }));
  const [projets, setProjets] = useState(() =>
    config.projets.length
      ? config.projets.map((p) => ({ nom: p.nom, dossierLocal: p.dossierLocal, dossierProd: p.dossierProd }))
      : [{ nom: '', dossierLocal: '', dossierProd: '' }]
  );
  const [controle, setControle] = useState(null);
  const [occupe, setOccupe] = useState(false);

  const changer = useCallback((role, valeur) => {
    setRacines((precedent) => ({ ...precedent, [role]: valeur }));
  }, []);

  const changerProjet = useCallback((index, champ, valeur) => {
    setProjets((precedents) =>
      precedents.map((projet, i) => (i === index ? { ...projet, [champ]: valeur } : projet))
    );
  }, []);

  // Contrôle différé : on ne va pas interroger le réseau à chaque frappe.
  useEffect(() => {
    let abandonne = false;
    const minuteur = setTimeout(async () => {
      const reponse = await window.avmdf.config.controlerRacines(racines);
      if (abandonne || !reponse.ok) return;
      setControle(reponse.acces);
    }, 500);
    return () => {
      abandonne = true;
      clearTimeout(minuteur);
    };
  }, [racines.locale, racines.prod, racines.avmdf]);

  const memeChemin =
    racines.locale.trim() &&
    racines.locale.trim().replace(/[\\/]+$/, '').toLowerCase() ===
      racines.prod.trim().replace(/[\\/]+$/, '').toLowerCase();

  const sansAuteur = !auteur.trim();
  const manque = !racines.locale.trim() || !racines.prod.trim() || !racines.avmdf.trim();
  // Un projet compte dès que son nom est saisi ; il doit alors être complet :
  // les réglages refuseraient un dossier vide, autant le dire tout de suite.
  const commences = projets.filter((p) => p.nom.trim());
  const incomplets = commences.filter((p) => !p.dossierLocal.trim() || !p.dossierProd.trim());
  const sansProjet = !commences.length;
  const peutCommencer = !sansAuteur && !manque && !memeChemin && !sansProjet && !incomplets.length && !occupe;

  const etatDe = (role) => {
    if (!controle) return null;
    const cote = controle.cotes.find((c) => c.role === role);
    if (!cote || !cote.chemin.trim()) return null;
    return cote;
  };

  const conseil = sansAuteur
    ? 'Indiquez votre nom : il signe les manifestes.'
    : manque
      ? 'Les trois racines sont nécessaires.'
      : memeChemin
        ? 'Corrigez la production.'
        : sansProjet
          ? 'Décrivez au moins un projet.'
          : incomplets.length
            ? `Complétez les deux dossiers du projet « ${incomplets[0].nom.trim()} ».`
            : '';

  async function commencer() {
    setOccupe(true);
    const reponse = await onEnregistrer({
      ...config,
      racines: {
        locale: racines.locale.trim(),
        prod: racines.prod.trim(),
        avmdf: racines.avmdf.trim()
      },
      projets: projets
        .filter((p) => p.nom.trim())
        .map((p) => ({
          nom: p.nom.trim(),
          dossierLocal: p.dossierLocal.trim(),
          dossierProd: p.dossierProd.trim(),
          actif: true
        })),
      options: { ...config.options, auteur: auteur.trim() }
    });
    if (!reponse || !reponse.ok) setOccupe(false);
  }

  return html`
    <div class="bienvenue">
      <div class="bienvenue-boite">
        <div class="bienvenue-titre">
          <img class="demarrage-logo" src="assets/logo.png" alt="Saarstahl Rail" />
          <h1><span class="demarrage-marque">AVMDF</span> Mise en production</h1>
          <div class="rail" aria-hidden="true"></div>
        </div>

        <p class="bienvenue-chapeau">
          Quatre réponses suffisent à configurer l'outil pour vous. Elles ne sont demandées${' '}
          qu'une fois et restent modifiables dans les réglages.
        </p>

        <div class="bienvenue-racine">
          <span class="bienvenue-numero">1</span>
          <div class="bienvenue-racine-corps">
            <div class="bienvenue-racine-titre">Vous</div>
            <div class="attenue">
              Votre identifiant ou votre nom : il signe chaque manifeste de mise en production.
            </div>
            <div class="bienvenue-saisie">
              <input
                type="text"
                spellcheck="false"
                placeholder="durand-p"
                value=${auteur}
                onInput=${(evenement) => setAuteur(evenement.target.value)}
              />
            </div>
          </div>
        </div>

        <${Racine}
          numero="2"
          titre="Vos sources locales"
          aide="Le dossier de votre poste qui contient les projets, celui d'où partent les fichiers."
          exemple="E:\\Sources"
          valeur=${racines.locale}
          etat=${etatDe('locale')}
          onChange=${(v) => changer('locale', v)}
        />

        <${Racine}
          numero="3"
          titre="La production"
          aide="Le lecteur réseau du serveur IIS : ce que voient les utilisateurs."
          exemple="Z:\\"
          valeur=${racines.prod}
          etat=${etatDe('prod')}
          erreur=${memeChemin ? 'La production ne peut pas être le même dossier que les sources locales.' : ''}
          onChange=${(v) => changer('prod', v)}
        />

        <${Racine}
          numero="4"
          titre="Les archives « avant modification »"
          aide="Où part chaque version écrasée, rangée par demande de travaux. C'est ce qui rend le retour arrière possible."
          exemple="Z:\\AvMdf"
          valeur=${racines.avmdf}
          etat=${etatDe('avmdf')}
          onChange=${(v) => changer('avmdf', v)}
        />

        <div class="bienvenue-racine">
          <span class="bienvenue-numero">5</span>
          <div class="bienvenue-racine-corps">
            <div class="bienvenue-racine-titre">${projets.length > 1 ? 'Vos projets' : 'Votre premier projet'}</div>
            <div class="attenue">
              Un projet apparie un dossier de vos sources et un dossier de la production, sous les
              racines ci-dessus. Les deux noms n'ont pas besoin de se ressembler. Écrivez un point
              (.) si la racine est directement le dossier du projet.
            </div>
            ${projets.map(
              (projet, index) => html`
                <div class="bienvenue-projet" key=${index}>
                  <label class="bienvenue-projet-champ">
                    <span>Nom</span>
                    <input
                      type="text"
                      spellcheck="false"
                      placeholder="GPNet"
                      value=${projet.nom}
                      onInput=${(evenement) => changerProjet(index, 'nom', evenement.target.value)}
                    />
                  </label>
                  <label class="bienvenue-projet-champ">
                    <span>Dossier local</span>
                    <input
                      type="text"
                      class="mono"
                      spellcheck="false"
                      placeholder="GPNET"
                      value=${projet.dossierLocal}
                      onInput=${(evenement) => changerProjet(index, 'dossierLocal', evenement.target.value)}
                    />
                  </label>
                  <label class="bienvenue-projet-champ">
                    <span>Dossier production</span>
                    <input
                      type="text"
                      class="mono"
                      spellcheck="false"
                      placeholder="GPNet"
                      value=${projet.dossierProd}
                      onInput=${(evenement) => changerProjet(index, 'dossierProd', evenement.target.value)}
                    />
                  </label>
                  ${projets.length > 1
                    ? html`<button
                        type="button"
                        class="btn btn-mini btn-plat bienvenue-projet-retirer"
                        title="Retirer ce projet"
                        onClick=${() => setProjets((liste) => liste.filter((p, i) => i !== index))}
                      >
                        ✕
                      </button>`
                    : null}
                </div>
              `
            )}
            <div>
              <button
                type="button"
                class="btn btn-mini"
                onClick=${() => setProjets((liste) => [...liste, { nom: '', dossierLocal: '', dossierProd: '' }])}
              >
                + Ajouter un autre projet
              </button>
            </div>
          </div>
        </div>

        <div class="bienvenue-actions">
          <button type="button" class="btn btn-plat" onClick=${onOuvrirReglages}>
            Ouvrir les réglages complets
          </button>
          <div style="flex:1"></div>
          <span class="attenue">${conseil}</span>
          <button type="button" class="btn btn-accent" disabled=${!peutCommencer} onClick=${commencer}>
            ${occupe ? 'Enregistrement…' : 'Commencer'}
          </button>
        </div>
      </div>
    </div>
  `;
}

function Racine({ numero, titre, aide, exemple, valeur, etat, erreur, onChange }) {
  async function parcourir() {
    const reponse = await window.avmdf.dialogue.choisirDossier({
      titre: titre,
      cheminInitial: valeur
    });
    if (reponse.ok && !reponse.annule) onChange(reponse.chemin);
  }

  return html`
    <div class="bienvenue-racine">
      <span class="bienvenue-numero">${numero}</span>
      <div class="bienvenue-racine-corps">
        <div class="bienvenue-racine-titre">${titre}</div>
        <div class="attenue">${aide}</div>
        <div class="bienvenue-saisie">
          <input
            type="text"
            class=${'mono' + (erreur ? ' invalide' : '')}
            spellcheck="false"
            placeholder=${exemple}
            value=${valeur}
            onInput=${(evenement) => onChange(evenement.target.value)}
          />
          <button type="button" class="btn" onClick=${parcourir}>Parcourir…</button>
        </div>
        ${erreur ? html`<div class="champ-erreur">${erreur}</div>` : null}
        ${!erreur && etat
          ? html`<div class=${'bienvenue-etat' + (etat.ok ? ' ok' : ' en-echec')}>
              <span aria-hidden="true">${etat.ok ? '✓' : '✕'}</span>
              ${etat.ok ? 'Ce dossier existe et se lit.' : `Il ${etat.probleme}. ${etat.conseil}`}
            </div>`
          : null}
      </div>
    </div>
  `;
}
