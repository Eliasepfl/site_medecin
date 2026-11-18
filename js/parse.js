// Script classique (sans import/export) pour que la page fonctionne aussi ouverte
// directement depuis le disque, par double-clic sur index.html.
(function (FP) {
  'use strict';
  // Lecture du texte des PDF : fonctions pures, sans accès au réseau ni au DOM.
  // Deux formats :
  //  - le journal des factures  (Date · Libellé · Patient · Montant · Dû · Payé · NIR)
  //  - la liste de patientèle médecin traitant (NOM PRÉNOM · ÂGE · NIR · ENTRÉ(E) LE · ALD · RÉGIME)

  const DATE = '\\d{2}/\\d{2}/\\d{4}';
  // NIR : 13 caractères (le département peut être 2A / 2B), espaces facultatifs,
  // clé de contrôle à 2 chiffres facultative.
  const NIR13 = '\\d ?\\d{2} ?\\d{2} ?\\d ?[\\dAB] ?\\d{3} ?\\d{3}';

  const RE_DATE = new RegExp(DATE, 'g');
  const RE_NIR = new RegExp('(^|[^\\d,])(' + NIR13 + '(?: ?\\d{2})?)(?![\\d,])');
  const RE_NUMBER = /(^|[^A-Za-zÀ-ÿ])([A-Z]{1,5}) ?(\d{3,})(?![\d,])/;
  const RE_AMOUNT = /()(-?(?:\d{1,3}(?:[ .]\d{3})+|\d+),\d{2})/;
  const RE_PATIENT_LINE = new RegExp(
    '^(\\D*?)\\s*(?:\\b(\\d{1,3})\\s+)?(' + NIR13 + '(?: ?\\d{2}(?![\\d/,]))?)(?![\\dA-Z])\\s*(' + DATE + ')?\\s*(OUI|NON)?\\s*(.*)$'
  );
  const RE_TOTAL = new RegExp('Nombre total de patients au\\s*(' + DATE + ')\\s*:\\s*(\\d[\\d ]*)', 'i');

  // Repères posés à la place des éléments déjà extraits d'un bloc.
  const M_NIR = '\u0001';
  const M_NUM = '\u0002';
  const M_AMT = '\u0003';
  const M_NIR2 = '\u0004';
  const RE_MARKS = /[\u0001-\u0004]/g;
  const RE_JOINER = /^[-–'’.]+$/;
  const isWord = (t) => /[A-Za-zÀ-ÿ]/.test(t) && !/\d/.test(t);

  /** "14/11/2026" -> "2026-11-14" (ou null si la date n'existe pas). */
  function toIso(fr) {
    const [d, m, y] = fr.split('/').map(Number);
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const toNumber = (fr) => Number(fr.replace(/[ .]/g, '').replace(',', '.'));

  /** Garde les 13 premiers caractères du NIR (sans la clé), sans espaces. */
  function nir13(raw) {
    if (!raw) return '';
    const s = raw.replace(/\s/g, '').toUpperCase();
    return s.length >= 13 ? s.slice(0, 13) : '';
  }

  const clean = (text) => text.replace(/[    ]/g, ' ');

  /** Retire la première occurrence de `re` (groupes : préfixe, valeur…) et pose un repère. */
  function take(re, s, mark) {
    const m = re.exec(s);
    if (!m) return [s, null];
    const start = m.index + m[1].length;
    return [s.slice(0, start) + ' ' + mark + ' ' + s.slice(m.index + m[0].length), m];
  }

  /**
   * Garde le nom en tête d'un fragment : les mots jusqu'au premier élément qui
   * n'en est pas un (chiffre, « : », repère). Un tiret ou une apostrophe isolé
   * fait partie du nom (« DUPONT - DE LA TOUR »).
   */
  function cleanName(raw, ref) {
    const words = [];
    for (const t of raw.split(/\s+/).filter(Boolean)) {
      if (!words.length) {
        if (!isWord(t)) continue;
      } else if (!isWord(t) && !RE_JOINER.test(t)) break;
      words.push(t);
    }
    while (words.length && RE_JOINER.test(words[words.length - 1])) words.pop();
    const name = words.join(' ');
    return ref && name.startsWith(ref + ' ') ? ref : name;
  }

  /**
   * Libellé sans numéro : « NOM CODE NOM » (le libellé reprend le nom du patient,
   * suivi d'un code de deux lettres). On cherche le mot court en majuscules placé
   * entre deux suites de mots identiques.
   */
  function splitOnRepeat(text) {
    const t = text.replace(RE_MARKS, ' ').split(/\s+/).filter((x) => isWord(x) || RE_JOINER.test(x));
    for (let i = 1; 2 * i + 1 <= t.length; i++) {
      if (!/^[A-Z]{1,5}$/.test(t[i])) continue;
      const name = t.slice(0, i).join(' ');
      if (name === t.slice(i + 1, 2 * i + 1).join(' ')) return { code: t[i], name };
    }
    return null;
  }

  /** Extrait d'un bloc (texte entre deux dates) : NIR, numéro de facture, montants, noms. */
  function fields(segment) {
    let w = ' ' + segment + ' ';
    let nirA, nirB, num, m;
    [w, nirA] = take(RE_NIR, w, M_NIR);
    [w, num] = take(RE_NUMBER, w, M_NUM);
    const amounts = [];
    while (amounts.length < 3) {
      [w, m] = take(RE_AMOUNT, w, M_AMT);
      if (!m) break;
      amounts.push(toNumber(m[2]));
    }
    // Second passage : NIR collé aux montants (« 3,001 84 05… »), ou second NIR du bloc
    // (un NIR dans la colonne Patient, « NOM : NIR », en plus de la colonne NIR).
    [w, nirB] = take(RE_NIR, w, nirA ? M_NIR2 : M_NIR);
    if (!nirA) [nirA, nirB] = [nirB, null];

    // Le NIR de la colonne NIR est celui qui suit les montants ; l'autre est gardé à part.
    const iAmt = w.indexOf(M_AMT);
    const iLastAmt = w.lastIndexOf(M_AMT);
    const iA = w.indexOf(M_NIR);
    const iB = w.indexOf(M_NIR2);
    let main = nirA;
    let alt = nirB;
    let iMain = iA;
    if (nirB && iLastAmt >= 0 && iB > iLastAmt && iA < iLastAmt) [main, alt, iMain] = [nirB, nirA, iB];

    let code = num ? num[2] : '';
    let libelleName = '';
    let patient = '';
    const iNum = w.indexOf(M_NUM);
    if (iNum >= 0) {
      libelleName = cleanName(w.slice(0, iNum).replace(RE_MARKS, ' '));
      // Le patient est le premier morceau de texte après le numéro (avant montants et NIR).
      const chunk = w.slice(iNum + 1).split(RE_MARKS).find((c) => /[A-Za-zÀ-ÿ]/.test(c)) || '';
      patient = cleanName(chunk, libelleName) || libelleName;
    } else {
      const rep = splitOnRepeat(w);
      if (rep) {
        code = rep.code;
        libelleName = patient = rep.name;
      } else {
        patient = cleanName(w.split(RE_MARKS).find((c) => /[A-Za-zÀ-ÿ]/.test(c)) || '');
      }
    }
    return {
      nir: main ? nir13(main[2]) : '',
      nirAlt: alt ? nir13(alt[2]) : '',
      nirFirst: iMain >= 0 && (iAmt < 0 || iMain < iAmt),
      code,
      number: num ? num[3] : '',
      amounts,
      libelleName,
      patient,
    };
  }

  /** Part des factures dont le NIR est celui le plus fréquent pour ce nom (1 = cohérent). */
  function nirConsistency(records) {
    const byName = new Map();
    for (const r of records) {
      if (!r.nir13 || !r.patient) continue;
      const k = r.patient.toUpperCase().split(/[^A-ZÀ-Ý]+/).filter(Boolean).sort().join(' ');
      if (!byName.has(k)) byName.set(k, new Map());
      const c = byName.get(k);
      c.set(r.nir13, (c.get(r.nir13) || 0) + 1);
    }
    let total = 0;
    let agree = 0;
    for (const c of byName.values()) {
      const n = [...c.values()].reduce((a, b) => a + b, 0);
      if (n < 2) continue;
      total += n;
      agree += Math.max(...c.values());
    }
    return total >= 10 ? agree / total : 1;
  }

  /**
   * Journal des factures. Le texte est un flux continu, replié en lignes : il est
   * découpé à chaque date, et tout ce qui se trouve entre deux dates appartient à
   * une même ligne du journal. Une ligne porte un à trois montants (les colonnes
   * Dû et Payé peuvent être vides).
   */
  function parseInvoices(text) {
    const flat = clean(text).replace(/\s+/g, ' ').trim();
    const dates = [];
    RE_DATE.lastIndex = 0;
    let m;
    while ((m = RE_DATE.exec(flat))) {
      const iso = toIso(m[0]);
      if (iso) dates.push({ iso, start: m.index, end: m.index + m[0].length });
    }
    const pre = fields(flat.slice(0, dates.length ? dates[0].start : 0));
    const segs = dates.map((d, i) => flat.slice(d.end, i + 1 < dates.length ? dates[i + 1].start : flat.length));
    const f = segs.map(fields);

    // Montants lus une ligne trop tôt (ils précèdent la date de leur facture) : le texte
    // commence par des montants sans nom et la dernière date a un nom sans montant.
    const last = f[f.length - 1];
    const shifted = f.length > 1 && pre.amounts.length >= 2 && !pre.patient && !last.amounts.length && !!last.patient;

    const records = [];
    const suspicious = [];
    f.forEach((cur, i) => {
      const prev = i ? f[i - 1] : pre;
      const amounts = shifted ? prev.amounts : cur.amounts;
      const nir = !shifted ? cur.nir : cur.nirFirst ? cur.nir : prev.nirFirst ? '' : prev.nir;
      if (!amounts.length || (!cur.patient && !nir)) {
        if (!shifted && (cur.amounts.length || cur.nir || cur.number)) suspicious.push(`${flat.slice(dates[i].start, dates[i].end)} ${segs[i].trim()}`);
        return;
      }
      records.push({
        date: dates[i].iso,
        code: cur.code,
        number: cur.number,
        libelleName: cur.libelleName,
        patient: cur.patient,
        montant: amounts[0],
        // Avec deux montants seulement, on ne sait pas lequel de Dû ou Payé est vide.
        du: amounts.length === 3 ? amounts[1] : null,
        paye: amounts.length === 3 ? amounts[2] : null,
        nir13: nir,
        nirAlt: shifted ? '' : cur.nirAlt,
      });
    });
    if (!shifted && pre.amounts.length) suspicious.push(flat.slice(0, dates.length ? dates[0].start : flat.length).trim());
    return { records, suspicious, quality: nirConsistency(records), shifted };
  }

  /** Liste de patientèle : une ligne de tableau par patient. */
  function parsePatientele(text) {
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
    return { records, suspicious, declaredTotal, declaredDate, quality: 1 };
  }

  /**
   * Reconstruit les lignes d'une page à partir de la position des fragments de
   * texte (x, y, largeur, hauteur) : même hauteur = même ligne, lue de gauche à droite.
   */
  function itemsToText(items) {
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
            // Deux fragments ne sont soudés que s'ils se touchent : un écart, ou un
            // chevauchement (colonnes qui débordent), donne une espace.
            const gap = it.x - (prev.x + prev.w);
            const h = Math.max(it.h || 0, prev.h || 0) || 10;
            if (gap > 0.12 * h || gap < -0.5 * h || /\s$/.test(prev.str) || /^\s/.test(it.str)) out += ' ';
          }
          out += it.str;
          prev = it;
        }
        return out;
      })
      .join('\n');
  }

  /** Texte dans l'ordre interne du PDF (ce que donne un copier-coller). */
  function itemsToStreamText(items) {
    return items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
  }

  const KEEP = new Set(
    'Date Libellé Patient Montant Dû Payé NIR FV NOM PRÉNOM ÂGE ENTRÉ(E) LE ALD RÉGIME OUI RG Page Total Nombre total de patients au :'.split(' ')
  );

  /**
   * Squelette du texte sans aucune donnée : chaque lettre devient A (ou a), chaque
   * chiffre 9. Sert à décrire la mise en page d'un PDF sans rien révéler.
   */
  function anonymize(text, maxLines = 40, extra) {
    return clean(text)
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(0, maxLines)
      .map((l) =>
        l
          .slice(0, 220)
          .replace(/\S+/g, (t) => (KEEP.has(t) || (extra && extra.has(t)) ? t : t.replace(/[A-ZÀ-Ý]/g, 'A').replace(/[a-zà-ÿ]/g, 'a').replace(/\d/g, '9')))
      )
      .join('\n');
  }

  const PARSERS = { factures: parseInvoices, patientele: parsePatientele };

  function best(type, texts) {
    let top = null;
    for (const text of texts) {
      const result = PARSERS[type](text);
      const score = result.records.length * (0.5 + 0.5 * result.quality);
      if (!top || score > top.score) top = { result, score, text };
    }
    return top;
  }

  /** Lit un document du type demandé ; `variants` = lectures possibles du même document ({label, text}). */
  function read(type, variants) {
    variants = variants.filter((v, i, a) => v.text && a.findIndex((o) => o.text === v.text) === i);
    const texts = variants.map((v) => v.text);
    const top = best(type, texts);
    const other = best(type === 'factures' ? 'patientele' : 'factures', texts);
    // Les codes de ligne (FV…) ne sont pas des données personnelles : on les laisse lisibles
    // dans la structure anonymisée, s'ils sont portés par assez de patients différents.
    const codes = new Set();
    if (type === 'factures' && top) {
      const by = new Map();
      for (const r of top.result.records) {
        if (!/^[A-Z]{2,3}$/.test(r.code)) continue;
        if (!by.has(r.code)) by.set(r.code, new Set());
        by.get(r.code).add(r.patient);
      }
      for (const [c, names] of by) if (names.size >= 8) codes.add(c);
    }
    return {
      type,
      count: top ? top.result.records.length : 0,
      result: top ? top.result : null,
      otherCount: other ? other.result.records.length : 0,
      structure: variants.map((v) => '# ' + v.label + '\n' + anonymize(v.text, 40, codes)).join('\n\n'),
    };
  }

  /** Texte brut (copier-coller). */
  function readTextAs(type, text) {
    return read(type, [{ label: 'Texte collé', text }]);
  }

  /** PDF : liste de pages, chaque page = liste de fragments positionnés. */
  function readAs(type, pages) {
    return read(type, [
      { label: 'Ordre visuel (lignes reconstruites)', text: pages.map(itemsToText).join('\n') },
      { label: 'Ordre interne du fichier', text: pages.map(itemsToStreamText).join('\n') },
    ]);
  }

  FP.parse = { toIso, nir13, parseInvoices, parsePatientele, itemsToText, itemsToStreamText, anonymize, readTextAs, readAs };
})((globalThis.FP = globalThis.FP || {}));
