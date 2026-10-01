/*
 * Ingestive Particle Collector - ESP32 BLE UART Firmware
 * 
 * Provides continuous wireless telemetry to the Web Bluetooth dashboard,
 * freeing the Arduino IDE serial port from lockups and buffer conflicts.
 * 
 * Uses standard Nordic UART Service (NUS) compatible with Web Bluetooth.
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define DEVICE_NAME "ParticleCollector-ESP32"

// Nordic UART Service (NUS) UUIDs
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 receives commands
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 sends telemetry

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Collector Telemetry Variables
uint32_t cumulativeParticles = 0;
float instantaneousConc = 0.0; // particles / mL
float fluidFlowRate = 12.0;    // mL / min
float opticalSensorVolts = 3.3;
bool samplingActive = true;

// Non-blocking timer for telemetry transmission (e.g. 5 Hz / 200ms)
unsigned long lastTelemetryTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 250;

// BLE Server Callbacks
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
  }

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
  }
};

// BLE Characteristic Callbacks for incoming Web commands
class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue();

    if (rxValue.length() > 0) {
      rxValue.trim();
      
      // Echo command processing
      if (rxValue.equalsIgnoreCase("START")) {
        samplingActive = true;
      } else if (rxValue.equalsIgnoreCase("STOP")) {
        samplingActive = false;
      } else if (rxValue.equalsIgnoreCase("TARE")) {
        cumulativeParticles = 0;
      }
    }
  }
};

void setup() {
  // Initialize BLE Device
  BLEDevice::init(DEVICE_NAME);

  // Create BLE Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  // Create BLE Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Create TX Characteristic (Notify web dashboard)
  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_TX,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pTxCharacteristic->addDescriptor(new BLE2902());

  // Create RX Characteristic (Receive web commands)
  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_RX,
    BLECharacteristic::PROPERTY_WRITE
  );
  pRxCharacteristic->setCallbacks(new CommandCallbacks());

  // Start the BLE Service
  pService->start();

  // Start Advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06); // iPhone/Chrome connection helper
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

void loop() {
  unsigned long currentMillis = millis();

  // Transmit telemetry periodically over BLE
  if (deviceConnected && (currentMillis - lastTelemetryTime >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetryTime = currentMillis;

    if (samplingActive) {
      // Replace this block with your actual sensor reading logic (e.g. analogRead from optical sensor)
      // Example simulation of particle detection:
      int detectedBurst = (random(0, 100) > 85) ? random(1, 4) : 0;
      cumulativeParticles += detectedBurst;
      instantaneousConc = (detectedBurst * 15.0) + (random(5, 20) / 10.0);
      opticalSensorVolts = 2.5 + (instantaneousConc / 50.0);

      // Format payload as JSON string
      char payload[128];
      snprintf(payload, sizeof(payload),
        "{\"count\":%lu,\"conc\":%.2f,\"flow\":%.1f,\"volt\":%.2f}\n",
        cumulativeParticles, instantaneousConc, fluidFlowRate, opticalSensorVolts
      );

      pTxCharacteristic->setValue((uint8_t*)payload, strlen(payload));
      pTxCharacteristic->notify();
    }
  }

  // Handle Disconnection / Re-advertising cleanly
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); // give the bluetooth stack the chance to get things ready
    pServer->startAdvertising(); // restart advertising so web dashboard can reconnect
    oldDeviceConnected = deviceConnected;
  }

  // Handle Connection established
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }
}
