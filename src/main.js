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
let hasPendingSave = false;
let lastEspT = -1;
let lastSpsTs = performance.now();
let spsAccum = 0;

// Chart data buffers — each entry { x: DOMHighResTimeStamp, y: number }
const buffers = { fl: [], fr: [], rl: [], rr: [], calc: [], total: [] };

// Ring buffers for the median pre-filter
const rawRings = { fl: [], fr: [], rl: [], rr: [] };

// Mode & analysis state
let currentMode = 'capture';
let analysisData = null; // { metadata, samples }
const playback = {
  playing: false,
  idx: 0,
  wallStart: 0,
  rafId: null,
};

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

// ─── Colors ───────────────────────────────────────────────────────────────────

const SENSOR_COLORS = {
  fl:    '#34d399',  // emerald-400
  fr:    '#38bdf8',  // sky-400
  rl:    '#fbbf24',  // amber-400
  rr:    '#fb7185',  // rose-400
  calc:  '#94a3b8',  // slate-400
  total: '#818cf8',  // indigo-400
};

function chartTheme() {
  const dark = document.documentElement.classList.contains('dark');
  return {
    grid:   dark ? '#1f2937' : '#f3f4f6',
    border: dark ? '#374151' : '#e5e7eb',
    ticks:  dark ? '#6b7280' : '#9ca3af',
    bg:     dark ? '#030712' : '#ffffff',
  };
}

// ─── Chart ───────────────────────────────────────────────────────────────────

const canvas = document.getElementById('scope-chart');
const chartCtx = canvas.getContext('2d');

function makeDataset(key, label, borderWidth = 1.5) {
  return {
    label,
    data: [],
    borderColor: SENSOR_COLORS[key],
    borderWidth,
    pointRadius: 0,
    tension: 0,
    parsing: false,
  };
}

const theme = chartTheme();

// Inline plugin: vertical playhead line for analysis mode
const playheadPlugin = {
  id: 'playhead',
  afterDraw(ch) {
    if (currentMode !== 'analysis' || !analysisData || analysisData.samples.length === 0) return;
    const sample = analysisData.samples[playback.idx];
    if (!sample) return;
    const { ctx, chartArea, scales } = ch;
    const t = sample.t - analysisData.samples[0].t;
    const x = scales.x.getPixelForValue(t);
    if (x < chartArea.left || x > chartArea.right) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.strokeStyle = '#a78bfa'; // violet-400
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  },
};

const chart = new Chart(chartCtx, {
  type: 'line',
  data: {
    datasets: [
      makeDataset('fl',    'FL',    1),
      makeDataset('fr',    'FR',    1),
      makeDataset('rl',    'RL',    1),
      makeDataset('rr',    'RR',    1),
      makeDataset('calc',  'CALC',  1.2),
      makeDataset('total', 'TOTAL', 3),
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
        grid: { color: theme.grid },
        border: { color: theme.border },
      },
      y: {
        ticks: {
          color: theme.ticks,
          font: { family: 'ui-monospace, monospace', size: 10 },
          maxTicksLimit: 5,
        },
        grid: { color: theme.grid },
        border: { color: theme.border },
      },
    },
  },
  plugins: [playheadPlugin],
});

function updateChartTheme() {
  const t = chartTheme();
  chart.options.scales.x.grid.color = t.grid;
  chart.options.scales.x.border.color = t.border;
  chart.options.scales.y.grid.color = t.grid;
  chart.options.scales.y.border.color = t.border;
  chart.options.scales.y.ticks.color = t.ticks;
  chart.update('none');
}

// ─── COP canvas ───────────────────────────────────────────────────────────────

const copCanvas = document.getElementById('cop-canvas');
const copCtx = copCanvas.getContext('2d');

function initCOPCanvas() {
  const container = copCanvas.parentElement;
  const side = Math.max(60, Math.min(container.clientWidth - 16, container.clientHeight - 28));
  copCanvas.width  = side;
  copCanvas.height = side;
  drawCOP(0, 0);
}

function drawCOP(nx, ny) {
  const w = copCanvas.width;
  const h = copCanvas.height;
  const dark = document.documentElement.classList.contains('dark');
  const cx = w / 2;
  const cy = h / 2;
  const rMax = Math.min(cx, cy) - 3;

  copCtx.clearRect(0, 0, w, h);

  copCtx.fillStyle = dark ? '#1f2937' : '#f9fafb';
  copCtx.fillRect(0, 0, w, h);

  const ringColor = dark ? '#374151' : '#e5e7eb';
  for (const f of [0.33, 0.66, 1]) {
    copCtx.beginPath();
    copCtx.arc(cx, cy, rMax * f, 0, Math.PI * 2);
    copCtx.strokeStyle = ringColor;
    copCtx.lineWidth = 1;
    copCtx.stroke();
  }

  copCtx.strokeStyle = dark ? '#4b5563' : '#d1d5db';
  copCtx.lineWidth = 1;
  copCtx.beginPath();
  copCtx.moveTo(cx, cy - rMax); copCtx.lineTo(cx, cy + rMax);
  copCtx.moveTo(cx - rMax, cy); copCtx.lineTo(cx + rMax, cy);
  copCtx.stroke();

  const labelColor = dark ? '#6b7280' : '#9ca3af';
  const fontSize = Math.max(8, Math.round(w * 0.1));
  copCtx.fillStyle = labelColor;
  copCtx.font = `${fontSize}px ui-sans-serif, sans-serif`;
  const pad = 4;
  copCtx.textAlign = 'left';  copCtx.fillText('FL', pad, fontSize + pad);
  copCtx.textAlign = 'right'; copCtx.fillText('FR', w - pad, fontSize + pad);
  copCtx.textAlign = 'left';  copCtx.fillText('RL', pad, h - pad);
  copCtx.textAlign = 'right'; copCtx.fillText('RR', w - pad, h - pad);

  const dx = cx + nx * rMax;
  const dy = cy - ny * rMax;

  copCtx.beginPath();
  copCtx.arc(dx, dy, 10, 0, Math.PI * 2);
  copCtx.fillStyle = 'rgba(129,140,248,0.25)';
  copCtx.fill();

  copCtx.beginPath();
  copCtx.arc(dx, dy, 5, 0, Math.PI * 2);
  copCtx.fillStyle = '#6366f1';
  copCtx.fill();
}

function computeCOP(fl, fr, rl, rr) {
  const absTotal = Math.abs(fl + fr + rl + rr);
  if (absTotal < 1) return { x: 0, y: 0 };
  return {
    x: Math.max(-1, Math.min(1, (fr + rr - fl - rl) / absTotal)),
    y: Math.max(-1, Math.min(1, (fl + fr - rl - rr) / absTotal)),
  };
}

// ─── Computed line metric ─────────────────────────────────────────────────────

function computeCalc(fl, fr, rl, rr) {
  if (cfg.calc === 'mean') return (fl + fr + rl + rr) / 4;
  const s = [fl, fr, rl, rr].slice().sort((a, b) => a - b);
  return (s[1] + s[2]) / 2;
}

// ─── Data ingestion ───────────────────────────────────────────────────────────

function ingestFrame(raw) {
  const espT = raw.t ?? -1;
  if (espT !== -1 && espT === lastEspT) return;
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
      let lo = 0;
      while (lo < buf.length - 1 && buf[lo].x < cutoff) lo++;
      if (lo > 0) buf.splice(0, lo);
    }
  }

  push(buffers.fl,    fl);
  push(buffers.fr,    fr);
  push(buffers.rl,    rl);
  push(buffers.rr,    rr);
  push(buffers.calc,  calc);
  push(buffers.total, total);

  // SPS counter — always
  spsAccum++;
  const elapsed = now - lastSpsTs;
  if (elapsed >= 1000) {
    document.getElementById('sps-counter').textContent =
      `${Math.round(spsAccum * 1000 / elapsed)} SPS`;
    spsAccum = 0;
    lastSpsTs = now;
  }

  // Recording — always, if active
  if (recording) {
    recordedSamples.push({ t: espT !== -1 ? espT : Date.now(), fl, fr, rl, rr, total, calc });
  }

  // Chart & widget updates only in capture mode
  if (currentMode === 'analysis') return;

  chart.data.datasets[0].data = buffers.fl;
  chart.data.datasets[1].data = buffers.fr;
  chart.data.datasets[2].data = buffers.rl;
  chart.data.datasets[3].data = buffers.rr;
  chart.data.datasets[4].data = buffers.calc;
  chart.data.datasets[5].data = buffers.total;

  chart.options.scales.x.min = recording ? recordStartPerfNow : cutoff;
  chart.options.scales.x.max = now;
  chart.update('none');

  document.getElementById('widget-total').textContent =
    total.toLocaleString(undefined, { maximumFractionDigits: 1 });

  const cop = computeCOP(fl, fr, rl, rr);
  drawCOP(cop.x, cop.y);
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connect() {
  if (sse) { sse.close(); sse = null; }
  setStatus('connecting');
  try {
    sse = new EventSource(`${cfg.url}/data`);
  } catch {
    setStatus('error');
    return;
  }
  sse.onopen = () => setStatus('connected');
  sse.onmessage = (ev) => {
    try { ingestFrame(JSON.parse(ev.data)); } catch { /* skip */ }
  };
  sse.onerror = () => {
    setStatus('disconnected');
    sse.close(); sse = null;
    setTimeout(connect, 3000);
  };
}

function disconnect() {
  if (sse) { sse.close(); sse = null; }
  setStatus('disconnected');
}

// ─── Status ───────────────────────────────────────────────────────────────────

function setStatus(state) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'w-2 h-2 rounded-full shrink-0';
  switch (state) {
    case 'connected':
      dot.classList.add('bg-emerald-500');
      text.textContent = `${cfg.url}`;
      break;
    case 'connecting':
      dot.classList.add('bg-amber-400', 'animate-pulse');
      text.textContent = 'Conectando…';
      break;
    case 'error':
      dot.classList.add('bg-red-500');
      text.textContent = 'Error';
      break;
    default:
      dot.classList.add('bg-red-500');
      text.textContent = 'Desconectado';
  }
}

// ─── ESP32 actions ────────────────────────────────────────────────────────────

async function espAction(cmd) {
  const resp = document.getElementById('esp-response');
  resp.textContent = '…';
  resp.className = 'text-xs text-gray-400 min-h-[1.25rem]';
  try {
    const r = await fetch(`${cfg.url}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: cmd,
    });
    resp.textContent = await r.text();
    resp.className = 'text-xs text-emerald-600 dark:text-emerald-400 min-h-[1.25rem]';
  } catch (e) {
    resp.textContent = `Error: ${e.message}`;
    resp.className = 'text-xs text-red-500 min-h-[1.25rem]';
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
    badge.classList.add('flex');
  } else {
    badge.classList.add('hidden');
    badge.classList.remove('flex');
  }
}

function startRec() {
  recordedSamples = [];
  recordStart = new Date().toISOString();
  recordStartPerfNow = performance.now();
  hasPendingSave = false;
  clearChartBuffers();
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
  clearChartBuffers();
  updatePendingSaveUI();
  document.getElementById('rec-indicator').classList.add('hidden');
  document.getElementById('btn-rec').disabled  = false;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('btn-save').disabled = !hasPendingSave;
  // Keep "Última" button in sync
  document.getElementById('btn-load-last').disabled = recordedSamples.length === 0;
}

function saveRecording() {
  if (recordedSamples.length === 0) return;
  const payload = {
    metadata: {
      start: recordStart,
      end:   new Date().toISOString(),
      url:   cfg.url,
      calc:  cfg.calc,
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

// ─── Analysis mode ────────────────────────────────────────────────────────────

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

function switchMode(mode) {
  if (mode === currentMode) return;
  if (mode === 'analysis' && recording) stopRec();

  currentMode = mode;
  const isAnalysis = mode === 'analysis';

  document.getElementById('action-capture').classList.toggle('hidden', isAnalysis);
  document.getElementById('action-analysis').classList.toggle('hidden', !isAnalysis);

  document.getElementById('tab-capture').classList.toggle('tab-active', !isAnalysis);
  document.getElementById('tab-analysis').classList.toggle('tab-active', isAnalysis);

  document.getElementById('btn-load-last').disabled = recordedSamples.length === 0;

  if (isAnalysis) {
    if (analysisData) {
      document.getElementById('analysis-empty').classList.add('hidden');
      renderAnalysisChart(analysisData.samples);
    } else if (recordedSamples.length > 0) {
      loadAnalysis({ metadata: { start: recordStart }, samples: recordedSamples });
    } else {
      document.getElementById('analysis-empty').classList.remove('hidden');
    }
  } else {
    stopPlayback();
    // Restore live capture chart
    const now = performance.now();
    const cutoff = now - cfg.window * 1000;
    const keys = ['fl', 'fr', 'rl', 'rr', 'calc', 'total'];
    chart.data.datasets.forEach((ds, i) => { ds.data = buffers[keys[i]]; });
    chart.options.scales.x.min = cutoff;
    chart.options.scales.x.max = now;
    chart.update('none');
  }
}

function loadAnalysis(data) {
  analysisData = data;
  stopPlayback();
  playback.idx = 0;
  document.getElementById('analysis-empty').classList.add('hidden');
  renderAnalysisChart(data.samples);
}

function renderAnalysisChart(samples) {
  if (!samples || samples.length === 0) return;
  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t - t0;
  const keys = ['fl', 'fr', 'rl', 'rr', 'calc', 'total'];

  chart.data.datasets.forEach((ds, i) => {
    ds.data = samples.map(s => ({ x: s.t - t0, y: s[keys[i]] }));
  });

  chart.options.scales.x.min = 0;
  chart.options.scales.x.max = tEnd;
  chart.update('none');

  const scrubber = document.getElementById('playback-scrubber');
  scrubber.max = samples.length - 1;
  scrubber.value = 0;
  scrubber.disabled = false;

  document.getElementById('playback-total').textContent = formatTime(tEnd);
  document.getElementById('btn-rewind').disabled = false;
  document.getElementById('btn-play').disabled = false;

  updatePlaybackUI();
}

function updatePlaybackUI() {
  if (!analysisData || !analysisData.samples.length) return;
  const samples = analysisData.samples;
  const t0 = samples[0].t;
  const currentT = samples[playback.idx].t - t0;

  document.getElementById('playback-scrubber').value = playback.idx;
  document.getElementById('playback-current').textContent = formatTime(currentT);

  const s = samples[playback.idx];
  document.getElementById('widget-total').textContent =
    s.total.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const cop = computeCOP(s.fl, s.fr, s.rl, s.rr);
  drawCOP(cop.x, cop.y);
}

function setPlayingState(playing) {
  document.getElementById('icon-play').classList.toggle('hidden', playing);
  document.getElementById('icon-pause').classList.toggle('hidden', !playing);
  document.getElementById('play-label').textContent = playing ? 'Pausa' : 'Play';
}

function startPlayback() {
  if (!analysisData || !analysisData.samples.length) return;
  if (playback.idx >= analysisData.samples.length - 1) playback.idx = 0;

  const t0 = analysisData.samples[0].t;
  const currentSampleT = analysisData.samples[playback.idx].t - t0;
  playback.wallStart = performance.now() - currentSampleT;
  playback.playing = true;
  setPlayingState(true);
  playback.rafId = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
  playback.playing = false;
  if (playback.rafId) { cancelAnimationFrame(playback.rafId); playback.rafId = null; }
  setPlayingState(false);
}

function stopPlayback() {
  pausePlayback();
  if (analysisData && analysisData.samples.length) {
    playback.idx = 0;
    updatePlaybackUI();
    chart.update('none');
  }
}

function playbackTick() {
  if (!playback.playing) return;
  const samples = analysisData.samples;
  const t0 = samples[0].t;
  const elapsed = performance.now() - playback.wallStart;

  while (
    playback.idx < samples.length - 1 &&
    samples[playback.idx + 1].t - t0 <= elapsed
  ) {
    playback.idx++;
  }

  updatePlaybackUI();
  chart.update('none');

  if (playback.idx >= samples.length - 1) {
    pausePlayback();
    return;
  }

  playback.rafId = requestAnimationFrame(playbackTick);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

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
  cfg.url          = document.getElementById('cfg-url').value.trim()          || DEFAULTS.url;
  cfg.window       = parseFloat(document.getElementById('cfg-window').value)   || DEFAULTS.window;
  cfg.calc         = document.getElementById('cfg-calc').value;
  cfg.filename     = document.getElementById('cfg-filename').value.trim()      || DEFAULTS.filename;
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
  const dark = document.documentElement.classList.contains('dark');
  thumb.style.transform = dark ? 'translateX(20px)' : 'translateX(0)';
}

function applyDark() {
  if (cfg.dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  updateChartTheme();
  drawCOP(0, 0);
}

// ─── Mixed content ────────────────────────────────────────────────────────────

function checkMixedContent() {
  if (location.protocol === 'https:' && cfg.url.startsWith('http://')) {
    const b = document.getElementById('mixed-content-banner');
    b.classList.remove('hidden');
    b.classList.add('flex');
  }
}

// ─── Clock ────────────────────────────────────────────────────────────────────

setInterval(() => {
  document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8);
}, 1000);

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Tabs
document.getElementById('tab-capture').addEventListener('click', () => switchMode('capture'));
document.getElementById('tab-analysis').addEventListener('click', () => switchMode('analysis'));

// Settings
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('modal-close').addEventListener('click', closeSettings);
document.getElementById('settings-save').addEventListener('click', applySettings);
document.getElementById('modal-settings').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings();
});

// Capture controls
document.getElementById('btn-rec').addEventListener('click', startRec);
document.getElementById('btn-stop').addEventListener('click', stopRec);
document.getElementById('btn-save').addEventListener('click', saveRecording);
document.getElementById('btn-reset').addEventListener('click', () => espAction('TARE'));

// ESP32 actions
document.getElementById('esp-tare').addEventListener('click', () => espAction('TARE'));
document.getElementById('esp-save').addEventListener('click', () => espAction('SAVE'));
document.getElementById('esp-calibrate-open').addEventListener('click', () => {
  document.getElementById('calibrate-form').classList.toggle('hidden');
});
document.getElementById('esp-calibrate-send').addEventListener('click', () => {
  const w = parseFloat(document.getElementById('cal-weight').value);
  if (isNaN(w) || w <= 0) {
    document.getElementById('esp-response').textContent = 'Error: peso inválido';
    return;
  }
  espAction(`CALIBRATE:${w}`);
});

// Dark mode toggle
document.getElementById('toggle-dark').addEventListener('click', () => {
  cfg.dark = !cfg.dark;
  applyDark();
  updateDarkToggle();
  saveConfig(cfg);
});

// Analysis: open file
document.getElementById('btn-open-file').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.samples || !Array.isArray(data.samples)) throw new Error('Formato inválido');
      loadAnalysis(data);
    } catch (err) {
      alert(`Error cargando archivo: ${err.message}`);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Analysis: load last recording
document.getElementById('btn-load-last').addEventListener('click', () => {
  if (recordedSamples.length === 0) return;
  loadAnalysis({ metadata: { start: recordStart }, samples: recordedSamples });
});

// Analysis: rewind
document.getElementById('btn-rewind').addEventListener('click', () => {
  const wasPlaying = playback.playing;
  pausePlayback();
  playback.idx = 0;
  updatePlaybackUI();
  chart.update('none');
  if (wasPlaying) startPlayback();
});

// Analysis: play / pause
document.getElementById('btn-play').addEventListener('click', () => {
  if (playback.playing) pausePlayback(); else startPlayback();
});

// Analysis: scrubber seek
document.getElementById('playback-scrubber').addEventListener('input', (e) => {
  if (!analysisData) return;
  const wasPlaying = playback.playing;
  if (wasPlaying) pausePlayback();
  playback.idx = parseInt(e.target.value, 10);
  const t0 = analysisData.samples[0].t;
  playback.wallStart = performance.now() - (analysisData.samples[playback.idx].t - t0);
  updatePlaybackUI();
  chart.update('none');
  if (wasPlaying) {
    playback.playing = true;
    setPlayingState(true);
    playback.rafId = requestAnimationFrame(playbackTick);
  }
});

window.addEventListener('resize', initCOPCanvas);

// ─── Boot ─────────────────────────────────────────────────────────────────────

applyDark();
checkMixedContent();
initCOPCanvas();
connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}
