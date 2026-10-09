/**
 * Ingestive Particle Collector - Autonomous Resistance Telemetry & Vacuum Controller
 * Dual Controller: Web Bluetooth (BLE UART) & Web Serial (USB COM at 115200 baud).
 * Continuously tracks circuit resistance, incorporating baseline (~3.8k - 4.0k Ohms)
 * with noise rejection, mirrors physical LEDs, controls vacuum levels (1-5), and triggers
 * autonomous 1k-Ohm cutoff.
 */

// Application State
const state = {
  // BLE Connection
  device: null,
  server: null,
  rxCharacteristic: null,
  txCharacteristic: null,
  isConnected: false,

  // Web Serial (USB) Connection
  serialPort: null,
  serialReader: null,
  serialWriter: null,
  isSerialConnected: false,
  serialKeepReading: false,

  isSimulating: false,
  isChartPaused: false,

  // Settings
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rxUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // ESP32 -> Web (Notify)
  txUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Web -> ESP32 (Write)
  namePrefix: 'Particle',

  // Core Telemetry & Hardware State
  systemPower: true,          // Main Unit Power (Defaults to ON like ESP32)
  isSensing: false,           // Sensing Execution (START/STOP)
  vacuumLevel: 1,             // Vacuum suction level (1 to 5)
  currentResistance: 3900.0,  // Measured circuit resistance in Ohms (nominal ~3.9k)
  baselineResistance: 3900.0, // Empty baseline resistance in Ohms
  totalShift: 0.0,            // Shift from baseline (|R - R_base|)
  resistanceThreshold: 1000.0,// Shift cutoff threshold in Ohms (1 kΩ)
  isCalibrated: false,        // True when baseline is locked
  ledState: 'OFF',            // 'OFF' | 'GREEN' | 'RED'
  taskCompleted: false,

  // Historical Telemetry for Chart & CSV Export
  history: [], // { timestamp, timeStr, res, base, shift, threshold, vac, isSensing, systemPower, led }
  maxHistoryPoints: 240,

  // Timers
  sessionStartTime: null,
  timerInterval: null,
  simInterval: null,
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
  bleConnectLabel: document.getElementById('ble-connect-label'),
  serialConnectBtn: document.getElementById('serial-connect-btn'),
  serialConnectLabel: document.getElementById('serial-connect-label'),
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

  // Main Hardware Power Controls (in twin deck)
  mainPowerBadge: document.getElementById('main-power-badge'),
  mainPowerOnBtn: document.getElementById('main-power-on-btn'),
  mainPowerOffBtn: document.getElementById('main-power-off-btn'),

  // Vacuum selector buttons
  vacSelectorBadge: document.getElementById('vac-selector-badge'),
  vacButtons: document.querySelectorAll('.vac-btn'),
  vacCalibBtn: document.getElementById('vac-calib-btn'),
  vacStepBtn: document.getElementById('vac-step-btn'),

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

// --- Initialize Application ---
function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  setupEventListeners();
  startChartRenderLoop();

  // Initial UI state (System defaults to POWER ON like ESP32)
  updatePowerUI(true);
  updateSensingUI(false);
  updateLedUI('OFF');
  updateVacuumUI(1);
  updateResistanceMetrics(3900.0, 3900.0, 0.0, false);

  appendLog('SYS', 'Ingestive Particle Collector Dashboard ready.', 'sys');
  appendLog('SYS', 'Dual interface supported: Connect via Web Bluetooth or USB Serial (115200 baud).', 'sys');
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
  // Main System Power Controls (Top Bar & Main Deck)
  if (ui.systemPowerToggle) {
    ui.systemPowerToggle.addEventListener('click', () => setSystemPower(!state.systemPower));
  }
  if (ui.mainPowerOnBtn) {
    ui.mainPowerOnBtn.addEventListener('click', () => setSystemPower(true));
  }
  if (ui.mainPowerOffBtn) {
    ui.mainPowerOffBtn.addEventListener('click', () => setSystemPower(false));
  }

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

  // Vacuum Calibration Button (Sets 1 as Base)
  if (ui.vacCalibBtn) {
    ui.vacCalibBtn.addEventListener('click', () => {
      calibrateVacuumBase(1);
    });
  }

  // Vacuum Step Button (Nudges +1 pulse)
  if (ui.vacStepBtn) {
    ui.vacStepBtn.addEventListener('click', () => {
      stepVacuumMeter();
    });
  }

  // Web Bluetooth Connect Button
  ui.bleConnectBtn.addEventListener('click', () => {
    if (state.isConnected) {
      disconnectBle();
    } else {
      connectBle();
    }
  });

  // Web Serial (USB) Connect Button
  if (ui.serialConnectBtn) {
    ui.serialConnectBtn.addEventListener('click', () => {
      if (state.isSerialConnected) {
        disconnectSerial();
      } else {
        connectSerial();
      }
    });
  }

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

  // Quick Action Buttons
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
function setSystemPower(powered) {
  if (state.systemPower === powered) return;
  state.systemPower = powered;
  updatePowerUI(powered);

  // Send hardware command
  sendCommand(powered ? 'POWER:ON' : 'POWER:OFF');

  if (!powered) {
    appendLog('PWR', 'Sent POWER:OFF command. ESP32 entering Deep Sleep (Low Power Mode). Wake with PCB Pin 33 button.', 'warn');
    if (state.isSensing) {
      stopSensing();
    }
  }
}

function updatePowerUI(powered) {
  state.systemPower = powered;

  // Header Toggle Button
  if (ui.systemPowerToggle) {
    ui.systemPowerToggle.className = powered ? 'power-toggle-btn powered-on' : 'power-toggle-btn powered-off';
    ui.powerToggleText.textContent = powered ? 'ON' : 'OFF';
  }

  // Twin Control Deck Buttons
  if (ui.mainPowerBadge) {
    ui.mainPowerBadge.className = powered ? 'power-status-badge powered-on' : 'power-status-badge powered-off';
    ui.mainPowerBadge.textContent = powered ? 'POWER ON' : 'POWER OFF';
  }
  if (ui.mainPowerOnBtn && ui.mainPowerOffBtn) {
    ui.mainPowerOnBtn.classList.toggle('active', powered);
    ui.mainPowerOffBtn.classList.toggle('active', !powered);
  }

  // Metric tag
  ui.valPowerIndicator.textContent = powered ? 'ON' : 'OFF';
  ui.valPowerIndicator.style.color = powered ? 'var(--accent-emerald)' : 'var(--accent-rose)';

  if (!powered) {
    ui.valDeviceState.textContent = 'POWER OFF';
    ui.valDeviceState.className = 'metric-tag';
    updateLedUI('OFF');
  } else if (!state.isSensing && !state.taskCompleted) {
    ui.valDeviceState.textContent = 'STANDBY';
    ui.valDeviceState.className = 'metric-tag';
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
  if (ui.vacSelectorBadge) {
    ui.vacSelectorBadge.textContent = `Level ${level}`;
  }

  // Duty cycle percentage calculation (20% to 100%)
  const duty = level * 20;
  ui.valVacuumPwm.textContent = `${duty}% Duty`;
  ui.vacStatusTag.textContent = `Level ${level} (${duty}%)`;

  // Update button active state
  ui.vacButtons.forEach(btn => {
    const btnLevel = parseInt(btn.getAttribute('data-level'), 10);
    btn.classList.toggle('active', btnLevel === level);
  });
}

// Synchronize current physical meter state to Base Level 1 without pulsing Pin 26
function calibrateVacuumBase(calLevel = 1) {
  state.vacuumLevel = calLevel;
  updateVacuumUI(calLevel);
  sendCommand(`CALIB:${calLevel}`);
  appendLog('CALIB', `Vacuum meter synchronized: Physical meter calibrated to Base Level ${calLevel}.`, 'sys');
}

// Nudge / pulse physical meter forward by +1 step
function stepVacuumMeter() {
  const nextLevel = (state.vacuumLevel % 5) + 1;
  state.vacuumLevel = nextLevel;
  updateVacuumUI(nextLevel);
  sendCommand('VAC:STEP');
  appendLog('STEP', `Pulsed meter Pin 26: advanced to Level ${nextLevel}.`, 'tx');
}

// --- Sensing Execution (Start / Stop) ---
function toggleSensing() {
  // If power is currently OFF, automatically turn it ON and start sensing
  if (!state.systemPower) {
    setSystemPower(true);
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
  state.isSensing = true;
  state.taskCompleted = false;

  updateSensingUI(true);
  updateLedUI('GREEN'); // Switch lights to GREEN upon sensing start
  startSessionTimer();

  appendLog('SYS', `Sensing task started at Vacuum Level ${state.vacuumLevel}. Cutoff target: ${state.resistanceThreshold} Ω shift.`, 'sys');
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
    ui.ledGreenState.textContent = 'LIT (SENSING)';
  } else if (led === 'RED') {
    ui.ledRedBulb.classList.add('active');
    ui.ledRedUnit.classList.add('active-unit', 'active-red');
    ui.ledRedState.textContent = 'LIT (CUTOFF REACHED)';
  }
}

// --- Reset / Tare Cycle ---
function resetTaskCycle() {
  state.totalShift = 0.0;
  state.taskCompleted = false;

  // Lock baseline to current resistance if valid
  if (state.currentResistance > 10.0) {
    state.baselineResistance = state.currentResistance;
    state.isCalibrated = true;
  } else {
    state.isCalibrated = false;
  }

  updateResistanceMetrics(state.currentResistance, state.baselineResistance, 0.0, state.isCalibrated);

  if (state.systemPower) {
    updateLedUI('OFF');
    ui.valDeviceState.textContent = 'STANDBY';
    ui.valDeviceState.className = 'metric-tag';
    ui.thresholdStatusTag.textContent = `Target: ${state.resistanceThreshold.toLocaleString()} Ω`;
    ui.thresholdStatusTag.className = 'metric-tag info';
  }

  sendCommand('TARE');
  appendLog('SYS', `Baseline tared at ${state.baselineResistance.toFixed(1)} Ω. Resistance shift zeroed.`, 'sys');
}

// --- Telemetry Processing & Autonomous Threshold Cutoff ---
function applyTelemetryData({ res, base, shift, thresh, led, power, sensing, calib, vac }) {
  if (power !== undefined && Boolean(power) !== state.systemPower) {
    updatePowerUI(Boolean(power));
  }

  if (vac !== undefined && Number(vac) !== state.vacuumLevel) {
    updateVacuumUI(Number(vac));
  }

  if (thresh !== undefined && Number(thresh) !== state.resistanceThreshold) {
    state.resistanceThreshold = Number(thresh);
    ui.resistanceThresholdSublabel.textContent = `${Number(thresh).toLocaleString()} Ω`;
  }

  if (calib !== undefined) {
    state.isCalibrated = Boolean(calib);
  }

  if (base !== undefined && parseFloat(base) > 0) {
    state.baselineResistance = parseFloat(base);
  }

  if (res !== undefined) {
    const numRes = parseFloat(res);
    state.currentResistance = numRes;

    // Use reported shift or calculate shift from baseline
    if (shift !== undefined) {
      state.totalShift = parseFloat(shift);
    } else if (state.isCalibrated && state.baselineResistance > 0) {
      const rawDelta = Math.abs(numRes - state.baselineResistance);
      // Small jumps under 150 Ohms are treated as baseline stability (not a shift)
      state.totalShift = rawDelta < 150.0 ? 0.0 : rawDelta;
    }

    updateResistanceMetrics(numRes, state.baselineResistance, state.totalShift, state.isCalibrated);

    // --- 1K THRESHOLD: EXTRACTION COMPLETE (Keeps monitoring until manual button press!) ---
    if (state.totalShift >= state.resistanceThreshold) {
      if (!state.taskCompleted) {
        state.taskCompleted = true;

        // Switch physical & virtual LED from GREEN to RED
        updateLedUI('RED');

        ui.valDeviceState.textContent = 'EXTRACTION COMPLETE';
        ui.valDeviceState.className = 'metric-tag alert';
        ui.thresholdStatusTag.textContent = 'EXTRACTION COMPLETE (≥1kΩ)';
        ui.thresholdStatusTag.className = 'metric-tag alert';

        appendLog('WARN', `Extraction Complete! (ΔR = ${state.totalShift.toFixed(1)} Ω). Switched lights to RED. Continuous post-extraction monitoring active.`, 'warn');
      }
    } else {
      if (state.isSensing && !state.taskCompleted) {
        updateLedUI('GREEN');
      }
    }
  }

  // Explicit LED state broadcast from ESP32
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

  // Historical record for chart and data export
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
  // Format resistance nicely in Ohms or kOhms
  ui.valResistance.textContent = res >= 1000 ? `${(res / 1000).toFixed(2)}k` : res.toFixed(1);

  if (base > 0) {
    const baseText = base >= 1000 ? `${(base / 1000).toFixed(2)} kΩ` : `${base.toFixed(1)} Ω`;
    ui.valBaselineResistance.textContent = baseText;
    ui.calibStatusBadge.textContent = calib ? 'Baseline Locked' : 'Tracking Baseline';
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
  ui.resistancePctLabel.textContent = `${pct.toFixed(0)}% of Cutoff`;

  if (pct >= 100) {
    ui.resistanceThresholdBar.className = 'progress-bar-fill fill-rose';
    ui.valShift.className = 'metric-value text-alert';
  } else {
    ui.resistanceThresholdBar.className = 'progress-bar-fill fill-cyan';
    ui.valShift.className = 'metric-value text-accent';
  }
}

// =========================================================================
//  WEB SERIAL API (USB CABLE at 115200 Baud)
// =========================================================================
async function connectSerial() {
  if (!navigator.serial) {
    alert('Web Serial API is not supported in this browser. Please use Google Chrome or Microsoft Edge on Desktop.');
    appendLog('ERR', 'Web Serial API not supported in this browser.', 'err');
    return;
  }

  try {
    appendLog('SYS', 'Requesting USB Serial port at 115200 baud...', 'sys');
    state.serialPort = await navigator.serial.requestPort();
    await state.serialPort.open({ baudRate: 115200 });

    state.isSerialConnected = true;
    state.serialKeepReading = true;

    // Get Serial Writer
    state.serialWriter = state.serialPort.writable.getWriter();

    updateSerialConnectionUI(true);
    appendLog('SYS', 'USB Serial connected successfully at 115200 baud!', 'sys');

    // Start reading stream
    readSerialLoop();

  } catch (err) {
    appendLog('ERR', `Serial connection failed: ${err.message}`, 'err');
    disconnectSerial();
  }
}

async function readSerialLoop() {
  let textDecoder = new TextDecoderStream();
  let readableStreamClosed = state.serialPort.readable.pipeTo(textDecoder.writable);
  let reader = textDecoder.readable.getReader();
  state.serialReader = reader;

  let buffer = '';

  try {
    while (state.serialKeepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Retain incomplete trailing line
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            processIncomingLine(trimmed);
          }
        }
      }
    }
  } catch (err) {
    appendLog('WARN', `Serial read error: ${err.message}`, 'warn');
  } finally {
    reader.releaseLock();
  }
}

async function disconnectSerial() {
  state.serialKeepReading = false;
  state.isSerialConnected = false;

  try {
    if (state.serialReader) {
      await state.serialReader.cancel();
      state.serialReader = null;
    }
    if (state.serialWriter) {
      await state.serialWriter.close();
      state.serialWriter = null;
    }
    if (state.serialPort) {
      await state.serialPort.close();
      state.serialPort = null;
    }
  } catch (e) {
    // Ignore close errors
  }

  updateSerialConnectionUI(false);
  appendLog('WARN', 'USB Serial disconnected.', 'warn');
}

function updateSerialConnectionUI(connected) {
  if (connected) {
    if (ui.serialConnectBtn) {
      ui.serialConnectBtn.classList.add('connected');
      if (ui.serialConnectLabel) ui.serialConnectLabel.textContent = 'Disconnect USB';
    }
    ui.connectionStatusPill.className = 'connection-status connected';
    ui.connectionStatusText.textContent = 'USB Serial Connected (115200)';
  } else {
    if (ui.serialConnectBtn) {
      ui.serialConnectBtn.classList.remove('connected');
      if (ui.serialConnectLabel) ui.serialConnectLabel.textContent = 'Connect USB Serial';
    }
    if (!state.isConnected) {
      ui.connectionStatusPill.className = 'connection-status disconnected';
      ui.connectionStatusText.textContent = 'Disconnected';
    }
  }
}

// =========================================================================
//  WEB BLUETOOTH API (Nordic UART Service)
// =========================================================================
async function connectBle() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Opera.');
    appendLog('ERR', 'Web Bluetooth API not supported.', 'err');
    return;
  }

  try {
    appendLog('SYS', 'Scanning for BLE Particle Collector...', 'sys');
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
    appendLog('SYS', `Selected device: ${state.device.name || 'ESP32 Collector'}`, 'sys');

    state.device.addEventListener('gattserverdisconnected', onDisconnectedBle);

    // Connect to GATT
    state.server = await state.device.gatt.connect();
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
      appendLog('SYS', 'Obtained TX characteristic for commands.', 'sys');
    } catch (err) {
      appendLog('WARN', `TX Characteristic not found: ${err.message}`, 'warn');
    }

    state.isConnected = true;
    updateBleConnectionUI('connected', state.device.name || 'ESP32 Bluetooth Connected');
    appendLog('SYS', 'ESP32 Bluetooth connected successfully!', 'sys');

  } catch (error) {
    appendLog('ERR', `BLE Connection failed: ${error.message}`, 'err');
    updateBleConnectionUI('disconnected', 'Disconnected');
  }
}

function updateBleConnectionUI(status, label) {
  if (status === 'connected') {
    ui.bleConnectBtn.classList.add('connected');
    if (ui.bleConnectLabel) ui.bleConnectLabel.textContent = 'Disconnect BLE';
    ui.connectionStatusPill.className = 'connection-status connected';
    ui.connectionStatusText.textContent = label;
  } else {
    ui.bleConnectBtn.classList.remove('connected');
    if (ui.bleConnectLabel) ui.bleConnectLabel.textContent = 'Connect Bluetooth';
    if (!state.isSerialConnected) {
      ui.connectionStatusPill.className = 'connection-status disconnected';
      ui.connectionStatusText.textContent = 'Disconnected';
    }
  }
}

function disconnectBle() {
  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
  }
  onDisconnectedBle();
}

function onDisconnectedBle() {
  state.isConnected = false;
  state.server = null;
  state.rxCharacteristic = null;
  state.txCharacteristic = null;
  updateBleConnectionUI('disconnected', 'Disconnected');
  appendLog('WARN', 'ESP32 Bluetooth connection terminated.', 'warn');
}

// --- Transmit Commands to ESP32 Firmware (Serial & BLE) ---
async function sendCommand(commandText) {
  const trimmed = commandText.trim();
  if (!trimmed) return;

  appendLog('TX', trimmed, 'tx');

  // 1. Send via USB Serial if connected
  if (state.isSerialConnected && state.serialWriter) {
    try {
      const encoder = new TextEncoder();
      await state.serialWriter.write(encoder.encode(trimmed + '\n'));
    } catch (err) {
      appendLog('ERR', `Serial TX Error: ${err.message}`, 'err');
    }
  }

  // 2. Send via Web Bluetooth if connected
  if (state.isConnected && state.txCharacteristic) {
    try {
      const encoder = new TextEncoder();
      await state.txCharacteristic.writeValue(encoder.encode(trimmed + '\n'));
    } catch (err) {
      appendLog('ERR', `BLE TX Error: ${err.message}`, 'err');
    }
  }

  // 3. Handle in Simulation Mode
  if (state.isSimulating) {
    setTimeout(() => {
      handleSimulatedCommand(trimmed);
    }, 80);
  } else if (!state.isConnected && !state.isSerialConnected && !trimmed.startsWith('STATUS')) {
    appendLog('WARN', `Command '${trimmed}' executed locally. (Connect USB Serial or Bluetooth to send to physical board).`, 'warn');
  }
}

// --- Handle Incoming BLE Data Stream ---
let bleRxBuffer = '';
function handleIncomingBleData(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const chunk = decoder.decode(value);

  bleRxBuffer += chunk;
  const lines = bleRxBuffer.split('\n');
  bleRxBuffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) processIncomingLine(trimmed);
  }
}

// --- Parse Incoming Telemetry Lines (Both Serial and BLE) ---
function processIncomingLine(line) {
  // Ignore raw status log prints from firmware to keep terminal clean
  if (line.startsWith('[STATUS]')) {
    appendLog('ESP32', line, 'rx');
    return;
  }
  // Check for System Started and Emergency Stop messages
  if (line.includes('System Started! Extracting')) {
    if (!state.isSensing) startSensing();
    appendLog('ESP32', line, 'rx');
    return;
  }
  // Check for Deep Sleep and Wakeup messages
  if (line.includes('Entering Deep Sleep') || line.includes('Deep Sleep active')) {
    updatePowerUI(false);
    appendLog('ESP32', line, 'warn');
    return;
  }
  if (line.includes('Woke up from Deep Sleep')) {
    updatePowerUI(true);
    appendLog('ESP32', line, 'sys');
    return;
  }
  if (line.includes('Empty Baseline Locked At:')) {
    const baseMatch = line.match(/Empty Baseline Locked At:\s*([\d\.]+)/i);
    if (baseMatch) {
      state.baselineResistance = parseFloat(baseMatch[1]);
      state.isCalibrated = true;
      updateResistanceMetrics(state.currentResistance, state.baselineResistance, 0.0, true);
    }
    appendLog('ESP32', line, 'rx');
    return;
  }

  // Parse Vacuum Meter Level format: "Vacuum Meter Level: 3" or "Vacuum Meter Calibrated to Base Level: 1"
  const vacMatch = line.match(/(?:Vacuum\s+(?:Meter\s+)?(?:Calibrated\s+to\s+Base\s+)?Level|VAC)\s*[:=]\s*(\d+)/i);
  if (vacMatch) {
    const lvl = parseInt(vacMatch[1], 10);
    if (lvl >= 1 && lvl <= 5) {
      updateVacuumUI(lvl);
      appendLog('ESP32', line, 'rx');
      return;
    }
  }

  // Parse concise format: "Current Resistance (Ohms): 4740.82" or "Current Resistance: 3912.4"
  const matchCurrentRes = line.match(/(?:Current\s+)?Resistance(?:\s*\([^\)]*\))?\s*:\s*([\d\.]+)/i);
  if (matchCurrentRes) {
    const rVal = parseFloat(matchCurrentRes[1]);
    if (!isNaN(rVal)) {
      applyTelemetryData({ res: rVal });
      appendLog('ESP32', line, 'rx');
      return;
    }
  }

  // Try parsing JSON telemetry packet
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const data = JSON.parse(line);
      applyTelemetryData(data);
      return;
    } catch (e) {
      // not JSON, fallback to key-value
    }
  }

  // Key-value parsing (e.g. R:3920.5,VAC:3,LED:GREEN)
  if (line.includes(':')) {
    const parts = line.split(',');
    const parsed = {};
    for (const part of parts) {
      const [k, v] = part.split(':').map(s => s.trim());
      if (k && v) {
        if (k.match(/^r(es(istance)?)?$/i)) parsed.res = parseFloat(v);
        if (k.match(/^b(ase)?$/i)) parsed.base = parseFloat(v);
        if (k.match(/^s(hift)?$/i)) parsed.shift = parseFloat(v);
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

  appendLog('RX', line, 'rx');
}

// --- Realistic Hardware Simulation Mode ---
function toggleDemoMode() {
  state.isSimulating = !state.isSimulating;

  if (state.isSimulating) {
    ui.demoModeToggle.classList.add('sim-active');
    ui.demoToggleLabel.textContent = 'Stop Simulation';
    appendLog('SYS', 'Simulation Mode ENABLED. Powering ON simulated ESP32.', 'sys');

    updatePowerUI(true);

    // Realistic baseline: ~3900 Ohms (3.8k to 4.0k)
    let simBase = 3920.0;
    let simShift = 0.0;
    let simCalibrated = true;

    state.simInterval = setInterval(() => {
      if (!state.isSimulating) return;

      if (state.systemPower && state.isSensing && !state.taskCompleted) {
        // Accumulation rate proportional to vacuum level 1-5
        const depositRate = state.vacuumLevel * 22.0; // Ω / sec
        const noise = (Math.random() - 0.48) * 8.0;
        simShift += (depositRate * 0.25) + noise;
        if (simShift < 0) simShift = 0;

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
        // Standby baseline with minor natural jitter (+/- 15 Ohms, shift remains 0)
        const jitter = (Math.random() - 0.5) * 15.0;
        applyTelemetryData({
          res: simBase + jitter,
          base: simBase,
          shift: 0.0,
          thresh: state.resistanceThreshold,
          vac: state.vacuumLevel,
          power: state.systemPower,
          sensing: state.isSensing,
          calib: simCalibrated,
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
  if (upper === 'POWER:ON' || upper === 'ON') {
    updatePowerUI(true);
    appendLog('RX', 'ACK: POWER:ON - Main hardware powered.', 'rx');
  } else if (upper === 'POWER:OFF' || upper === 'OFF') {
    updatePowerUI(false);
    appendLog('RX', 'ACK: POWER:OFF - System powered down.', 'rx');
  } else if (upper === 'SENSE:START' || upper === 'START') {
    startSensing();
    appendLog('RX', `ACK: SENSE:START - Vacuum running at Level ${state.vacuumLevel}. Green LED ON.`, 'rx');
  } else if (upper === 'SENSE:STOP' || upper === 'STOP') {
    stopSensing();
    appendLog('RX', 'ACK: SENSE:STOP - Vacuum halted. Sensing standby.', 'rx');
  } else if (upper.startsWith('CALIB') || upper.startsWith('SET:')) {
    let calLvl = 1;
    if (upper.includes(':')) calLvl = parseInt(upper.split(':')[1], 10) || 1;
    if (calLvl < 1 || calLvl > 5) calLvl = 1;
    updateVacuumUI(calLvl);
    appendLog('RX', `ACK: CALIB - Vacuum calibrated to Base Level ${calLvl}.`, 'rx');
  } else if (upper === 'VAC:STEP' || upper === 'STEP' || upper === 'TAP') {
    let nextLvl = (state.vacuumLevel % 5) + 1;
    updateVacuumUI(nextLvl);
    appendLog('RX', `ACK: STEP - Vacuum stepped to Level ${nextLvl}.`, 'rx');
  } else if (upper.startsWith('VAC:')) {
    const lvl = parseInt(upper.split(':')[1], 10);
    if (lvl >= 1 && lvl <= 5) {
      updateVacuumUI(lvl);
      appendLog('RX', `ACK: VAC:${lvl} - Motor PWM duty adjusted to ${lvl * 20}%.`, 'rx');
    }
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
  let maxRes = (state.baselineResistance + state.resistanceThreshold) * 1.25;
  if (maxRes < 5500) maxRes = 5500;
  let minRes = Math.max(0, state.baselineResistance - 500);

  for (const pt of state.history) {
    if (pt.res > maxRes) maxRes = pt.res * 1.15;
    if (pt.res < minRes) minRes = Math.max(0, pt.res * 0.9);
  }

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

    const label = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Math.round(val)} Ω`;
    ctx.fillText(label, paddingLeft - 8, y + 3);
  }

  // Draw Horizontal Autonomous Cutoff Threshold Line (Baseline + 1,000 Ω)
  const cutoffTarget = state.baselineResistance + state.resistanceThreshold;
  const threshY = paddingTop + chartH - ((cutoffTarget - minRes) / (maxRes - minRes)) * chartH;
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

    ctx.fillStyle = '#fda4af';
    ctx.font = 'bold 10px "Outfit", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`CUTOFF TARGET: ${(cutoffTarget / 1000).toFixed(2)} kΩ (+${state.resistanceThreshold.toLocaleString()} Ω)`, paddingLeft + chartW - 6, threshY - 6);
    ctx.restore();
  }

  // Draw Time X-Axis
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.beginPath();
  ctx.moveTo(paddingLeft, paddingTop + chartH);
  ctx.lineTo(paddingLeft + chartW, paddingTop + chartH);
  ctx.stroke();

  if (state.history.length < 2) {
    ctx.fillStyle = '#475569';
    ctx.font = '13px "Outfit", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting resistance telemetry stream... Connect USB Serial, Bluetooth, or Start Simulation', paddingLeft + chartW / 2, paddingTop + chartH / 2);
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

  // Gradient fill under curve
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

  // Latest Value Pulse Dot
  const lastIndex = numPoints - 1;
  const lastPt = points[lastIndex];
  const lastX = paddingLeft + chartW;
  const lastNormY = (lastPt.res - minRes) / (maxRes - minRes);
  const lastY = paddingTop + chartH - (lastNormY * chartH);

  ctx.save();
  const isOver = state.totalShift >= state.resistanceThreshold;
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
    device: state.device ? state.device.name : (state.isSerialConnected ? 'ESP32 USB Serial' : 'Simulated ESP32'),
    configuration: {
      resistanceThreshold: state.resistanceThreshold,
      vacuumLevel: state.vacuumLevel,
      systemPower: state.systemPower
    },
    finalState: {
      resistance: state.currentResistance,
      baseline: state.baselineResistance,
      shift: state.totalShift,
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
