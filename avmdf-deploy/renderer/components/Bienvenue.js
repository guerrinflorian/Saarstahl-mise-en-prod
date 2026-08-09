import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useCallback, useEffect, useState } from '../vendor/hooks.module.js';

const html = htm.bind(h);

/**
 * Écran de premier démarrage : les trois racines, et rien d'autre.
 *
 * L'outil ne devine pas où sont les dossiers. Une valeur inventée serait pire
 * que rien : elle donnerait l'illusion d'une application déjà réglée, et la
 * première analyse partirait sur un chemin qui n'existe pas. On demande donc,
 * une fois, avant tout le reste.
 *
 * Chaque chemin saisi est contrôlé pour de vrai - existence et lecture - et le
 * résultat s'affiche à côté. Rien n'oblige à corriger : un partage réseau peut
 * être arrêté au moment où l'on s'installe, et l'adresse être juste quand
 * même.
 */
export function Bienvenue({ config, defauts, onEnregistrer, onOuvrirReglages }) {
  const [racines, setRacines] = useState(() => ({
    locale: config.racines.locale || '',
    prod: config.racines.prod || '',
    avmdf: config.racines.avmdf || (defauts ? defauts.racines.avmdf : '')
  }));
  const [controle, setControle] = useState(null);
  const [occupe, setOccupe] = useState(false);

  const changer = useCallback((role, valeur) => {
    setRacines((precedent) => ({ ...precedent, [role]: valeur }));
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

  const manque = !racines.locale.trim() || !racines.prod.trim() || !racines.avmdf.trim();
  const peutCommencer = !manque && !memeChemin && !occupe;

  const etatDe = (role) => {
    if (!controle) return null;
    const cote = controle.cotes.find((c) => c.role === role);
    if (!cote || !cote.chemin.trim()) return null;
    return cote;
  };

  async function commencer() {
    setOccupe(true);
    const reponse = await onEnregistrer({
      ...config,
      racines: {
        locale: racines.locale.trim(),
        prod: racines.prod.trim(),
        avmdf: racines.avmdf.trim()
      }
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
          Trois racines suffisent à tout situer. Elles ne sont demandées qu'une fois${' '}
          et restent modifiables dans les réglages.
        </p>

        <${Racine}
          numero="1"
          titre="Vos sources locales"
          aide="Le dossier de votre poste qui contient les projets, celui d'où partent les fichiers."
          exemple="E:\\F Guerrin\\Process"
          valeur=${racines.locale}
          etat=${etatDe('locale')}
          onChange=${(v) => changer('locale', v)}
        />

        <${Racine}
          numero="2"
          titre="La production"
          aide="Le lecteur réseau du serveur IIS : ce que voient les utilisateurs."
          exemple="Z:\\"
          valeur=${racines.prod}
          etat=${etatDe('prod')}
          erreur=${memeChemin ? 'La production ne peut pas être le même dossier que les sources locales.' : ''}
          onChange=${(v) => changer('prod', v)}
        />

        <${Racine}
          numero="3"
          titre="Les archives « avant modification »"
          aide="Où part chaque version écrasée, rangée par demande de travaux. C'est ce qui rend le retour arrière possible."
          exemple="Z:\\AvMdf"
          valeur=${racines.avmdf}
          etat=${etatDe('avmdf')}
          onChange=${(v) => changer('avmdf', v)}
        />

        <div class="encart">
          Deux projets sont déjà décrits, <strong>GPNet</strong> et <strong>WebService</strong>. Un projet
          apparie un dossier local et un dossier de production, sous ces racines. Vérifiez-les dans les
          réglages si vos dossiers portent d'autres noms.
        </div>

        <div class="bienvenue-actions">
          <button type="button" class="btn btn-plat" onClick=${onOuvrirReglages}>
            Ouvrir les réglages complets
          </button>
          <div style="flex:1"></div>
          <span class="attenue">
            ${manque
              ? 'Les trois racines sont nécessaires.'
              : memeChemin
                ? 'Corrigez la production.'
                : ''}
          </span>
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
