/*
 * ==============================================================================
 * SMART SHADOW CANOPY - BIDIRECTIONAL ESP32 FIRMWARE FOR WOKWI & HARDWARE
 * Microcontroller: ESP32 Dev Module
 * Broker: broker.hivemq.com (Port: 1883)
 * Telemetry Topic: smartcanopy/demo-7f3a9c/telemetry  (ESP32 -> Webpage)
 * Command Topic:   smartcanopy/demo-7f3a9c/command    (Webpage -> ESP32)
 * ==============================================================================
 * Features:
 *   1. Publishes real-time sensor telemetry every 2 seconds
 *   2. Listens for live commands from your webpage over MQTT
 *   3. Supports AUTO mode (sensor-driven) & MANUAL mode (webpage override)
 *   4. Allows live remote control of Servo angle (0° - 180°) and Water Pump (ON/OFF)
 *   5. Allows remote threshold calibration on-the-fly without restarting
 * ==============================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ESP32Servo.h>

// -------- PIN CONNECTIONS --------
#define LDR_PIN    34    // Analog Light Dependent Resistor (0 - 4095)
#define SOIL_PIN   35    // Analog Soil Moisture Sensor (0 - 4095)
#define DHT_PIN    15    // Digital DHT22 (Temp & Humidity)
#define SERVO_PIN  18    // PWM Servo for Canopy Louver Awning
#define PUMP_PIN   19    // Digital Output for Virtual Water Pump Relay / Blue LED

#define DHT_TYPE DHT22

// -------- WIFI CONFIGURATION --------
// Default credentials for Wokwi simulation
const char* WIFI_NAME = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// -------- MQTT BROKER CONFIGURATION --------
// HiveMQ Public Broker
const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;

// Telemetry & Command Topics
const char* MQTT_TELEMETRY_TOPIC = "smartcanopy/demo-7f3a9c/telemetry";
const char* MQTT_COMMAND_TOPIC   = "smartcanopy/demo-7f3a9c/command";

// -------- THRESHOLDS & CALIBRATION (Can be updated via webpage) --------
int   LIGHT_THRESHOLD = 2500;  // ADC > 2500 triggers shade
int   SOIL_THRESHOLD  = 1400;  // ADC < 1400 triggers pump
float TEMP_THRESHOLD  = 35.0;  // Temp > 35°C triggers shade

// -------- OPERATIONAL STATE --------
bool manualMode          = false; // false = AUTO (Sensors decide), true = MANUAL (Webpage controls)
int  manualServoAngle    = 0;     // Angle commanded from webpage (0 - 180)
bool manualPumpState     = false; // Pump state commanded from webpage (true = ON, false = OFF)

// Current actuator states
int  currentServoAngle   = 0;
bool currentPumpState    = false;
bool currentShadeClosed  = false;

// Hardware instances
DHT dht(DHT_PIN, DHT_TYPE);
Servo shadeServo;
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastPublish = 0;
const unsigned long PUBLISH_INTERVAL = 2000; // 2 seconds normal cycle

// Forward declaration
void publishTelemetry(const char* reason = "INTERVAL");

// -------- MQTT MESSAGE CALLBACK (WEBPAGE -> ESP32) --------
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Convert payload to String
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println("\n--------------------------------------------------");
  Serial.print("[MQTT COMMAND FROM WEBPAGE] Topic: ");
  Serial.println(topic);
  Serial.print("Payload: ");
  Serial.println(message);

  bool stateChanged = false;

  // 1. Process MODE command ("AUTO" or "MANUAL")
  if (message.indexOf("\"mode\":\"MANUAL\"") >= 0 || message.indexOf("\"cmd\":\"MANUAL\"") >= 0) {
    manualMode = true;
    Serial.println("-> MODE: MANUAL OVERRIDE ACTIVATED (Controlled by Webpage)");
    stateChanged = true;
  } 
  else if (message.indexOf("\"mode\":\"AUTO\"") >= 0 || message.indexOf("\"cmd\":\"AUTO\"") >= 0) {
    manualMode = false;
    Serial.println("-> MODE: AUTONOMOUS MODE ACTIVATED (Controlled by Sensors)");
    stateChanged = true;
  }

  // 2. Process SERVO ANGLE command (e.g. "servoAngle":90 or "angle":90)
  int angleIdx = message.indexOf("\"servoAngle\":");
  if (angleIdx < 0) angleIdx = message.indexOf("\"angle\":");
  
  if (angleIdx >= 0) {
    int colonIdx = message.indexOf(':', angleIdx);
    if (colonIdx >= 0) {
      int endIdx = message.indexOf(',', colonIdx);
      if (endIdx < 0) endIdx = message.indexOf('}', colonIdx);
      if (endIdx > colonIdx) {
        String angleStr = message.substring(colonIdx + 1, endIdx);
        angleStr.trim();
        int targetAngle = angleStr.toInt();
        if (targetAngle >= 0 && targetAngle <= 180) {
          manualMode = true; // Automatically switch to manual if specific angle commanded
          manualServoAngle = targetAngle;
          shadeServo.write(manualServoAngle);
          currentServoAngle = manualServoAngle;
          currentShadeClosed = (manualServoAngle >= 45);
          Serial.print("-> SERVO COMMAND: Physically turning canopy servo to ");
          Serial.print(manualServoAngle);
          Serial.println(" degrees!");
          stateChanged = true;
        }
      }
    }
  }

  // 3. Process PUMP command (e.g. "pump":"ON" or "pump":"OFF")
  if (message.indexOf("\"pump\":\"ON\"") >= 0 || message.indexOf("\"cmd\":\"PUMP_ON\"") >= 0) {
    manualMode = true;
    manualPumpState = true;
    digitalWrite(PUMP_PIN, HIGH);
    currentPumpState = true;
    Serial.println("-> PUMP COMMAND: Virtual Water Pump / LED Pin 19 turned ON!");
    stateChanged = true;
  } 
  else if (message.indexOf("\"pump\":\"OFF\"") >= 0 || message.indexOf("\"cmd\":\"PUMP_OFF\"") >= 0) {
    manualMode = true;
    manualPumpState = false;
    digitalWrite(PUMP_PIN, LOW);
    currentPumpState = false;
    Serial.println("-> PUMP COMMAND: Virtual Water Pump / LED Pin 19 turned OFF!");
    stateChanged = true;
  }

  // 4. Process THRESHOLDS updates from Webpage
  int lightThreshIdx = message.indexOf("\"lightThresh\":");
  if (lightThreshIdx >= 0) {
    int cIdx = message.indexOf(':', lightThreshIdx);
    int eIdx = message.indexOf(',', cIdx);
    if (eIdx < 0) eIdx = message.indexOf('}', cIdx);
    if (eIdx > cIdx) {
      LIGHT_THRESHOLD = message.substring(cIdx + 1, eIdx).toInt();
      Serial.print("-> Light Threshold updated to: ");
      Serial.println(LIGHT_THRESHOLD);
      stateChanged = true;
    }
  }

  int soilThreshIdx = message.indexOf("\"soilThresh\":");
  if (soilThreshIdx >= 0) {
    int cIdx = message.indexOf(':', soilThreshIdx);
    int eIdx = message.indexOf(',', cIdx);
    if (eIdx < 0) eIdx = message.indexOf('}', cIdx);
    if (eIdx > cIdx) {
      SOIL_THRESHOLD = message.substring(cIdx + 1, eIdx).toInt();
      Serial.print("-> Soil Threshold updated to: ");
      Serial.println(SOIL_THRESHOLD);
      stateChanged = true;
    }
  }

  int tempThreshIdx = message.indexOf("\"tempThresh\":");
  if (tempThreshIdx >= 0) {
    int cIdx = message.indexOf(':', tempThreshIdx);
    int eIdx = message.indexOf(',', cIdx);
    if (eIdx < 0) eIdx = message.indexOf('}', cIdx);
    if (eIdx > cIdx) {
      TEMP_THRESHOLD = message.substring(cIdx + 1, eIdx).toFloat();
      Serial.print("-> Temperature Threshold updated to: ");
      Serial.println(TEMP_THRESHOLD);
      stateChanged = true;
    }
  }

  Serial.println("--------------------------------------------------");

  // If state changed, immediately publish feedback telemetry to webpage
  if (stateChanged) {
    publishTelemetry("COMMAND_ACK");
  }
}

void connectWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_NAME);

  WiFi.begin(WIFI_NAME, WIFI_PASSWORD, 6);

  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }

  Serial.println("\nWiFi Connected successfully!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT Broker: ");
    Serial.println(MQTT_SERVER);

    String clientId = "Canopy-ESP32-";
    clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

    if (mqtt.connect(clientId.c_str())) {
      Serial.println("MQTT Connected!");
      
      // Subscribe to command topic to receive control instructions from webpage
      mqtt.subscribe(MQTT_COMMAND_TOPIC);
      Serial.print("Subscribed to Command Topic: ");
      Serial.println(MQTT_COMMAND_TOPIC);

      // Publish initial state
      publishTelemetry("STARTUP");
    } else {
      Serial.print("MQTT Connection failed, rc=");
      Serial.println(mqtt.state());
      Serial.println("Retrying in 2 seconds...");
      delay(2000);
    }
  }
}

void publishTelemetry(const char* reason) {
  // Read sensors
  int lightValue = analogRead(LDR_PIN);
  int soilValue  = analogRead(SOIL_PIN);

  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  bool validDHT = !isnan(temperature) && !isnan(humidity);

  // DECISION LOGIC
  if (manualMode) {
    // Controlled directly by webpage
    currentServoAngle  = manualServoAngle;
    currentShadeClosed = (manualServoAngle >= 45);
    currentPumpState   = manualPumpState;
  } else {
    // Autonomous decision logic:
    // Shade deploys if sunlight is high OR temperature is dangerous
    currentShadeClosed = (lightValue > LIGHT_THRESHOLD) ||
                         (validDHT && temperature > TEMP_THRESHOLD);
    currentServoAngle  = currentShadeClosed ? 90 : 0;
    shadeServo.write(currentServoAngle);

    // Irrigation pump activates if soil is dry
    currentPumpState = (soilValue < SOIL_THRESHOLD);
    digitalWrite(PUMP_PIN, currentPumpState ? HIGH : LOW);
  }

  // Construct JSON payload
  String payload = "{";
  payload += "\"light\":" + String(lightValue) + ",";
  payload += "\"soil\":" + String(soilValue) + ",";
  payload += "\"temperature\":";
  payload += validDHT ? String(temperature, 1) : "null";
  payload += ",\"humidity\":";
  payload += validDHT ? String(humidity, 1) : "null";
  payload += ",\"shade\":\"" + String(currentShadeClosed ? "CLOSED" : "OPEN") + "\",";
  payload += "\"servoAngle\":" + String(currentServoAngle) + ",";
  payload += "\"pump\":\"" + String(currentPumpState ? "ON" : "OFF") + "\",";
  payload += "\"mode\":\"" + String(manualMode ? "MANUAL" : "AUTO") + "\",";
  payload += "\"reason\":\"" + String(reason) + "\",";
  payload += "\"lightThresh\":" + String(LIGHT_THRESHOLD) + ",";
  payload += "\"soilThresh\":" + String(SOIL_THRESHOLD) + ",";
  payload += "\"tempThresh\":" + String(TEMP_THRESHOLD, 1) + ",";
  payload += "\"uptimeMs\":" + String(millis());
  payload += "}";

  bool sent = mqtt.publish(MQTT_TELEMETRY_TOPIC, payload.c_str());

  Serial.print("Telemetry [");
  Serial.print(reason);
  Serial.print("]: ");
  Serial.println(payload);

  if (!sent) {
    Serial.println("-> MQTT Publish failed!");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  analogReadResolution(12); // ESP32 12-bit ADC (0 - 4095)

  dht.begin();

  shadeServo.setPeriodHertz(50);
  shadeServo.attach(SERVO_PIN, 500, 2400);
  shadeServo.write(0); // 0 degrees = Canopy OPEN

  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, LOW); // Pump OFF initially

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(mqttCallback); // Set command handler callback

  connectWiFi();

  Serial.println("==================================================");
  Serial.println("  SMART SHADOW CANOPY - TWO-WAY CONTROL INITIALIZED");
  Serial.println("==================================================");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!mqtt.connected()) {
    connectMQTT();
  }

  mqtt.loop(); // Crucial: processes incoming command packets from webpage

  if (millis() - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = millis();
    publishTelemetry("PERIODIC");
  }
}
