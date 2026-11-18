// Script classique (sans import/export) pour que la page fonctionne aussi ouverte
// directement depuis le disque, par double-clic sur index.html.
(function (FP) {
  'use strict';
  // Rapprochement des patients et calcul des indicateurs : fonctions pures.

  /** "Jean-Pierre DUPONT-MARTIN" -> ["JEAN","PIERRE","DUPONT","MARTIN"] */
  function nameTokens(s) {
    return (s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  const nameKey = (tokens) => [...new Set(tokens)].sort().join(' ');

  /** Mêmes mots, ou tous les mots du nom le plus court (au moins 2) présents dans l'autre. */
  function namesCompatible(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (!A.size || !B.size) return false;
    const [small, large] = A.size <= B.size ? [A, B] : [B, A];
    if (small.size < 2 && small.size !== large.size) return false;
    for (const t of small) if (!large.has(t)) return false;
    return true;
  }

  /**
   * Les deux documents écrivent NOM puis PRÉNOM(S) ; la facture donne tous les prénoms,
   * la patientèle le premier (simple ou composé). « DUPONT JEAN » est donc le début de
   * « DUPONT JEAN PIERRE MARCEL », mais pas de « DUPONT PAUL JEAN » (un autre membre
   * de la famille). Les tirets ont déjà été retirés des deux côtés.
   */
  function isPrefix(a, b) {
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.length >= 2 && s.every((t, i) => l[i] === t);
  }

  /** Même NIR des deux côtés : est-ce la même personne ? 'sur', 'probable' ou null. */
  function samePersonSameNir(inv, list) {
    if (!inv.length || isPrefix(inv, list)) return 'sur';
    if (list.length < 2) return null;
    const surname = list.slice(0, -1);
    const first = list[list.length - 1];
    // Nom raccourci d'un côté (« ZOLA--ZIDANE XAVIER » / « ZOLA XAVIER LOUIS ») : le premier
    // mot de la facture hors du nom doit être le prénom inscrit dans la patientèle.
    const rest = inv.filter((t) => !surname.includes(t));
    if (rest.length < inv.length && rest[0] === first) return 'sur';
    // Nom entièrement différent (nom d'usage / de naissance) mais même prénom.
    if (inv[0] !== list[0] && inv.slice(1).includes(first)) return 'probable';
    return null;
  }

  class UnionFind {
    constructor(n) {
      this.p = Array.from({ length: n }, (_, i) => i);
    }
    find(i) {
      while (this.p[i] !== i) {
        this.p[i] = this.p[this.p[i]];
        i = this.p[i];
      }
      return i;
    }
    union(a, b) {
      this.p[this.find(a)] = this.find(b);
    }
  }

  function groupBy(list, keyFn) {
    const map = new Map();
    for (const x of list) {
      const k = keyFn(x);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(x);
    }
    return map;
  }

  /**
   * Construit la liste des patients distincts présents dans les factures et
   * indique pour chacun s'il figure dans la patientèle médecin traitant.
   */
  function buildModel(invoices, patientele, { matchByName = true, nirOnly = false } = {}) {
    // Factures en double (même fichier chargé deux fois, exports qui se recoupent).
    const seen = new Set();
    const unique = [];
    let duplicates = 0;
    for (const inv of invoices) {
      const k = [inv.date, inv.code, inv.number, inv.patient, inv.montant, inv.nir13].join('|');
      if (inv.number && seen.has(k)) {
        duplicates++;
        continue;
      }
      seen.add(k);
      unique.push(inv);
    }

    // Patientèle sans doublons.
    const listSeen = new Set();
    const list = [];
    for (const p of patientele) {
      const tokens = nameTokens(p.name);
      const k = p.nir13 + '|' + nameKey(tokens);
      if (listSeen.has(k)) continue;
      listSeen.add(k);
      list.push({ ...p, tokens, nameKey: nameKey(tokens) });
    }
    const listByNir = groupBy(list, (p) => p.nir13);
    const listByName = groupBy(list, (p) => (p.tokens.length >= 2 ? p.nameKey : ''));
    const listByToken = new Map();
    for (const p of list)
      for (const t of new Set(p.tokens)) {
        if (!listByToken.has(t)) listByToken.set(t, []);
        listByToken.get(t).push(p);
      }

    // Identités = couples (NIR, nom) distincts rencontrés dans les factures.
    const ids = new Map();
    const unidentified = [];
    for (const inv of unique) {
      const tokens = nameTokens(inv.patient);
      if (!tokens.length && !inv.nir13) {
        unidentified.push(inv);
        continue;
      }
      const k = inv.nir13 + '|' + tokens.join(' ');
      if (!ids.has(k)) ids.set(k, { nir: inv.nir13, alts: new Set(), tokens, nameKey: nameKey(tokens), label: inv.patient, invoices: [] });
      if (inv.nirAlt) ids.get(k).alts.add(inv.nirAlt);
      ids.get(k).invoices.push(inv);
    }
    const idList = [...ids.values()];
    idList.forEach((id, i) => (id.i = i));

    // Une même personne = même NIR et nom compatible (un NIR peut couvrir toute une
    // famille : assuré + ayants droit), ou bien nom et prénom strictement identiques.
    const uf = new UnionFind(idList.length);
    for (const group of groupBy(idList, (id) => id.nir).values())
      for (let a = 0; a < group.length; a++)
        for (let b = a + 1; b < group.length; b++)
          if (nirOnly || group[a].nameKey === group[b].nameKey || isPrefix(group[a].tokens, group[b].tokens)) uf.union(group[a].i, group[b].i);
    if (matchByName)
      for (const group of groupBy(idList, (id) => (id.tokens.length >= 2 ? id.nameKey : '')).values())
        for (let a = 1; a < group.length; a++) uf.union(group[0].i, group[a].i);

    const clusters = groupBy(idList, (id) => String(uf.find(id.i)));
    const patients = [];
    for (const members of clusters.values()) {
      let match = null; // 'nir' | 'nom'
      let review = null;
      for (const id of members) {
        // NIR de la colonne NIR, puis NIR éventuellement écrit à côté du nom du patient.
        const sameNir = [id.nir, ...id.alts].filter(Boolean).flatMap((n) => listByNir.get(n) || []);
        const verdicts = sameNir.map((p) => (nirOnly ? 'sur' : samePersonSameNir(id.tokens, p.tokens)));
        if (verdicts.includes('sur')) {
          match = 'nir';
          review = null;
          break;
        }
        if (verdicts.includes('probable')) {
          match = 'nir';
          review = {
            kind: 'nom-different',
            text: `Même NIR et même prénom que « ${sameNir[verdicts.indexOf('probable')].name} » dans la patientèle, nom différent.`,
          };
          continue;
        }
        if (match === 'nir') continue;
        // Sans NIR commun : même nom et prénom, ou nom + premier prénom de la patientèle
        // en tête du nom de la facture.
        let exact = id.tokens.length >= 2 ? listByName.get(id.nameKey) : null;
        if (!exact && id.tokens.length >= 2) {
          const same = (listByToken.get(id.tokens[0]) || []).filter((p) => isPrefix(p.tokens, id.tokens));
          if (same.length) exact = same;
        }
        if (exact && matchByName) {
          match = 'nom';
          review = {
            kind: 'nom-seul',
            text: `Rapproché par le nom uniquement — NIR facture ${id.nir || 'absent'}, NIR patientèle ${exact[0].nir13}.`,
          };
          continue;
        }
        if (match) continue;
        if (exact) {
          review = { kind: 'homonyme', text: `Même nom et prénom dans la patientèle, NIR différent (${exact[0].nir13}).` };
        } else if (sameNir.length) {
          review = review || {
            kind: 'meme-nir',
            text: `Même NIR que « ${sameNir[0].name} » dans la patientèle (ayant droit ou nom différent ?).`,
          };
        } else {
          const near = id.tokens
            .flatMap((t) => listByToken.get(t) || [])
            .find((p) => namesCompatible(id.tokens, p.tokens));
          if (near) review = review || { kind: 'nom-proche', text: `Nom proche de « ${near.name} » dans la patientèle (NIR ${near.nir13}).` };
        }
      }
      const main = members.reduce((a, b) => (b.invoices.length > a.invoices.length ? b : a));
      const all = members.flatMap((id) => id.invoices).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      patients.push({
        name: main.label || '(sans nom)',
        nir: main.nir || members.find((m) => m.nir)?.nir || '',
        invoices: all,
        inList: !!match,
        match,
        review,
      });
    }

    return { invoices: unique, duplicates, unidentified, patients, listSize: list.length };
  }

  const ym = (iso) => iso.slice(0, 7);

  function monthRange(from, to) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }

  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const round2 = (x) => Math.round(x * 100) / 100;

  /** Indicateurs pour la période [from, to] (dates ISO, bornes incluses). */
  function computeStats(model, from, to) {
    const inRange = (inv) => inv.date >= from && inv.date <= to;
    const rows = [];
    for (const p of model.patients) {
      const invs = p.invoices.filter(inRange);
      if (!invs.length) continue;
      rows.push({
        patient: p,
        invoices: invs,
        n: invs.length,
        first: invs[0].date,
        last: invs[invs.length - 1].date,
        montant: round2(sum(invs, (i) => i.montant)),
      });
    }
    const hors = rows.filter((r) => !r.patient.inList);
    const mt = rows.filter((r) => r.patient.inList);
    const group = (list) => ({
      patients: list.length,
      invoices: sum(list, (r) => r.n),
      montant: round2(sum(list, (r) => r.montant)),
    });

    const allInv = rows.flatMap((r) => r.invoices);
    const lo = allInv.length ? allInv.reduce((a, i) => (i.date < a ? i.date : a), allInv[0].date) : from;
    const hi = allInv.length ? allInv.reduce((a, i) => (i.date > a ? i.date : a), allInv[0].date) : to;
    const months = monthRange(lo, hi).map((k) => ({
      key: k,
      invMT: 0,
      invHors: 0,
      amtMT: 0,
      amtHors: 0,
      newHors: 0,
      patients: new Set(),
    }));
    const idx = new Map(months.map((m, i) => [m.key, i]));
    rows.forEach((r, ri) => {
      const isHors = !r.patient.inList;
      for (const inv of r.invoices) {
        const m = months[idx.get(ym(inv.date))];
        if (isHors) {
          m.invHors++;
          m.amtHors += inv.montant;
        } else {
          m.invMT++;
          m.amtMT += inv.montant;
        }
        m.patients.add(ri);
      }
      if (isHors) months[idx.get(ym(r.first))].newHors++;
    });
    for (const m of months) {
      m.amtMT = round2(m.amtMT);
      m.amtHors = round2(m.amtHors);
      m.patients = m.patients.size;
    }

    const years = [];
    for (const y of [...new Set(months.map((m) => m.key.slice(0, 4)))]) {
      const inYear = (inv) => inv.date.startsWith(y);
      const active = rows.filter((r) => r.invoices.some(inYear));
      const activeHors = active.filter((r) => !r.patient.inList);
      years.push({
        year: y,
        invoices: sum(active, (r) => r.invoices.filter(inYear).length),
        patients: active.length,
        mt: active.length - activeHors.length,
        hors: activeHors.length,
        newHors: activeHors.filter((r) => r.first.startsWith(y)).length,
        montant: round2(sum(active, (r) => sum(r.invoices.filter(inYear), (i) => i.montant))),
      });
    }

    const buckets = [
      { label: '1', min: 1, max: 1 },
      { label: '2', min: 2, max: 2 },
      { label: '3', min: 3, max: 3 },
      { label: '4', min: 4, max: 4 },
      { label: '5 à 9', min: 5, max: 9 },
      { label: '10 et +', min: 10, max: Infinity },
    ].map((b) => ({ label: b.label, count: hors.filter((r) => r.n >= b.min && r.n <= b.max).length }));

    const unidentified = model.unidentified.filter(inRange).length;
    return {
      from,
      to,
      all: group(rows),
      hors: group(hors),
      mt: group(mt),
      du: round2(sum(allInv, (i) => i.du)),
      paye: round2(sum(allInv, (i) => i.paye)),
      listSize: model.listSize,
      months,
      years,
      buckets,
      horsRows: hors.sort((a, b) => b.n - a.n || a.patient.name.localeCompare(b.patient.name, 'fr')),
      reviewRows: rows.filter((r) => r.patient.review),
      unidentified,
    };
  }

  FP.analyse = { nameTokens, namesCompatible, buildModel, computeStats };
})((globalThis.FP = globalThis.FP || {}));
