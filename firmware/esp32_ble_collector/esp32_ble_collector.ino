/*
 * Ingestive Particle Collector - ESP32 BLE Telemetry & Autonomous Controller
 * 
 * Hardware Pins:
 * - analogPin = 34: Measurement wire (Voltage Divider with 10k fixed anchor)
 * - greenLED  = 21: Status: Ready / Extracting
 * - redLED    = 22: Status: Complete (1,000 Ω Shift detected)
 * - buttonPin = 25: Physical Start / Emergency Stop button (INPUT_PULLUP)
 * - vacuumPin = 23: Vacuum Motor PWM (Levels 1 to 5)
 *
 * Senses resistance change from an empty baseline:
 * totalShift = abs(currentResistance - baselineResistance) > 1000.0 Ohms
 * Communicates bidirectionally over Nordic UART Service Web Bluetooth.
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define DEVICE_NAME "ParticleCollector-ESP32"

// --- Pin Definitions ---
const int analogPin     = 34; // Measurement wire (ADC)
const int greenLED      = 21; // Status: Ready / Extracting
const int redLED        = 22; // Status: Complete
const int buttonPin     = 25; // Physical Start / Stop Button
const int powerPin      = 33; // D33: Controls ON / OFF Power State
const int levelMeterPin = 26; // D26: Controls Level Meter (1-5 indicator)
const int vacuumPin     = 23; // Vacuum motor PWM drive (Levels 1-5)

// PWM Channel configuration (LEDC)
#define VAC_PWM_CHANNEL     0
#define VAC_PWM_FREQ        5000
#define VAC_PWM_RESOLUTION  8

// --- Known Hardware Constants ---
const float R_fixed = 10000.0; // 10k Ohm fixed anchor resistor
const float V_in    = 3.3;     // ESP32 logic voltage

// --- Operational Tracking Variables ---
float baselineResistance    = 0.0;
float currentResistance     = 0.0;
float totalShift            = 0.0;
float shiftThreshold        = 1000.0; // 1k Ohm cutoff trigger
bool systemPowered          = true;   // Main power state
bool systemActive           = false;  // Extracting / Sensing state
bool isCalibrated           = false;  // Tells the board to lock empty baseline on second #1
bool taskCompleted          = false;
int vacuumLevel             = 1;      // Vacuum power level 1 to 5
String ledState             = "OFF";  // "OFF", "GREEN", "RED"

unsigned long lastMeasurementTime = 0;
unsigned long lastBleTelemetryTime = 0;
const unsigned long BLE_TELEMETRY_INTERVAL_MS = 250;

// Button debouncing
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long DEBOUNCE_DELAY_MS = 250;

// --- BLE UUIDs (Nordic UART Service) ---
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // Web -> ESP32
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 -> Web

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Forward Declarations
void updateHardwareOutputs();
void startExtraction();
void stopExtraction(bool completed);
void processIncomingCommand(String cmd);
void sendBleTelemetry();

// --- BLE Callbacks ---
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
  }
  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue();
    if (rxValue.length() > 0) {
      rxValue.trim();
      processIncomingCommand(rxValue);
    }
  }
};

void setup() {
  Serial.begin(115200);

  // Configure Pins
  pinMode(greenLED, OUTPUT);
  pinMode(redLED, OUTPUT);
  pinMode(buttonPin, INPUT_PULLUP);
  pinMode(powerPin, OUTPUT);
  pinMode(levelMeterPin, OUTPUT);

  digitalWrite(greenLED, LOW);
  digitalWrite(redLED, LOW);
  digitalWrite(powerPin, HIGH); // System power ON
  digitalWrite(levelMeterPin, LOW);

  // Configure Vacuum Motor PWM (Supports ESP32 Core v3.x and v2.x)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcAttach(vacuumPin, VAC_PWM_FREQ, VAC_PWM_RESOLUTION);
  ledcWrite(vacuumPin, 0);
#else
  ledcSetup(VAC_PWM_CHANNEL, VAC_PWM_FREQ, VAC_PWM_RESOLUTION);
  ledcAttachPin(vacuumPin, VAC_PWM_CHANNEL);
  ledcWrite(VAC_PWM_CHANNEL, 0);
#endif

  // Initialize Web Bluetooth BLE
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  // TX characteristic (Notify to Web)
  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_TX,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pTxCharacteristic->addDescriptor(new BLE2902());

  // RX characteristic (Commands from Web)
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_RX,
    BLECharacteristic::PROPERTY_WRITE
  );
  pRxCharacteristic->setCallbacks(new CommandCallbacks());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("=================================================");
  Serial.println("ESP32 Ingestive Particle Collector Online");
  Serial.println("Pins: Analog 34 | Green 21 | Red 22 | Button 25 | Vac 23");
  Serial.println("=================================================");
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. Listen for the physical button press (debounced)
  int reading = digitalRead(buttonPin);
  if (reading == LOW && lastButtonState == HIGH && (currentMillis - lastDebounceTime > DEBOUNCE_DELAY_MS)) {
    lastDebounceTime = currentMillis;

    if (!systemActive) {
      startExtraction();
    } else {
      stopExtraction(false);
      Serial.println("Emergency Stop! Returned to Standby.");
    }
  }
  lastButtonState = reading;

  // 2. Active Extraction Mode: read analog pin & track baseline shift
  if (systemActive && systemPowered) {
    if (currentMillis - lastMeasurementTime >= 500) { // Check every 500ms
      lastMeasurementTime = currentMillis;

      int rawValue = analogRead(analogPin);

      // Dropped to 50 so it successfully grabs phantom baseline
      if (rawValue > 50) {
        float V_out = (rawValue / 4095.0) * V_in;
        if (V_out > 0.01 && V_out < V_in) {
          currentResistance = R_fixed * ((V_in / V_out) - 1.0);

          // Lock in the phantom noise as the Empty Baseline on second #1
          if (!isCalibrated) {
            baselineResistance = currentResistance;
            isCalibrated = true;
            totalShift = 0.0;
            Serial.print("Empty Baseline Locked At (Ohms): ");
            Serial.println(baselineResistance);
          } else {
            // Check how much the resistance has changed from empty baseline
            totalShift = abs(currentResistance - baselineResistance);

            Serial.print("Current Resistance: ");
            Serial.print(currentResistance);
            Serial.print(" Ω | Shift: ");
            Serial.print(totalShift);
            Serial.println(" Ω");

            // Autonomous Cutoff Trigger: Shift > 1000 Ohms
            if (totalShift >= shiftThreshold) {
              stopExtraction(true);
              Serial.println("Extraction Complete! Massive resistance shift detected (> 1,000 Ω).");
            }
          }
        }
      }
    }
  }

  // 3. Periodic BLE Telemetry Broadcast to Web Dashboard
  if (deviceConnected && (currentMillis - lastBleTelemetryTime >= BLE_TELEMETRY_INTERVAL_MS)) {
    lastBleTelemetryTime = currentMillis;
    sendBleTelemetry();
  }

  // 4. Handle Disconnection & Re-advertising
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }
}

// --- Extraction Control Functions ---
void startExtraction() {
  systemActive = true;
  taskCompleted = false;
  isCalibrated = false; // Reset calibration for fresh run
  totalShift = 0.0;
  ledState = "GREEN";

  updateHardwareOutputs();
  Serial.println("System Started! Extracting...");
  sendBleTelemetry();
}

void stopExtraction(bool completed) {
  systemActive = false;
  taskCompleted = completed;
  ledState = completed ? "RED" : "OFF";

  updateHardwareOutputs();
  sendBleTelemetry();
}

// --- Helper for PWM compatibility across ESP32 Core versions ---
void setVacuumPwm(int duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcWrite(vacuumPin, duty);
#else
  ledcWrite(VAC_PWM_CHANNEL, duty);
#endif
}

// --- Output Actuator Controller ---
void updateHardwareOutputs() {
  digitalWrite(powerPin, systemPowered ? HIGH : LOW);

  if (!systemPowered) {
    digitalWrite(greenLED, LOW);
    digitalWrite(redLED, LOW);
    digitalWrite(levelMeterPin, LOW);
    setVacuumPwm(0);
    ledState = "OFF";
    return;
  }

  // Level meter indicator
  digitalWrite(levelMeterPin, (vacuumLevel > 0 && systemActive) ? HIGH : LOW);

  if (ledState == "GREEN") {
    digitalWrite(greenLED, HIGH);
    digitalWrite(redLED, LOW);
  } else if (ledState == "RED") {
    digitalWrite(greenLED, LOW);
    digitalWrite(redLED, HIGH);
  } else {
    digitalWrite(greenLED, LOW);
    digitalWrite(redLED, LOW);
  }

  // Vacuum Motor: Runs during active extraction
  if (systemActive) {
    int duty = (vacuumLevel * 255) / 5; // 20% to 100% duty cycle
    setVacuumPwm(duty);
  } else {
    setVacuumPwm(0);
  }
}

// --- Send JSON Telemetry Packet to Web ---
void sendBleTelemetry() {
  if (!deviceConnected || pTxCharacteristic == NULL) return;

  char payload[192];
  snprintf(payload, sizeof(payload),
    "{\"res\":%.1f,\"base\":%.1f,\"shift\":%.1f,\"thresh\":%.0f,\"led\":\"%s\",\"power\":%d,\"sensing\":%d,\"calib\":%d,\"vac\":%d}\n",
    currentResistance,
    baselineResistance,
    totalShift,
    shiftThreshold,
    ledState.c_str(),
    systemPowered ? 1 : 0,
    systemActive ? 1 : 0,
    isCalibrated ? 1 : 0,
    vacuumLevel
  );

  pTxCharacteristic->setValue((uint8_t*)payload, strlen(payload));
  pTxCharacteristic->notify();
}

// --- Process Web Dashboard Commands ---
void processIncomingCommand(String cmd) {
  cmd.toUpperCase();
  Serial.print("BLE RX Command: ");
  Serial.println(cmd);

  if (cmd == "POWER:ON") {
    systemPowered = true;
    updateHardwareOutputs();
  } else if (cmd == "POWER:OFF") {
    systemPowered = false;
    systemActive = false;
    updateHardwareOutputs();
  } else if (cmd == "SENSE:START") {
    if (systemPowered) startExtraction();
  } else if (cmd == "SENSE:STOP") {
    stopExtraction(false);
  } else if (cmd.startsWith("VAC:")) {
    int lvl = cmd.substring(4).toInt();
    if (lvl >= 1 && lvl <= 5) {
      vacuumLevel = lvl;
      updateHardwareOutputs();
    }
  } else if (cmd == "TARE") {
    isCalibrated = false;
    totalShift = 0.0;
    taskCompleted = false;
    if (systemPowered) {
      ledState = systemActive ? "GREEN" : "OFF";
      updateHardwareOutputs();
    }
  } else if (cmd.startsWith("SET_THRESH:")) {
    float val = cmd.substring(11).toFloat();
    if (val > 0) shiftThreshold = val;
  }
}
