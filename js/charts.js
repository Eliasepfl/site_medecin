// Script classique (sans import/export) pour que la page fonctionne aussi ouverte
// directement depuis le disque, par double-clic sur index.html.
(function (FP) {
  'use strict';
  // Petits graphiques SVG dessinés à la main (aucune bibliothèque externe).
  // Les couleurs viennent des classes CSS .s-mt / .s-hors, jamais d'attributs style.

  const NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs = {}, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  }

  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }

  let tip = null;
  function tooltip() {
    if (!tip) {
      tip = h('div', { class: 'tip', role: 'status' });
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(title, rows, x, y) {
    const t = tooltip();
    t.replaceChildren(
      h('div', { class: 'tip-title', text: title }),
      ...rows.map((r) =>
        h('div', { class: 'tip-row' }, [
          r.cls ? h('span', { class: 'tip-key ' + r.cls }) : h('span', { class: 'tip-key none' }),
          h('strong', { text: r.value }),
          h('span', { text: r.label }),
        ])
      )
    );
    t.hidden = false;
    const w = t.offsetWidth;
    const hh = t.offsetHeight;
    const left = Math.min(Math.max(8, x + 14), document.documentElement.clientWidth - w - 8);
    const top = Math.max(8, y - hh - 12);
    t.style.left = left + window.scrollX + 'px';
    t.style.top = top + window.scrollY + 'px';
  }
  function hideTip() {
    if (tip) tip.hidden = true;
  }

  /** Échelle à graduations rondes (pas en 1, 2 ou 5 × 10^k), 5 intervalles au plus. */
  function niceScale(v) {
    if (v <= 0) return { max: 1, step: 1 };
    for (let p = Math.pow(10, Math.floor(Math.log10(v)) - 1); ; p *= 10)
      for (const m of [1, 2, 5]) {
        const step = m * p;
        if (step >= 1 && Math.ceil(v / step) <= 5) return { max: Math.ceil(v / step) * step, step };
      }
  }

  /** Colonne à sommet arrondi (4 px), base carrée posée sur la ligne de zéro. */
  function roundedTop(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }

  /**
   * Colonnes (empilées s'il y a plusieurs séries).
   * opts : { labels: [{short, long, major}], series: [{name, cls, values}], format, ariaLabel }
   */
  function columnChart(container, opts) {
    const draw = () => {
      const width = Math.max(280, Math.floor(container.clientWidth));
      const height = 240;
      const m = { top: 18, right: 8, bottom: 26, left: 46 };
      const pw = width - m.left - m.right;
      const ph = height - m.top - m.bottom;
      const n = opts.labels.length;
      const totals = opts.labels.map((_, i) => opts.series.reduce((s, se) => s + se.values[i], 0));
      const { max, step } = niceScale(Math.max(...totals, 0));
      const band = pw / Math.max(n, 1);
      const bw = Math.max(1, Math.min(24, band - 2));
      const y = (v) => m.top + ph - (v / max) * ph;

      const root = svg('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        tabindex: '0',
        'aria-label': opts.ariaLabel + ' Flèches gauche et droite pour parcourir les valeurs.',
        class: 'chart',
      });

      for (let v = 0; v <= max + step / 2; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        svg('line', { x1: m.left, x2: width - m.right, y1: yy, y2: yy, class: v === 0 ? 'ax' : 'gl' }, root);
        svg('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, root).textContent = opts.format(v, true);
      }

      // Axe horizontal : une étiquette tous les k intervalles, calée sur les repères
      // principaux (janvier), avec le plus petit k pour lequel elles ne se touchent pas.
      const xOf = (i) => m.left + band * i + band / 2;
      const widest = Math.max(...opts.labels.map((l) => l.short.length)) * 6.4 + 12;
      const every = [1, 2, 3, 4, 6, 12].find((k) => k * band >= widest) || 12;
      const anchor = Math.max(0, opts.labels.findIndex((l) => l.major));
      opts.labels.forEach((l, i) => {
        if ((((i - anchor) % every) + every) % every !== 0) return;
        svg('text', { x: xOf(i), y: height - 8, 'text-anchor': 'middle', class: l.major ? 'tick major' : 'tick' }, root).textContent = l.short;
      });

      const cols = [];
      opts.labels.forEach((_, i) => {
        const g = svg('g', { class: 'col' }, root);
        const x = xOf(i) - bw / 2;
        let base = 0;
        const live = opts.series.map((se, si) => ({ se, v: se.values[i], si })).filter((s) => s.v > 0);
        live.forEach((s, k) => {
          const y0 = y(base);
          const y1 = y(base + s.v);
          const isTop = k === live.length - 1;
          const gap = k > 0 ? 2 : 0; // 2 px de fond entre deux segments
          const hgt = Math.max(1, y0 - y1 - gap);
          if (isTop) svg('path', { d: roundedTop(x, y1, bw, hgt, 4), class: s.se.cls }, g);
          else svg('rect', { x, y: y1, width: bw, height: hgt, class: s.se.cls }, g);
          base += s.v;
        });
        cols.push(g);
      });

      // Étiquette directe : uniquement le maximum.
      const peak = totals.indexOf(Math.max(...totals));
      if (n && totals[peak] > 0) {
        const tx = Math.min(Math.max(xOf(peak), m.left + 24), width - m.right - 24);
        svg('text', { x: tx, y: y(totals[peak]) - 6, 'text-anchor': 'middle', class: 'peak' }, root).textContent = opts.format(totals[peak]);
      }

      let active = -1;
      const setActive = (i, clientX, clientY) => {
        if (active >= 0) cols[active].classList.remove('active');
        active = i;
        if (i < 0) {
          root.classList.remove('hovering');
          hideTip();
          return;
        }
        root.classList.add('hovering');
        cols[i].classList.add('active');
        const rows = opts.series.map((se) => ({ cls: opts.series.length > 1 ? se.cls : '', value: opts.format(se.values[i]), label: se.name }));
        if (opts.series.length > 1) rows.push({ cls: '', value: opts.format(totals[i]), label: 'Total' });
        showTip(opts.labels[i].long, rows, clientX, clientY);
      };
      const indexAt = (clientX) => {
        const r = root.getBoundingClientRect();
        const i = Math.floor((clientX - r.left - m.left) / band);
        return i >= 0 && i < n ? i : -1;
      };
      root.addEventListener('pointermove', (e) => setActive(indexAt(e.clientX), e.clientX, e.clientY));
      root.addEventListener('pointerleave', () => setActive(-1));
      root.addEventListener('blur', () => setActive(-1));
      root.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
        e.preventDefault();
        if (e.key === 'Escape') return setActive(-1);
        const next = Math.min(n - 1, Math.max(0, active < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : active + (e.key === 'ArrowRight' ? 1 : -1)));
        const r = root.getBoundingClientRect();
        setActive(next, r.left + xOf(next), r.top + y(totals[next]));
      });

      container.replaceChildren(root);
    };

    draw();
    let lastW = container.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastW) < 2) return;
      lastW = container.clientWidth;
      draw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }

  /** Barre segmentée haute : un tout découpé en parts. parts : [{name, value, cls}] */
  function segmentedBar(container, parts, format) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
    const bar = h('div', {
      class: 'segbar',
      role: 'img',
      'aria-label': parts.map((p) => `${p.name} : ${format(p.value)} (${pct(p.value)} %)`).join(', '),
    });
    for (const p of parts) {
      if (!p.value) continue;
      const seg = h('div', { class: 'seg ' + p.cls });
      seg.style.flexGrow = String(p.value);
      bar.appendChild(seg);
    }
    // Barre fine, sans texte : la légende porte les chiffres.
    const legend = h(
      'div',
      { class: 'legend' },
      parts.map((p) =>
        h('span', { class: 'legend-item' }, [h('i', { class: 'swatch ' + p.cls }), h('strong', { text: format(p.value) }), `${p.name} · ${pct(p.value)} %`])
      )
    );
    container.replaceChildren(bar, legend);
  }

  function legend(items) {
    return h(
      'div',
      { class: 'legend' },
      items.map((it) => h('span', { class: 'legend-item' }, [h('i', { class: 'swatch ' + it.cls }), it.name]))
    );
  }

  /** Tableau HTML simple. columns : [{label, num}] · rows : tableau de tableaux. */
  function table(columns, rows, { cls = '' } = {}) {
    const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '', scope: 'col', text: c.label }))));
    const tbody = h(
      'tbody',
      {},
      rows.map((r) => h('tr', {}, r.map((v, i) => h('td', { class: columns[i].num ? 'num' : '', text: String(v) }))))
    );
    return h('table', { class: cls }, [thead, tbody]);
  }

  FP.charts = { h, columnChart, segmentedBar, legend, table };
})((globalThis.FP = globalThis.FP || {}));
