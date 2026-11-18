// Script classique (sans import/export) pour que la page fonctionne aussi ouverte
// directement depuis le disque, par double-clic sur index.html.
(function (FP) {
  'use strict';
  const pdfjs = globalThis.pdfjsLib;
  const { readAs, readTextAs } = FP.parse;
  const { buildModel, computeStats } = FP.analyse;
  const { h, columnChart, segmentedBar, legend, table } = FP.charts;
  // Interface : lecture des PDF dans le navigateur, puis affichage du tableau de bord.
  // Aucune donnée n'est envoyée ni conservée (pas de fetch, pas de stockage, pas de cookie).


  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', document.baseURI).href;

  const $ = (id) => document.getElementById(id);
  const DEFAULT_FROM = '2024-01-01'; // « depuis le 31/12/2023 »
  const ZONES = {
    factures: { one: 'facture', many: 'factures', none: 'Aucune facture reconnue dans ce fichier.', looksLike: 'une liste de patientèle' },
    patientele: { one: 'patient', many: 'patients', none: 'Aucun patient reconnu dans ce fichier.', looksLike: 'un journal de factures' },
  };

  const state = { files: [], model: null, from: '', to: '', presets: [], byName: true, nirOnly: false, codes: [], codesOff: new Set(), cleanups: [], showAll: false, search: '' };

  const nf = new Intl.NumberFormat('fr-FR');
  const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
  const frDate = (iso) => iso.split('-').reverse().join('/');
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const plural = (n, one, many) => `${nf.format(n)} ${n > 1 ? many : one}`;
  // NIR à la française : sexe, année, mois, département, commune, ordre.
  const fmtNir = (n) => (n ? `${n[0]} ${n.slice(1, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7, 10)} ${n.slice(10, 13)}` : '—');

  /* ---------- Lecture des fichiers ---------- */

  async function extractPages(file, onProgress) {
    const data = new Uint8Array(await file.arrayBuffer());
    // verbosity 0 : seul le texte nous intéresse, pas le rendu des polices.
    const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const pages = [];
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        onProgress(p, doc.numPages);
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .filter((it) => typeof it.str === 'string')
            .map((it) => ({
              str: it.str,
              x: it.transform[4],
              y: it.transform[5],
              w: it.width,
              h: it.height || Math.abs(it.transform[3]),
              hasEOL: it.hasEOL,
            }))
        );
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
    return pages;
  }

  function accept(entry, doc, hasText = true) {
    const z = ZONES[entry.zone];
    Object.assign(entry, { status: 'ok', count: doc.count, result: doc.result, structure: doc.structure });
    if (doc.count) return;
    entry.status = 'error';
    entry.message = !hasText
      ? 'Aucun texte dans ce PDF (document scanné ?).'
      : doc.otherCount
        ? `Ce fichier ressemble à ${z.looksLike}. Déposez-le dans l'autre zone.`
        : `${z.none} Voir « Un PDF est mal lu ? » ci-dessous.`;
  }

  async function addFiles(zone, fileList) {
    for (const file of [...fileList]) {
      const entry = { zone, name: file.name, status: 'reading', count: 0, pages: 0, result: null, structure: '', message: 'Lecture…' };
      state.files.push(entry);
      renderZones();
      try {
        const pages = await extractPages(file, (p, n) => {
          entry.message = `Lecture, page ${p} sur ${n}…`;
          renderZones();
        });
        entry.pages = pages.length;
        const chars = pages.reduce((s, pg) => s + pg.reduce((t, it) => t + it.str.length, 0), 0);
        accept(entry, readAs(zone, pages), chars >= 20);
      } catch (err) {
        entry.status = 'error';
        entry.message =
          err && err.name === 'PasswordException'
            ? 'PDF protégé par mot de passe.'
            : err && err.name === 'InvalidPDFException'
              ? "Ce fichier n'est pas un PDF lisible."
              : 'Lecture impossible : ' + (err && err.message ? err.message : err);
      }
      renderZones();
    }
    refresh(true);
  }

  function addPastedText(zone, text) {
    if (!text.trim()) return;
    const entry = { zone, name: 'Texte collé', status: 'ok', count: 0, pages: 0, result: null, structure: '', message: '' };
    accept(entry, readTextAs(zone, text));
    state.files.push(entry);
    renderZones();
    refresh(true);
  }

  function fileDetail(f) {
    if (f.status !== 'ok') return { text: f.message, warn: f.status === 'error' };
    const z = ZONES[f.zone];
    const parts = [plural(f.count, z.one, z.many)];
    if (f.pages) parts.push(plural(f.pages, 'page', 'pages'));
    const r = f.result;
    if (f.zone === 'patientele' && r.declaredTotal != null && r.declaredTotal !== f.count)
      return { text: `${parts.join(' · ')}. Le document en annonce ${nf.format(r.declaredTotal)} : lecture incomplète.`, warn: true };
    if (f.zone === 'factures' && r.quality < 0.9)
      return { text: `${parts.join(' · ')}. Lecture incertaine : les NIR varient d'une facture à l'autre pour un même patient.`, warn: true };
    if (r.suspicious.length) return { text: `${parts.join(' · ')}. ${plural(r.suspicious.length, 'passage non reconnu', 'passages non reconnus')}.`, warn: true };
    return { text: parts.join(' · '), warn: false };
  }

  function renderZones() {
    for (const zone of Object.keys(ZONES)) {
      const mine = state.files.filter((f) => f.zone === zone);
      $('files-' + zone).replaceChildren(
        ...mine.map((f) => {
          const d = fileDetail(f);
          const remove = h('button', { type: 'button', class: 'quiet', 'aria-label': `Retirer ${f.name}`, text: 'Retirer' });
          remove.addEventListener('click', () => {
            state.files.splice(state.files.indexOf(f), 1);
            renderZones();
            refresh(true);
          });
          return h('li', { class: 'file' }, [
            h('span', { class: 'file-name', text: f.name }),
            h('span', { class: d.warn ? 'file-detail warn' : 'file-detail', text: d.text }),
            f.status === 'reading' ? null : remove,
          ]);
        })
      );
      $('zone-' + zone).querySelector('.pick span').textContent = mine.length ? 'Ajouter un fichier' : 'Déposer ou choisir un fichier';
    }
    $('resetBtn').hidden = !state.files.length;
    renderHelp();
  }

  function renderHelp() {
    const text = h('textarea', { id: 'pasteText', rows: '5', spellcheck: 'false', 'aria-label': 'Texte copié depuis le PDF' });
    const btn = (zone, label) => {
      const b = h('button', { type: 'button', text: label });
      b.addEventListener('click', () => addPastedText(zone, text.value));
      return b;
    };
    const blocks = [
      h('h3', { text: 'Coller le texte du PDF' }),
      h('p', { text: 'Ouvrir le PDF, tout sélectionner (Ctrl + A), copier (Ctrl + C), puis coller ici.' }),
      text,
      h('div', { class: 'row' }, [btn('factures', 'Ajouter comme factures'), btn('patientele', 'Ajouter comme patientèle')]),
    ];
    const read = state.files.filter((f) => f.structure);
    if (read.length) {
      blocks.push(
        h('h3', { text: 'Structure du texte lu, sans les données' }),
        h('p', {
          text: 'Chaque lettre est remplacée par A et chaque chiffre par 9 : ce bloc ne contient ni nom, ni NIR, ni montant. Il peut être transmis tel quel pour faire corriger la lecture.',
        })
      );
      for (const f of read) {
        const pre = h('pre', { tabindex: '0', text: f.structure });
        const copy = h('button', { type: 'button', text: 'Copier' });
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(`${f.zone} — ${plural(f.count, 'ligne lue', 'lignes lues')}\n${f.structure}`);
            copy.textContent = 'Copié';
          } catch {
            getSelection().selectAllChildren(pre);
          }
        });
        blocks.push(h('div', { class: 'head' }, [h('strong', { text: `${f.name} (${f.zone === 'factures' ? 'factures' : 'patientèle'})` }), copy]), pre);
        if (f.result && f.result.suspicious.length)
          blocks.push(
            h('p', { class: 'warn', text: `${plural(f.result.suspicious.length, 'passage non reconnu', 'passages non reconnus')} (données réelles, affichées uniquement ici) :` }),
            h('pre', { text: f.result.suspicious.slice(0, 30).map((t) => (t.length > 300 ? t.slice(0, 300) + '…' : t)).join('\n') })
          );
      }
    }
    const keep = $('pasteText') ? $('pasteText').value : '';
    $('helpBody').replaceChildren(...blocks);
    text.value = keep;
  }

  /* ---------- Analyse ---------- */

  function refresh(resetPeriod) {
    const ok = (zone) => state.files.filter((f) => f.zone === zone && f.status === 'ok').flatMap((f) => f.result.records);
    const lines = ok('factures');
    // Types de ligne du journal (FV…), du plus fréquent au moins fréquent.
    const counts = new Map();
    for (const l of lines) counts.set(l.code, (counts.get(l.code) || 0) + 1);
    state.codes = [...counts].sort((a, b) => b[1] - a[1]);
    for (const c of [...state.codesOff]) if (!counts.has(c)) state.codesOff.delete(c);
    const invoices = lines.filter((l) => !state.codesOff.has(l.code));
    const patientele = ok('patientele');
    const busy = state.files.some((f) => f.status === 'reading');

    if (!invoices.length || !patientele.length) {
      state.model = null;
      $('dash').hidden = true;
      $('status').textContent = busy || (!invoices.length && !patientele.length)
        ? ''
        : !invoices.length
          ? 'Ajoutez le journal des factures pour calculer le flux.'
          : 'Ajoutez la liste de patientèle pour calculer le flux.';
      return;
    }
    $('status').textContent = '';
    state.model = buildModel(invoices, patientele, { matchByName: state.byName, nirOnly: state.nirOnly });

    if (resetPeriod) {
      const dates = state.model.invoices.map((i) => i.date).sort();
      const min = dates[0];
      const max = dates[dates.length - 1];
      state.from = max >= DEFAULT_FROM ? DEFAULT_FROM : min;
      state.to = max;
      const years = [...new Set(dates.map((d) => d.slice(0, 4)))].filter((y) => y + '-12-31' >= state.from);
      state.presets = [{ label: max >= DEFAULT_FROM ? 'Depuis 2024' : 'Tout', from: state.from, to: max }].concat(
        years.length > 1 ? years.map((y) => ({ label: y, from: y + '-01-01', to: y + '-12-31' > max ? max : y + '-12-31' })) : []
      );
    }
    $('dash').hidden = false;
    render();
  }

  /* ---------- Tableau de bord ---------- */

  function chartFigure(title, subtitle, series, labels, format, tableFormat, ariaLabel) {
    const holder = h('div', { class: 'chart-holder' });
    const columns = [{ label: labels.head }].concat(series.map((s) => ({ label: s.name, num: true })));
    const rows = labels.items.map((l, i) => [l.long].concat(series.map((s) => tableFormat(s.values[i]))));
    const el = h('figure', {}, [
      h('figcaption', {}, [h('h3', { text: title }), h('p', { text: subtitle })]),
      series.length > 1 ? legend(series) : null,
      holder,
      h('details', { class: 'data' }, [h('summary', { text: 'Voir les données' }), h('div', { class: 'scroll' }, table(columns, rows))]),
    ]);
    return { el, mount: () => state.cleanups.push(columnChart(holder, { labels: labels.items, series, format, ariaLabel })) };
  }

  function periodBar() {
    const input = (id, label, value, key) => {
      const el = h('input', { type: 'date', id, value });
      el.addEventListener('change', () => {
        state[key] = el.value;
        render();
      });
      return h('label', {}, [label, el]);
    };
    const presets = state.presets.map((p) => {
      const b = h('button', { type: 'button', class: 'preset', text: p.label, 'aria-pressed': String(p.from === state.from && p.to === state.to) });
      b.addEventListener('click', () => {
        state.from = p.from;
        state.to = p.to;
        render();
      });
      return b;
    });
    const codes =
      state.codes.length > 1
        ? h('div', { class: 'codes', role: 'group', 'aria-label': 'Types de ligne comptés' }, [
            h('span', { text: 'Lignes comptées' }),
            ...state.codes.slice(0, 8).map(([code, n], i) => {
              const box = h('input', { type: 'checkbox', id: 'code-' + i });
              box.checked = !state.codesOff.has(code);
              box.addEventListener('change', () => {
                if (box.checked) state.codesOff.delete(code);
                else if (state.codes.filter(([c]) => !state.codesOff.has(c)).length > 1) state.codesOff.add(code);
                refresh(false);
              });
              return h('label', {}, [box, `${code || 'sans code'} (${nf.format(n)})`]);
            }),
          ])
        : null;
    return h('div', { class: 'period no-print' }, [
      input('from', 'Du', state.from, 'from'),
      input('to', 'au', state.to, 'to'),
      h('div', { class: 'presets', role: 'group', 'aria-label': 'Périodes' }, presets),
      codes,
    ]);
  }

  function render() {
    const model = state.model;
    if (!model) return;
    state.cleanups.forEach((f) => f());
    state.cleanups = [];
    const { from, to } = state;
    const dash = $('dash');
    const focusId = document.activeElement && dash.contains(document.activeElement) ? document.activeElement.id : '';
    const bar = periodBar();
    const done = (...nodes) => {
      dash.replaceChildren(bar, ...nodes.filter(Boolean));
      const el = focusId && $(focusId);
      if (el) el.focus();
      if (el && el.type === 'search') el.setSelectionRange(el.value.length, el.value.length);
    };
    if (!from || !to || from > to) return done(h('p', { class: 'status', text: 'Choisissez une date de début antérieure à la date de fin.' }));
    const s = computeStats(model, from, to);
    const period = `du ${frDate(from)} au ${frDate(to)}`;
    if (!s.all.invoices) return done(h('p', { class: 'status', text: `Aucune facture ${period}.` }));

    /* Chiffre principal */
    const split = h('div');
    segmentedBar(
      split,
      [
        { name: 'hors patientèle', value: s.hors.patients, cls: 's-hors' },
        { name: 'patientèle médecin traitant', value: s.mt.patients, cls: 's-mt' },
      ],
      (v) => nf.format(v)
    );
    const unread = state.files.filter((f) => f.zone === 'factures' && f.status === 'ok').reduce((n, f) => n + f.result.suspicious.length, 0);
    const hero = h('section', { class: 'hero' }, [
      unread
        ? h('p', {
            class: 'alert',
            role: 'alert',
            text: `${plural(unread, 'passage du journal des factures n’a pas été reconnu', 'passages du journal des factures n’ont pas été reconnus')} : le résultat peut être incomplet. Détail dans « Un PDF est mal lu ? ».`,
          })
        : null,
      h('div', { class: 'hero-value', text: nf.format(s.hors.patients) }),
      h('h2', { text: s.hors.patients > 1 ? 'patients hors patientèle' : 'patient hors patientèle' }),
      h('p', { text: `Patients distincts facturés ${period}, absents de la liste médecin traitant. Un patient revenu plusieurs fois compte une fois.` }),
      split,
    ]);

    const stat = (label, value, sub) => h('div', {}, [h('dt', { text: label }), h('dd', { class: 'v', text: value }), h('dd', { class: 's', text: sub })]);
    const stats = h('dl', { class: 'stats' }, [
      stat('Factures', nf.format(s.all.invoices), `dont ${nf.format(s.hors.invoices)} hors patientèle`),
      stat('Patients facturés', nf.format(s.all.patients), `${(s.all.invoices / s.all.patients).toFixed(1).replace('.', ',')} factures par patient`),
      stat('Patientèle vue', `${pct(s.mt.patients, s.listSize)} %`, `${nf.format(s.mt.patients)} sur ${nf.format(s.listSize)} inscrits`),
      stat('Montant facturé', eur0.format(s.all.montant), `dont ${eur0.format(s.hors.montant)} hors patientèle`),
    ]);

    /* Graphiques */
    const monthLabels = {
      head: 'Mois',
      items: s.months.map((m) => {
        const [y, mo] = m.key.split('-').map(Number);
        return { short: mo === 1 ? String(y) : MONTHS[mo - 1], long: `${MONTHS_LONG[mo - 1]} ${y}`, major: mo === 1 };
      }),
    };
    const axisInt = (v, axis) => (axis && v >= 10000 ? compact.format(v) : nf.format(v));
    const axisEur = (v, axis) => (axis ? (v >= 10000 ? compact.format(v) : nf.format(v)) + ' €' : eur0.format(v));
    const HORS = 'Hors patientèle';
    const MT = 'Patientèle';
    const charts = [
      chartFigure(
        'Factures par mois',
        'Selon que le patient figure ou non dans la patientèle.',
        [
          { name: HORS, cls: 's-hors', values: s.months.map((m) => m.invHors) },
          { name: MT, cls: 's-mt', values: s.months.map((m) => m.invMT) },
        ],
        monthLabels,
        axisInt,
        (v) => nf.format(v),
        'Factures par mois, hors patientèle et patientèle.'
      ),
      chartFigure(
        'Nouveaux patients hors patientèle',
        'Chaque patient compte le mois de sa première facture sur la période.',
        [{ name: 'Nouveaux patients hors patientèle', cls: 's-hors', values: s.months.map((m) => m.newHors) }],
        monthLabels,
        axisInt,
        (v) => nf.format(v),
        'Nouveaux patients hors patientèle par mois.'
      ),
      chartFigure(
        'Montant facturé par mois',
        'Colonne « Montant » du journal.',
        [
          { name: HORS, cls: 's-hors', values: s.months.map((m) => m.amtHors) },
          { name: MT, cls: 's-mt', values: s.months.map((m) => m.amtMT) },
        ],
        monthLabels,
        axisEur,
        (v) => eur2.format(v),
        'Montant facturé par mois, hors patientèle et patientèle.'
      ),
      chartFigure(
        'Fidélité hors patientèle',
        'Patients hors patientèle selon leur nombre de factures sur la période.',
        [{ name: 'Patients hors patientèle', cls: 's-hors', values: s.buckets.map((b) => b.count) }],
        {
          head: 'Nombre de factures',
          items: s.buckets.map((b) => ({ short: b.label, long: `${b.label} facture${b.label === '1' ? '' : 's'}`, major: true })),
        },
        axisInt,
        (v) => nf.format(v),
        'Patients hors patientèle selon leur nombre de factures.'
      ),
    ];
    const chartGrid = h('section', { class: 'charts' }, charts.map((c) => c.el));

    /* Par année */
    const years = h('section', {}, [
      h('h2', { text: 'Par année' }),
      h('p', { class: 'note', text: 'Un patient vu plusieurs années compte dans chacune. Nouveaux : première facture de la période cette année-là.' }),
      h(
        'div',
        { class: 'scroll' },
        table(
          [
            { label: 'Année' },
            { label: 'Factures', num: true },
            { label: 'Patients', num: true },
            { label: 'Patientèle', num: true },
            { label: 'Hors patientèle', num: true },
            { label: 'Nouveaux hors patientèle', num: true },
            { label: 'Montant', num: true },
          ],
          s.years
            .map((y) => [y.year, nf.format(y.invoices), nf.format(y.patients), nf.format(y.mt), nf.format(y.hors), nf.format(y.newHors), eur0.format(y.montant)])
            .concat([['Période', nf.format(s.all.invoices), nf.format(s.all.patients), nf.format(s.mt.patients), nf.format(s.hors.patients), nf.format(s.hors.patients), eur0.format(s.all.montant)]]),
          { cls: 'total-last' }
        )
      ),
    ]);

    /* Liste des patients hors patientèle */
    const q = state.search.trim().toUpperCase();
    const qDigits = q.replace(/\s/g, '');
    const filtered = q ? s.horsRows.filter((r) => r.patient.name.toUpperCase().includes(q) || (qDigits && r.patient.nir.includes(qDigits))) : s.horsRows;
    const shown = state.showAll || q ? filtered : filtered.slice(0, 25);
    const search = h('input', { type: 'search', id: 'search', placeholder: 'Nom ou NIR', 'aria-label': 'Rechercher un patient', value: state.search });
    search.addEventListener('input', () => {
      state.search = search.value;
      render();
    });
    const csvBtn = h('button', { type: 'button', text: 'Exporter en CSV' });
    csvBtn.addEventListener('click', () => exportCsv(s));
    const more = filtered.length > shown.length ? h('button', { type: 'button', class: 'quiet', id: 'more', text: `Afficher les ${nf.format(filtered.length)} patients` }) : null;
    if (more)
      more.addEventListener('click', () => {
        state.showAll = true;
        render();
      });
    const list = h('section', {}, [
      h('div', { class: 'head' }, [h('h2', { text: 'Patients hors patientèle' }), h('div', { class: 'row no-print' }, [search, csvBtn])]),
      h(
        'div',
        { class: 'scroll' },
        table(
          [{ label: 'Patient' }, { label: 'NIR' }, { label: 'Factures', num: true }, { label: 'Première' }, { label: 'Dernière' }, { label: 'Montant', num: true }],
          shown.map((r) => [r.patient.name, fmtNir(r.patient.nir), nf.format(r.n), frDate(r.first), frDate(r.last), eur2.format(r.montant)])
        )
      ),
      more ? h('div', {}, more) : null,
    ]);

    /* Rapprochements */
    const nirOnly = h('input', { type: 'checkbox', id: 'nirOnly' });
    nirOnly.checked = state.nirOnly;
    nirOnly.addEventListener('change', () => {
      state.nirOnly = nirOnly.checked;
      refresh(false);
    });
    const byName = h('input', { type: 'checkbox', id: 'byName' });
    byName.checked = state.byName;
    byName.addEventListener('change', () => {
      state.byName = byName.checked;
      refresh(false);
    });
    const notes = [];
    if (model.duplicates) notes.push(`${plural(model.duplicates, 'facture en double ignorée', 'factures en double ignorées')} (même date, même numéro, même patient).`);
    if (s.unidentified) notes.push(`${plural(s.unidentified, 'facture', 'factures')} sans nom ni NIR sur la période, non comptée(s) parmi les patients.`);
    const review = h('details', { class: 'fold', id: 'review' }, [
      h('summary', { text: `Rapprochements à vérifier (${nf.format(s.reviewRows.length)})` }),
      h('div', {}, [
        h('p', {
          class: 'note',
          text: 'Un patient est rattaché à la patientèle quand son NIR (13 premiers chiffres) y figure sous un nom compatible. Les cas ci-dessous ne concordent pas parfaitement.',
        }),
        h('label', { class: 'check' }, [byName, h('span', { text: 'Rattacher aussi par nom et prénom identiques quand le NIR diffère ou manque.' })]),
        h('label', { class: 'check' }, [nirOnly, h('span', { text: 'Se fier au NIR seul : un même NIR désigne toujours la même personne, quel que soit le nom. À ne cocher que si aucun NIR ne couvre plusieurs membres d’une famille.' })]),
        ...notes.map((t) => h('p', { class: 'note', text: t })),
        s.reviewRows.length
          ? h(
              'div',
              { class: 'scroll' },
              table(
                [{ label: 'Patient (facture)' }, { label: 'NIR' }, { label: 'Classé' }, { label: 'Remarque' }],
                s.reviewRows.map((r) => [r.patient.name, fmtNir(r.patient.nir), r.patient.inList ? 'Patientèle' : 'Hors patientèle', r.patient.review.text]),
                { cls: 'wrap-last' }
              )
            )
          : null,
      ]),
    ]);
    review.open = state.reviewOpen || false;
    review.addEventListener('toggle', () => (state.reviewOpen = review.open));

    done(hero, stats, chartGrid, years, list, review);
    charts.forEach((c) => c.mount());
  }

  function exportCsv(s) {
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [['Patient', 'NIR', 'Factures', 'Première facture', 'Dernière facture', 'Montant', 'Remarque']];
    for (const r of s.horsRows)
      lines.push([r.patient.name, r.patient.nir, r.n, frDate(r.first), frDate(r.last), r.montant.toFixed(2).replace('.', ','), r.patient.review ? r.patient.review.text : '']);
    const csv = '﻿' + lines.map((l) => l.map(esc).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: `patients-hors-patientele_${s.from}_${s.to}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- Événements ---------- */

  for (const zone of Object.keys(ZONES)) {
    const box = $('zone-' + zone);
    const input = $('file-' + zone);
    input.addEventListener('change', () => {
      addFiles(zone, input.files);
      input.value = '';
    });
    for (const ev of ['dragenter', 'dragover'])
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.add('over');
      });
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget)) box.classList.remove('over');
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('over');
      addFiles(zone, e.dataTransfer.files);
    });
  }
  // Un PDF lâché à côté d'une zone ne doit pas s'ouvrir dans l'onglet.
  for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());
  $('resetBtn').addEventListener('click', () => location.reload());
  renderZones();

  FP.ready = true;
})((globalThis.FP = globalThis.FP || {}));
