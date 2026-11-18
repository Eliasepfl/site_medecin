// Lecture du texte des PDF : fonctions pures, sans accès au réseau ni au DOM.
// Deux formats sont reconnus :
//  - le journal des factures  (Date · Libellé · Patient · Montant · Dû · Payé · NIR)
//  - la liste de patientèle médecin traitant (NOM PRÉNOM · ÂGE · NIR · ENTRÉ(E) LE · ALD · RÉGIME)

const DATE = '\\d{2}/\\d{2}/\\d{4}';
const AMT = '-?(?:\\d{1,3}(?:[ .]\\d{3})+|\\d+),\\d{2}';
// NIR : 13 caractères (le département peut être 2A / 2B), espaces facultatifs,
// clé de contrôle à 2 chiffres facultative.
const NIR13 = '\\d ?\\d{2} ?\\d{2} ?\\d ?[\\dAB] ?\\d{3} ?\\d{3}';
const NIR = NIR13 + '(?: ?\\d{2}(?![\\d/,]))?';

const RE_INVOICE = new RegExp(
  '(' + DATE + ') ' +
  '((?:(?!' + DATE + ').)*?) ?' +
  '(' + AMT + ') (' + AMT + ') (' + AMT + ')(?![\\d,])' +
  '(?: (' + NIR + '))?',
  'g'
);
// Le numéro peut être collé au nom qui suit quand les colonnes se touchent.
const RE_LIBELLE = /^(.*?)\s*\b([A-Z]{1,5}) ?(\d{3,})\s*(.*)$/;
const RE_PATIENT_LINE = new RegExp(
  '^(\\D*?)\\s*(?:\\b(\\d{1,3})\\s+)?(' + NIR + ')(?![\\dA-Z])\\s*(' + DATE + ')?\\s*(OUI|NON)?\\s*(.*)$'
);
const RE_TOTAL = new RegExp('Nombre total de patients au\\s*(' + DATE + ')\\s*:\\s*(\\d[\\d ]*)', 'i');

/** "14/11/2026" -> "2026-11-14" (ou null si la date n'existe pas). */
export function toIso(fr) {
  const [d, m, y] = fr.split('/').map(Number);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toNumber(fr) {
  return Number(fr.replace(/[ .]/g, '').replace(',', '.'));
}

/** Garde les 13 premiers caractères du NIR (sans la clé), sans espaces. */
export function nir13(raw) {
  if (!raw) return '';
  const s = raw.replace(/\s/g, '').toUpperCase();
  return s.length >= 13 ? s.slice(0, 13) : '';
}

function clean(text) {
  return text.replace(/[    ]/g, ' ');
}

/**
 * Journal des factures. Le texte est lu comme un flux continu : une facture
 * commence à une date et se termine après ses trois montants (+ NIR), qu'elle
 * tienne sur une ou deux lignes.
 */
export function parseInvoices(text) {
  const flat = clean(text).replace(/\s+/g, ' ').trim();
  const all = [];
  const leftovers = [];
  let last = 0;
  RE_INVOICE.lastIndex = 0;
  let m;
  while ((m = RE_INVOICE.exec(flat))) {
    const iso = toIso(m[1]);
    if (!iso) continue;
    const before = flat.slice(last, m.index).trim();
    if (before) leftovers.push(before);
    last = RE_INVOICE.lastIndex;

    const middle = m[2].trim();
    const lib = RE_LIBELLE.exec(middle);
    const rec = {
      date: iso,
      code: lib ? lib[2] : '',
      number: lib ? lib[3] : '',
      libelleName: lib ? lib[1].trim() : '',
      patient: lib ? lib[4].trim() : middle,
      montant: toNumber(m[3]),
      du: toNumber(m[4]),
      paye: toNumber(m[5]),
      nir13: nir13(m[6]),
      raw: m[0],
    };
    if (!rec.patient) rec.patient = rec.libelleName;
    all.push(rec);
  }
  const tail = flat.slice(last).trim();
  if (tail) leftovers.push(tail);

  // Si presque toutes les lignes portent un numéro de facture, celles qui n'en
  // ont pas sont très probablement des totaux ou des pieds de page.
  const numbered = all.filter((r) => r.number);
  let records = all;
  const rejected = [];
  if (numbered.length && numbered.length >= all.length * 0.9) {
    records = numbered;
    for (const r of all) if (!r.number) rejected.push(r.raw);
  }

  const suspicious = leftovers
    .filter((s) => new RegExp(DATE).test(s) || /\d,\d{2}(?!\d)/.test(s))
    .concat(rejected);
  return { records, suspicious };
}

/** Liste de patientèle : une ligne de tableau par patient. */
export function parsePatientele(text) {
  const records = [];
  const suspicious = [];
  let declaredTotal = null;
  let declaredDate = null;
  for (const rawLine of clean(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const t = RE_TOTAL.exec(line);
    if (t) {
      declaredDate = toIso(t[1]);
      declaredTotal = Number(t[2].replace(/ /g, ''));
      continue;
    }
    const m = RE_PATIENT_LINE.exec(line);
    if (m && m[1].trim()) {
      records.push({
        name: m[1].trim(),
        age: m[2] ? Number(m[2]) : null,
        nir13: nir13(m[3]),
        since: m[4] ? toIso(m[4]) : null,
        ald: m[5] === 'OUI',
        regime: (m[6] || '').trim(),
      });
    } else if (/\d{13}/.test(line.replace(/ /g, ''))) {
      suspicious.push(line);
    }
  }
  return { records, suspicious, declaredTotal, declaredDate };
}

/**
 * Reconstruit les lignes d'une page à partir de la position des fragments de
 * texte (x, y, largeur, hauteur) : même hauteur = même ligne, lue de gauche à droite.
 */
export function itemsToText(items) {
  const its = items.filter((i) => i.str && i.str.trim() !== '');
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let line = null;
  for (const it of its) {
    const tol = Math.max(2, 0.45 * (it.h || 10));
    if (!line || Math.abs(line.y - it.y) > tol) {
      line = { y: it.y, items: [] };
      lines.push(line);
    }
    line.items.push(it);
  }
  return lines
    .map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let out = '';
      let prev = null;
      for (const it of l.items) {
        if (prev) {
          const gap = it.x - (prev.x + prev.w);
          const h = Math.max(it.h || 0, prev.h || 0) || 10;
          if (gap > 0.12 * h || /\s$/.test(prev.str) || /^\s/.test(it.str)) out += ' ';
        }
        out += it.str;
        prev = it;
      }
      return out;
    })
    .join('\n');
}

/** Texte dans l'ordre interne du PDF (ce que donne un copier-coller). */
export function itemsToStreamText(items) {
  return items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
}

/**
 * Lit un document (liste de pages, chaque page = liste de fragments) et devine
 * son type en essayant les deux formats et les deux ordres de lecture.
 */
export function readDocument(pages) {
  const byPosition = pages.map(itemsToText).join('\n');
  const byStream = pages.map(itemsToStreamText).join('\n');
  return readText(byPosition, byStream);
}

/** Même chose à partir d'un texte brut (copier-coller). */
export function readText(text, altText) {
  const candidates = [text];
  if (altText && altText !== text) candidates.push(altText);
  let best = null;
  for (const t of candidates) {
    const inv = parseInvoices(t);
    const pat = parsePatientele(t);
    for (const c of [
      { type: 'factures', count: inv.records.length, result: inv, text: t },
      { type: 'patientele', count: pat.records.length, result: pat, text: t },
    ]) {
      if (!best || c.count > best.count) best = c;
    }
  }
  if (!best || best.count === 0) return { type: 'inconnu', count: 0, text, result: null };
  return best;
}
