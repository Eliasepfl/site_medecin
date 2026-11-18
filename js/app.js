// Interface : lecture des PDF dans le navigateur, puis affichage du tableau de bord.
// Aucune donnée n'est envoyée ni conservée (pas de fetch, pas de stockage, pas de cookie).

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { readDocument, readText } from './parse.js';
import { buildModel, computeStats } from './analyse.js';
import { h, columnChart, segmentedBar, legend, table } from './charts.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const DEFAULT_FROM = '2024-01-01'; // « depuis le 31/12/2023 »

const state = { files: [], model: null, cleanups: [], showAll: false, search: '' };

const nf = new Intl.NumberFormat('fr-FR');
const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const frDate = (iso) => iso.split('-').reverse().join('/');
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, one, many) => `${nf.format(n)} ${n > 1 ? many : one}`;

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

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  for (const file of files) {
    const entry = { name: file.name, type: 'lecture', count: 0, pages: 0, result: null, text: '', error: '' };
    state.files.push(entry);
    renderFiles();
    try {
      const pages = await extractPages(file, (p, n) => {
        $('status').textContent = `Lecture de ${file.name} — page ${p} sur ${n}…`;
      });
      entry.pages = pages.length;
      const chars = pages.reduce((s, pg) => s + pg.reduce((t, it) => t + it.str.length, 0), 0);
      const doc = readDocument(pages);
      Object.assign(entry, { type: doc.type, count: doc.count, result: doc.result, text: doc.text });
      if (doc.type === 'inconnu')
        entry.error = chars < 20
          ? 'Aucun texte dans ce PDF (document scanné ?).'
          : "Format non reconnu : ni journal de factures, ni liste de patientèle.";
    } catch (err) {
      entry.type = 'inconnu';
      entry.error = err && err.name === 'PasswordException' ? 'PDF protégé par mot de passe.' : 'Lecture impossible : ' + (err && err.message ? err.message : err);
    }
    renderFiles();
  }
  $('status').textContent = '';
  refresh(true);
}

function addPastedText() {
  const text = $('pasteText').value;
  if (!text.trim()) return;
  const doc = readText(text);
  state.files.push({
    name: 'Texte collé',
    type: doc.type,
    count: doc.count,
    pages: 0,
    result: doc.result,
    text: doc.text,
    error: doc.type === 'inconnu' ? 'Format non reconnu.' : '',
  });
  $('pasteText').value = '';
  renderFiles();
  refresh(true);
}

function renderFiles() {
  const typeLabel = { factures: 'Factures', patientele: 'Patientèle', inconnu: 'Non reconnu', lecture: 'Lecture…' };
  $('files').replaceChildren(
    ...state.files.map((f, i) => {
      let detail = '';
      if (f.type === 'factures') detail = plural(f.count, 'ligne de facture', 'lignes de facture');
      if (f.type === 'patientele') {
        detail = plural(f.count, 'patient', 'patients');
        const d = f.result.declaredTotal;
        if (d != null) detail += d === f.count ? ' (conforme au total annoncé)' : ` — le document en annonce ${nf.format(d)}`;
      }
      if (f.pages) detail += ` · ${plural(f.pages, 'page', 'pages')}`;
      const remove = h('button', { type: 'button', class: 'link', 'aria-label': `Retirer ${f.name}`, text: 'Retirer' });
      remove.addEventListener('click', () => {
        state.files.splice(i, 1);
        renderFiles();
        refresh(true);
      });
      const warn = f.type === 'patientele' && f.result.declaredTotal != null && f.result.declaredTotal !== f.count;
      return h('li', { class: f.error || warn ? 'file warn' : 'file' }, [
        h('span', { class: 'badge ' + f.type, text: typeLabel[f.type] }),
        h('span', { class: 'file-name', text: f.name }),
        h('span', { class: 'file-detail', text: f.error || detail }),
        f.type === 'lecture' ? null : remove,
      ]);
    })
  );
}

/* ---------- Analyse ---------- */

function refresh(resetPeriod) {
  const invoices = state.files.filter((f) => f.type === 'factures').flatMap((f) => f.result.records);
  const patientele = state.files.filter((f) => f.type === 'patientele').flatMap((f) => f.result.records);
  const busy = state.files.some((f) => f.type === 'lecture');
  const ready = invoices.length > 0 && patientele.length > 0;

  if (!ready) {
    state.model = null;
    $('filters').hidden = true;
    $('dash').hidden = true;
    if (!busy && state.files.length) {
      $('status').textContent = !invoices.length && !patientele.length
        ? 'Aucun document exploitable pour le moment.'
        : !invoices.length
          ? 'Il manque le journal des factures.'
          : 'Il manque la liste de patientèle médecin traitant.';
    } else if (!state.files.length) $('status').textContent = '';
    return;
  }
  $('status').textContent = '';
  state.model = buildModel(invoices, patientele, { matchByName: $('byName').checked });

  if (resetPeriod) {
    const dates = state.model.invoices.map((i) => i.date).sort();
    const max = dates[dates.length - 1];
    const min = dates[0];
    $('from').value = max >= DEFAULT_FROM ? DEFAULT_FROM : min;
    $('to').value = max;
    const years = [...new Set(dates.map((d) => d.slice(0, 4)))].filter((y) => y + '-12-31' >= DEFAULT_FROM);
    const presets = [{ label: 'Depuis le 01/01/2024', from: $('from').value, to: max }].concat(
      years.length > 1 ? years.map((y) => ({ label: y, from: y + '-01-01', to: y + '-12-31' > max ? max : y + '-12-31' })) : []
    );
    if (max < DEFAULT_FROM) presets[0].label = 'Toute la période';
    $('presets').replaceChildren(
      ...presets.map((p) => {
        const b = h('button', { type: 'button', class: 'preset', text: p.label });
        b.dataset.from = p.from;
        b.dataset.to = p.to;
        b.addEventListener('click', () => {
          $('from').value = p.from;
          $('to').value = p.to;
          render();
        });
        return b;
      })
    );
  }
  $('filters').hidden = false;
  $('dash').hidden = false;
  render();
}

/* ---------- Tableau de bord ---------- */

function card(title, subtitle, children, cls = '') {
  return h('section', { class: 'card ' + cls }, [
    h('h3', { text: title }),
    subtitle ? h('p', { class: 'hint', text: subtitle }) : null,
    ...[].concat(children),
  ]);
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, [
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value', text: value }),
    sub ? h('div', { class: 'tile-sub', text: sub }) : null,
  ]);
}

function dataDetails(columns, rows) {
  return h('details', { class: 'data' }, [h('summary', { text: 'Voir les données' }), h('div', { class: 'scroll' }, table(columns, rows))]);
}

function chartCard(title, subtitle, series, labels, format, tableFormat, ariaLabel) {
  const holder = h('div', { class: 'chart-holder' });
  const columns = [{ label: labels.head }].concat(series.map((s) => ({ label: s.name, num: true })));
  const rows = labels.items.map((l, i) => [l.long].concat(series.map((s) => tableFormat(s.values[i]))));
  const el = card(title, subtitle, [series.length > 1 ? legend(series) : null, holder, dataDetails(columns, rows)]);
  return { el, mount: () => state.cleanups.push(columnChart(holder, { labels: labels.items, series, format, ariaLabel })) };
}

function render() {
  const model = state.model;
  if (!model) return;
  state.cleanups.forEach((f) => f());
  state.cleanups = [];
  const from = $('from').value;
  const to = $('to').value;
  for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.from === from && b.dataset.to === to));
  const dash = $('dash');
  if (!from || !to || from > to) {
    dash.replaceChildren(h('p', { class: 'status', text: 'Choisir une période valide (date de début avant la date de fin).' }));
    return;
  }
  const s = computeStats(model, from, to);
  const period = `du ${frDate(from)} au ${frDate(to)}`;
  if (!s.all.invoices) {
    dash.replaceChildren(h('p', { class: 'status', text: `Aucune facture ${period}.` }));
    return;
  }

  /* Chiffre principal + indicateurs */
  const hero = h('section', { class: 'card hero' }, [
    h('div', { class: 'hero-label', text: 'Flux de patients hors patientèle' }),
    h('div', { class: 'hero-value', text: nf.format(s.hors.patients) }),
    h('p', {
      class: 'hero-sub',
      text: `${s.hors.patients > 1 ? 'patients distincts facturés' : 'patient distinct facturé'} ${period}, absents de la patientèle médecin traitant. Un patient revenu plusieurs fois ne compte qu'une fois.`,
    }),
  ]);
  const tiles = h('div', { class: 'tiles' }, [
    tile('Factures sur la période', nf.format(s.all.invoices), `dont ${nf.format(s.hors.invoices)} hors patientèle (${pct(s.hors.invoices, s.all.invoices)} %)`),
    tile('Patients distincts facturés', nf.format(s.all.patients), `${(s.all.invoices / s.all.patients).toFixed(1).replace('.', ',')} factures par patient en moyenne`),
    tile('Patientèle médecin traitant vue', nf.format(s.mt.patients), `sur ${nf.format(s.listSize)} patients dans la liste (${pct(s.mt.patients, s.listSize)} %)`),
    tile('Montant facturé', eur0.format(s.all.montant), `dont ${eur0.format(s.hors.montant)} hors patientèle (${pct(s.hors.montant, s.all.montant)} %)`),
  ]);

  const splitHolder = h('div');
  segmentedBar(
    splitHolder,
    [
      { name: 'Patientèle médecin traitant', value: s.mt.patients, cls: 's-mt' },
      { name: 'Hors patientèle', value: s.hors.patients, cls: 's-hors' },
    ],
    (v) => plural(v, 'patient', 'patients')
  );
  const split = card('Répartition des patients facturés', `Patients distincts ${period}.`, splitHolder);

  /* Graphiques */
  const monthLabels = {
    head: 'Mois',
    items: s.months.map((m) => {
      const [y, mo] = m.key.split('-').map(Number);
      return { short: mo === 1 ? String(y) : MONTHS[mo - 1], long: `${MONTHS_LONG[mo - 1]} ${y}`, major: mo === 1 };
    }),
  };
  const axisInt = (v, axis) => (axis && v >= 10000 ? compact.format(v) : nf.format(Math.round(v * 10) / 10));
  const axisEur = (v, axis) => (axis ? (v >= 10000 ? compact.format(v) + ' €' : nf.format(v) + ' €') : eur0.format(v));
  const MT = 'Patientèle médecin traitant';
  const HORS = 'Hors patientèle';

  const charts = [
    chartCard(
      'Factures par mois',
      'Nombre de factures, selon que le patient figure ou non dans la patientèle.',
      [
        { name: MT, cls: 's-mt', values: s.months.map((m) => m.invMT) },
        { name: HORS, cls: 's-hors', values: s.months.map((m) => m.invHors) },
      ],
      monthLabels,
      axisInt,
      (v) => nf.format(v),
      'Factures par mois, patientèle et hors patientèle.'
    ),
    chartCard(
      'Nouveaux patients hors patientèle par mois',
      'Chaque patient hors patientèle est compté une seule fois, le mois de sa première facture sur la période.',
      [{ name: 'Nouveaux patients hors patientèle', cls: 's-hors', values: s.months.map((m) => m.newHors) }],
      monthLabels,
      axisInt,
      (v) => nf.format(v),
      'Nouveaux patients hors patientèle par mois.'
    ),
    chartCard(
      'Montant facturé par mois',
      'Colonne « Montant » des factures.',
      [
        { name: MT, cls: 's-mt', values: s.months.map((m) => m.amtMT) },
        { name: HORS, cls: 's-hors', values: s.months.map((m) => m.amtHors) },
      ],
      monthLabels,
      axisEur,
      (v) => eur2.format(v),
      'Montant facturé par mois, patientèle et hors patientèle.'
    ),
    chartCard(
      'Fréquence des patients hors patientèle',
      'Nombre de patients hors patientèle selon leur nombre de factures sur la période.',
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
  const grid = h('div', { class: 'grid' }, charts.map((c) => c.el));

  /* Par année */
  const years = card(
    'Par année',
    'Un patient vu sur plusieurs années est compté dans chacune ; « nouveaux » = première facture de la période cette année-là.',
    h(
      'div',
      { class: 'scroll' },
      table(
        [
          { label: 'Année' },
          { label: 'Factures', num: true },
          { label: 'Patients distincts', num: true },
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
    )
  );

  /* Liste des patients hors patientèle */
  const q = state.search.trim().toUpperCase();
  const filtered = q ? s.horsRows.filter((r) => r.patient.name.toUpperCase().includes(q) || r.patient.nir.includes(q)) : s.horsRows;
  const shown = state.showAll ? filtered : filtered.slice(0, 50);
  const search = h('input', { type: 'search', id: 'search', placeholder: 'Rechercher un nom ou un NIR', 'aria-label': 'Rechercher un patient', value: state.search });
  search.addEventListener('input', () => {
    state.search = search.value;
    render();
    const again = $('search');
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
  const csvBtn = h('button', { type: 'button', text: 'Exporter en CSV' });
  csvBtn.addEventListener('click', () => exportCsv(s));
  const more = filtered.length > shown.length ? h('button', { type: 'button', class: 'link', text: `Afficher les ${nf.format(filtered.length)} patients` }) : null;
  if (more)
    more.addEventListener('click', () => {
      state.showAll = true;
      render();
    });
  const list = card('Patients hors patientèle', `${plural(s.hors.patients, 'patient', 'patients')} ${period}, du plus fréquent au moins fréquent.`, [
    h('div', { class: 'toolbar no-print' }, [search, csvBtn]),
    h(
      'div',
      { class: 'scroll' },
      table(
        [{ label: 'Patient' }, { label: 'NIR' }, { label: 'Factures', num: true }, { label: 'Première' }, { label: 'Dernière' }, { label: 'Montant', num: true }],
        shown.map((r) => [r.patient.name, r.patient.nir || '—', nf.format(r.n), frDate(r.first), frDate(r.last), eur2.format(r.montant)])
      )
    ),
    more,
  ]);

  /* Cas à vérifier + contrôle de lecture */
  const review = h('details', { class: 'card fold' }, [
    h('summary', { text: `Rapprochements à vérifier (${nf.format(s.reviewRows.length)})` }),
    h('p', { class: 'hint', text: 'Cas où le NIR et le nom ne concordent pas parfaitement entre les factures et la liste de patientèle.' }),
    s.reviewRows.length
      ? h(
          'div',
          { class: 'scroll' },
          table(
            [{ label: 'Patient (facture)' }, { label: 'NIR' }, { label: 'Classé' }, { label: 'Remarque' }],
            s.reviewRows.map((r) => [r.patient.name, r.patient.nir || '—', r.patient.inList ? 'Patientèle' : 'Hors patientèle', r.patient.review.text]),
            { cls: 'wrap-last' }
          )
        )
      : h('p', { text: 'Rien à signaler.' }),
  ]);

  const notes = [];
  if (model.duplicates) notes.push(`${plural(model.duplicates, 'facture en double ignorée', 'factures en double ignorées')} (même date, même numéro, même patient).`);
  if (s.unidentified) notes.push(`${plural(s.unidentified, 'facture', 'factures')} sans nom ni NIR sur la période : non comptée(s) parmi les patients.`);
  const fileNotes = state.files
    .filter((f) => f.result)
    .map((f) => {
      const bad = f.result.suspicious;
      return h('div', { class: 'diag-file' }, [
        h('h4', { text: `${f.name} — ${f.type === 'factures' ? plural(f.count, 'ligne lue', 'lignes lues') : plural(f.count, 'patient lu', 'patients lus')}` }),
        bad.length
          ? h('p', { class: 'warn-text', text: `${plural(bad.length, 'passage non reconnu', 'passages non reconnus')} (en-têtes, totaux… ou lignes manquées) :` })
          : h('p', { text: 'Toutes les lignes ont été reconnues.' }),
        bad.length ? h('pre', { text: bad.slice(0, 30).map((t) => (t.length > 300 ? t.slice(0, 300) + '…' : t)).join('\n') }) : null,
        h('details', {}, [h('summary', { text: 'Début du texte lu' }), h('pre', { text: f.text.split('\n').slice(0, 25).join('\n') })]),
      ]);
    });
  const totalBad = state.files.reduce((n, f) => n + (f.result ? f.result.suspicious.length : 0), 0);
  const diag = h('details', { class: 'card fold no-print' }, [
    h('summary', { text: `Contrôle de la lecture des PDF${totalBad ? ` (${nf.format(totalBad)} passage${totalBad > 1 ? 's' : ''} à regarder)` : ''}` }),
    ...notes.map((t) => h('p', { text: t })),
    ...fileNotes,
  ]);

  const invBad = state.files.filter((f) => f.type === 'factures').reduce((n, f) => n + f.result.suspicious.length, 0);
  const alert = invBad
    ? h('p', {
        class: 'alert',
        role: 'alert',
        text: `Attention : ${plural(invBad, 'passage', 'passages')} du journal des factures n'${invBad > 1 ? 'ont' : 'a'} pas été reconnu${invBad > 1 ? 's' : ''}. Les chiffres peuvent être incomplets — voir « Contrôle de la lecture des PDF » en bas de page.`,
      })
    : null;
  dash.replaceChildren(...[alert, hero, tiles, split, grid, years, list, review, diag].filter(Boolean));
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

$('file').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
const drop = $('drop');
for (const ev of ['dragenter', 'dragover'])
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});
// Un PDF lâché à côté de la zone ne doit pas s'ouvrir dans l'onglet.
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());

$('pasteBtn').addEventListener('click', addPastedText);
$('from').addEventListener('change', render);
$('to').addEventListener('change', render);
$('byName').addEventListener('change', () => refresh(false));
$('printBtn').addEventListener('click', () => window.print());
$('resetBtn').addEventListener('click', () => location.reload());
