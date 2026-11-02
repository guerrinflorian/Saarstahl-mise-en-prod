'use strict';

/**
 * assembly.js - lecture des métadonnées d'une DLL .NET.
 *
 * Module Node pur : aucune dépendance à Electron, à Windows ni au framework
 * .NET. La DLL est lue comme un fichier : en-tête PE, en-tête CLI, puis les
 * tables de métadonnées décrites par la norme ECMA-335 (partition II).
 *
 * On en tire trois choses :
 *   - le nom et la version de l'assembly (table Assembly) ;
 *   - les assemblies dont elle a besoin, avec leur version (table AssemblyRef) ;
 *   - les classes et leurs méthodes publiques (tables TypeDef et MethodDef),
 *     de quoi dire ce qui change dans l'API d'un WebService.
 *
 * Une DLL qui n'est pas un assembly .NET (DLL native) renvoie `null`, jamais
 * une exception.
 */

const fsp = require('fs/promises');
const { cheminLong } = require('./fsindex');

// Numéros des tables (ECMA-335 II.22).
const T = {
  Module: 0x00, TypeRef: 0x01, TypeDef: 0x02, FieldPtr: 0x03, Field: 0x04, MethodPtr: 0x05, MethodDef: 0x06,
  ParamPtr: 0x07, Param: 0x08, InterfaceImpl: 0x09, MemberRef: 0x0a, Constant: 0x0b, CustomAttribute: 0x0c,
  FieldMarshal: 0x0d, DeclSecurity: 0x0e, ClassLayout: 0x0f, FieldLayout: 0x10, StandAloneSig: 0x11,
  EventMap: 0x12, EventPtr: 0x13, Event: 0x14, PropertyMap: 0x15, PropertyPtr: 0x16, Property: 0x17,
  MethodSemantics: 0x18, MethodImpl: 0x19, ModuleRef: 0x1a, TypeSpec: 0x1b, ImplMap: 0x1c, FieldRVA: 0x1d,
  ENCLog: 0x1e, ENCMap: 0x1f, Assembly: 0x20, AssemblyProcessor: 0x21, AssemblyOS: 0x22, AssemblyRef: 0x23
};

// Index codés : tables possibles et nombre de bits du marqueur.
const CODES = {
  TypeDefOrRef: { bits: 2, tables: [T.TypeDef, T.TypeRef, T.TypeSpec] },
  HasConstant: { bits: 2, tables: [T.Field, T.Param, T.Property] },
  HasCustomAttribute: {
    bits: 5,
    tables: [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b]
  },
  HasFieldMarshal: { bits: 1, tables: [T.Field, T.Param] },
  HasDeclSecurity: { bits: 2, tables: [T.TypeDef, T.MethodDef, T.Assembly] },
  MemberRefParent: { bits: 3, tables: [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec] },
  HasSemantics: { bits: 1, tables: [T.Event, T.Property] },
  MethodDefOrRef: { bits: 1, tables: [T.MethodDef, T.MemberRef] },
  MemberForwarded: { bits: 1, tables: [T.Field, T.MethodDef] },
  ResolutionScope: { bits: 2, tables: [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef] },
  CustomAttributeType: { bits: 3, tables: [-1, -1, T.MethodDef, T.MemberRef, -1] }
};

// Colonnes de chaque table, dans l'ordre. u1/u2/u4 : entiers ; s/g/b : index
// dans les tas String, GUID, Blob ; un nombre : index simple dans cette table ;
// une chaîne d'un code : index codé.
const SCHEMA = {
  [T.Module]: [['generation', 'u2'], ['nom', 's'], ['mvid', 'g'], ['encId', 'g'], ['encBaseId', 'g']],
  [T.TypeRef]: [['portee', 'ResolutionScope'], ['nom', 's'], ['espace', 's']],
  [T.TypeDef]: [['flags', 'u4'], ['nom', 's'], ['espace', 's'], ['herite', 'TypeDefOrRef'], ['champs', T.Field], ['methodes', T.MethodDef]],
  [T.FieldPtr]: [['champ', T.Field]],
  [T.Field]: [['flags', 'u2'], ['nom', 's'], ['signature', 'b']],
  [T.MethodPtr]: [['methode', T.MethodDef]],
  [T.MethodDef]: [['rva', 'u4'], ['implFlags', 'u2'], ['flags', 'u2'], ['nom', 's'], ['signature', 'b'], ['parametres', T.Param]],
  [T.ParamPtr]: [['parametre', T.Param]],
  [T.Param]: [['flags', 'u2'], ['sequence', 'u2'], ['nom', 's']],
  [T.InterfaceImpl]: [['classe', T.TypeDef], ['interface', 'TypeDefOrRef']],
  [T.MemberRef]: [['classe', 'MemberRefParent'], ['nom', 's'], ['signature', 'b']],
  [T.Constant]: [['type', 'u2'], ['parent', 'HasConstant'], ['valeur', 'b']],
  [T.CustomAttribute]: [['parent', 'HasCustomAttribute'], ['type', 'CustomAttributeType'], ['valeur', 'b']],
  [T.FieldMarshal]: [['parent', 'HasFieldMarshal'], ['type', 'b']],
  [T.DeclSecurity]: [['action', 'u2'], ['parent', 'HasDeclSecurity'], ['permissions', 'b']],
  [T.ClassLayout]: [['packing', 'u2'], ['taille', 'u4'], ['parent', T.TypeDef]],
  [T.FieldLayout]: [['decalage', 'u4'], ['champ', T.Field]],
  [T.StandAloneSig]: [['signature', 'b']],
  [T.EventMap]: [['parent', T.TypeDef], ['evenements', T.Event]],
  [T.EventPtr]: [['evenement', T.Event]],
  [T.Event]: [['flags', 'u2'], ['nom', 's'], ['type', 'TypeDefOrRef']],
  [T.PropertyMap]: [['parent', T.TypeDef], ['proprietes', T.Property]],
  [T.PropertyPtr]: [['propriete', T.Property]],
  [T.Property]: [['flags', 'u2'], ['nom', 's'], ['type', 'b']],
  [T.MethodSemantics]: [['semantique', 'u2'], ['methode', T.MethodDef], ['association', 'HasSemantics']],
  [T.MethodImpl]: [['classe', T.TypeDef], ['corps', 'MethodDefOrRef'], ['declaration', 'MethodDefOrRef']],
  [T.ModuleRef]: [['nom', 's']],
  [T.TypeSpec]: [['signature', 'b']],
  [T.ImplMap]: [['flags', 'u2'], ['membre', 'MemberForwarded'], ['nom', 's'], ['portee', T.ModuleRef]],
  [T.FieldRVA]: [['rva', 'u4'], ['champ', T.Field]],
  [T.ENCLog]: [['jeton', 'u4'], ['code', 'u4']],
  [T.ENCMap]: [['jeton', 'u4']],
  [T.Assembly]: [
    ['hash', 'u4'], ['majeur', 'u2'], ['mineur', 'u2'], ['build', 'u2'], ['revision', 'u2'],
    ['flags', 'u4'], ['clePublique', 'b'], ['nom', 's'], ['culture', 's']
  ],
  [T.AssemblyProcessor]: [['processeur', 'u4']],
  [T.AssemblyOS]: [['plateforme', 'u4'], ['majeur', 'u4'], ['mineur', 'u4']],
  [T.AssemblyRef]: [
    ['majeur', 'u2'], ['mineur', 'u2'], ['build', 'u2'], ['revision', 'u2'], ['flags', 'u4'],
    ['clePublique', 'b'], ['nom', 's'], ['culture', 's'], ['hash', 'b']
  ]
};

// Méthode : visibilité publique, nom spécial (constructeurs, accesseurs), statique.
const METHODE_ACCES = 0x0007;
const METHODE_PUBLIQUE = 0x0006;
const METHODE_NOM_SPECIAL = 0x0800;
const TYPE_VISIBILITE = 0x0007;
const TYPE_ABSTRAIT = 0x0080;

/** Lecture d'un en-tête PE jusqu'aux métadonnées CLI. */
function localiserMetadonnees(tampon) {
  if (tampon.length < 0x40 || tampon.readUInt16LE(0) !== 0x5a4d) return null; // « MZ »
  const pe = tampon.readUInt32LE(0x3c);
  if (pe + 24 > tampon.length || tampon.readUInt32LE(pe) !== 0x00004550) return null; // « PE\0\0 »
  const coff = pe + 4;
  const sections = tampon.readUInt16LE(coff + 2);
  const tailleOptionnel = tampon.readUInt16LE(coff + 16);
  const optionnel = coff + 20;
  const magie = tampon.readUInt16LE(optionnel);
  const repertoires = optionnel + (magie === 0x20b ? 112 : 96);
  const nombreRepertoires = tampon.readUInt32LE(repertoires - 4);
  if (nombreRepertoires < 15) return null;
  const cliRva = tampon.readUInt32LE(repertoires + 14 * 8);
  if (!cliRva) return null; // DLL native : pas d'en-tête CLI

  const tableSections = optionnel + tailleOptionnel;
  const versDecalage = (rva) => {
    for (let i = 0; i < sections; i += 1) {
      const s = tableSections + i * 40;
      const taille = Math.max(tampon.readUInt32LE(s + 8), tampon.readUInt32LE(s + 16));
      const adresse = tampon.readUInt32LE(s + 12);
      if (rva >= adresse && rva < adresse + taille) return rva - adresse + tampon.readUInt32LE(s + 20);
    }
    return -1;
  };

  const cli = versDecalage(cliRva);
  if (cli < 0) return null;
  const racine = versDecalage(tampon.readUInt32LE(cli + 8));
  if (racine < 0 || tampon.readUInt32LE(racine) !== 0x424a5342) return null; // « BSJB »
  return racine;
}

/** Lit les en-têtes de flux (#~, #Strings, #Blob…) de la racine de métadonnées. */
function lireFlux(tampon, racine) {
  const longueurVersion = tampon.readUInt32LE(racine + 12);
  let position = racine + 16 + longueurVersion + 2;
  const nombre = tampon.readUInt16LE(position);
  position += 2;
  const flux = {};
  for (let i = 0; i < nombre; i += 1) {
    const decalage = tampon.readUInt32LE(position);
    const taille = tampon.readUInt32LE(position + 4);
    position += 8;
    let fin = position;
    while (tampon[fin] !== 0) fin += 1;
    const nom = tampon.toString('ascii', position, fin);
    position = (fin + 4) & ~3; // nom terminé par un zéro, aligné sur 4
    flux[nom] = { debut: racine + decalage, taille };
  }
  return flux;
}

/**
 * Lit toutes les tables de métadonnées dont on a besoin.
 * @returns {{ tables: Object<number, object[]>, chaine: (i:number)=>string, blob: (i:number)=>Buffer }}
 */
function lireTables(tampon) {
  const racine = localiserMetadonnees(tampon);
  if (racine === null) return null;
  const flux = lireFlux(tampon, racine);
  const tablesFlux = flux['#~'] || flux['#-'];
  const chaines = flux['#Strings'];
  const blobs = flux['#Blob'];
  if (!tablesFlux || !chaines) return null;

  let p = tablesFlux.debut;
  const tailleTas = tampon[p + 6];
  const valides = tampon.readBigUInt64LE(p + 8);
  p += 24;
  const lignes = new Array(64).fill(0);
  for (let i = 0; i < 64; i += 1) {
    if ((valides >> BigInt(i)) & 1n) {
      lignes[i] = tampon.readUInt32LE(p);
      p += 4;
    }
  }
  // Le flux non compressé « #- » peut porter quatre octets de plus.
  if (tailleTas & 0x40) p += 4;

  const indexChaine = tailleTas & 0x01 ? 4 : 2;
  const indexGuid = tailleTas & 0x02 ? 4 : 2;
  const indexBlob = tailleTas & 0x04 ? 4 : 2;
  const tailleCode = (code) => {
    const { bits, tables } = CODES[code];
    const max = Math.max(...tables.map((t) => (t >= 0 ? lignes[t] : 0)));
    return max < 1 << (16 - bits) ? 2 : 4;
  };
  const tailleColonne = (type) => {
    if (type === 'u1') return 1;
    if (type === 'u2') return 2;
    if (type === 'u4') return 4;
    if (type === 's') return indexChaine;
    if (type === 'g') return indexGuid;
    if (type === 'b') return indexBlob;
    if (typeof type === 'number') return lignes[type] < 65536 ? 2 : 4;
    return tailleCode(type);
  };

  const tables = {};
  for (let numero = 0; numero <= T.AssemblyRef; numero += 1) {
    const colonnes = SCHEMA[numero];
    const tailles = colonnes.map(([, type]) => tailleColonne(type));
    const tailleLigne = tailles.reduce((a, b) => a + b, 0);
    const rangs = [];
    for (let r = 0; r < lignes[numero]; r += 1) {
      const rang = {};
      let q = p + r * tailleLigne;
      colonnes.forEach(([nom], i) => {
        rang[nom] = tailles[i] === 1 ? tampon[q] : tailles[i] === 2 ? tampon.readUInt16LE(q) : tampon.readUInt32LE(q);
        q += tailles[i];
      });
      rangs.push(rang);
    }
    tables[numero] = rangs;
    p += tailleLigne * lignes[numero];
  }

  const chaine = (index) => {
    const debut = chaines.debut + index;
    let fin = debut;
    while (fin < tampon.length && tampon[fin] !== 0) fin += 1;
    return tampon.toString('utf8', debut, fin);
  };
  const blob = (index) => {
    if (!blobs) return Buffer.alloc(0);
    let q = blobs.debut + index;
    const premier = tampon[q];
    let longueur;
    if ((premier & 0x80) === 0) {
      longueur = premier;
      q += 1;
    } else if ((premier & 0xc0) === 0x80) {
      longueur = ((premier & 0x3f) << 8) | tampon[q + 1];
      q += 2;
    } else {
      longueur = ((premier & 0x1f) << 24) | (tampon[q + 1] << 16) | (tampon[q + 2] << 8) | tampon[q + 3];
      q += 4;
    }
    return tampon.subarray(q, q + longueur);
  };

  return { tables, chaine, blob };
}

/** Nombre de paramètres d'une signature de méthode (II.23.2.1). */
function nombreParametres(signature) {
  if (!signature || signature.length < 2) return 0;
  let q = 1;
  if (signature[0] & 0x10) {
    // méthode générique : nombre de paramètres de type, à sauter
    q += (signature[q] & 0x80) === 0 ? 1 : (signature[q] & 0xc0) === 0x80 ? 2 : 4;
  }
  const premier = signature[q];
  if ((premier & 0x80) === 0) return premier;
  if ((premier & 0xc0) === 0x80) return ((premier & 0x3f) << 8) | signature[q + 1];
  return 0;
}

function version(rang) {
  return `${rang.majeur}.${rang.mineur}.${rang.build}.${rang.revision}`;
}

/** Classes dont on suit l'API : contrôleurs Web API / MVC et services ASMX. */
const BASES_EXPOSEES = new Set(['ApiController', 'Controller', 'WebService', 'ControllerBase']);

/**
 * Analyse un assembly .NET.
 *
 * @param {Buffer} tampon contenu de la DLL
 * @returns {null | {
 *   nom: string, version: string,
 *   references: Array<{nom:string, version:string}>,
 *   api: string[]   // « Espace.Classe.Methode(n) », n = nombre de paramètres
 * }}
 */
function analyser(tampon) {
  let lu;
  try {
    lu = lireTables(tampon);
  } catch (err) {
    return null;
  }
  if (!lu) return null;
  const { tables, chaine, blob } = lu;

  const assembly = tables[T.Assembly][0];
  const references = tables[T.AssemblyRef].map((r) => ({ nom: chaine(r.nom), version: version(r) }));

  const nomType = (code) => {
    const marqueur = code & 0x3;
    const ligne = code >> 2;
    if (ligne === 0) return null;
    if (marqueur === 0) return chaine(tables[T.TypeDef][ligne - 1].nom);
    if (marqueur === 1) return chaine(tables[T.TypeRef][ligne - 1].nom);
    return null;
  };

  const types = tables[T.TypeDef];
  const methodes = tables[T.MethodDef];
  const api = [];
  for (let i = 0; i < types.length; i += 1) {
    const type = types[i];
    const nom = chaine(type.nom);
    if (nom === '<Module>' || (type.flags & TYPE_ABSTRAIT) !== 0) continue;
    const visible = (type.flags & TYPE_VISIBILITE) === 1 || (type.flags & TYPE_VISIBILITE) === 2;
    if (!visible) continue;
    const base = nomType(type.herite);
    if (!BASES_EXPOSEES.has(base) && !/Controller$/.test(nom)) continue;

    const espace = chaine(type.espace);
    const debut = type.methodes - 1;
    const fin = i + 1 < types.length ? types[i + 1].methodes - 1 : methodes.length;
    for (let m = debut; m < fin && m < methodes.length; m += 1) {
      const methode = methodes[m];
      if ((methode.flags & METHODE_ACCES) !== METHODE_PUBLIQUE) continue;
      if (methode.flags & METHODE_NOM_SPECIAL) continue;
      const n = nombreParametres(blob(methode.signature));
      api.push(`${espace ? espace + '.' : ''}${nom}.${chaine(methode.nom)}(${n})`);
    }
  }
  api.sort();

  return {
    nom: assembly ? chaine(assembly.nom) : null,
    version: assembly ? version(assembly) : null,
    references,
    api
  };
}

/** Lit et analyse une DLL sur disque ; `null` si illisible ou non .NET. */
async function analyserFichier(chemin) {
  try {
    return analyser(await fsp.readFile(cheminLong(chemin)));
  } catch (err) {
    return null;
  }
}

/**
 * Écart d'API entre deux analyses : méthodes ajoutées, retirées. Une méthode
 * dont seul le nombre de paramètres change apparaît des deux côtés.
 */
function comparerApi(avant, apres) {
  const a = new Set((avant && avant.api) || []);
  const b = new Set((apres && apres.api) || []);
  return {
    ajoutees: [...b].filter((x) => !a.has(x)),
    retirees: [...a].filter((x) => !b.has(x)),
    total: b.size
  };
}

module.exports = { analyser, analyserFichier, comparerApi, lireTables, nombreParametres };
