# Ingestive Particle Collector — Autonomous Telemetry & Vacuum Controller

A real-time laboratory telemetry dashboard and control interface for ESP32-powered Ingestive Particle Collectors. Communicates wirelessly using the **Web Bluetooth API** (Nordic UART Service), completely replacing the Arduino IDE Serial Monitor to avoid COM port lockups, timing jitter, and firmware crashes.

---

## ⚡ Key Features

1. **Resistance Over Time Telemetry**:
   - Continuous 60 FPS HTML5 Canvas graph plotting measured circuit resistance ($\Omega$) in real-time.
   - Dynamic auto-scaling Y-axis with glowing neon trace.
   - Visible dashed cutoff threshold marker (default: **1,000 Ω / 1 kΩ**).

2. **Autonomous Task Cutoff (1 kΩ Threshold)**:
   - When particle accumulation causes circuit resistance to reach or exceed the set threshold ($R \ge 1,000\ \Omega$):
     - The task **autonomously completes**.
     - Vacuum suction stops.
     - The physical and virtual status LEDs switch from **GREEN to RED**.
     - An alert is logged to the terminal and telemetry status is updated.

3. **Physical Hardware Twin (Virtual LED Mirror)**:
   - Photorealistic digital twin on the dashboard that lights up at the exact instance physical hardware LEDs illuminate:
     - **GREEN LED**: Lit when sensing is active and resistance is below 1 kΩ.
     - **RED LED**: Lit when the 1 kΩ threshold is reached / task cutoff.
     - **OFF**: When the unit is in standby or powered down.

4. **Vacuum Power Level Controller (1 to 5)**:
   - 5 selectable power modes (Level 1 = 20% PWM duty up to Level 5 = 100% max suction).
   - Monitored live and controllable from the web dashboard buttons (`VAC:1` to `VAC:5`).

5. **Independent System Power & Sensing Execution**:
   - **System Power Toggle**: Controls main hardware power state (`POWER:ON` / `POWER:OFF`).
   - **Sensing Execution Button**: Separate trigger to start/stop the sensing cycle (`SENSE:START` / `SENSE:STOP`).

6. **Interactive Simulation Mode**:
   - Built-in hardware simulation toggle to test power-on, vacuum levels 1-5, particle accumulation, and the autonomous 1 kΩ cutoff without needing physical hardware connected.

7. **Data Export**:
   - Export full session telemetry to timestamped **CSV** or formatted **JSON**:
     ```csv
     Timestamp,Time,Resistance_Ohms,Threshold_Ohms,VacuumLevel,SensingActive,SystemPower,LedState
     ```

---

## 🚀 Quick Start

### 1. Launch the Web Development Server
In your terminal, navigate to this project folder and run:

```bash
npm.cmd run dev
```

Then open the local URL (usually `http://localhost:5173`) in **Google Chrome** or **Microsoft Edge**.

> **Note on Web Bluetooth:** Web Bluetooth requires a secure origin (`localhost` or `https://`). It will not run directly from a raw `file:///` path.

### 2. Test in Simulation Mode
- Click **"Start Simulation"** in the top navigation bar.
- Notice System Power turns ON.
- Select your desired **Vacuum Level (1 to 5)**.
- Click **"START SENSING"**:
  - The **Green LED** lights up.
  - The graph begins plotting resistance climbing over time.
  - As soon as resistance crosses **1,000 Ω**, the task autonomously completes and the **Red LED** turns on!

---

## 📂 Project Structure

```
ingestive-particle-collector/
├── index.html                           # Laboratory dashboard & physical twin UI
├── style.css                            # Glassmorphic dark lab theme & realistic LED shaders
├── app.js                              # Web Bluetooth GATT controller, chart & simulation
├── package.json                         # Vite dev server configuration
├── .gitignore                           # Git ignore rules
└── firmware/
    └── esp32_ble_collector/
        └── esp32_ble_collector.ino      # ESP32 Arduino sketch with BLE UART & resistance logic
```

---

## 🔌 ESP32 Hardware Wiring

| ESP32 Pin | Component | Description |
| :--- | :--- | :--- |
| **GPIO 18** | Green LED | Active during sensing ($R < 1\text{ k}\Omega$) |
| **GPIO 19** | Red LED | Active when threshold reached ($R \ge 1\text{ k}\Omega$) |
| **GPIO 23** | Vacuum Motor (PWM / MOSFET) | 5 kHz PWM speed control (Levels 1-5) |
| **GPIO 34** | Voltage Divider ADC | Collector circuit resistance sensor |

---

## 📡 BLE Commands Reference

| Command | Action |
| :--- | :--- |
| `POWER:ON` | Turn on main system hardware |
| `POWER:OFF` | Turn off main system hardware |
| `SENSE:START` | Engage vacuum and begin sensing resistance |
| `SENSE:STOP` | Halt sensing and vacuum motor |
| `VAC:1` ... `VAC:5` | Set vacuum power level (20% to 100% duty) |
| `TARE` | Zero baseline resistance and reset cycle |
| `SET_THRESH:<val>` | Set custom resistance cutoff threshold (default 1000) |
