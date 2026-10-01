# Ingestive Particle Collector — Web Bluetooth Dashboard

A real-time laboratory telemetry dashboard and control interface for ESP32-powered Ingestive Particle Collectors. Communicates wirelessly using the **Web Bluetooth API** (Nordic UART Service), completely replacing the Arduino IDE Serial Monitor to prevent COM port lockups, timing jitter, and firmware crashes.

---

## 🚀 Quick Start

### 1. Launch the Web Development Server
In your terminal, navigate to this project folder and run:

```bash
npm run dev
```

Then open the local URL (usually `http://localhost:5173`) in **Google Chrome**, **Microsoft Edge**, or **Opera** (browsers that support the Web Bluetooth API).

> **Note on Web Bluetooth:** Web Bluetooth requires a secure context (`localhost` or `https://`). It will not run from a raw `file:///` path.

---

## ⚡ Features

1. **Direct Web Bluetooth (BLE UART)**:
   - Wireless connection to ESP32 using the standard Nordic UART Service (`6E400001-B5A3-F393-E0A9-E50E24DCCA9E`).
   - Auto-reconnection handling when the device is toggled or reset.
2. **Real-Time Dynamic Telemetry**:
   - 60 FPS Canvas chart tracking instantaneous particle concentration (`particles/mL`) and sensor optical voltage (`mV`).
   - Particle classification bins: Micro (< 5 μm), Medium (5–25 μm), and Macro (> 25 μm).
   - Session stats: Cumulative particle count, peak concentration, flow rate, and session elapsed timer.
3. **Firmware Terminal & Monitor**:
   - Clean, color-coded serial monitor replacement (`[SYS]`, `[RX]`, `[TX]`, `[WARN]`, `[ERR]`).
   - Quick command buttons (`START`, `STOP`, `TARE`, `CALIBRATE`, `FLUSH`).
   - Interactive CLI command input to send custom commands directly to ESP32 firmware.
4. **Data Export**:
   - Export full telemetry history to **CSV** or formatted **JSON** for laboratory analysis.
5. **Simulation Mode**:
   - Built-in hardware simulation toggle to test the full dashboard, graphs, and UI without needing physical hardware connected.

---

## 📂 Project Structure

```
ingestive-particle-collector/
├── index.html                           # Modern laboratory telemetry UI
├── style.css                            # Glassmorphic dark lab theme
├── app.js                              # Web Bluetooth GATT controller & chart engine
├── package.json                         # Vite dev server configuration
├── .gitignore                           # Git ignore rules
└── firmware/
    └── esp32_ble_collector/
        └── esp32_ble_collector.ino      # ESP32 Arduino sketch with BLE UART
```

---

## 🔌 ESP32 Firmware Integration

The `firmware/esp32_ble_collector/esp32_ble_collector.ino` sketch demonstrates how to:
- Broadcast telemetry packets periodically in JSON format:
  ```json
  {"count": 142, "conc": 18.5, "flow": 12.0, "volt": 3.32}
  ```
- Receive web commands (`START`, `STOP`, `TARE`) without blocking the main CPU loop.
- Automatically re-advertise BLE when disconnected.
