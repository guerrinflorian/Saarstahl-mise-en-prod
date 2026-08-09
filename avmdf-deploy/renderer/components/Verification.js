import { h } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { formaterNombre } from './arborescence.js';

const html = htm.bind(h);

/**
 * Affichage des verdicts de vérification de la production : un manifeste dit
 * ce qui a été livré, la vérification dit ce qu'il en reste. Partagé entre
 * l'historique et le rapport de fin de passage, pour que « intact » ait
 * exactement la même tête partout.
 */

export const VERDICTS = {
  conforme: { libelle: 'intact', classe: 'verdict-conforme' },
  modifie: { libelle: 'modifié depuis', classe: 'verdict-modifie' },
  absent: { libelle: 'absent de la production', classe: 'verdict-absent' },
  reapparu: { libelle: 'réapparu', classe: 'verdict-absent' },
  inverifiable: { libelle: 'invérifiable', classe: 'verdict-modifie' }
};

/** Pastille d'un verdict, pour une cellule de tableau. */
export function Verdict({ verdict }) {
  const description = VERDICTS[verdict];
  if (!description) return null;
  return html`<span class=${'verdict ' + description.classe}>${description.libelle}</span>`;
}

/**
 * Encart de synthèse d'une vérification. Vert quand tout est intact, alerte
 * sinon : le résultat se lit avant de se compter.
 */
export function EncartVerification({ verification }) {
  const resume = verification.resume;
  const intact = resume.conformes === resume.total && resume.total > 0;
  const morceaux = [];
  if (resume.modifies) morceaux.push(formaterNombre(resume.modifies) + ' modifié(s) depuis');
  if (resume.absents) morceaux.push(formaterNombre(resume.absents) + ' absent(s)');
  if (resume.reapparus) morceaux.push(formaterNombre(resume.reapparus) + ' réapparu(s)');
  if (resume.inverifiables) morceaux.push(formaterNombre(resume.inverifiables) + ' invérifiable(s)');

  return html`
    <div class=${'encart ' + (intact ? 'encart-succes' : 'encart-alerte')} style="margin:12px 0">
      <strong>
        ${intact
          ? 'La production est conforme à ce passage : ' +
            formaterNombre(resume.conformes) +
            ' fichier(s) intact(s).'
          : formaterNombre(resume.conformes) +
            ' fichier(s) intact(s) sur ' +
            formaterNombre(resume.total) +
            ' - ' +
            morceaux.join(', ') +
            '.'}
      </strong>
      <div style="margin-top:4px">
        ${intact
          ? 'Chaque empreinte relevée à l\'instant en production est celle du manifeste. Rien n\'a bougé depuis ce passage.'
          : 'Le détail est reporté fichier par fichier dans la colonne « En prod » du tableau. Un fichier « modifié depuis » a pu l\'être par un passage plus récent : vérifiez l\'historique avant de conclure.'}
        ${resume.ignores
          ? ' Les ' + formaterNombre(resume.ignores) + ' fichier(s) en échec dans le manifeste ne sont pas vérifiés.'
          : ''}
      </div>
    </div>
  `;
}
