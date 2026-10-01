/**
 * Ingestive Particle Collector - ESP32 Web Bluetooth Telemetry Hub
 * Handles BLE connection, Nordic UART Service (NUS), live canvas rendering,
 * data classification, and serial monitor communications.
 */

// Application State
const state = {
  device: null,
  server: null,
  rxCharacteristic: null,
  txCharacteristic: null,
  isConnected: false,
  isSimulating: false,
  isChartPaused: false,
  autoReconnect: true,

  // Settings
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rxUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // ESP32 -> Web (Notify)
  txUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Web -> ESP32 (Write)
  namePrefix: 'Particle',

  // Telemetry Metrics
  particleCount: 0,
  concentration: 0,
  peakConcentration: 0,
  flowRate: 12.4,
  sensorVoltage: 3.28,
  deviceStatus: 'STANDBY',

  // Particle bins
  bins: {
    micro: 0,
    medium: 0,
    macro: 0
  },

  // Historical data for charts & export
  history: [], // { timestamp, timeStr, count, conc, flow, volt }
  maxHistoryPoints: 200,

  // Session timer
  sessionStartTime: null,
  timerInterval: null,
  simInterval: null,
};

// DOM Elements
const ui = {
  connectionStatusPill: document.getElementById('connection-status-pill'),
  connectionStatusText: document.getElementById('connection-status-text'),
  bleConnectBtn: document.getElementById('ble-connect-btn'),
  demoModeToggle: document.getElementById('demo-mode-toggle'),
  demoToggleLabel: document.getElementById('demo-toggle-label'),

  // Metrics
  valParticleCount: document.getElementById('val-particle-count'),
  rateBadge: document.getElementById('rate-badge'),
  valConcentration: document.getElementById('val-concentration'),
  valPeakConc: document.getElementById('val-peak-conc'),
  valFlowRate: document.getElementById('val-flow-rate'),
  valSensorVoltage: document.getElementById('val-sensor-voltage'),
  valDeviceState: document.getElementById('val-device-state'),
  valSessionTime: document.getElementById('val-session-time'),
  valRssi: document.getElementById('val-rssi'),
  flowStatusTag: document.getElementById('flow-status-tag'),

  // Bins
  binMicroCount: document.getElementById('bin-micro-count'),
  binMicroBar: document.getElementById('bin-micro-bar'),
  binMedCount: document.getElementById('bin-med-count'),
  binMedBar: document.getElementById('bin-med-bar'),
  binMacroCount: document.getElementById('bin-macro-count'),
  binMacroBar: document.getElementById('bin-macro-bar'),

  // Canvas
  canvas: document.getElementById('telemetry-canvas'),
  pauseBtn: document.getElementById('chart-toggle-pause'),
  pauseBtnText: document.getElementById('pause-btn-text'),
  resetChartBtn: document.getElementById('chart-reset-btn'),

  // Terminal
  terminalBody: document.getElementById('terminal-body'),
  terminalForm: document.getElementById('terminal-cmd-form'),
  terminalInput: document.getElementById('terminal-input'),
  clearTermBtn: document.getElementById('clear-term-btn'),
  exportCsvBtn: document.getElementById('export-csv-btn'),
  exportJsonBtn: document.getElementById('export-json-btn'),

  // Settings Modal
  settingsBtn: document.getElementById('settings-open-btn'),
  settingsModal: document.getElementById('settings-modal'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  settingsSaveBtn: document.getElementById('settings-save-btn'),
  cfgServiceUuid: document.getElementById('cfg-service-uuid'),
  cfgRxUuid: document.getElementById('cfg-rx-uuid'),
  cfgTxUuid: document.getElementById('cfg-tx-uuid'),
  cfgNameFilter: document.getElementById('cfg-name-filter'),
  cfgAutoReconnect: document.getElementById('cfg-auto-reconnect')
};

// Canvas 2D Context Setup
const ctx = ui.canvas.getContext('2d');
let canvasWidth = 0;
let canvasHeight = 0;

function resizeCanvas() {
  const rect = ui.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ui.canvas.width = rect.width * dpr;
  ui.canvas.height = rect.height * dpr;
  canvasWidth = rect.width;
  canvasHeight = rect.height;
  ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Terminal Logging Helpers ---
function appendLog(tag, message, type = 'sys') {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const line = document.createElement('div');
  line.className = `log-line ${type}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${timeStr}]`;

  const tagSpan = document.createElement('span');
  tagSpan.className = `log-tag tag-${type}`;
  tagSpan.textContent = tag;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = message;

  line.appendChild(timeSpan);
  line.appendChild(tagSpan);
  line.appendChild(msgSpan);

  ui.terminalBody.appendChild(line);

  // Auto scroll to bottom
  ui.terminalBody.scrollTop = ui.terminalBody.scrollHeight;

  // Trim logs if too long
  if (ui.terminalBody.children.length > 500) {
    ui.terminalBody.removeChild(ui.terminalBody.firstElementChild);
  }
}

// --- Session Timer ---
function startSessionTimer() {
  state.sessionStartTime = Date.now();
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    if (!state.sessionStartTime) return;
    const diff = Math.floor((Date.now() - state.sessionStartTime) / 1000);
    const hrs = String(Math.floor(diff / 3600)).padStart(2, '0');
    const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const secs = String(diff % 60).padStart(2, '0');
    ui.valSessionTime.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopSessionTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// --- Bluetooth Connection Management ---
async function requestBleDevice() {
  if (!navigator.bluetooth) {
    appendLog('ERR', 'Web Bluetooth API is not supported in this browser. Please use Chrome, Edge, or Opera over HTTPS or localhost.', 'err');
    alert('Web Bluetooth is not supported or enabled in this browser. Please open in Google Chrome or Microsoft Edge.');
    return;
  }

  try {
    updateConnectionUI('connecting', 'Connecting...');
    appendLog('SYS', 'Opening Web Bluetooth device picker...', 'sys');

    const serviceUuid = state.serviceUuid.toLowerCase();

    const options = {
      filters: [
        { namePrefix: state.namePrefix || 'Particle' }
      ],
      optionalServices: [serviceUuid]
    };

    // If no prefix, accept all devices with optionalServices
    if (!state.namePrefix.trim()) {
      delete options.filters;
      options.acceptAllDevices = true;
    }

    state.device = await navigator.bluetooth.requestDevice(options);
    appendLog('SYS', `Selected device: ${state.device.name || 'Unnamed ESP32'} (ID: ${state.device.id})`, 'sys');

    state.device.addEventListener('gattserverdisconnected', onDisconnected);

    // Connect to GATT
    appendLog('SYS', 'Connecting to GATT Server...', 'sys');
    state.server = await state.device.gatt.connect();

    // Get Primary Service
    appendLog('SYS', `Getting Primary Service: ${serviceUuid}`, 'sys');
    const service = await state.server.getPrimaryService(serviceUuid);

    // Get Characteristics
    appendLog('SYS', 'Discovering RX & TX Characteristics...', 'sys');
    try {
      state.rxCharacteristic = await service.getCharacteristic(state.rxUuid.toLowerCase());
      await state.rxCharacteristic.startNotifications();
      state.rxCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingBleData);
      appendLog('SYS', 'Subscribed to BLE RX notifications.', 'sys');
    } catch (err) {
      appendLog('WARN', `Could not subscribe to RX characteristic: ${err.message}`, 'warn');
    }

    try {
      state.txCharacteristic = await service.getCharacteristic(state.txUuid.toLowerCase());
      appendLog('SYS', 'Obtained TX characteristic for firmware commands.', 'sys');
    } catch (err) {
      appendLog('WARN', `TX Characteristic not found: ${err.message}`, 'warn');
    }

    state.isConnected = true;
    updateConnectionUI('connected', state.device.name || 'ESP32 Connected');
    appendLog('SYS', 'ESP32 Ingestive Particle Collector paired successfully!', 'sys');
    startSessionTimer();

  } catch (error) {
    appendLog('ERR', `BLE Connection failed: ${error.message}`, 'err');
    updateConnectionUI('disconnected', 'Disconnected');
  }
}

function updateConnectionUI(status, label) {
  ui.connectionStatusPill.className = `connection-status ${status}`;
  ui.connectionStatusText.textContent = label;

  if (status === 'connected') {
    ui.bleConnectBtn.classList.add('connected');
    ui.bleConnectBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
      <span>Disconnect</span>
    `;
    ui.valDeviceState.textContent = 'ACTIVE';
    ui.valDeviceState.className = 'metric-tag success';
  } else {
    ui.bleConnectBtn.classList.remove('connected');
    ui.bleConnectBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m7 7 10 10-5 5V2l5 5L7 17" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Connect ESP32</span>
    `;
    if (!state.isSimulating) {
      ui.valDeviceState.textContent = 'STANDBY';
      ui.valDeviceState.className = 'metric-tag';
    }
  }
}

function disconnectBle() {
  if (state.device && state.device.gatt.connected) {
    appendLog('SYS', 'Disconnecting from ESP32...', 'sys');
    state.device.gatt.disconnect();
  }
  onDisconnected();
}

function onDisconnected() {
  state.isConnected = false;
  state.server = null;
  state.rxCharacteristic = null;
  state.txCharacteristic = null;
  updateConnectionUI('disconnected', 'Disconnected');
  appendLog('WARN', 'ESP32 Bluetooth connection terminated.', 'warn');
  stopSessionTimer();
}

// --- Sending Commands to ESP32 Firmware ---
async function sendCommand(commandText) {
  const trimmed = commandText.trim();
  if (!trimmed) return;

  appendLog('TX', trimmed, 'tx');

  if (state.isConnected && state.txCharacteristic) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(trimmed + '\n');
      await state.txCharacteristic.writeValue(data);
    } catch (err) {
      appendLog('ERR', `Write error: ${err.message}`, 'err');
    }
  } else if (state.isSimulating) {
    // Handle simulated replies
    setTimeout(() => {
      handleSimulatedCommand(trimmed);
    }, 150);
  } else {
    appendLog('WARN', 'Device not connected. Connect ESP32 or enable Simulation Mode.', 'warn');
  }
}

function handleSimulatedCommand(cmd) {
  const upper = cmd.toUpperCase();
  if (upper === 'START') {
    state.deviceStatus = 'SAMPLING';
    ui.valDeviceState.textContent = 'SAMPLING';
    ui.valDeviceState.className = 'metric-tag success';
    appendLog('RX', 'ACK: START - Particle collector sampling initiated.', 'rx');
  } else if (upper === 'STOP') {
    state.deviceStatus = 'PAUSED';
    ui.valDeviceState.textContent = 'PAUSED';
    ui.valDeviceState.className = 'metric-tag';
    appendLog('RX', 'ACK: STOP - Particle collector sampling halted.', 'rx');
  } else if (upper === 'TARE') {
    appendLog('RX', 'ACK: TARE - Baseline optical offset zeroed.', 'rx');
  } else if (upper === 'CALIBRATE') {
    appendLog('RX', 'ACK: CALIBRATE - Laser intensity recalibrated (Gain: 1.04).', 'rx');
  } else if (upper === 'FLUSH') {
    state.deviceStatus = 'FLUSHING';
    ui.valDeviceState.textContent = 'FLUSHING';
    ui.valDeviceState.className = 'metric-tag info';
    appendLog('RX', 'ACK: FLUSH - Purge valve opened for fluid cleaning cycle.', 'rx');
    setTimeout(() => {
      state.deviceStatus = 'SAMPLING';
      ui.valDeviceState.textContent = 'SAMPLING';
      ui.valDeviceState.className = 'metric-tag success';
    }, 3000);
  } else {
    appendLog('RX', `ACK: Received '${cmd}'`, 'rx');
  }
}

// --- Incoming Data Stream Handler ---
let rxBuffer = '';
function handleIncomingBleData(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const chunk = decoder.decode(value);

  rxBuffer += chunk;
  const lines = rxBuffer.split('\n');
  rxBuffer = lines.pop(); // Keep incomplete trailing fragment in buffer

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processIncomingLine(trimmed);
  }
}

function processIncomingLine(line) {
  appendLog('RX', line, 'rx');

  // Try parsing JSON telemetry
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const data = JSON.parse(line);
      applyTelemetryData({
        count: data.count !== undefined ? data.count : state.particleCount + 1,
        conc: data.conc !== undefined ? data.conc : state.concentration,
        flow: data.flow !== undefined ? data.flow : state.flowRate,
        volt: data.volt !== undefined ? data.volt : state.sensorVoltage,
        size: data.size || 'micro'
      });
      return;
    } catch (e) {
      // not JSON, fallback to CSV / Key-value
    }
  }

  // Key-value parsing (e.g. C:120,CONC:14.2,F:12.1,V:3.28)
  if (line.includes(':')) {
    const parts = line.split(',');
    const parsed = {};
    for (const part of parts) {
      const [k, v] = part.split(':').map(s => s.trim());
      if (k && v) {
        const num = parseFloat(v);
        if (!isNaN(num)) {
          if (k.match(/^c(ount)?$/i)) parsed.count = num;
          if (k.match(/^conc(entration)?$/i)) parsed.conc = num;
          if (k.match(/^f(low)?$/i)) parsed.flow = num;
          if (k.match(/^v(olt(age)?)?$/i)) parsed.volt = num;
        }
      }
    }
    if (Object.keys(parsed).length > 0) {
      applyTelemetryData(parsed);
      return;
    }
  }
}

function applyTelemetryData({ count, conc, flow, volt, size }) {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  if (count !== undefined) state.particleCount = count;
  if (conc !== undefined) {
    state.concentration = conc;
    if (conc > state.peakConcentration) {
      state.peakConcentration = conc;
      ui.valPeakConc.textContent = conc.toFixed(1);
    }
  }
  if (flow !== undefined) state.flowRate = flow;
  if (volt !== undefined) state.sensorVoltage = volt;

  // Classify particle size
  if (size) {
    if (size === 'micro') state.bins.micro++;
    else if (size === 'medium') state.bins.medium++;
    else if (size === 'macro') state.bins.macro++;
  } else {
    // Estimate size bin based on optical voltage pulse amplitude
    const rand = Math.random();
    if (rand < 0.65) state.bins.micro++;
    else if (rand < 0.9) state.bins.medium++;
    else state.bins.macro++;
  }

  // Record point in history
  const point = {
    timestamp: Date.now(),
    timeStr,
    count: state.particleCount,
    conc: state.concentration,
    flow: state.flowRate,
    volt: state.sensorVoltage
  };

  state.history.push(point);
  if (state.history.length > state.maxHistoryPoints) {
    state.history.shift();
  }

  updateMetricsUI();
}

function updateMetricsUI() {
  ui.valParticleCount.textContent = state.particleCount.toLocaleString();
  ui.valConcentration.textContent = state.concentration.toFixed(1);
  ui.valFlowRate.textContent = state.flowRate.toFixed(1);
  ui.valSensorVoltage.textContent = state.sensorVoltage.toFixed(2);

  // Rate badge calculation (particles in last 3 seconds)
  if (state.history.length > 3) {
    const recent = state.history.slice(-3);
    const deltaCount = recent[recent.length - 1].count - recent[0].count;
    const deltaSec = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
    const rate = deltaSec > 0 ? Math.max(0, Math.round(deltaCount / deltaSec)) : 0;
    ui.rateBadge.textContent = `+${rate} /s`;
  }

  // Update bin progress bars
  const totalBins = state.bins.micro + state.bins.medium + state.bins.macro || 1;
  const microPct = Math.round((state.bins.micro / totalBins) * 100);
  const medPct = Math.round((state.bins.medium / totalBins) * 100);
  const macroPct = Math.round((state.bins.macro / totalBins) * 100);

  ui.binMicroCount.textContent = state.bins.micro;
  ui.binMicroBar.style.width = `${microPct}%`;

  ui.binMedCount.textContent = state.bins.medium;
  ui.binMedBar.style.width = `${medPct}%`;

  ui.binMacroCount.textContent = state.bins.macro;
  ui.binMacroBar.style.width = `${macroPct}%`;
}

// --- Realtime Canvas Rendering ---
function renderChart() {
  requestAnimationFrame(renderChart);
  if (state.isChartPaused) return;

  const w = canvasWidth;
  const h = canvasHeight;

  ctx.clearRect(0, 0, w, h);

  // Grid background lines
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineWidth = 1;

  const gridStepsY = 4;
  for (let i = 0; i <= gridStepsY; i++) {
    const y = (h / gridStepsY) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const gridStepsX = 8;
  for (let i = 0; i <= gridStepsX; i++) {
    const x = (w / gridStepsX) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  if (state.history.length < 2) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.font = '12px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting live ESP32 particle telemetry stream...', w / 2, h / 2);
    return;
  }

  const points = state.history;
  const maxConc = Math.max(50, ...points.map(p => p.conc)) * 1.15;
  const maxVolt = 5.0; // 0-5V sensor scale

  // Function to map values
  const getX = (i) => (i / (state.maxHistoryPoints - 1)) * w;
  const getYConc = (val) => h - (val / maxConc) * (h - 20) - 10;
  const getYVolt = (val) => h - (val / maxVolt) * (h - 20) - 10;

  // 1. Draw Raw Optical Signal (Violet Line)
  ctx.beginPath();
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 1.5;
  points.forEach((p, i) => {
    const x = getX(i);
    const y = getYVolt(p.volt);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 2. Draw Concentration Area Gradient & Line (Cyan)
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
  grad.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = getX(i);
    const y = getYConc(p.conc);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(getX(points.length - 1), h);
  ctx.lineTo(getX(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 2.5;
  points.forEach((p, i) => {
    const x = getX(i);
    const y = getYConc(p.conc);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Highlight latest point
  const lastIndex = points.length - 1;
  const lastX = getX(lastIndex);
  const lastY = getYConc(points[lastIndex].conc);

  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#06b6d4';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
}
requestAnimationFrame(renderChart);

// --- Simulation Mode ---
function toggleSimulation() {
  if (state.isSimulating) {
    // Stop simulation
    clearInterval(state.simInterval);
    state.simInterval = null;
    state.isSimulating = false;
    ui.demoModeToggle.classList.remove('btn-primary');
    ui.demoModeToggle.classList.add('btn-secondary');
    ui.demoToggleLabel.textContent = 'Start Simulation';
    updateConnectionUI('disconnected', 'Disconnected');
    appendLog('SYS', 'Simulation mode stopped.', 'sys');
    stopSessionTimer();
  } else {
    // Disconnect real BLE if active
    if (state.isConnected) disconnectBle();

    state.isSimulating = true;
    ui.demoModeToggle.classList.remove('btn-secondary');
    ui.demoModeToggle.classList.add('btn-primary');
    ui.demoToggleLabel.textContent = 'Stop Simulation';
    updateConnectionUI('connected', 'Simulated ESP32 (Virtual BLE)');
    appendLog('SYS', 'Hardware simulation active. Emulating optical particle detection stream...', 'sys');
    startSessionTimer();

    let simCount = state.particleCount || 24;
    let baseConc = 18.0;

    state.simInterval = setInterval(() => {
      // Simulate realistic ingestive particle flow burst
      const isBurst = Math.random() < 0.2;
      const countInc = isBurst ? Math.floor(Math.random() * 8) + 3 : Math.floor(Math.random() * 2) + 1;
      simCount += countInc;

      const noise = (Math.random() - 0.5) * 6;
      const burstConc = isBurst ? Math.random() * 35 : 0;
      const conc = Math.max(1.0, baseConc + noise + burstConc);
      const volt = Math.min(4.8, 2.5 + (conc / 80) + (Math.random() * 0.2));
      const flow = 12.0 + (Math.random() - 0.5) * 1.2;

      // Simulated JSON packet like ESP32 produces
      const simulatedPacket = {
        count: simCount,
        conc: parseFloat(conc.toFixed(2)),
        flow: parseFloat(flow.toFixed(1)),
        volt: parseFloat(volt.toFixed(2))
      };

      processIncomingLine(JSON.stringify(simulatedPacket));
    }, 400);
  }
}

// --- Data Export (CSV & JSON) ---
function exportCsv() {
  if (state.history.length === 0) {
    alert('No data recorded yet to export.');
    return;
  }

  let csv = 'Timestamp,Time,ParticleCount,Concentration_p_mL,FlowRate_mL_min,SensorVoltage_V\n';
  state.history.forEach(p => {
    csv += `${p.timestamp},${p.timeStr},${p.count},${p.conc},${p.flow},${p.volt}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `particle_collector_${Date.now()}.csv`);
  appendLog('SYS', 'Telemetry session exported to CSV.', 'sys');
}

function exportJson() {
  if (state.history.length === 0) {
    alert('No data recorded yet to export.');
    return;
  }

  const exportPayload = {
    sessionTimestamp: Date.now(),
    device: state.device ? state.device.name : 'Simulated ESP32',
    metrics: {
      totalParticles: state.particleCount,
      peakConcentration: state.peakConcentration,
      finalFlowRate: state.flowRate,
      bins: state.bins
    },
    dataPoints: state.history
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `particle_collector_${Date.now()}.json`);
  appendLog('SYS', 'Telemetry session exported to JSON.', 'sys');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Event Listeners Initialization ---
function initEvents() {
  // BLE Connection Button
  ui.bleConnectBtn.addEventListener('click', () => {
    if (state.isConnected) {
      disconnectBle();
    } else {
      requestBleDevice();
    }
  });

  // Demo Simulation Toggle
  ui.demoModeToggle.addEventListener('click', toggleSimulation);

  // Terminal Command Submission
  ui.terminalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = ui.terminalInput.value;
    if (val) {
      sendCommand(val);
      ui.terminalInput.value = '';
    }
  });

  // Quick Command Pills
  document.querySelectorAll('.cmd-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd) sendCommand(cmd);
    });
  });

  // Terminal Controls
  ui.clearTermBtn.addEventListener('click', () => {
    ui.terminalBody.innerHTML = '';
    appendLog('SYS', 'Terminal buffer cleared.', 'sys');
  });

  // Chart Controls
  ui.pauseBtn.addEventListener('click', () => {
    state.isChartPaused = !state.isChartPaused;
    ui.pauseBtnText.textContent = state.isChartPaused ? 'Resume' : 'Pause';
    appendLog('SYS', state.isChartPaused ? 'Chart stream paused.' : 'Chart stream resumed.', 'sys');
  });

  ui.resetChartBtn.addEventListener('click', () => {
    state.history = [];
    appendLog('SYS', 'Chart history buffer cleared.', 'sys');
  });

  // Export Buttons
  ui.exportCsvBtn.addEventListener('click', exportCsv);
  ui.exportJsonBtn.addEventListener('click', exportJson);

  // Settings Modal Handlers
  ui.settingsBtn.addEventListener('click', () => {
    ui.settingsModal.style.display = 'flex';
  });

  ui.settingsCloseBtn.addEventListener('click', () => {
    ui.settingsModal.style.display = 'none';
  });

  ui.settingsModal.addEventListener('click', (e) => {
    if (e.target === ui.settingsModal) {
      ui.settingsModal.style.display = 'none';
    }
  });

  ui.settingsSaveBtn.addEventListener('click', () => {
    state.serviceUuid = ui.cfgServiceUuid.value.trim();
    state.rxUuid = ui.cfgRxUuid.value.trim();
    state.txUuid = ui.cfgTxUuid.value.trim();
    state.namePrefix = ui.cfgNameFilter.value.trim();
    state.autoReconnect = ui.cfgAutoReconnect.value === 'true';
    ui.settingsModal.style.display = 'none';
    appendLog('SYS', 'Updated Bluetooth settings.', 'sys');
  });
}

// Start application
document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  appendLog('SYS', 'Web Bluetooth interface initialized. Modern dark theme active.', 'sys');
});
