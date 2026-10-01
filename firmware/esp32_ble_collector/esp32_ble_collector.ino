/*
 * Ingestive Particle Collector - ESP32 Resistance Telemetry & Vacuum Controller
 * 
 * Hardware Features:
 * - Voltage divider resistance sensing on collector circuit.
 * - Autonomous task completion when circuit resistance exceeds threshold (default 1,000 Ω).
 * - Physical Green & Red status LEDs tracking sensing state and threshold cutoff.
 * - 5-level PWM vacuum power motor control.
 * - Nordic UART Service (NUS) Web Bluetooth communication.
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define DEVICE_NAME "ParticleCollector-ESP32"

// --- Hardware Pin Configuration ---
#define GREEN_LED_PIN       18   // Status LED: Green (Sensing Active / Normal)
#define RED_LED_PIN         19   // Status LED: Red (Threshold Reached / Cutoff)
#define VACUUM_PWM_PIN      23   // Vacuum Motor PWM Drive
#define RESISTANCE_ADC_PIN  34   // Analog Pin for Collector Circuit Voltage Divider

// PWM Channel configuration (LEDC)
#define PWM_CHANNEL         0
#define PWM_FREQ_HZ         5000
#define PWM_RESOLUTION_BITS 8

// --- Circuit Constants ---
const float KNOWN_R_REF = 1000.0; // Known reference resistor in divider (e.g. 1,000 Ω)
const float V_SUPPLY    = 3.3;    // ESP32 ADC supply reference voltage

// --- Operational State ---
bool systemPowered       = false;
bool sensingActive       = false;
int vacuumLevel          = 1;      // 1 to 5
float currentResistance  = 0.0;    // Ohms
float resistanceThreshold = 1000.0; // Cutoff target (1 kΩ)
String ledState          = "OFF";  // "OFF", "GREEN", "RED"
bool taskCompleted       = false;

// --- BLE UUIDs (Nordic UART Service) ---
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 receives commands
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 sends telemetry

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Telemetry transmit interval (4 Hz = 250ms)
unsigned long lastTelemetryTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 250;

// Forward declarations
void updateActuators();
float readCircuitResistance();
void processCommand(String cmd);

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
      processCommand(rxValue);
    }
  }
};

void setup() {
  Serial.begin(115200);

  // Configure LED pins
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);

  // Configure Vacuum Motor PWM
  ledcSetup(PWM_CHANNEL, PWM_FREQ_HZ, PWM_RESOLUTION_BITS);
  ledcAttachPin(VACUUM_PWM_PIN, PWM_CHANNEL);
  ledcWrite(PWM_CHANNEL, 0); // initial 0% duty

  // Initialize Web Bluetooth BLE
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  // TX characteristic (notify telemetry to web dashboard)
  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_TX,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pTxCharacteristic->addDescriptor(new BLE2902());

  // RX characteristic (receive commands from web dashboard)
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

  Serial.println("ESP32 Ingestive Particle Collector BLE Online.");
}

void loop() {
  unsigned long currentMillis = millis();

  // Read resistance continuously
  currentResistance = readCircuitResistance();

  // --- Autonomous Task Completion Logic ---
  // When sensing is active and resistance exceeds 1,000 Ω (or set threshold)
  if (systemPowered && sensingActive && (currentResistance >= resistanceThreshold)) {
    sensingActive = false;
    taskCompleted = true;
    ledState = "RED"; // Switch lights from GREEN to RED
    updateActuators();
    Serial.println("AUTONOMOUS CUTOFF: Threshold 1,000 Ohms exceeded! Lights switched to RED.");
  }

  // Periodic Telemetry Broadcast over Web Bluetooth
  if (deviceConnected && (currentMillis - lastTelemetryTime >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetryTime = currentMillis;

    // Send JSON telemetry packet
    char payload[160];
    snprintf(payload, sizeof(payload),
      "{\"res\":%.1f,\"thresh\":%.0f,\"led\":\"%s\",\"power\":%d,\"sensing\":%d,\"vac\":%d}\n",
      currentResistance,
      resistanceThreshold,
      ledState.c_str(),
      systemPowered ? 1 : 0,
      sensingActive ? 1 : 0,
      vacuumLevel
    );

    pTxCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    pTxCharacteristic->notify();
  }

  // Handle BLE Disconnection / Re-advertising cleanly
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }
}

// --- Circuit Resistance Measurement Formula ---
// Reads ADC voltage divider and calculates unknown collector resistance
float readCircuitResistance() {
  if (!systemPowered) return 0.0;

  int rawAdc = analogRead(RESISTANCE_ADC_PIN);
  float vOut = (rawAdc / 4095.0) * V_SUPPLY;

  // Prevent divide-by-zero
  if (vOut <= 0.02) return 0.0;
  if (vOut >= V_SUPPLY - 0.02) return 50000.0; // High resistance saturation

  // Formula for divider: R_sensor = R_ref * (V_supply / V_out - 1)
  float rCalc = KNOWN_R_REF * ((V_SUPPLY / vOut) - 1.0);
  if (rCalc < 0.0) rCalc = 0.0;
  return rCalc;
}

// --- Actuator and LED Hardware State Controller ---
void updateActuators() {
  if (!systemPowered) {
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, LOW);
    ledcWrite(PWM_CHANNEL, 0);
    ledState = "OFF";
    return;
  }

  // Update Status LEDs
  if (ledState == "GREEN") {
    digitalWrite(GREEN_LED_PIN, HIGH);
    digitalWrite(RED_LED_PIN, LOW);
  } else if (ledState == "RED") {
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, HIGH);
  } else {
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, LOW);
  }

  // Update Vacuum Motor PWM (Levels 1 to 5 = 20% to 100% duty)
  if (sensingActive) {
    int duty = (vacuumLevel * 255) / 5; // 51, 102, 153, 204, 255
    ledcWrite(PWM_CHANNEL, duty);
  } else {
    ledcWrite(PWM_CHANNEL, 0); // Motor idle when not sensing
  }
}

// --- Process Bidirectional Commands from Web App ---
void processCommand(String cmd) {
  cmd.toUpperCase();
  Serial.print("BLE RX Command: ");
  Serial.println(cmd);

  if (cmd == "POWER:ON") {
    systemPowered = true;
    updateActuators();
  } else if (cmd == "POWER:OFF") {
    systemPowered = false;
    sensingActive = false;
    updateActuators();
  } else if (cmd == "SENSE:START") {
    if (systemPowered) {
      sensingActive = true;
      taskCompleted = false;
      ledState = "GREEN"; // Switch lights to GREEN upon sensing
      updateActuators();
    }
  } else if (cmd == "SENSE:STOP") {
    sensingActive = false;
    if (!taskCompleted) {
      ledState = "OFF";
    }
    updateActuators();
  } else if (cmd.startsWith("VAC:")) {
    int lvl = cmd.substring(4).toInt();
    if (lvl >= 1 && lvl <= 5) {
      vacuumLevel = lvl;
      updateActuators();
    }
  } else if (cmd == "TARE") {
    taskCompleted = false;
    if (systemPowered) {
      ledState = sensingActive ? "GREEN" : "OFF";
    }
    updateActuators();
  } else if (cmd.startsWith("SET_THRESH:")) {
    float val = cmd.substring(11).toFloat();
    if (val > 0) {
      resistanceThreshold = val;
    }
  }
}
