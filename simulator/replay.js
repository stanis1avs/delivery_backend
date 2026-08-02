// Сборка HTML-проигрывателя записи симуляции.
//
// Модель «запись → воспроизведение», а не живая трансляция: прогон
// детерминирован по seed, сервер не нужен, файл можно открыть где угодно
// и отмотать назад. Данные вшиваются в HTML, Leaflet и тайлы тянутся из сети.

const fs = require('node:fs');
const path = require('node:path');

function buildPayload(world, strategyName, summary) {
  return {
    strategy: strategyName,
    center: [world.cfg.center.lat, world.cfg.center.lon],
    durationSeconds: world.cfg.durationHours * 3600,
    couriers: world.couriers.map((c) => ({ id: c.id, profile: c.profileName })),
    timeline: world.timeline,
    orders: world.orderLog,
    summary,
    config: {
      couriers: world.cfg.couriers,
      ordersPerHour: world.cfg.ordersPerHour,
      hours: world.cfg.durationHours,
      seed: world.cfg.seed,
    },
  };
}

const PAGE = (dataJson) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Симуляция распределения заказов</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root {
    --bg: #14161a; --panel: #1d2027; --line: #2b2f38;
    --text: #e8eaed; --muted: #9aa0aa;
    --free: #22c55e; --pickup: #f59e0b; --dropoff: #3b82f6; --order: #ef4444;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: var(--bg); color: var(--text); }
  #app { display: grid; grid-template-columns: 1fr 300px; height: 100vh; }
  #map { height: 100%; background: #0d0f12; }
  aside { background: var(--panel); border-left: 1px solid var(--line);
          padding: 16px; overflow-y: auto; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .clock { font-variant-numeric: tabular-nums; font-size: 26px; margin-bottom: 2px; }
  .controls { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
  button { background: #2b303a; color: var(--text); border: 1px solid var(--line);
           border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button:hover { background: #353b47; }
  input[type=range] { width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 3px 0; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-direction: column; gap: 5px; margin: 14px 0;
            font-size: 12.5px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
              margin-right: 7px; vertical-align: middle; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--muted); margin: 18px 0 6px; font-weight: 600; }
  canvas { width: 100%; height: 70px; display: block; }
  .dot { width: 11px; height: 11px; border-radius: 50%; border: 2px solid #fff; }
  .order-dot { width: 9px; height: 9px; border-radius: 2px;
               background: var(--order); border: 1px solid #fff; }
  @media (max-width: 820px) { #app { grid-template-columns: 1fr; } #map { height: 55vh; } }
</style>
</head>
<body>
<div id="app">
  <div id="map"></div>
  <aside>
    <h1>Симуляция распределения</h1>
    <div class="sub" id="scenario"></div>

    <div class="clock" id="clock">00:00:00</div>
    <div class="sub">виртуальное время</div>

    <div class="controls">
      <button id="play">Пауза</button>
      <button id="speed">×60</button>
      <button id="restart">С начала</button>
    </div>
    <input type="range" id="scrub" min="0" value="0" step="1">

    <div class="legend">
      <div><i style="background:var(--free)"></i>свободен</div>
      <div><i style="background:var(--pickup)"></i>едет за грузом</div>
      <div><i style="background:var(--dropoff)"></i>везёт заказ</div>
      <div><i style="background:var(--order);border-radius:2px"></i>заказ ждёт курьера</div>
    </div>

    <h2>Сейчас</h2>
    <table id="live"></table>

    <h2>Очередь заказов</h2>
    <canvas id="chart" width="280" height="70"></canvas>

    <h2>Итог прогона</h2>
    <table id="summary"></table>
  </aside>
</div>

<script>
const DATA = ${dataJson};

// ── карта ───────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView(DATA.center, 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap, © CARTO', maxZoom: 19,
}).addTo(map);

const COLOR = { free: '#22c55e', pickup: '#f59e0b', dropoff: '#3b82f6' };

// Отрезки по курьерам: на каждом кадре ищем активный
const byCourier = new Map();
for (const seg of DATA.timeline) {
  if (!byCourier.has(seg.c)) byCourier.set(seg.c, []);
  byCourier.get(seg.c).push(seg);
}
for (const segs of byCourier.values()) segs.sort((a, b) => a.t0 - b.t0);

const markers = new Map();
for (const c of DATA.couriers) {
  const m = L.marker(DATA.center, {
    icon: L.divIcon({ className: '', html: '<div class="dot"></div>', iconSize: [11, 11] }),
  }).addTo(map);
  m.bindTooltip(c.profile, { direction: 'top' });
  markers.set(c.id, m);
}

const orderLayer = L.layerGroup().addTo(map);

/** Позиция вдоль полилинии по доле пути. Длина считается по сегментам. */
function along(path, frac) {
  if (!path || path.length === 0) return null;
  if (path.length === 1) return path[0];
  const lens = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    lens.push(d); total += d;
  }
  if (total === 0) return path[0];
  let target = Math.max(0, Math.min(1, frac)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) {
      const k = lens[i] === 0 ? 0 : target / lens[i];
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * k,
        path[i][1] + (path[i + 1][1] - path[i][1]) * k,
      ];
    }
    target -= lens[i];
  }
  return path[path.length - 1];
}

function stateAt(courierId, t) {
  const segs = byCourier.get(courierId) || [];
  for (const s of segs) {
    const end = s.t1 == null ? Infinity : s.t1;
    if (t >= s.t0 && t < end) {
      if (s.at) return { pos: s.at, kind: 'free' };
      const frac = end === Infinity ? 0 : (t - s.t0) / (end - s.t0);
      return { pos: along(s.path, frac), kind: s.leg };
    }
  }
  const last = segs[segs.length - 1];
  if (!last) return null;
  return last.at ? { pos: last.at, kind: 'free' } : { pos: along(last.path, 1), kind: 'free' };
}

// ── проигрыватель ───────────────────────────────────────────────────────────
let t = 0;
let playing = true;
const SPEEDS = [60, 300, 900];
let speedIdx = 0;

const $ = (id) => document.getElementById(id);
$('scrub').max = DATA.durationSeconds;
$('scenario').textContent =
  DATA.config.couriers + ' курьеров · ' + DATA.config.ordersPerHour + ' заказов/час · ' +
  'стратегия ' + DATA.strategy + ' · seed ' + DATA.config.seed;

function hhmmss(sec) {
  const s = Math.floor(sec);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((v) => String(v).padStart(2, '0')).join(':');
}

function render() {
  let free = 0, toPickup = 0, toDropoff = 0;

  for (const c of DATA.couriers) {
    const st = stateAt(c.id, t);
    const m = markers.get(c.id);
    if (!st || !st.pos) { m.setOpacity(0); continue; }
    m.setOpacity(1);
    m.setLatLng(st.pos);
    const color = COLOR[st.kind] || COLOR.free;
    m.getElement()?.firstChild?.style.setProperty('background', color);
    if (st.kind === 'pickup') toPickup++;
    else if (st.kind === 'dropoff') toDropoff++;
    else free++;
  }

  // Заказы, которые уже появились, но ещё не назначены
  orderLayer.clearLayers();
  let pending = 0;
  for (const o of DATA.orders) {
    const waiting = o.t0 <= t && (o.assignedT == null || o.assignedT > t);
    if (!waiting) continue;
    pending++;
    L.marker(o.pickup, {
      icon: L.divIcon({ className: '', html: '<div class="order-dot"></div>', iconSize: [9, 9] }),
    }).addTo(orderLayer);
  }

  const done = DATA.orders.filter((o) => o.doneT != null && o.doneT <= t).length;
  $('live').innerHTML = row('Свободны', free) + row('Едут за грузом', toPickup) +
    row('Везут заказ', toDropoff) + row('Заказов ждёт', pending) + row('Доставлено', done);

  $('clock').textContent = hhmmss(t);
  $('scrub').value = t;
  drawChart();
}

const row = (k, v) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>';

// ── график очереди ──────────────────────────────────────────────────────────
const ctx = $('chart').getContext('2d');

// Ряд считаем из самих заказов, а не отдельной записью: так кривая гарантированно
// совпадает с красными точками на карте — «появился, но ещё не принят».
const SERIES = (() => {
  const points = 160;
  const out = [];
  for (let i = 0; i <= points; i++) {
    const time = (DATA.durationSeconds * i) / points;
    const pending = DATA.orders.filter(
      (o) => o.t0 <= time && (o.assignedT == null || o.assignedT > time)
    ).length;
    out.push({ t: time, pending });
  }
  return out;
})();

function drawChart() {
  const w = $('chart').width, h = $('chart').height;
  ctx.clearRect(0, 0, w, h);
  if (SERIES.length < 2) return;

  const maxPending = Math.max(1, ...SERIES.map((p) => p.pending));
  ctx.beginPath();
  SERIES.forEach((p, i) => {
    const x = (p.t / DATA.durationSeconds) * w;
    const y = h - (p.pending / maxPending) * (h - 6) - 3;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Курсор текущего времени
  const cx = (t / DATA.durationSeconds) * w;
  ctx.beginPath();
  ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
  ctx.strokeStyle = '#9aa0aa';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#9aa0aa';
  ctx.font = '10px system-ui';
  ctx.fillText('пик ' + maxPending, 4, 11);
}

// ── управление ──────────────────────────────────────────────────────────────
$('play').onclick = () => {
  playing = !playing;
  $('play').textContent = playing ? 'Пауза' : 'Играть';
};
$('speed').onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $('speed').textContent = '×' + SPEEDS[speedIdx];
};
$('restart').onclick = () => { t = 0; render(); };
$('scrub').oninput = (e) => { t = Number(e.target.value); render(); };

// Те же подписи, что в таблице CLI
const LABELS = {
  orders_created: 'Заказов создано',
  orders_assigned: 'Назначено',
  orders_delivered: 'Доставлено',
  orders_unassigned: 'Не назначено',
  pickup_eta_median_s: 'ETA до забора, медиана (с)',
  pickup_eta_p95_s: 'ETA до забора, p95 (с)',
  pickup_eta_max_s: 'ETA до забора, макс (с)',
  wait_median_s: 'Ожидание, медиана (с)',
  wait_p95_s: 'Ожидание, p95 (с)',
  invitations: 'Приглашений всего',
  invites_per_assignment: 'Приглашений на назначение',
  rejection_rate: 'Доля отказов',
  timeout_rate: 'Доля игноров',
  load_gini: 'Джини по нагрузке',
  couriers_used: 'Курьеров задействовано',
  candidates_median: 'Кандидатов, медиана',
  choice_available_pct: 'Был выбор, %',
};

$('summary').innerHTML = Object.entries(DATA.summary)
  .map(([k, v]) => row(LABELS[k] || k.replace(/_/g, ' '), v ?? '—')).join('');

let lastFrame = performance.now();
function loop(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (playing) {
    t += dt * SPEEDS[speedIdx];
    if (t > DATA.durationSeconds) { t = DATA.durationSeconds; playing = false; $('play').textContent = 'Играть'; }
    render();
  }
  requestAnimationFrame(loop);
}
render();
requestAnimationFrame(loop);
</script>
</body>
</html>
`;

/**
 * Записать HTML-проигрыватель на диск.
 * @returns {string} путь к файлу
 */
function writeReplay(world, strategyName, summary, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `replay-${strategyName}.html`);
  const payload = buildPayload(world, strategyName, summary);
  fs.writeFileSync(file, PAGE(JSON.stringify(payload)), 'utf8');
  return file;
}

module.exports = { writeReplay };
