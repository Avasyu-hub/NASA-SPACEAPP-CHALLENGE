// Mission timeline (WORKPLAN M3.5): Sun visible, Earth visible and battery charge, hour by hour,
// for the slipped window, with the on-time plan as a thin lane above each bar when there is a slip.
// Everything drawn here is read from results.sun_lit / earth_vis and missionLogic.batteryTrace.
const COLORS = {
  sun: '#FFD58A', earth: '#5B8EF0', off: '#161a24', grid: 'rgba(255,255,255,0.07)',
  ink: '#ECEFF5', ink2: '#8E96A8', fail: '#FF5A4F', cursor: '#D4FF24', battery: '#D4FF24',
};
const LABEL_W = 78;

export class Timeline {
  constructor(canvas, tooltip, { onScrub } = {}) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.onScrub = onScrub || (() => {});
    this.model = null;
    this.dragging = false;
    const hourAt = (e) => {
      if (!this.model) return null;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const { span } = this.model;
      const frac = (x - LABEL_W) / Math.max(1, r.width - LABEL_W - 8);
      return Math.max(span.start, Math.min(span.end - 1, Math.round(span.start + frac * (span.end - span.start))));
    };
    canvas.addEventListener('pointerdown', (e) => {
      const h = hourAt(e);
      if (h === null) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.onScrub(h);
    });
    canvas.addEventListener('pointermove', (e) => {
      const h = hourAt(e);
      if (h === null) return;
      if (this.dragging) this.onScrub(h);
      this.showTip(e, h);
    });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('pointerleave', () => { this.tooltip.hidden = true; });
    canvas.addEventListener('keydown', (e) => {
      if (!this.model) return;
      const step = e.shiftKey ? 24 : 1;
      if (e.key === 'ArrowRight') { this.onScrub(Math.min(this.model.span.end - 1, this.model.cursor + step)); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.onScrub(Math.max(this.model.span.start, this.model.cursor - step)); e.preventDefault(); }
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /**
   * model: { results, angles?, win, nominal, battery, failure, cursor, delayDays, horizonAt? }
   */
  set(model) {
    const start = Math.min(model.win.startIdx, model.nominal.startIdx);
    const end = Math.max(model.win.endIdx, model.nominal.endIdx);
    this.model = { ...model, span: { start, end } };
    this.draw();
  }

  setCursor(h) {
    if (!this.model) return;
    this.model.cursor = h;
    this.draw();
  }

  showTip(e, h) {
    const m = this.model;
    const t = m.results.t[h];
    if (!t) { this.tooltip.hidden = true; return; }
    const sun = m.results.sun_lit[h] === 1, earth = m.results.earth_vis[h] === 1;
    const inWin = h >= m.win.startIdx && h < m.win.endIdx;
    let extra = '';
    if (m.angles && m.horizonAt) {
      const sm = m.angles.sun_el[h] - m.horizonAt(m.angles.sun_az[h]);
      const em = m.angles.earth_el[h] - m.horizonAt(m.angles.earth_az[h]);
      extra = `<div>Sun ${sm >= 0 ? '+' : ''}${sm.toFixed(2)}° vs ridge · Earth ${em >= 0 ? '+' : ''}${em.toFixed(2)}°</div>`;
    }
    this.tooltip.innerHTML =
      `<b>${t.slice(0, 10)} ${t.slice(11, 16)} UTC</b>` +
      `<div>${inWin ? `Mission hour ${h - m.win.startIdx + 1}` : 'Outside the slipped window'}</div>` +
      `<div><i style="background:${sun ? COLORS.sun : COLORS.off}"></i>Sun ${sun ? 'above' : 'below'} the terrain</div>` +
      `<div><i style="background:${earth ? COLORS.earth : COLORS.off}"></i>Earth ${earth ? 'in view' : 'hidden'}</div>` + extra;
    const r = this.canvas.getBoundingClientRect();
    this.tooltip.hidden = false;
    const x = Math.min(r.width - 230, Math.max(0, e.clientX - r.left + 12));
    this.tooltip.style.transform = `translate(${x}px, ${-this.tooltip.offsetHeight - 6}px)`;
  }

  draw() {
    const c = this.canvas, m = this.model;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!m) return;

    const { results, win, nominal, battery, failure, span } = m;
    const n = span.end - span.start;
    const x0 = LABEL_W, x1 = W - 8;
    const X = (k) => x0 + ((k - span.start) / n) * (x1 - x0);
    const slip = m.delayDays > 0;
    const rows = { axis: 16, sun: 26, earth: 56, bat: 86 };
    const barH = 14, laneH = 4;

    // Day grid + date labels
    g.font = '500 9.5px "IBM Plex Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';
    const firstDay = span.start - (span.start % 24);
    const pxPerDay = ((x1 - x0) / n) * 24;
    const every = pxPerDay > 46 ? 1 : pxPerDay > 22 ? 2 : pxPerDay > 11 ? 4 : 7;
    let dayCount = 0;
    for (let k = firstDay; k <= span.end; k += 24, dayCount++) {
      if (k < span.start) continue;
      const x = X(k);
      g.fillStyle = COLORS.grid;
      g.fillRect(x, rows.axis + 6, 1, H - rows.axis - 6);
      const t = results.t[k];
      if (t && dayCount % every === 0) {
        g.fillStyle = COLORS.ink2;
        g.fillText(t.slice(5, 10).replace('-', '·'), x + 3, rows.axis - 4);
      }
    }

    // Row labels
    g.font = '600 9px Inter, system-ui, sans-serif';
    g.fillStyle = COLORS.ink2;
    const label = (txt, y) => { g.save(); g.letterSpacing = '1.4px'; g.fillText(txt, 0, y); g.restore(); };
    label('SUN', rows.sun + barH / 2 + (slip ? laneH : 0));
    label('EARTH', rows.earth + barH / 2 + (slip ? laneH : 0));
    label('BATTERY', rows.bat + 14);

    const runs = (arr, from, to, y, h, color) => {
      g.fillStyle = COLORS.off;
      g.fillRect(X(from), y, X(to) - X(from), h);
      g.fillStyle = color;
      let k = from;
      while (k < to) {
        if (arr[k] === 1) {
          let j = k;
          while (j < to && arr[j] === 1) j++;
          g.fillRect(X(k), y, Math.max(1, X(j) - X(k)), h);
          k = j;
        } else k++;
      }
    };
    const rowAt = (key, arr, color) => {
      const y = rows[key] + (slip ? laneH + 2 : 0);
      if (slip) {
        g.globalAlpha = 0.45;
        runs(arr, nominal.startIdx, nominal.endIdx, rows[key], laneH, color);
        g.globalAlpha = 1;
      }
      runs(arr, win.startIdx, win.endIdx, y, barH, color);
      return y;
    };
    const ySun = rowAt('sun', results.sun_lit, COLORS.sun);
    const yEarth = rowAt('earth', results.earth_vis, COLORS.earth);

    // The run that breaks a requirement, outlined in red.
    if (failure && failure.runStartIndex != null) {
      const y = failure.kind === 'night' ? ySun : yEarth;
      g.strokeStyle = COLORS.fail;
      g.lineWidth = 1.5;
      g.strokeRect(X(failure.runStartIndex) + 0.5, y - 2.5, X(failure.hourIndex + 1) - X(failure.runStartIndex) - 1, barH + 5);
    }

    // Battery state of charge (scenario model) as a filled line.
    if (battery && battery.socWh.length) {
      const top = rows.bat + 2, h = 26, cap = battery.params.capacityWh;
      g.fillStyle = 'rgba(212,255,36,0.10)';
      g.strokeStyle = COLORS.battery;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(X(win.startIdx), top + h);
      battery.socWh.forEach((v, i) => g.lineTo(X(win.startIdx + i + 0.5), top + h - (v / cap) * h));
      g.lineTo(X(win.endIdx), top + h);
      g.closePath();
      g.fill();
      g.beginPath();
      battery.socWh.forEach((v, i) => {
        const x = X(win.startIdx + i + 0.5), y = top + h - (v / cap) * h;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();
      g.fillStyle = COLORS.grid;
      g.fillRect(X(win.startIdx), top + h, X(win.endIdx) - X(win.startIdx), 1);
    }

    // Window brackets: landing and end of mission.
    g.fillStyle = COLORS.ink;
    g.fillRect(X(win.startIdx), rows.axis + 4, 1.5, H - rows.axis - 4);
    g.fillRect(X(win.endIdx) - 1.5, rows.axis + 4, 1.5, H - rows.axis - 4);

    // First failure flag.
    if (failure) {
      const x = X(failure.hourIndex + 0.5);
      g.fillStyle = COLORS.fail;
      g.fillRect(x - 0.75, rows.axis + 2, 1.5, H - rows.axis - 2);
      g.beginPath(); g.moveTo(x, rows.axis + 2); g.lineTo(x + 8, rows.axis + 6); g.lineTo(x, rows.axis + 10); g.fill();
    }

    // Cursor (current hour, shared with the 3D views).
    if (m.cursor != null && m.cursor >= span.start && m.cursor < span.end) {
      const x = X(m.cursor + 0.5);
      g.fillStyle = COLORS.cursor;
      g.fillRect(x - 1, rows.axis, 2, H - rows.axis);
      g.beginPath(); g.arc(x, rows.axis, 3.5, 0, Math.PI * 2); g.fill();
    }
  }
}
