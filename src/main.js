// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  url:          'http://192.168.4.1',
  window:       10,
  calc:         'median',
  filename:     'medicion.json',
  dark:         true,
  filterOn:     true,
  filterWindow: 5,
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('jpConfig') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  localStorage.setItem('jpConfig', JSON.stringify(cfg));
}

// ─── State ───────────────────────────────────────────────────────────────────

let cfg = loadConfig();
let sse = null;
let recording = false;
let recordedSamples = [];
let recordStart = null;
let recordStartPerfNow = 0;
let lastEspT = -1;  // last seen ESP32 timestamp, deduplication guard
let hasPendingSave = false;
let frameCount = 0;
let lastSpsTs = performance.now();
let spsAccum = 0;

// Chart data buffers: each entry { x: DOMHighResTimeStamp, y: number }
const buffers = { fl: [], fr: [], rl: [], rr: [], calc: [], total: [] };

// Ring buffers for the median pre-filter (raw values, not chart points)
const rawRings = { fl: [], fr: [], rl: [], rr: [] };

// ─── Median pre-filter ────────────────────────────────────────────────────────

function pushRing(ring, value) {
  ring.push(value);
  if (ring.length > cfg.filterWindow) ring.shift();
}

function medianOf(ring) {
  if (ring.length === 0) return 0;
  const s = ring.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function applyFilter(key, raw) {
  if (!cfg.filterOn) return raw;
  pushRing(rawRings[key], raw);
  return medianOf(rawRings[key]);
}

function resetRings() {
  for (const k of Object.keys(rawRings)) rawRings[k] = [];
}

// ─── Chart setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('scope-chart');
const ctx = canvas.getContext('2d');

const COLORS = {
  fl:    '#00ff88',
  fr:    '#00aaff',
  rl:    '#ff8800',
  rr:    '#ff4455',
  calc:  'rgba(180,180,180,0.55)',
  total: '#33ff33',
};

function makeDataset(key, label, borderWidth = 1.2, alpha = 1) {
  return {
    label,
    data: [],
    borderColor: COLORS[key],
    borderWidth,
    pointRadius: 0,
    tension: 0,
    parsing: false,
    borderDash: [],
  };
}

const chart = new Chart(ctx, {
  type: 'line',
  data: {
    datasets: [
      makeDataset('fl',   'FL',   1),
      makeDataset('fr',   'FR',   1),
      makeDataset('rl',   'RL',   1),
      makeDataset('rr',   'RR',   1),
      makeDataset('calc', cfg.calc.toUpperCase(), 1.5),
      // total drawn last so it renders on top
      { ...makeDataset('total', 'TOTAL', 3), borderColor: COLORS.total },
    ],
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: { display: false },
        grid: {
          color: '#1a2a1a',
          drawBorder: false,
        },
        border: { color: '#1f3a1f' },
      },
      y: {
        ticks: {
          color: '#1a8c1a',
          font: { family: 'ui-monospace, monospace', size: 10 },
          maxTicksLimit: 6,
        },
        grid: {
          color: '#1a2a1a',
          drawBorder: false,
        },
        border: { color: '#1f3a1f' },
      },
    },
  },
});

// ─── Computed metric ──────────────────────────────────────────────────────────

function computeCalc(fl, fr, rl, rr) {
  switch (cfg.calc) {
    case 'median': {
      const sorted = [fl, fr, rl, rr].slice().sort((a, b) => a - b);
      return (sorted[1] + sorted[2]) / 2;
    }
    case 'mean':
    default:
      return (fl + fr + rl + rr) / 4;
  }
}

// ─── SSE data ingestion ───────────────────────────────────────────────────────

function ingestFrame(raw) {
  const espT = raw.t ?? -1;
  if (espT !== -1 && espT === lastEspT) return;  // duplicate frame, skip
  lastEspT = espT;

  const now = performance.now();
  const fl = applyFilter('fl', raw.fl ?? 0);
  const fr = applyFilter('fr', raw.fr ?? 0);
  const rl = applyFilter('rl', raw.rl ?? 0);
  const rr = applyFilter('rr', raw.rr ?? 0);

  const total = fl + fr + rl + rr;
  const calc  = computeCalc(fl, fr, rl, rr);
  const windowMs = cfg.window * 1000;
  const cutoff = now - windowMs;

  function push(buf, val) {
    buf.push({ x: now, y: val });
    if (!recording) {
      // sliding window: discard points older than the configured window
      let lo = 0;
      while (lo < buf.length - 1 && buf[lo].x < cutoff) lo++;
      if (lo > 0) buf.splice(0, lo);
    }
    // while recording: accumulate everything, no trim
  }

  push(buffers.fl,    fl);
  push(buffers.fr,    fr);
  push(buffers.rl,    rl);
  push(buffers.rr,    rr);
  push(buffers.calc,  calc);
  push(buffers.total, total);

  chart.data.datasets[0].data = buffers.fl;
  chart.data.datasets[1].data = buffers.fr;
  chart.data.datasets[2].data = buffers.rl;
  chart.data.datasets[3].data = buffers.rr;
  chart.data.datasets[4].data = buffers.calc;
  chart.data.datasets[5].data = buffers.total;

  if (recording) {
    chart.options.scales.x.min = recordStartPerfNow;
  } else {
    chart.options.scales.x.min = cutoff;
  }
  chart.options.scales.x.max = now;
  chart.update('none');

  // SPS counter
  spsAccum++;
  const elapsed = now - lastSpsTs;
  if (elapsed >= 1000) {
    const sps = Math.round(spsAccum * 1000 / elapsed);
    document.getElementById('sps-counter').textContent = `${sps} SPS`;
    spsAccum = 0;
    lastSpsTs = now;
  }

  if (recording) {
    recordedSamples.push({
      t: raw.t ?? Date.now(),
      fl, fr, rl, rr, total, calc,
    });
  }
}

// ─── SSE connection ───────────────────────────────────────────────────────────

function connect() {
  if (sse) {
    sse.close();
    sse = null;
  }

  const url = `${cfg.url}/data`;
  setStatus('connecting');

  try {
    sse = new EventSource(url);
  } catch (e) {
    setStatus('error');
    return;
  }

  sse.onopen = () => setStatus('connected');

  sse.onmessage = (ev) => {
    try {
      ingestFrame(JSON.parse(ev.data));
    } catch { /* skip malformed frame */ }
  };

  sse.onerror = () => {
    setStatus('disconnected');
    sse.close();
    sse = null;
    // auto-reconnect after 3s
    setTimeout(connect, 3000);
  };
}

function disconnect() {
  if (sse) {
    sse.close();
    sse = null;
  }
  setStatus('disconnected');
}

// ─── Status ───────────────────────────────────────────────────────────────────

function setStatus(state) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'w-2 h-2 rounded-full';
  switch (state) {
    case 'connected':
      dot.classList.add('bg-green-400');
      text.textContent = `CONNECTED · ${cfg.url}`;
      break;
    case 'connecting':
      dot.classList.add('bg-yellow-400', 'animate-pulse');
      text.textContent = 'CONNECTING…';
      break;
    case 'error':
      dot.classList.add('bg-red-500');
      text.textContent = 'ERROR';
      break;
    default:
      dot.classList.add('bg-red-500');
      text.textContent = 'DISCONNECTED';
  }
}

// ─── ESP32 actions ────────────────────────────────────────────────────────────

async function espAction(cmd) {
  const resp = document.getElementById('esp-response');
  resp.textContent = '…';
  try {
    const r = await fetch(`${cfg.url}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: cmd,
    });
    const text = await r.text();
    resp.textContent = text;
    resp.className = 'mt-2 text-xs text-green-400 min-h-[1.2em]';
  } catch (e) {
    resp.textContent = `ERR: ${e.message}`;
    resp.className = 'mt-2 text-xs text-red-400 min-h-[1.2em]';
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────

function clearChartBuffers() {
  for (const k of Object.keys(buffers)) buffers[k] = [];
}

function updatePendingSaveUI() {
  const badge = document.getElementById('pending-save-badge');
  const count = document.getElementById('pending-save-count');
  if (hasPendingSave && recordedSamples.length > 0) {
    count.textContent = recordedSamples.length.toLocaleString();
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function startRec() {
  recordedSamples = [];
  recordStart = new Date().toISOString();
  recordStartPerfNow = performance.now();
  hasPendingSave = false;
  clearChartBuffers();   // fresh view from the start of the recording
  recording = true;
  updatePendingSaveUI();
  document.getElementById('rec-indicator').classList.remove('hidden');
  document.getElementById('btn-rec').disabled  = true;
  document.getElementById('btn-stop').disabled = false;
  document.getElementById('btn-save').disabled = true;
}

function stopRec() {
  recording = false;
  hasPendingSave = recordedSamples.length > 0;
  clearChartBuffers();   // back to sliding window, start clean
  updatePendingSaveUI();
  document.getElementById('rec-indicator').classList.add('hidden');
  document.getElementById('btn-rec').disabled  = false;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('btn-save').disabled = !hasPendingSave;
}

function saveRecording() {
  if (recordedSamples.length === 0) return;
  const payload = {
    metadata: {
      start:      recordStart,
      end:        new Date().toISOString(),
      url:        cfg.url,
      calc:       cfg.calc,
      windowSecs: cfg.window,
      samples:    recordedSamples.length,
    },
    samples: recordedSamples,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = cfg.filename || 'medicion.json';
  a.click();
  URL.revokeObjectURL(a.href);

  hasPendingSave = false;
  updatePendingSaveUI();
  document.getElementById('btn-save').disabled = true;
}

// ─── Settings modal ───────────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('cfg-url').value            = cfg.url;
  document.getElementById('cfg-window').value         = cfg.window;
  document.getElementById('cfg-calc').value           = cfg.calc;
  document.getElementById('cfg-filename').value       = cfg.filename;
  document.getElementById('cfg-filter-on').checked   = cfg.filterOn;
  document.getElementById('cfg-filter-window').value = cfg.filterWindow;
  updateDarkToggle();
  document.getElementById('modal-settings').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('modal-settings').classList.add('hidden');
}

function applySettings() {
  cfg.url          = document.getElementById('cfg-url').value.trim()         || DEFAULTS.url;
  cfg.window       = parseFloat(document.getElementById('cfg-window').value)  || DEFAULTS.window;
  cfg.calc         = document.getElementById('cfg-calc').value;
  cfg.filename     = document.getElementById('cfg-filename').value.trim()     || DEFAULTS.filename;
  cfg.filterOn     = document.getElementById('cfg-filter-on').checked;
  cfg.filterWindow = parseInt(document.getElementById('cfg-filter-window').value, 10) || DEFAULTS.filterWindow;
  saveConfig(cfg);

  resetRings();

  chart.data.datasets[4].label = cfg.calc === 'median' ? 'MEDIANA' : 'MEDIA';

  disconnect();
  connect();

  closeSettings();
}

// ─── Dark mode ────────────────────────────────────────────────────────────────

function updateDarkToggle() {
  const thumb = document.getElementById('toggle-dark-thumb');
  const btn   = document.getElementById('toggle-dark');
  if (cfg.dark) {
    thumb.style.transform = 'translateX(20px)';
    btn.style.backgroundColor = '#1a8c1a';
  } else {
    thumb.style.transform = 'translateX(0)';
    btn.style.backgroundColor = '#4a7a4a';
  }
}

function applyDark() {
  if (cfg.dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

// ─── Mixed content detection ──────────────────────────────────────────────────

function checkMixedContent() {
  if (location.protocol === 'https:' && cfg.url.startsWith('http://')) {
    document.getElementById('mixed-content-banner').classList.remove('hidden');
  }
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toTimeString().slice(0, 8);
}
setInterval(tickClock, 1000);
tickClock();

// ─── Wire up events ───────────────────────────────────────────────────────────

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('modal-close').addEventListener('click', closeSettings);
document.getElementById('settings-save').addEventListener('click', applySettings);

document.getElementById('btn-rec').addEventListener('click', startRec);
document.getElementById('btn-stop').addEventListener('click', stopRec);
document.getElementById('btn-save').addEventListener('click', saveRecording);

document.getElementById('esp-tare').addEventListener('click', () => espAction('TARE'));
document.getElementById('esp-save').addEventListener('click', () => espAction('SAVE'));

document.getElementById('esp-calibrate-open').addEventListener('click', () => {
  document.getElementById('calibrate-form').classList.toggle('hidden');
});

document.getElementById('esp-calibrate-send').addEventListener('click', () => {
  const w = parseFloat(document.getElementById('cal-weight').value);
  if (isNaN(w) || w <= 0) {
    document.getElementById('esp-response').textContent = 'ERR: peso inválido';
    return;
  }
  espAction(`CALIBRATE:${w}`);
});

document.getElementById('toggle-dark').addEventListener('click', () => {
  cfg.dark = !cfg.dark;
  applyDark();
  updateDarkToggle();
  saveConfig(cfg);
});

// close modal on backdrop click
document.getElementById('modal-settings').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

applyDark();
checkMixedContent();
connect();

// Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}
