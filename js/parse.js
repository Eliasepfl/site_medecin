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
  // Nom (facultatif), âge, NIR, puis le reste de la ligne (date, ALD, régime, dans un ordre quelconque).
  const RE_PATIENT_LINE = new RegExp('^(\\D*?)\\s*(?:\\b(\\d{1,3})\\s+)?(' + NIR13 + '(?: ?\\d{2}(?![\\d/,]))?)(.*)$');
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
  function splitOnRepeat(text, knownCodes) {
    const t = text.replace(RE_MARKS, ' ').split(/\s+/).filter((x) => isWord(x) || RE_JOINER.test(x));
    // Le libellé peut être en capitales et la colonne Patient en casse mixte.
    const fold = (words) => words.join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    for (let i = 1; 2 * i + 1 <= t.length; i++) {
      if (!/^[A-Z]{1,5}$/.test(t[i])) continue;
      if (fold(t.slice(0, i)) === fold(t.slice(i + 1, 2 * i + 1))) return { code: t[i], libelle: t.slice(0, i).join(' '), name: t.slice(i + 1, 2 * i + 1).join(' ') };
    }
    // Pas de répétition exacte : on coupe sur un code déjà rencontré ailleurs dans le journal.
    if (knownCodes)
      for (let i = 1; i < t.length - 1; i++)
        if (knownCodes.has(t[i])) return { code: t[i], libelle: t.slice(0, i).join(' '), name: cleanName(t.slice(i + 1).join(' '), t.slice(0, i).join(' ')) };
    return null;
  }

  /** Extrait d'un bloc (texte entre deux dates) : NIR, numéro de facture, montants, noms. */
  function fields(segment, knownCodes) {
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
      const rep = splitOnRepeat(w, knownCodes);
      if (rep) {
        code = rep.code;
        libelleName = rep.libelle;
        patient = rep.name;
      } else {
        patient = cleanName(w.split(RE_MARKS).find((c) => /[A-Za-zÀ-ÿ]/.test(c)) || '');
      }
    }
    return {
      segment,
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
    let f = segs.map((s) => fields(s));
    // Second passage pour les lignes sans code reconnu, avec les codes fréquents du journal.
    const codeCount = new Map();
    for (const x of f) if (x.code) codeCount.set(x.code, (codeCount.get(x.code) || 0) + 1);
    const known = new Set([...codeCount].filter(([c, n]) => n >= 5 && /^[A-Z]{2,3}$/.test(c)).map(([c]) => c));
    if (known.size) f = f.map((x) => (x.code || !x.patient ? x : fields(x.segment, known)));

    // Montants lus une ligne trop tôt (ils précèdent la date de leur facture) : le texte
    // commence par des montants (avant toute date) et la dernière date a un nom sans montant.
    const last = f[f.length - 1];
    const shifted = f.length > 1 && pre.amounts.length >= 2 && !last.amounts.length && !!last.patient;

    const records = [];
    const suspicious = [];
    const contexts = [];
    const around = (i) =>
      [i - 1, i, i + 1]
        .filter((k) => k >= 0 && k < segs.length)
        .map((k) => `${flat.slice(dates[k].start, dates[k].end)} ${segs[k].trim()}`)
        .join('\n');
    for (let i = 0; i < f.length; i++) {
      const cur = f[i];
      const prev = i ? f[i - 1] : pre;
      const next = f[i + 1];
      let amounts = (shifted ? prev.amounts : cur.amounts).slice();
      let nir = !shifted ? cur.nir : cur.nirFirst ? cur.nir : prev.nirFirst ? '' : prev.nir;
      let nirAlt = shifted ? '' : cur.nirAlt;
      // Une date écrite dans le nom du patient (date de naissance, par exemple) coupe la
      // ligne en deux : le début porte le code et le nom, la suite seulement les montants
      // et le NIR. On recolle les deux moitiés sous la première date.
      const split = !shifted && !amounts.length && !!cur.code && !!cur.patient && !!next && next.amounts.length > 0 && !next.code && !next.number;
      if (split) {
        amounts = next.amounts.slice();
        nir = nir || next.nir;
        nirAlt = nirAlt || next.nirAlt;
      }
      // Code et nom mais aucun montant trouvé : la ligne compte pour le patient, son
      // montant n'a pas pu être lu (il n'est pas nul), et elle est signalée.
      const noAmount = !shifted && !amounts.length && !!cur.code && !!cur.patient;
      if (noAmount) {
        amounts.push(null);
        contexts.push(around(i));
      }
      if (!amounts.length || (!cur.patient && !nir)) {
        if (!shifted && (cur.amounts.length || cur.nir || cur.number)) {
          suspicious.push(`${flat.slice(dates[i].start, dates[i].end)} ${segs[i].trim()}`);
          contexts.push(around(i));
        }
        continue;
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
        nirAlt,
      });
      if (split) i++;
    }
    if (!shifted && pre.amounts.length) suspicious.push(flat.slice(0, dates.length ? dates[0].start : flat.length).trim());
    const unread = records.filter((r) => r.montant == null).length;
    return { records, suspicious, contexts, unread, quality: nirConsistency(records), shifted };
  }

  const RE_LIST_HEADER = /^(Nombre total|Les données|celles des|LISTE COMPL|NOM PR.NOM|Page\b)/i;

  const RE_NIR_ONLY = new RegExp('^' + NIR13 + '(?: ?\\d{2})?$');
  // Rangée privée de son NIR : un nom en capitales, puis l'âge ou la date d'entrée.
  const isRowWithoutNir = (l) => /^[^\da-zà-ÿ]*[A-ZÀ-Ý][^\da-zà-ÿ]*\s\d/.test(l) && !RE_LIST_HEADER.test(l) && !RE_PATIENT_LINE.test(l);
  const isNameOnly = (l) => !!l && !/\d/.test(l) && /[A-ZÀ-Ý]/.test(l) && !/[a-zà-ÿ]/.test(l) && !RE_LIST_HEADER.test(l);

  /** « NOM 45 01/03/2017 RG » + NIR -> « NOM 45 NIR 01/03/2017 RG » */
  function insertNir(row, nir) {
    const m = /^(\D*?)\s*(\d{1,3})(?:\s+(.*))?$/.exec(row);
    if (m) return `${m[1]} ${m[2]} ${nir} ${m[3] || ''}`.trim();
    const cut = row.search(/\d/);
    return `${row.slice(0, cut)} ${nir} ${row.slice(cut)}`.trim();
  }

  /**
   * Dans certains PDF le NIR est écrit légèrement plus haut (ou plus bas) que le reste de
   * sa rangée et se retrouve seul sur une ligne. On le remet dans la rangée voisine ; le
   * sens (NIR avant ou après) est celui de la première rangée du document.
   */
  function joinSplitRows(lines) {
    lines = lines.filter(Boolean);
    const first = lines.find((l) => RE_NIR_ONLY.test(l) || isRowWithoutNir(l));
    if (!first) return lines;
    const nirBefore = RE_NIR_ONLY.test(first);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (nirBefore && RE_NIR_ONLY.test(l)) {
        // Jusqu'à deux lignes de nom seules (nom très long) entre le NIR et sa rangée.
        let j = i + 1;
        const names = [];
        while (j < lines.length && names.length < 2 && isNameOnly(lines[j])) names.push(lines[j++]);
        if (j < lines.length && isRowWithoutNir(lines[j])) {
          out.push(insertNir((names.join(' ') + ' ' + lines[j]).trim(), l));
          i = j;
          continue;
        }
      } else if (!nirBefore && isRowWithoutNir(l) && i + 1 < lines.length && RE_NIR_ONLY.test(lines[i + 1])) {
        out.push(insertNir(l, lines[i + 1]));
        i++;
        continue;
      }
      out.push(l);
    }
    return out;
  }

  /**
   * Liste de patientèle : une ligne de tableau par patient (nom, âge, NIR, puis date
   * d'entrée, ALD et régime dans un ordre quelconque, parfois collés). Quand le nom est
   * trop long, il se retrouve seul sur la ligne du dessus ou du dessous.
   */
  function parsePatientele(text) {
    const lines = joinSplitRows(clean(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()));
    const isNameLine = (l) => !!l && !/\d/.test(l) && /[A-ZÀ-Ý]/.test(l) && !/[a-zà-ÿ]/.test(l) && !RE_LIST_HEADER.test(l);
    const records = [];
    const suspicious = [];
    const contexts = [];
    let declaredTotal = null;
    let declaredDate = null;
    let pending = []; // lignes de nom seules, en attente de leur ligne de données
    const flag = (i) => contexts.push(lines.slice(Math.max(0, i - 2), i + 3).filter(Boolean).join('\n'));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const t = RE_TOTAL.exec(line);
      if (t) {
        declaredDate = toIso(t[1]);
        declaredTotal = Number(t[2].replace(/ /g, ''));
        pending = [];
        continue;
      }
      const m = RE_PATIENT_LINE.exec(line);
      if (!m) {
        if (isNameLine(line)) pending.push(line);
        else {
          pending = [];
          if (/\d{13}/.test(line.replace(/ /g, ''))) {
            suspicious.push(line);
            flag(i);
          }
        }
        continue;
      }
      let name = m[1].trim();
      if (!name) {
        // Nom au-dessus de la ligne de données…
        name = pending.join(' ');
        // …et/ou en dessous, si ces lignes ne peuvent pas appartenir au patient suivant.
        let j = i + 1;
        const below = [];
        while (j < lines.length && (isNameLine(lines[j]) || !lines[j])) {
          if (lines[j]) below.push(lines[j]);
          j++;
        }
        const next = j < lines.length ? RE_PATIENT_LINE.exec(lines[j]) : null;
        if (below.length && (!name || !next || next[1].trim())) {
          name = (name + ' ' + below.join(' ')).trim();
          i = j - 1;
        }
        if (!name) flag(i);
      }
      pending = [];
      const tail = m[4] || '';
      const date = new RegExp(DATE).exec(tail);
      records.push({
        name,
        age: m[2] ? Number(m[2]) : null,
        nir13: nir13(m[3]),
        since: date ? toIso(date[0]) : null,
        ald: /OUI/.test(tail),
        regime: tail.replace(new RegExp(DATE), ' ').replace(/OUI|NON/, ' ').replace(/\s+/g, ' ').trim(),
      });
    }
    // Une lecture qui retrouve les noms vaut mieux qu'une lecture qui n'a que les NIR.
    const named = records.filter((r) => r.name).length;
    return { records, suspicious, contexts, declaredTotal, declaredDate, quality: records.length ? named / records.length : 1 };
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
    'Date Libellé Patient Montant Dû Payé NIR FV FP FD NOM PRÉNOM ÂGE ENTRÉ(E) LE ALD RÉGIME OUI RG Page Total Nombre total de patients au :'.split(' ')
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
      // À score égal, la lecture qui laisse le moins de passages non reconnus.
      if (!top || score > top.score || (score === top.score && result.suspicious.length + (result.unread || 0) < top.result.suspicious.length + (top.result.unread || 0))) top = { result, score, text };
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
      structure:
        variants.map((v) => '# ' + v.label + '\n' + anonymize(v.text, 40, codes)).join('\n\n') +
        // Lignes à problème, anonymisées elles aussi, avec leurs voisines pour le contexte.
        (top && (top.result.contexts || top.result.suspicious).length
          ? '\n\n# Lignes à problème (anonymisées)\n' +
            (top.result.contexts || top.result.suspicious)
              .slice(0, 12)
              .map((c) => anonymize(c, 6, codes))
              .join('\n--\n')
          : ''),
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
