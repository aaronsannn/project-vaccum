#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define DEVICE_NAME "ParticleCollector-ESP32"

// Pin Definitions 
const int analogPin      = 34; // Measurement wire 
const int greenLED       = 21; // Status: Ready / Extracting 
const int redLED         = 22; // Status: Complete 
const int buttonPin      = 25; // Start / Reset Button 
const int meterButtonPin = 26; // PCB Vacuum Meter Button 
const int powerButtonPin = 33; // PCB Power Button (Deep Sleep Wake / Sleep Trigger)

// Known Hardware Variables 
const float R_fixed = 10000.0; // 10k Ohm fixed anchor resistor 
const float V_in    = 3.3;     // ESP32 logic voltage 

// Tracking Variables 
float baselineResistance = 0.0; 
float currentResistance  = 0.0; 
bool systemActive        = false;      
bool isCalibrated        = false; // Tells the board to grab a new baseline 
bool thresholdReached    = false; // Tracks if extraction is complete (1k shift)
unsigned long lastMeasurementTime = 0;  

// Vacuum Level Tracking (1 to 5)
int vacuumLevel = 1;
int lastMeterButtonState = HIGH;
unsigned long lastMeterDebounceTime = 0;
volatile bool isProgrammaticTapping = false;

// Power Button (Pin 33) Tracking
int lastPowerButtonState = HIGH;
unsigned long lastPowerDebounceTime = 0;

// USB Serial Command Buffer
String serialBuffer = "";

// --- Bidirectional BLE Setup (Nordic UART Service) ---
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // ESP32 -> Web (Notify)
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // Web -> ESP32 (Write)

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// Forward declarations
void processCommand(String cmd);
void setTargetVacuumLevel(int target);
void calibrateVacuumBase(int calLevel);
void stepMeterOnce();
void tapMeterButton();
void enterDeepSleep();

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
      processCommand(rxValue);
    }
  }
};

void sendBleTelemetry(float res, float base, float shift, const char* led, int vac) {
  if (deviceConnected && pTxCharacteristic != NULL) {
    char payload[128];
    snprintf(payload, sizeof(payload), "{\"res\":%.2f,\"base\":%.2f,\"shift\":%.2f,\"led\":\"%s\",\"vac\":%d}\n", res, base, shift, led, vac);
    pTxCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    pTxCharacteristic->notify();
  }
}

// Tap Pin 26 once to advance PCB meter by 1 level
void tapMeterButton() {
  pinMode(meterButtonPin, OUTPUT);
  digitalWrite(meterButtonPin, LOW);   // Pull to GND (simulates button press)
  delay(90);
  pinMode(meterButtonPin, INPUT_PULLUP); // Release button
  delay(140);
}

// Step single level forward (1 -> 2 -> 3 -> 4 -> 5 -> 1)
void stepMeterOnce() {
  isProgrammaticTapping = true;
  tapMeterButton();
  vacuumLevel++;
  if (vacuumLevel > 5) vacuumLevel = 1;
  isProgrammaticTapping = false;
  lastMeterButtonState = HIGH;
  lastMeterDebounceTime = millis();

  Serial.print("Vacuum Meter Level: ");
  Serial.println(vacuumLevel);
  sendBleTelemetry(currentResistance, baselineResistance, (systemActive ? abs(currentResistance - baselineResistance) : 0.0), thresholdReached ? "RED" : (systemActive ? "GREEN" : "OFF"), vacuumLevel);
}

// Calibrate / set current hardware state as base (Level 1) without pulsing Pin 26
void calibrateVacuumBase(int calLevel) {
  if (calLevel < 1 || calLevel > 5) calLevel = 1;
  vacuumLevel = calLevel;
  lastMeterButtonState = HIGH;
  lastMeterDebounceTime = millis();

  Serial.print("Vacuum Meter Calibrated to Base Level: ");
  Serial.println(vacuumLevel);
  Serial.print("Vacuum Meter Level: ");
  Serial.println(vacuumLevel);
  sendBleTelemetry(currentResistance, baselineResistance, (systemActive ? abs(currentResistance - baselineResistance) : 0.0), thresholdReached ? "RED" : (systemActive ? "GREEN" : "OFF"), vacuumLevel);
}

// Step Pin 26 forward until physical level matches target (1 is base, next is 2, etc.)
void setTargetVacuumLevel(int target) {
  if (target < 1 || target > 5) return;
  
  // Calculate forward pulses needed: e.g. from 1 to 2 = 1, from 5 to 1 = 1, from 4 to 2 = 3
  int steps = (target - vacuumLevel + 5) % 5;
  if (steps == 0) {
    Serial.print("Vacuum Meter Level: ");
    Serial.println(vacuumLevel);
    return;
  }

  isProgrammaticTapping = true;
  for (int i = 0; i < steps; i++) {
    tapMeterButton();
  }
  vacuumLevel = target;
  isProgrammaticTapping = false;
  lastMeterButtonState = HIGH;
  lastMeterDebounceTime = millis();

  Serial.print("Vacuum Meter Level: ");
  Serial.println(vacuumLevel);
  sendBleTelemetry(currentResistance, baselineResistance, (systemActive ? abs(currentResistance - baselineResistance) : 0.0), thresholdReached ? "RED" : (systemActive ? "GREEN" : "OFF"), vacuumLevel);
}

// Put ESP32 into Deep Sleep (Low Power Mode) and arm Pin 33 as wake trigger
void enterDeepSleep() {
  Serial.println("Entering Deep Sleep (Low Power Mode)...");
  systemActive = false;
  digitalWrite(greenLED, LOW);
  digitalWrite(redLED, LOW);

  // Send power off telemetry before shutting down BLE
  sendBleTelemetry(currentResistance, baselineResistance, 0.0, "OFF", vacuumLevel);
  delay(150);

  // Stop BLE stack if initialized
  if (pServer != NULL) {
    BLEDevice::deinit(true);
  }

  // Ensure button is released before arming wakeup to prevent immediate re-wake
  while (digitalRead(powerButtonPin) == LOW) {
    delay(20);
  }
  delay(200);

  // Configure Pin 33 as external RTC wakeup source (triggers when pulled LOW)
  esp_sleep_enable_ext0_wakeup((gpio_num_t)powerButtonPin, LOW);

  Serial.println("Deep Sleep active (micro-amps). Press Pin 33 to wake up.");
  Serial.flush();
  esp_deep_sleep_start();
}

// Process commands from Web Bluetooth or USB Serial
void processCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  Serial.print("[CMD] ");
  Serial.println(cmd);

  if (cmd.startsWith("VAC:")) {
    String sub = cmd.substring(4);
    if (sub == "STEP" || sub == "+1") {
      stepMeterOnce();
    } else {
      int target = sub.toInt();
      if (target >= 1 && target <= 5) {
        setTargetVacuumLevel(target);
      }
    }
  } else if (cmd.startsWith("CALIB") || cmd.startsWith("SET:")) {
    int calLvl = 1;
    int colonIdx = cmd.indexOf(':');
    if (colonIdx != -1) {
      calLvl = cmd.substring(colonIdx + 1).toInt();
      if (calLvl < 1 || calLvl > 5) calLvl = 1;
    }
    calibrateVacuumBase(calLvl);
  } else if (cmd == "STEP" || cmd == "TAP") {
    stepMeterOnce();
  } else if (cmd == "POWER:OFF" || cmd == "SLEEP" || cmd == "OFF") {
    enterDeepSleep();
  } else if (cmd == "SENSE:START" || cmd == "START") {
    if (!systemActive) {
      systemActive = true;
      isCalibrated = false;
      thresholdReached = false;
      digitalWrite(greenLED, HIGH);
      digitalWrite(redLED, LOW);
      Serial.println("System Started! Extracting...");
    }
  } else if (cmd == "SENSE:STOP" || cmd == "STOP") {
    if (systemActive) {
      systemActive = false;
      thresholdReached = false;
      digitalWrite(greenLED, LOW);
      digitalWrite(redLED, LOW);
      Serial.println("Extraction Stopped: Returned to Standby.");
      sendBleTelemetry(currentResistance, baselineResistance, 0.0, "OFF", vacuumLevel);
    }
  }
}

void setup() { 
  Serial.begin(115200); 
  pinMode(greenLED, OUTPUT); 
  pinMode(redLED, OUTPUT); 
  pinMode(buttonPin, INPUT_PULLUP);  
  pinMode(meterButtonPin, INPUT_PULLUP);
  pinMode(powerButtonPin, INPUT_PULLUP);

  digitalWrite(greenLED, LOW); 
  digitalWrite(redLED, LOW); 

  // Check if board woke up from Deep Sleep via Pin 33
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) {
    Serial.println("Woke up from Deep Sleep via Pin 33 power button!");
    // Wait until user releases Pin 33 to prevent re-entering sleep
    while (digitalRead(powerButtonPin) == LOW) {
      delay(20);
    }
    delay(200);
  } 

  // Initialize Web Bluetooth
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_TX,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pTxCharacteristic->addDescriptor(new BLE2902());

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
} 

void loop() { 
  // 1. Process USB Serial commands (from Web Serial or Serial Monitor)
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuffer.length() > 0) {
        processCommand(serialBuffer);
        serialBuffer = "";
      }
    } else {
      if (serialBuffer.length() < 32) {
        serialBuffer += c;
      }
    }
  }

  // 2. Physical extraction button on Pin 25
  if (digitalRead(buttonPin) == LOW) {  
    if (!systemActive) { 
      systemActive = true; 
      isCalibrated = false;     // Reset calibration for a fresh run 
      thresholdReached = false; // Reset complete flag
      digitalWrite(greenLED, HIGH);  
      digitalWrite(redLED, LOW);  
      Serial.println("System Started! Extracting..."); 
    } else { 
      systemActive = false; 
      thresholdReached = false;
      digitalWrite(greenLED, LOW); 
      digitalWrite(redLED, LOW); 
      Serial.println("Extraction Stopped: Returned to Standby (Press button again to start new run)."); 
      sendBleTelemetry(currentResistance, baselineResistance, 0.0, "OFF", vacuumLevel);
    } 
    delay(500);  
  } 

  // 3. Physical PCB button on Pin 26 (Cycles 1 -> 2 -> 3 -> 4 -> 5 -> 1)
  if (!isProgrammaticTapping) {
    int meterReading = digitalRead(meterButtonPin);
    if (meterReading == LOW && lastMeterButtonState == HIGH && (millis() - lastMeterDebounceTime > 250)) {
      lastMeterDebounceTime = millis();
      vacuumLevel++;
      if (vacuumLevel > 5) {
        vacuumLevel = 1;
      }
      Serial.print("Vacuum Meter Level: ");
      Serial.println(vacuumLevel);
      sendBleTelemetry(currentResistance, baselineResistance, (systemActive ? abs(currentResistance - baselineResistance) : 0.0), thresholdReached ? "RED" : (systemActive ? "GREEN" : "OFF"), vacuumLevel);
    }
    lastMeterButtonState = meterReading;
  }

  // 4. Physical PCB Power button on Pin 33 (Enter Deep Sleep / Low Power Mode)
  int powerReading = digitalRead(powerButtonPin);
  if (powerReading == LOW && lastPowerButtonState == HIGH && (millis() - lastPowerDebounceTime > 400)) {
    lastPowerDebounceTime = millis();
    enterDeepSleep();
  }
  lastPowerButtonState = powerReading;

  // 5. Active mode - Continues measuring & logging even after extraction is complete
  if (systemActive) { 
    if (millis() - lastMeasurementTime >= 1000) { 
      lastMeasurementTime = millis();  

      int rawValue = analogRead(analogPin); 

      // Dropped to 50 so it successfully grabs your phantom baseline 
      if (rawValue > 50) {  
        float V_out = (rawValue / 4095.0) * 3.3; 
        currentResistance = R_fixed * ((V_in / V_out) - 1.0); 

        // Lock in the phantom noise as the Empty Baseline on second #1 
        if (!isCalibrated) { 
          baselineResistance = currentResistance; 
          isCalibrated = true; 
          Serial.print("Empty Baseline Locked At: "); 
          Serial.println(baselineResistance); 
          sendBleTelemetry(currentResistance, baselineResistance, 0.0, "GREEN", vacuumLevel);
          return; // Skip the rest of the loop for this second 
        } 

        Serial.print("Current Resistance (Ohms): "); 
        Serial.println(currentResistance); 

        // Check how much the resistance has changed from the empty state 
        float totalShift = abs(currentResistance - baselineResistance); 

        // Switch lights to RED when extraction complete (shift > 1,000 Ω) - CONTINUES MEASURING!
        if (totalShift > 1000.0) { 
          if (!thresholdReached) {
            thresholdReached = true;
            digitalWrite(greenLED, LOW); 
            digitalWrite(redLED, HIGH); 
            Serial.println("Extraction Complete! Threshold met (> 1,000 Ω) - Lights switched to RED. (Continuing post-extraction monitoring...)"); 
          }
        } 

        sendBleTelemetry(currentResistance, baselineResistance, totalShift, thresholdReached ? "RED" : "GREEN", vacuumLevel);
      } 
    } 
  } 

  // 5. Handle BLE disconnect & re-advertising
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }
}