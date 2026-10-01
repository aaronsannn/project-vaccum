/**
 * Ingestive Particle Collector - Autonomous Resistance Telemetry & Vacuum Controller
 * Web Bluetooth GATT controller for ESP32.
 * Tracks circuit resistance over time, mirrors physical Green/Red LEDs, controls vacuum levels (1-5),
 * and handles autonomous task termination when resistance exceeds 1,000 Ohms.
 */

// Application State
const state = {
  // BLE Connection
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

  // Core Telemetry & Hardware State
  systemPower: false,        // Main Unit Power (ON/OFF)
  isSensing: false,          // Sensing Execution (START/STOP)
  vacuumLevel: 1,            // Vacuum suction level (1 to 5)
  currentResistance: 0.0,    // Measured circuit resistance in Ohms
  baselineResistance: 0.0,   // Empty baseline resistance in Ohms
  totalShift: 0.0,           // Shift from baseline (|R - R_base|)
  resistanceThreshold: 1000.0, // Shift cutoff threshold in Ohms (1 kΩ)
  isCalibrated: false,       // True when empty baseline is locked
  ledState: 'OFF',           // 'OFF' | 'GREEN' | 'RED'
  taskCompleted: false,

  // Historical Telemetry for Chart & CSV Export
  history: [], // { timestamp, timeStr, res, base, shift, threshold, vac, isSensing, systemPower, led }
  maxHistoryPoints: 240,

  // Timers
  sessionStartTime: null,
  timerInterval: null,
  simInterval: null,
  lastResistanceVal: 0.0,
  lastRateCalcTime: Date.now()
};

// DOM Elements
const ui = {
  // Top bar
  systemPowerToggle: document.getElementById('system-power-toggle'),
  powerToggleText: document.getElementById('power-toggle-text'),
  connectionStatusPill: document.getElementById('connection-status-pill'),
  connectionStatusText: document.getElementById('connection-status-text'),
  demoModeToggle: document.getElementById('demo-mode-toggle'),
  demoToggleLabel: document.getElementById('demo-toggle-label'),
  bleConnectBtn: document.getElementById('ble-connect-btn'),
  settingsOpenBtn: document.getElementById('settings-open-btn'),

  // Metrics
  valResistance: document.getElementById('val-resistance'),
  valBaselineResistance: document.getElementById('val-baseline-resistance'),
  valShift: document.getElementById('val-shift'),
  calibStatusBadge: document.getElementById('calib-status-badge'),
  resistanceThresholdBar: document.getElementById('resistance-threshold-bar'),
  resistancePctLabel: document.getElementById('resistance-pct-label'),
  resistanceThresholdSublabel: document.getElementById('resistance-threshold-sublabel'),
  thresholdStatusTag: document.getElementById('threshold-status-tag'),
  vacStatusTag: document.getElementById('vac-status-tag'),
  valVacuumLevel: document.getElementById('val-vacuum-level'),
  valVacuumPwm: document.getElementById('val-vacuum-pwm'),
  valDeviceState: document.getElementById('val-device-state'),
  valSessionTime: document.getElementById('val-session-time'),
  valPowerIndicator: document.getElementById('val-power-indicator'),

  // Physical LED Twin
  ledGreenUnit: document.getElementById('led-green-unit'),
  ledGreenBulb: document.getElementById('led-green-bulb'),
  ledGreenState: document.getElementById('led-green-state'),
  ledRedUnit: document.getElementById('led-red-unit'),
  ledRedBulb: document.getElementById('led-red-bulb'),
  ledRedState: document.getElementById('led-red-state'),

  // Vacuum selector buttons
  vacSelectorBadge: document.getElementById('vac-selector-badge'),
  vacButtons: document.querySelectorAll('.vac-btn'),

  // Sensing execution controls
  sensingToggleBtn: document.getElementById('sensing-toggle-btn'),
  sensingBtnText: document.getElementById('sensing-btn-text'),
  taskResetBtn: document.getElementById('task-reset-btn'),
  sensingStatusNote: document.getElementById('sensing-status-note'),

  // Chart
  canvas: document.getElementById('telemetry-canvas'),
  chartTogglePause: document.getElementById('chart-toggle-pause'),
  pauseBtnText: document.getElementById('pause-btn-text'),
  chartResetBtn: document.getElementById('chart-reset-btn'),

  // Terminal
  terminalBody: document.getElementById('terminal-body'),
  terminalCmdForm: document.getElementById('terminal-cmd-form'),
  terminalInput: document.getElementById('terminal-input'),
  clearTermBtn: document.getElementById('clear-term-btn'),
  exportCsvBtn: document.getElementById('export-csv-btn'),
  exportJsonBtn: document.getElementById('export-json-btn'),
  quickCmdButtons: document.querySelectorAll('.cmd-pill'),

  // Settings Modal
  settingsModal: document.getElementById('settings-modal'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  settingsSaveBtn: document.getElementById('settings-save-btn'),
  cfgThreshold: document.getElementById('cfg-threshold'),
  cfgServiceUuid: document.getElementById('cfg-service-uuid'),
  cfgRxUuid: document.getElementById('cfg-rx-uuid'),
  cfgTxUuid: document.getElementById('cfg-tx-uuid'),
  cfgNameFilter: document.getElementById('cfg-name-filter')
};

// Canvas 2D Context
const ctx = ui.canvas.getContext('2d');
let animationFrameId = null;

// --- Initialize App ---
function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  setupEventListeners();
  startChartRenderLoop();

  // Initial UI state
  updatePowerUI(false);
  updateSensingUI(false);
  updateLedUI('OFF');
  updateVacuumUI(1);
  updateResistanceMetrics(0.0);

  appendLog('SYS', 'System initialized. Nordic UART Service BLE configured.', 'sys');
}

// --- Responsive Canvas Setup ---
function resizeCanvas() {
  const rect = ui.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  ui.canvas.width = rect.width * dpr;
  ui.canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Main System Power Toggle
  ui.systemPowerToggle.addEventListener('click', toggleSystemPower);

  // Sensing Button (Start / Stop)
  ui.sensingToggleBtn.addEventListener('click', toggleSensing);

  // Reset / Tare Button
  ui.taskResetBtn.addEventListener('click', resetTaskCycle);

  // Vacuum Level Buttons (1 to 5)
  ui.vacButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const level = parseInt(btn.getAttribute('data-level'), 10);
      setVacuumLevel(level);
    });
  });

  // Web Bluetooth Connect Button
  ui.bleConnectBtn.addEventListener('click', () => {
    if (state.isConnected) {
      disconnectBle();
    } else {
      connectBle();
    }
  });

  // Demo / Simulation Mode Toggle
  ui.demoModeToggle.addEventListener('click', toggleDemoMode);

  // Chart Controls
  ui.chartTogglePause.addEventListener('click', () => {
    state.isChartPaused = !state.isChartPaused;
    ui.pauseBtnText.textContent = state.isChartPaused ? 'Resume' : 'Pause';
    appendLog('SYS', `Chart rendering ${state.isChartPaused ? 'paused' : 'resumed'}.`, 'sys');
  });

  ui.chartResetBtn.addEventListener('click', () => {
    state.history = [];
    appendLog('SYS', 'Chart historical buffer cleared.', 'sys');
  });

  // Terminal & Export
  ui.terminalCmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = ui.terminalInput.value.trim();
    if (cmd) {
      sendCommand(cmd);
      ui.terminalInput.value = '';
    }
  });

  ui.clearTermBtn.addEventListener('click', () => {
    ui.terminalBody.innerHTML = '';
  });

  ui.exportCsvBtn.addEventListener('click', exportCsv);
  ui.exportJsonBtn.addEventListener('click', exportJson);

  ui.quickCmdButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      sendCommand(cmd);
    });
  });

  // Settings Modal
  ui.settingsOpenBtn.addEventListener('click', () => {
    ui.cfgThreshold.value = state.resistanceThreshold;
    ui.cfgServiceUuid.value = state.serviceUuid;
    ui.cfgRxUuid.value = state.rxUuid;
    ui.cfgTxUuid.value = state.txUuid;
    ui.cfgNameFilter.value = state.namePrefix;
    ui.settingsModal.style.display = 'flex';
  });

  ui.settingsCloseBtn.addEventListener('click', () => {
    ui.settingsModal.style.display = 'none';
  });

  ui.settingsSaveBtn.addEventListener('click', () => {
    const newThresh = parseFloat(ui.cfgThreshold.value);
    if (!isNaN(newThresh) && newThresh > 0) {
      state.resistanceThreshold = newThresh;
      ui.valThreshold.textContent = newThresh.toLocaleString();
      ui.resistanceThresholdSublabel.textContent = `${newThresh.toLocaleString()} Ω`;
      sendCommand(`SET_THRESH:${newThresh}`);
    }
    state.serviceUuid = ui.cfgServiceUuid.value.trim().toLowerCase();
    state.rxUuid = ui.cfgRxUuid.value.trim().toLowerCase();
    state.txUuid = ui.cfgTxUuid.value.trim().toLowerCase();
    state.namePrefix = ui.cfgNameFilter.value.trim();

    ui.settingsModal.style.display = 'none';
    appendLog('SYS', `Settings saved. Threshold: ${state.resistanceThreshold} Ω`, 'sys');
  });
}

// --- System Power Control ---
function toggleSystemPower() {
  const newPower = !state.systemPower;
  updatePowerUI(newPower);

  // Send hardware command
  sendCommand(newPower ? 'POWER:ON' : 'POWER:OFF');

  if (!newPower && state.isSensing) {
    // Turning power off automatically halts sensing
    stopSensing();
  }
}

function updatePowerUI(powered) {
  state.systemPower = powered;
  if (powered) {
    ui.systemPowerToggle.className = 'power-toggle-btn powered-on';
    ui.powerToggleText.textContent = 'ON';
    ui.valPowerIndicator.textContent = 'ON';
    ui.valPowerIndicator.style.color = 'var(--accent-emerald)';
    if (!state.isSensing && !state.taskCompleted) {
      ui.valDeviceState.textContent = 'STANDBY';
      ui.valDeviceState.className = 'metric-tag';
    }
  } else {
    ui.systemPowerToggle.className = 'power-toggle-btn powered-off';
    ui.powerToggleText.textContent = 'OFF';
    ui.valPowerIndicator.textContent = 'OFF';
    ui.valPowerIndicator.style.color = 'var(--accent-rose)';
    ui.valDeviceState.textContent = 'POWER OFF';
    ui.valDeviceState.className = 'metric-tag';
    updateLedUI('OFF');
  }
}

// --- Vacuum Power Level (1 to 5) ---
function setVacuumLevel(level) {
  if (level < 1) level = 1;
  if (level > 5) level = 5;

  state.vacuumLevel = level;
  updateVacuumUI(level);
  sendCommand(`VAC:${level}`);
}

function updateVacuumUI(level) {
  state.vacuumLevel = level;
  ui.valVacuumLevel.textContent = level;
  ui.vacSelectorBadge.textContent = `Level ${level}`;

  // Duty cycle percentage calculation (20% to 100%)
  const duty = level * 20;
  ui.valVacuumPwm.textContent = `${duty}% Duty`;
  ui.vacStatusTag.textContent = `Level ${level} (${duty}%)`;

  // Update button active state
  ui.vacButtons.forEach(btn => {
    const btnLevel = parseInt(btn.getAttribute('data-level'), 10);
    if (btnLevel === level) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// --- Sensing Execution (Start / Stop) ---
function toggleSensing() {
  if (!state.systemPower) {
    alert('Please turn SYSTEM POWER ON before starting sensing.');
    appendLog('WARN', 'Cannot start sensing: System Power is OFF.', 'warn');
    return;
  }

  if (state.isSensing) {
    stopSensing();
    sendCommand('SENSE:STOP');
  } else {
    startSensing();
    sendCommand('SENSE:START');
  }
}

function startSensing() {
  if (!state.systemPower) return;
  state.isSensing = true;
  state.taskCompleted = false;

  updateSensingUI(true);
  updateLedUI('GREEN'); // Switch lights to GREEN upon sensing start
  startSessionTimer();

  appendLog('SYS', `Sensing task started at Vacuum Level ${state.vacuumLevel}. Cutoff threshold: ${state.resistanceThreshold} Ω.`, 'sys');
}

function stopSensing() {
  state.isSensing = false;
  updateSensingUI(false);
  stopSessionTimer();

  if (!state.taskCompleted) {
    updateLedUI('OFF');
    ui.valDeviceState.textContent = 'STANDBY';
    ui.valDeviceState.className = 'metric-tag';
  }

  appendLog('SYS', 'Sensing stopped.', 'sys');
}

function updateSensingUI(active) {
  if (active) {
    ui.sensingToggleBtn.className = 'btn btn-sense-start sensing-active';
    ui.sensingBtnText.textContent = 'STOP SENSING';
    ui.valDeviceState.textContent = 'SENSING ACTIVE';
    ui.valDeviceState.className = 'metric-tag success';
    ui.sensingStatusNote.innerHTML = `Sensing active: Vacuum suction running at <strong>Level ${state.vacuumLevel}</strong>. Monitoring resistance curve...`;
  } else {
    ui.sensingToggleBtn.className = 'btn btn-sense-start';
    ui.sensingBtnText.textContent = 'START SENSING';
    ui.sensingStatusNote.innerHTML = `Press <strong>Start Sensing</strong> to engage vacuum suction and track circuit resistance.`;
  }
}

// --- Physical Status LEDs Mirror ---
function updateLedUI(led) {
  state.ledState = led;

  // Clear states
  ui.ledGreenBulb.classList.remove('active');
  ui.ledRedBulb.classList.remove('active');
  ui.ledGreenUnit.className = 'led-unit';
  ui.ledRedUnit.className = 'led-unit';
  ui.ledGreenState.textContent = 'OFF';
  ui.ledRedState.textContent = 'OFF';

  if (led === 'GREEN') {
    ui.ledGreenBulb.classList.add('active');
    ui.ledGreenUnit.classList.add('active-unit', 'active-green');
    ui.ledGreenState.textContent = 'LIT (NORMAL)';
  } else if (led === 'RED') {
    ui.ledRedBulb.classList.add('active');
    ui.ledRedUnit.classList.add('active-unit', 'active-red');
    ui.ledRedState.textContent = 'LIT (THRESHOLD)';
  }
}

// --- Reset / Tare Cycle ---
function resetTaskCycle() {
  state.currentResistance = 0.0;
  state.baselineResistance = 0.0;
  state.totalShift = 0.0;
  state.isCalibrated = false;
  state.taskCompleted = false;
  updateResistanceMetrics(0.0, 0.0, 0.0, false);

  if (state.systemPower) {
    updateLedUI('OFF');
    ui.valDeviceState.textContent = 'STANDBY';
    ui.valDeviceState.className = 'metric-tag';
  }

  sendCommand('TARE');
  appendLog('SYS', 'Cycle reset: Baseline resistance recalibration primed.', 'sys');
}

// --- Telemetry Processing & Autonomous Threshold Cutoff ---
function applyTelemetryData({ res, base, shift, thresh, led, power, sensing, calib, vac }) {
  if (power !== undefined && power !== state.systemPower) {
    updatePowerUI(Boolean(power));
  }

  if (vac !== undefined && vac !== state.vacuumLevel) {
    updateVacuumUI(Number(vac));
  }

  if (thresh !== undefined && thresh !== state.resistanceThreshold) {
    state.resistanceThreshold = Number(thresh);
    ui.resistanceThresholdSublabel.textContent = `${Number(thresh).toLocaleString()} Ω`;
  }

  if (calib !== undefined) {
    state.isCalibrated = Boolean(calib);
  }

  if (base !== undefined) {
    state.baselineResistance = parseFloat(base);
  }

  if (shift !== undefined) {
    state.totalShift = parseFloat(shift);
  }

  if (res !== undefined) {
    const numRes = parseFloat(res);
    state.currentResistance = numRes;

    // If shift is not explicitly supplied, calculate shift from baseline
    if (shift === undefined && state.isCalibrated && state.baselineResistance > 0) {
      state.totalShift = Math.abs(numRes - state.baselineResistance);
    }

    updateResistanceMetrics(numRes, state.baselineResistance, state.totalShift, state.isCalibrated);

    // --- AUTONOMOUS CUTOFF CHECK ---
    // Trigger if totalShift exceeds the 1,000 Ohm threshold
    if (state.totalShift >= state.resistanceThreshold) {
      if (!state.taskCompleted) {
        state.taskCompleted = true;

        // Switch physical & virtual LED from GREEN to RED
        updateLedUI('RED');

        // Automatically end the sensing task
        if (state.isSensing) {
          state.isSensing = false;
          updateSensingUI(false);
          stopSessionTimer();
        }

        ui.valDeviceState.textContent = 'EXTRACTION COMPLETE';
        ui.valDeviceState.className = 'metric-tag alert';
        ui.thresholdStatusTag.textContent = 'CUTOFF TRIGGERED';
        ui.thresholdStatusTag.className = 'metric-tag alert';

        appendLog('WARN', `🚨 EXTRACTION COMPLETE: Massive resistance shift detected (ΔR = ${state.totalShift.toFixed(1)} Ω ≥ ${state.resistanceThreshold} Ω). Switched lights to RED.`, 'warn');
      }
    } else {
      if (state.isSensing && !state.taskCompleted) {
        updateLedUI('GREEN');
      }
    }
  }

  // If explicit LED state broadcasted from ESP32
  if (led && typeof led === 'string') {
    const upper = led.toUpperCase();
    if (upper === 'RED' || upper === 'GREEN' || upper === 'OFF') {
      updateLedUI(upper);
    }
  }

  if (sensing !== undefined && Boolean(sensing) !== state.isSensing && !state.taskCompleted) {
    state.isSensing = Boolean(sensing);
    updateSensingUI(state.isSensing);
  }

  // Store in historical record for graph & CSV export
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  state.history.push({
    timestamp: now.getTime(),
    timeStr: timeStr,
    res: state.currentResistance,
    base: state.baselineResistance,
    shift: state.totalShift,
    threshold: state.resistanceThreshold,
    vac: state.vacuumLevel,
    isSensing: state.isSensing,
    systemPower: state.systemPower,
    led: state.ledState
  });

  if (state.history.length > state.maxHistoryPoints) {
    state.history.shift();
  }
}

function updateResistanceMetrics(res, base, shift, calib) {
  ui.valResistance.textContent = res > 0 ? res.toFixed(1) : '0.0';

  if (calib && base > 0) {
    ui.valBaselineResistance.textContent = `${base.toFixed(1)} Ω`;
    ui.calibStatusBadge.textContent = 'Baseline Locked';
    ui.calibStatusBadge.style.color = 'var(--accent-emerald)';
    ui.calibStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  } else {
    ui.valBaselineResistance.textContent = '-- Ω';
    ui.calibStatusBadge.textContent = 'Uncalibrated';
    ui.calibStatusBadge.style.color = 'var(--text-dim)';
    ui.calibStatusBadge.style.borderColor = 'var(--border-color)';
  }

  ui.valShift.textContent = shift > 0 ? `+${shift.toFixed(1)}` : '0.0';

  const pct = Math.min(100, Math.max(0, (shift / state.resistanceThreshold) * 100));
  ui.resistanceThresholdBar.style.width = `${pct}%`;
  ui.resistancePctLabel.textContent = `${pct.toFixed(0)}% of 1k Cutoff`;

  if (pct >= 100) {
    ui.resistanceThresholdBar.className = 'progress-bar-fill fill-rose';
    ui.valShift.className = 'metric-value text-alert';
  } else {
    ui.resistanceThresholdBar.className = 'progress-bar-fill fill-cyan';
    ui.valShift.className = 'metric-value text-accent';
  }
}

// --- Web Bluetooth API Connection ---
async function connectBle() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Opera.');
    appendLog('ERR', 'Web Bluetooth API not supported.', 'err');
    return;
  }

  try {
    appendLog('SYS', 'Requesting Web Bluetooth device scan...', 'sys');
    const serviceUuid = state.serviceUuid;

    const options = {
      filters: [{ namePrefix: state.namePrefix || 'Particle' }],
      optionalServices: [serviceUuid]
    };

    if (!state.namePrefix.trim()) {
      delete options.filters;
      options.acceptAllDevices = true;
    }

    state.device = await navigator.bluetooth.requestDevice(options);
    appendLog('SYS', `Selected device: ${state.device.name || 'ESP32 Collector'} (ID: ${state.device.id})`, 'sys');

    state.device.addEventListener('gattserverdisconnected', onDisconnected);

    // Connect to GATT
    appendLog('SYS', 'Connecting to GATT Server...', 'sys');
    state.server = await state.device.gatt.connect();

    // Get Primary Nordic UART Service
    appendLog('SYS', `Getting Primary Service: ${serviceUuid}`, 'sys');
    const service = await state.server.getPrimaryService(serviceUuid);

    // Get RX Notification Characteristic
    try {
      state.rxCharacteristic = await service.getCharacteristic(state.rxUuid);
      await state.rxCharacteristic.startNotifications();
      state.rxCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingBleData);
      appendLog('SYS', 'Subscribed to BLE RX notifications.', 'sys');
    } catch (err) {
      appendLog('WARN', `Could not subscribe to RX characteristic: ${err.message}`, 'warn');
    }

    // Get TX Command Write Characteristic
    try {
      state.txCharacteristic = await service.getCharacteristic(state.txUuid);
      appendLog('SYS', 'Obtained TX characteristic for firmware commands.', 'sys');
    } catch (err) {
      appendLog('WARN', `TX Characteristic not found: ${err.message}`, 'warn');
    }

    state.isConnected = true;
    updateConnectionUI('connected', state.device.name || 'ESP32 Connected');
    appendLog('SYS', 'ESP32 Particle Collector connected successfully!', 'sys');

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
  } else {
    ui.bleConnectBtn.classList.remove('connected');
    ui.bleConnectBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m7 7 10 10-5 5V2l5 5L7 17" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Connect ESP32</span>
    `;
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
}

// --- Transmit Commands to ESP32 Firmware ---
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
    setTimeout(() => {
      handleSimulatedCommand(trimmed);
    }, 120);
  } else {
    // If not connected and not simulating
    if (!trimmed.startsWith('STATUS')) {
      appendLog('WARN', 'Command queued locally (connect ESP32 or enable Simulation Mode to execute).', 'warn');
    }
  }
}

// --- Handle Incoming BLE Data Stream ---
let rxBuffer = '';
function handleIncomingBleData(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const chunk = decoder.decode(value);

  rxBuffer += chunk;
  const lines = rxBuffer.split('\n');
  rxBuffer = lines.pop(); // Retain incomplete trailing fragment

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processIncomingLine(trimmed);
  }
}

function processIncomingLine(line) {
  appendLog('RX', line, 'rx');

  // Try parsing JSON telemetry packet
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const data = JSON.parse(line);
      applyTelemetryData(data);
      return;
    } catch (e) {
      // not JSON, fallback to comma/key-value
    }
  }

  // Key-value parsing (e.g. R:845.2,VAC:3,LED:GREEN)
  if (line.includes(':')) {
    const parts = line.split(',');
    const parsed = {};
    for (const part of parts) {
      const [k, v] = part.split(':').map(s => s.trim());
      if (k && v) {
        if (k.match(/^r(es(istance)?)?$/i)) parsed.res = parseFloat(v);
        if (k.match(/^t(hresh(old)?)?$/i)) parsed.thresh = parseFloat(v);
        if (k.match(/^v(ac(uum)?)?$/i)) parsed.vac = parseInt(v, 10);
        if (k.match(/^led$/i)) parsed.led = v.toUpperCase();
        if (k.match(/^p(wr|ower)?$/i)) parsed.power = (v === '1' || v.toUpperCase() === 'ON');
        if (k.match(/^s(ense|ensing)?$/i)) parsed.sensing = (v === '1' || v.toUpperCase() === 'START');
      }
    }
    if (Object.keys(parsed).length > 0) {
      applyTelemetryData(parsed);
      return;
    }
  }

  // Raw CSV line fallback (e.g. "842.5,1000,3,GREEN")
  if (line.includes(',')) {
    const parts = line.split(',').map(s => s.trim());
    const resVal = parseFloat(parts[0]);
    if (!isNaN(resVal)) {
      applyTelemetryData({
        res: resVal,
        thresh: parts[1] ? parseFloat(parts[1]) : state.resistanceThreshold,
        vac: parts[2] ? parseInt(parts[2], 10) : state.vacuumLevel,
        led: parts[3] ? parts[3].toUpperCase() : undefined
      });
    }
  }
}

// --- Realistic Hardware Simulation Mode ---
function toggleDemoMode() {
  state.isSimulating = !state.isSimulating;

  if (state.isSimulating) {
    ui.demoModeToggle.classList.add('sim-active');
    ui.demoToggleLabel.textContent = 'Stop Simulation';
    appendLog('SYS', 'Hardware Simulation Mode ENABLED. Powering ON simulated ESP32.', 'sys');

    // Automatically power on in simulation for instant feedback
    updatePowerUI(true);

    let simBase = 2400.0;
    let simShift = 0.0;
    let simCalibrated = false;

    state.simInterval = setInterval(() => {
      if (!state.isSimulating) return;

      if (state.systemPower && state.isSensing && !state.taskCompleted) {
        if (!simCalibrated) {
          simCalibrated = true;
          simBase = 2380.0 + (Math.random() - 0.5) * 40.0;
          simShift = 0.0;
          appendLog('RX', `Empty Baseline Locked At: ${simBase.toFixed(1)} Ω`, 'rx');
        } else {
          // Accumulation rate proportional to vacuum level 1-5
          const depositRate = state.vacuumLevel * 18.0; // Ω / sec
          const noise = (Math.random() - 0.45) * 6.0;
          simShift += (depositRate * 0.25) + noise;
          if (simShift < 0) simShift = 0;
        }

        const simCurrent = simBase + simShift;

        applyTelemetryData({
          res: simCurrent,
          base: simBase,
          shift: simShift,
          thresh: state.resistanceThreshold,
          vac: state.vacuumLevel,
          power: true,
          sensing: true,
          calib: simCalibrated,
          led: simShift >= state.resistanceThreshold ? 'RED' : 'GREEN'
        });
      } else {
        // Idle state
        simCalibrated = false;
        simShift = 0.0;
        applyTelemetryData({
          res: simBase + (Math.random() - 0.5) * 2.0,
          base: state.baselineResistance,
          shift: state.totalShift,
          thresh: state.resistanceThreshold,
          vac: state.vacuumLevel,
          power: state.systemPower,
          sensing: state.isSensing,
          calib: state.isCalibrated,
          led: state.taskCompleted ? 'RED' : (state.isSensing ? 'GREEN' : 'OFF')
        });
      }
    }, 250); // 4 Hz broadcast rate

  } else {
    ui.demoModeToggle.classList.remove('sim-active');
    ui.demoToggleLabel.textContent = 'Start Simulation';
    if (state.simInterval) {
      clearInterval(state.simInterval);
      state.simInterval = null;
    }
    appendLog('SYS', 'Hardware Simulation Mode DISABLED.', 'sys');
  }
}

function handleSimulatedCommand(cmd) {
  const upper = cmd.toUpperCase();
  if (upper === 'POWER:ON') {
    updatePowerUI(true);
    appendLog('RX', 'ACK: POWER:ON - Main ESP32 hardware powered.', 'rx');
  } else if (upper === 'POWER:OFF') {
    updatePowerUI(false);
    appendLog('RX', 'ACK: POWER:OFF - System powered down.', 'rx');
  } else if (upper === 'SENSE:START') {
    startSensing();
    appendLog('RX', `ACK: SENSE:START - Vacuum engaged at Level ${state.vacuumLevel}. Green LED ON.`, 'rx');
  } else if (upper === 'SENSE:STOP') {
    stopSensing();
    appendLog('RX', 'ACK: SENSE:STOP - Vacuum halted. Sensing standby.', 'rx');
  } else if (upper.startsWith('VAC:')) {
    const lvl = parseInt(upper.split(':')[1], 10);
    updateVacuumUI(lvl);
    appendLog('RX', `ACK: VAC:${lvl} - Motor PWM duty adjusted to ${lvl * 20}%.`, 'rx');
  } else if (upper === 'TARE') {
    resetTaskCycle();
    appendLog('RX', 'ACK: TARE - Baseline circuit offset zeroed.', 'rx');
  } else if (upper.startsWith('SET_THRESH:')) {
    const val = parseFloat(upper.split(':')[1]);
    state.resistanceThreshold = val;
    appendLog('RX', `ACK: SET_THRESH - Threshold updated to ${val} Ω.`, 'rx');
  } else {
    appendLog('RX', `ACK: Command '${cmd}' processed.`, 'rx');
  }
}

// --- Session Elapsed Timer ---
function startSessionTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.sessionStartTime = Date.now();
  state.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.sessionStartTime) / 1000);
    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    ui.valSessionTime.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopSessionTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// --- Real-time 60 FPS HTML5 Canvas Chart: Resistance Over Time ---
function startChartRenderLoop() {
  function render() {
    if (!state.isChartPaused) {
      drawResistanceChart();
    }
    animationFrameId = requestAnimationFrame(render);
  }
  animationFrameId = requestAnimationFrame(render);
}

function drawResistanceChart() {
  const width = ui.canvas.clientWidth;
  const height = ui.canvas.clientHeight;

  ctx.clearRect(0, 0, width, height);

  const paddingLeft = 60;
  const paddingRight = 24;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  // Determine dynamic Y-axis maximum
  let maxRes = state.resistanceThreshold * 1.25; // default scale slightly above cutoff
  for (const pt of state.history) {
    if (pt.res > maxRes) maxRes = pt.res * 1.15;
  }
  const minRes = 0;

  // Draw Horizontal Gridlines & Y-Axis Labels
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.fillStyle = '#64748b';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const val = minRes + (maxRes - minRes) * (i / gridSteps);
    const y = paddingTop + chartH - (i / gridSteps) * chartH;

    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(paddingLeft + chartW, y);
    ctx.stroke();

    ctx.fillText(`${Math.round(val)} Ω`, paddingLeft - 8, y + 3);
  }

  // Draw Horizontal Autonomous Cutoff Threshold Line (e.g. 1000 Ω)
  const threshY = paddingTop + chartH - ((state.resistanceThreshold - minRes) / (maxRes - minRes)) * chartH;
  if (threshY >= paddingTop && threshY <= paddingTop + chartH) {
    ctx.save();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.shadowColor = 'rgba(244, 63, 94, 0.6)';
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.moveTo(paddingLeft, threshY);
    ctx.lineTo(paddingLeft + chartW, threshY);
    ctx.stroke();

    // Threshold Marker Label
    ctx.fillStyle = '#fda4af';
    ctx.font = 'bold 10px "Outfit", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`CUTOFF THRESHOLD: ${state.resistanceThreshold.toLocaleString()} Ω`, paddingLeft + chartW - 6, threshY - 6);
    ctx.restore();
  }

  // Draw Time X-Axis
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop + chartH);
  ctx.lineTo(paddingLeft + chartW, paddingTop + chartH);
  ctx.stroke();

  if (state.history.length < 2) {
    // Empty state prompt
    ctx.fillStyle = '#475569';
    ctx.font = '13px "Outfit", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting resistance telemetry stream... Click "Connect ESP32" or "Start Simulation"', paddingLeft + chartW / 2, paddingTop + chartH / 2);
    return;
  }

  // Plot Resistance Waveform
  const points = state.history;
  const numPoints = points.length;

  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(6, 182, 212, 0.6)';
  ctx.shadowBlur = 10;

  for (let i = 0; i < numPoints; i++) {
    const x = paddingLeft + (i / (numPoints - 1)) * chartW;
    const normY = (points[i].res - minRes) / (maxRes - minRes);
    const y = paddingTop + chartH - (normY * chartH);

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // Gradient fill under the curve
  ctx.lineTo(paddingLeft + chartW, paddingTop + chartH);
  ctx.lineTo(paddingLeft, paddingTop + chartH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, paddingTop, 0, paddingTop + chartH);
  grad.addColorStop(0, 'rgba(6, 182, 212, 0.25)');
  grad.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
  ctx.fillStyle = grad;
  ctx.shadowBlur = 0;
  ctx.fill();
  ctx.restore();

  // Draw Latest Value Pulse Dot
  const lastIndex = numPoints - 1;
  const lastPt = points[lastIndex];
  const lastX = paddingLeft + chartW;
  const lastNormY = (lastPt.res - minRes) / (maxRes - minRes);
  const lastY = paddingTop + chartH - (lastNormY * chartH);

  ctx.save();
  const isOver = lastPt.res >= state.resistanceThreshold;
  ctx.fillStyle = isOver ? '#f43f5e' : '#06b6d4';
  ctx.shadowColor = isOver ? '#f43f5e' : '#06b6d4';
  ctx.shadowBlur = 14;

  ctx.beginPath();
  ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// --- Data Export (CSV & JSON) ---
function exportCsv() {
  if (state.history.length === 0) {
    alert('No data recorded yet to export.');
    return;
  }

  let csv = 'Timestamp,Time,CurrentResistance_Ohms,BaselineResistance_Ohms,ShiftDelta_Ohms,CutoffThreshold_Ohms,VacuumLevel,ExtractionActive,SystemPower,LedState\n';
  state.history.forEach(p => {
    csv += `${p.timestamp},${p.timeStr},${p.res},${p.base || 0},${p.shift || 0},${p.threshold},${p.vac},${p.isSensing ? 1 : 0},${p.systemPower ? 1 : 0},${p.led}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `particle_collector_resistance_${Date.now()}.csv`);
  appendLog('SYS', 'Resistance shift telemetry session exported to CSV.', 'sys');
}

function exportJson() {
  if (state.history.length === 0) {
    alert('No data recorded yet to export.');
    return;
  }

  const exportPayload = {
    sessionTimestamp: Date.now(),
    device: state.device ? state.device.name : 'Simulated ESP32',
    configuration: {
      resistanceThreshold: state.resistanceThreshold,
      vacuumLevel: state.vacuumLevel,
      systemPower: state.systemPower
    },
    finalState: {
      resistance: state.currentResistance,
      taskCompleted: state.taskCompleted,
      ledState: state.ledState
    },
    dataPoints: state.history
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `particle_collector_resistance_${Date.now()}.json`);
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

// --- Terminal Logging Utility ---
function appendLog(tag, msg, type = 'sys') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  line.innerHTML = `
    <span class="log-time">[${timeStr}]</span>
    <span class="log-tag tag-${type}">${tag}</span>
    <span class="log-msg">${escapeHtml(msg)}</span>
  `;

  ui.terminalBody.appendChild(line);
  ui.terminalBody.scrollTop = ui.terminalBody.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Start application
window.addEventListener('DOMContentLoaded', init);
