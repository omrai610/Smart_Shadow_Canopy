/**
 * ==============================================================================
 * SMART SHADOW CANOPY OS - CLIENT-SIDE TELEMETRY & PHYSICAL TWIN ENGINE
 * Real-time HiveMQ WebSockets MQTT Client + Interactive ESP32 Physics Simulator
 * ==============================================================================
 */

// Global State
const state = {
  mode: 'mqtt', // 'mqtt' | 'sim'
  telemetry: {
    light: 2500,
    soil: 1400,
    temperature: 28.4,
    humidity: 55.0,
    shade: 'OPEN',
    servoAngle: 0,
    pump: 'OFF',
    uptimeMs: 0,
    timestamp: Date.now()
  },
  previousActuators: {
    shade: 'OPEN',
    pump: 'OFF'
  },
  thresholds: {
    light: 2500,
    temp: 35.0,
    soil: 1400
  },
  mqttConfig: {
    host: 'broker.hivemq.com',
    port: 8884,
    path: '/mqtt',
    topic: 'smartcanopy/demo-7f3a9c/telemetry',
    commandTopic: 'smartcanopy/demo-7f3a9c/command',
    clientId: 'CanopyWeb-' + Math.random().toString(16).substring(2, 10),
    useSSL: true
  },
  systemMode: 'AUTO', // 'AUTO' | 'MANUAL'
  lastCommandTimestamp: 0,
  units: {
    temp: 'C' // 'C' | 'F'
  },
  audioEnabled: true,
  broadcastSimToMqtt: false,
  noiseJitter: true,
  packetCount: 0,
  mqttClient: null,
  charts: {
    analog: null,
    climate: null
  },
  history: {
    timestamps: [],
    light: [],
    soil: [],
    temp: [],
    humidity: []
  },
  maxHistoryPoints: 25,
  simTimer: null
};

// ==============================================================================
// 1. SYNTHESIZED WEB AUDIO API SOUND SYSTEM
// ==============================================================================
class SoundFX {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playServoHum(targetAngle) {
    if (!state.audioEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      // Pitch slide representing mechanical servo motor rotation
      const startFreq = targetAngle > 0 ? 180 : 320;
      const endFreq = targetAngle > 0 ? 320 : 180;

      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.35);

      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.36);
    } catch (e) {
      console.warn('Audio FX error:', e);
    }
  }

  playPumpClick(isStarting) {
    if (!state.audioEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isStarting ? 520 : 260, now);
      osc.frequency.exponentialRampToValueAtTime(isStarting ? 880 : 180, now + 0.12);

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {
      console.warn('Audio FX error:', e);
    }
  }

  playAlertChime() {
    if (!state.audioEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const freqs = [587.33, 880]; // D5 -> A5 sci-fi chime

      freqs.forEach((f, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + idx * 0.08);

        gain.gain.setValueAtTime(0.05, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.26);
      });
    } catch (e) {
      console.warn('Audio FX error:', e);
    }
  }
}

const soundFx = new SoundFX();

// ==============================================================================
// 2. PAHO MQTT CLIENT MANAGER
// ==============================================================================
class MqttManager {
  constructor() {
    this.client = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.client) {
      try { this.client.disconnect(); } catch (e) {}
    }

    if (typeof Paho === 'undefined' || !Paho.MQTT || !Paho.MQTT.Client) {
      logTerminal('Notice: Paho MQTT library not loaded (offline or CDN blocked).', 'warn');
      logTerminal('Interactive Physics Simulator is fully active with all controls & scenarios!', 'system');
      updateStatusDot('sim', 'MODE: OFFLINE SIMULATOR', 'Interactive Controls Active');
      // Auto switch to sim mode
      const modeSimBtn = document.getElementById('modeSimBtn');
      if (modeSimBtn && state.mode !== 'sim') {
        modeSimBtn.click();
      }
      return;
    }

    const { host, port, path, topic, clientId, useSSL } = state.mqttConfig;
    logTerminal(`Connecting to MQTT Broker: wss://${host}:${port}${path}...`, 'system');
    updateStatusDot('connecting', `MQTT: CONNECTING...`, `${host}:${port}`);

    try {
      // Paho MQTT Client constructor
      this.client = new Paho.MQTT.Client(host, Number(port), path, clientId);

      this.client.onConnectionLost = (responseObject) => {
        state.mqttConfig.connected = false;
        if (responseObject.errorCode !== 0) {
          logTerminal(`MQTT Connection Lost: ${responseObject.errorMessage}`, 'err');
        }
        if (state.mode === 'mqtt') {
          updateStatusDot('offline', 'MQTT: DISCONNECTED', 'Retrying in 4s...');
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), 4000);
        }
      };

      this.client.onMessageArrived = (message) => {
        if (state.mode !== 'mqtt') return; // Ignore incoming packets while in simulator mode
        this.handleMessage(message);
      };

      const options = {
        timeout: 5,
        useSSL: useSSL,
        cleanSession: true,
        onSuccess: () => {
          state.mqttConfig.connected = true;
          logTerminal(`MQTT Connected! Subscribing to topic: ${topic}`, 'system');
          updateStatusDot('online', 'MQTT: CONNECTED', topic);
          
          this.client.subscribe(topic, {
            onSuccess: () => {
              logTerminal(`Subscribed successfully to ${topic}`, 'system');
            },
            onFailure: (err) => {
              logTerminal(`Failed to subscribe: ${err.errorMessage}`, 'err');
            }
          });
        },
        onFailure: (err) => {
          state.mqttConfig.connected = false;
          logTerminal(`MQTT Connection Failed: ${err.errorMessage || 'Timeout/Network error'}`, 'err');
          if (state.mode === 'mqtt') {
            updateStatusDot('offline', 'MQTT: FAILED', 'Retrying in 5s...');
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.connect(), 5000);
          }
        }
      };

      this.client.connect(options);
    } catch (err) {
      logTerminal(`MQTT Client Exception: ${err.message}`, 'err');
      updateStatusDot('offline', 'MQTT: ERROR', err.message);
    }
  }

  handleMessage(message) {
    try {
      const payloadStr = message.payloadString;
      const data = JSON.parse(payloadStr);

      state.packetCount++;
      document.getElementById('packetCountBadge').textContent = `Packets: ${state.packetCount}`;

      // Update state telemetry
      state.telemetry.light = typeof data.light === 'number' ? data.light : state.telemetry.light;
      state.telemetry.soil = typeof data.soil === 'number' ? data.soil : state.telemetry.soil;
      if (data.temperature !== null && typeof data.temperature === 'number') {
        state.telemetry.temperature = data.temperature;
      }
      if (data.humidity !== null && typeof data.humidity === 'number') {
        state.telemetry.humidity = data.humidity;
      }
      if (typeof data.shade === 'string') {
        state.telemetry.shade = data.shade.toUpperCase();
      }
      if (typeof data.servoAngle === 'number') {
        state.telemetry.servoAngle = data.servoAngle;
      }
      if (typeof data.pump === 'string') {
        state.telemetry.pump = data.pump.toUpperCase();
      }
      if (typeof data.uptimeMs === 'number') {
        state.telemetry.uptimeMs = data.uptimeMs;
      }
      state.telemetry.timestamp = Date.now();

      // Check for Wokwi Remote Control Mode ACK
      if (data.mode) {
        state.systemMode = data.mode;
        const btnAuto = document.getElementById('btnSetAutoMode');
        const btnManual = document.getElementById('btnSetManualMode');
        const modeTag = document.getElementById('modeTag');
        const modeHint = document.getElementById('modeHint');

        if (data.mode === 'MANUAL') {
          if (btnManual) btnManual.classList.add('active');
          if (btnAuto) btnAuto.classList.remove('active');
          if (modeTag) {
            modeTag.textContent = 'MODE: MANUAL (WEBPAGE)';
            modeTag.className = 'mode-tag tag-manual';
          }
          if (modeHint) modeHint.textContent = 'Webpage has direct manual override over Wokwi actuators.';
        } else {
          if (btnAuto) btnAuto.classList.add('active');
          if (btnManual) btnManual.classList.remove('active');
          if (modeTag) {
            modeTag.textContent = 'MODE: AUTO (SENSORS)';
            modeTag.className = 'mode-tag tag-auto';
          }
          if (modeHint) modeHint.textContent = 'ESP32 autonomously reacts to Wokwi sensors (LDR & DHT22).';
        }
      }

      // Check for Command ACK and round-trip ping time
      if (data.reason === 'COMMAND_ACK') {
        const pingMs = Math.max(1, Math.round(performance.now() - state.lastCommandTimestamp));
        const pingDot = document.getElementById('pingDot');
        const pingText = document.getElementById('pingText');
        if (pingDot) pingDot.className = 'ping-dot';
        if (pingText) pingText.textContent = `Wokwi Ack: ${pingMs}ms ✅`;
        logTerminal(`[WOKWI ACKNOWLEDGED] Command executed in Wokwi ESP32 (${pingMs}ms round-trip)!`, 'system');
        soundFx.playAlertChime();
      }

      // Sync Remote Deck Badges & Sliders
      const cmdAngleBadge = document.getElementById('cmdAngleBadge');
      const remoteServoSlider = document.getElementById('remoteServoSlider');
      if (cmdAngleBadge) cmdAngleBadge.textContent = `${state.telemetry.servoAngle}°`;
      if (remoteServoSlider && document.activeElement !== remoteServoSlider) {
        remoteServoSlider.value = state.telemetry.servoAngle;
      }

      const cmdPumpBadge = document.getElementById('cmdPumpBadge');
      if (cmdPumpBadge) {
        cmdPumpBadge.textContent = state.telemetry.pump;
        if (state.telemetry.pump === 'ON') {
          cmdPumpBadge.className = 'pump-state-badge active-pumping';
        } else {
          cmdPumpBadge.className = 'pump-state-badge';
        }
      }

      // Log packet snippet
      logTerminal(`[PACKET #${state.packetCount}] ${payloadStr}`, 'packet');

      // Update visual twin, cards, and charts
      renderAll();
    } catch (err) {
      logTerminal(`Error parsing telemetry payload: ${err.message}`, 'err');
    }
  }

  publishCommand(cmdObj) {
    state.lastCommandTimestamp = performance.now();
    const pingDot = document.getElementById('pingDot');
    const pingText = document.getElementById('pingText');
    if (pingDot) pingDot.className = 'ping-dot dispatching';
    if (pingText) pingText.textContent = 'Dispatching to Wokwi...';

    const jsonStr = JSON.stringify(cmdObj);
    logTerminal(`[SENDING COMMAND TO WOKWI] -> ${jsonStr}`, 'warn');

    // Also update local twin state immediately for fluid zero-latency response
    if (cmdObj.mode) state.systemMode = cmdObj.mode;
    if (typeof cmdObj.servoAngle === 'number') {
      state.telemetry.servoAngle = cmdObj.servoAngle;
      state.telemetry.shade = cmdObj.servoAngle >= 45 ? 'CLOSED' : 'OPEN';
      renderAll();
    }
    if (cmdObj.pump) {
      state.telemetry.pump = cmdObj.pump;
      renderAll();
    }

    if (!this.client || !state.mqttConfig.connected) {
      logTerminal('Notice: MQTT not connected to live broker. Command reflected in local twin simulation.', 'warn');
      setTimeout(() => {
        if (pingDot) pingDot.className = 'ping-dot';
        if (pingText) pingText.textContent = 'Simulated Locally';
      }, 250);
      return;
    }

    try {
      const message = new Paho.MQTT.Message(jsonStr);
      message.destinationName = state.mqttConfig.commandTopic;
      this.client.send(message);
    } catch (e) {
      logTerminal(`MQTT Publish Command Failed: ${e.message}`, 'err');
    }
  }

  publishSimData(payloadObj) {
    if (!this.client || !state.mqttConfig.connected) return;
    try {
      const jsonStr = JSON.stringify(payloadObj);
      const message = new Paho.MQTT.Message(jsonStr);
      message.destinationName = state.mqttConfig.topic;
      this.client.send(message);
      logTerminal(`[BROADCAST SIM] -> ${jsonStr}`, 'packet');
    } catch (e) {
      console.warn('MQTT Publish error:', e);
    }
  }
}

const mqttManager = new MqttManager();

// ==============================================================================
// 3. PHYSICAL TWIN & CANOPY VISUAL ENGINE
// ==============================================================================
class CanopyVisualizer {
  constructor() {
    this.louverElements = document.querySelectorAll('.canopy-louver .louver-blade');
    this.tieRod = document.getElementById('servoTieRod');
    this.servoHorn = document.getElementById('servoHornArm');
    this.groundShadow = document.getElementById('canopyGroundShadow');
    this.soilBed = document.getElementById('soilBedPath');
    this.soilCracks = document.getElementById('soilCracks');
    this.waterDroplets = document.getElementById('waterDropletsGroup');
    this.waterPulseLine = document.getElementById('waterPulseLine');
    this.pumpImpeller = document.getElementById('pumpImpeller');
    this.pumpHousing = document.getElementById('pumpHousing');
    this.pumpLed = document.getElementById('pumpLedDot');
    this.sunOrb = document.getElementById('sunOrb');
    this.sunCore = document.querySelector('.sun-glow-core');
    this.skyBackdrop = document.getElementById('skyBackdrop');
    this.heatWaves = document.getElementById('heatWavesContainer');
    this.cropPlants = document.querySelectorAll('.crop-plant');
    this.hudStatusText = document.getElementById('hudStateText');
    this.hudStatusDot = document.getElementById('hudStateDot');
  }

  update(telemetry, thresholds) {
    const { light, soil, temperature, servoAngle, pump, shade } = telemetry;
    const isCanopyClosed = servoAngle >= 45 || shade === 'CLOSED';
    const isPumpOn = pump === 'ON';

    // 1. ROTATE CANOPY LOUVERS (0° -> 90°)
    // Physical awning slats pivot from horizontal (open) to vertical (closed)
    const angle = isCanopyClosed ? 90 : 0;
    this.louverElements.forEach((blade, index) => {
      blade.style.transform = `rotate(${angle}deg)`;
      blade.setAttribute('transform', `rotate(${angle}, 0, 3)`);
      blade.setAttribute('fill', isCanopyClosed ? 'url(#canopyFabricClosed)' : 'url(#canopyFabricOpen)');
    });

    // Animate Servo Horn Arm
    if (this.servoHorn) {
      this.servoHorn.setAttribute('transform', `rotate(${angle}, 12, 0)`);
    }

    // Dynamic Tie-Rod Linkage shift
    if (this.tieRod) {
      const rodY = isCanopyClosed ? 135 : 125;
      this.tieRod.setAttribute('y1', rodY);
      this.tieRod.setAttribute('y2', rodY);
    }

    // 2. SOFT CANOPY GROUND SHADOW
    if (this.groundShadow) {
      if (isCanopyClosed) {
        this.groundShadow.setAttribute('opacity', '0.75');
        this.groundShadow.setAttribute('rx', '410');
      } else {
        this.groundShadow.setAttribute('opacity', '0.15');
        this.groundShadow.setAttribute('rx', '340');
      }
    }

    // 3. SUN INTENSITY & ATMOSPHERE
    // LDR: 0 (dark night) to 4095 (scorching sunlight)
    const lightRatio = Math.min(Math.max(light / 4095, 0), 1);

    if (this.sunOrb) {
      // Dynamic scaling and opacity
      const scale = 0.6 + lightRatio * 0.75;
      this.sunOrb.style.transform = `translateX(-50%) scale(${scale})`;
      this.sunOrb.style.opacity = Math.max(0.15, lightRatio * 1.1).toString();
    }

    if (this.sunCore) {
      if (light > thresholds.light) {
        this.sunCore.style.boxShadow = '0 0 50px #ef4444, 0 0 100px rgba(239, 68, 68, 0.8)';
      } else {
        this.sunCore.style.boxShadow = '0 0 35px #f59e0b, 0 0 70px rgba(245, 158, 11, 0.6)';
      }
    }

    // Sky Backdrop Color Blend based on Light Intensity
    if (this.skyBackdrop) {
      if (light < 800) {
        // Night / twilight sky
        this.skyBackdrop.style.background = 'linear-gradient(180deg, #030712 0%, #081026 50%, #111827 100%)';
      } else if (light > thresholds.light) {
        // High solar radiation blazing sky
        this.skyBackdrop.style.background = 'linear-gradient(180deg, #1c1917 0%, #451a03 40%, #7c2d12 75%, #1e293b 100%)';
      } else {
        // Normal daytime clear sky
        this.skyBackdrop.style.background = 'linear-gradient(180deg, #070d1e 0%, #0d1b38 45%, #182848 80%, #1f2937 100%)';
      }
    }

    // 4. HEAT SHIMMER WAVES
    if (this.heatWaves) {
      if (temperature > thresholds.temp) {
        this.heatWaves.style.opacity = '1';
      } else {
        this.heatWaves.style.opacity = '0';
      }
    }

    // 5. SOIL HYDRATION & PLANT LUSHNESS
    // Soil: 0 (dry) to 4095 (wet/saturated)
    const isDrySoil = soil < thresholds.soil;

    if (this.soilBed) {
      this.soilBed.setAttribute('fill', isDrySoil ? 'url(#soilGradientDry)' : 'url(#soilGradientMoist)');
    }
    if (this.soilCracks) {
      this.soilCracks.setAttribute('opacity', isDrySoil ? '0.7' : '0.05');
    }

    this.cropPlants.forEach(plant => {
      if (isDrySoil && !isCanopyClosed) {
        plant.classList.add('wilted');
        plant.classList.remove('lush');
      } else {
        plant.classList.remove('wilted');
        plant.classList.add('lush');
      }
    });

    // 6. DRIP IRRIGATION PUMP & DROPLETS
    if (this.waterDroplets) {
      if (isPumpOn) {
        this.waterDroplets.classList.remove('droplets-hidden');
        this.waterDroplets.classList.add('droplets-active');
      } else {
        this.waterDroplets.classList.add('droplets-hidden');
        this.waterDroplets.classList.remove('droplets-active');
      }
    }

    if (this.waterPulseLine) {
      this.waterPulseLine.style.opacity = isPumpOn ? '0.9' : '0.15';
    }

    if (this.pumpImpeller) {
      if (isPumpOn) {
        this.pumpImpeller.classList.add('pump-spinning');
      } else {
        this.pumpImpeller.classList.remove('pump-spinning');
      }
    }

    if (this.pumpHousing && this.pumpLed) {
      if (isPumpOn) {
        this.pumpHousing.style.borderColor = '#38bdf8';
        this.pumpHousing.style.boxShadow = '0 0 15px rgba(56, 189, 248, 0.6)';
        this.pumpLed.setAttribute('fill', '#38bdf8');
      } else {
        this.pumpHousing.style.borderColor = '#334155';
        this.pumpHousing.style.boxShadow = 'none';
        this.pumpLed.setAttribute('fill', '#64748b');
      }
    }

    // 7. VIEWPORT HUD BANNER
    if (this.hudStatusText && this.hudStatusDot) {
      if (isCanopyClosed) {
        this.hudStatusText.textContent = `CANOPY SHIELD DEPLOYED (${servoAngle}°) • PROTECTING CROPS`;
        this.hudStatusDot.setAttribute('fill', '#c084fc');
      } else {
        this.hudStatusText.textContent = `CANOPY RETRACTED (${servoAngle}°) • HARVESTING SUNLIGHT`;
        this.hudStatusDot.setAttribute('fill', '#22c55e');
      }
    }

    // Top Mini Stats Strip
    document.getElementById('miniCanopyVal').textContent = `${servoAngle}° (${shade})`;
    document.getElementById('miniPumpVal').textContent = pump;
    document.getElementById('miniUptimeVal').textContent = formatUptime(telemetry.uptimeMs);

    // Viewport HUD Tags
    document.getElementById('hudSunVal').textContent = `LDR: ${light.toLocaleString()}`;
    document.getElementById('hudTempVal').textContent = formatTemp(temperature);
    document.getElementById('hudSoilVal').textContent = `Soil: ${soil.toLocaleString()}`;
  }
}

const canopyVisualizer = new CanopyVisualizer();

// ==============================================================================
// 4. CHART.JS REAL-TIME HISTORICAL CHARTS
// ==============================================================================
function initCharts() {
  if (typeof Chart === 'undefined') {
    logTerminal('Notice: Chart.js library not detected. Running with high-precision numeric & gauge HUDs.', 'warn');
    return;
  }

  const chartOptionsBase = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1,
        titleFont: { family: 'Outfit', size: 12 },
        bodyFont: { family: 'JetBrains Mono', size: 11 },
        padding: 10
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 }
      },
      y: {
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 10 } }
      }
    }
  };

  // Chart 1: Analog (Light & Soil)
  const ctxAnalog = document.getElementById('analogChart').getContext('2d');
  state.charts.analog = new Chart(ctxAnalog, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Light (LDR ADC)',
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5
        },
        {
          label: 'Soil Moisture (ADC)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.08)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      ...chartOptionsBase,
      scales: {
        ...chartOptionsBase.scales,
        y: {
          ...chartOptionsBase.scales.y,
          min: 0,
          max: 4095
        }
      }
    }
  });

  // Chart 2: Climate (Temperature & Humidity)
  const ctxClimate = document.getElementById('climateChart').getContext('2d');
  state.charts.climate = new Chart(ctxClimate, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperature (°C)',
          data: [],
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.08)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 2,
          yAxisID: 'y'
        },
        {
          label: 'Humidity (%)',
          data: [],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.08)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 2,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      ...chartOptionsBase,
      scales: {
        x: chartOptionsBase.scales.x,
        y: {
          position: 'left',
          min: 0,
          max: 55,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#f43f5e', font: { family: 'JetBrains Mono', size: 10 } }
        },
        y1: {
          position: 'right',
          min: 0,
          max: 100,
          grid: { drawOnChartArea: false },
          ticks: { color: '#38bdf8', font: { family: 'JetBrains Mono', size: 10 } }
        }
      }
    }
  });
}

function pushChartHistory(telemetry) {
  const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const { history, maxHistoryPoints, charts } = state;

  history.timestamps.push(timeLabel);
  history.light.push(telemetry.light);
  history.soil.push(telemetry.soil);
  history.temp.push(telemetry.temperature);
  history.humidity.push(telemetry.humidity);

  if (history.timestamps.length > maxHistoryPoints) {
    history.timestamps.shift();
    history.light.shift();
    history.soil.shift();
    history.temp.shift();
    history.humidity.shift();
  }

  if (charts.analog) {
    charts.analog.data.labels = history.timestamps;
    charts.analog.data.datasets[0].data = history.light;
    charts.analog.data.datasets[1].data = history.soil;
    charts.analog.update('none');
  }

  if (charts.climate) {
    charts.climate.data.labels = history.timestamps;
    charts.climate.data.datasets[0].data = history.temp;
    charts.climate.data.datasets[1].data = history.humidity;
    charts.climate.update('none');
  }
}

// ==============================================================================
// 5. FIRMWARE LOGIC & INTERACTIVE SIMULATION ENGINE
// ==============================================================================
function runFirmwareLogic(light, soil, temp) {
  // Replicates ESP32 Arduino C++ logic:
  // bool shadeClosed = (lightValue > LIGHT_THRESHOLD) || (validDHT && temperature > TEMP_THRESHOLD);
  // bool pumpOn = (soilValue < SOIL_THRESHOLD);
  const shadeClosed = (light > state.thresholds.light) || (temp > state.thresholds.temp);
  const servoAngle = shadeClosed ? 90 : 0;
  const shade = shadeClosed ? 'CLOSED' : 'OPEN';
  const pumpOn = (soil < state.thresholds.soil);
  const pump = pumpOn ? 'ON' : 'OFF';

  return { shadeClosed, servoAngle, shade, pumpOn, pump };
}

function updateSimulationTick() {
  if (state.mode !== 'sim') return;

  // If noise jitter enabled, add slight realistic fluctuations (±1-2%)
  if (state.noiseJitter) {
    const jitterLight = Math.round((Math.random() - 0.5) * 20);
    const jitterSoil = Math.round((Math.random() - 0.5) * 15);
    const jitterTemp = Number(((Math.random() - 0.5) * 0.2).toFixed(1));
    const jitterHum = Number(((Math.random() - 0.5) * 0.4).toFixed(1));

    state.telemetry.light = Math.min(Math.max(state.telemetry.light + jitterLight, 0), 4095);
    state.telemetry.soil = Math.min(Math.max(state.telemetry.soil + jitterSoil, 0), 4095);
    state.telemetry.temperature = Number(Math.min(Math.max(state.telemetry.temperature + jitterTemp, -10), 60).toFixed(1));
    state.telemetry.humidity = Number(Math.min(Math.max(state.telemetry.humidity + jitterHum, 0), 100).toFixed(1));

    syncSlidersWithTelemetry();
  }

  // Execute firmware logic
  const logic = runFirmwareLogic(state.telemetry.light, state.telemetry.soil, state.telemetry.temperature);
  state.telemetry.shade = logic.shade;
  state.telemetry.servoAngle = logic.servoAngle;
  state.telemetry.pump = logic.pump;
  state.telemetry.uptimeMs += 1000;
  state.telemetry.timestamp = Date.now();

  // If user enabled MQTT broadcast, publish simulated packet to broker
  if (state.broadcastSimToMqtt) {
    mqttManager.publishSimData({
      light: state.telemetry.light,
      soil: state.telemetry.soil,
      temperature: state.telemetry.temperature,
      humidity: state.telemetry.humidity,
      shade: state.telemetry.shade,
      servoAngle: state.telemetry.servoAngle,
      pump: state.telemetry.pump,
      uptimeMs: state.telemetry.uptimeMs
    });
  }

  renderAll();
}

function syncSlidersWithTelemetry() {
  document.getElementById('rangeLight').value = state.telemetry.light;
  document.getElementById('simValLight').textContent = `${state.telemetry.light} ADC`;

  document.getElementById('rangeSoil').value = state.telemetry.soil;
  document.getElementById('simValSoil').textContent = `${state.telemetry.soil} ADC`;

  document.getElementById('rangeTemp').value = state.telemetry.temperature;
  document.getElementById('simValTemp').textContent = `${state.telemetry.temperature} °C`;

  document.getElementById('rangeHumidity').value = state.telemetry.humidity;
  document.getElementById('simValHumidity').textContent = `${state.telemetry.humidity} %`;
}

// ==============================================================================
// 6. UI RENDERING & COMPONENT SYNC
// ==============================================================================
function renderAll() {
  const { telemetry, thresholds, previousActuators } = state;
  const { light, soil, temperature, humidity, shade, servoAngle, pump } = telemetry;

  // Audio trigger detection when actuator states change
  if (shade !== previousActuators.shade) {
    soundFx.playServoHum(servoAngle);
    if (shade === 'CLOSED') soundFx.playAlertChime();
    previousActuators.shade = shade;
  }
  if (pump !== previousActuators.pump) {
    soundFx.playPumpClick(pump === 'ON');
    previousActuators.pump = pump;
  }

  // --- CARD 1: LIGHT SENSOR ---
  document.getElementById('lightValue').textContent = light.toLocaleString();
  const lightPct = Math.min((light / 4095) * 100, 100);
  document.getElementById('lightBarFill').style.width = `${lightPct}%`;
  
  const approxLux = Math.round(light * 24.5);
  document.getElementById('lightLuxEstimate').textContent = `≈ ${approxLux.toLocaleString()} Lux (${getSunlightDescription(light)})`;

  const lightChip = document.getElementById('lightChip');
  if (light > thresholds.light) {
    lightChip.className = 'status-chip chip-alert';
    lightChip.textContent = 'HIGH SUN';
  } else if (light < 800) {
    lightChip.className = 'status-chip chip-warn';
    lightChip.textContent = 'LOW LIGHT';
  } else {
    lightChip.className = 'status-chip chip-normal';
    lightChip.textContent = 'OPTIMAL';
  }

  // --- CARD 2: SOIL MOISTURE ---
  document.getElementById('soilValue').textContent = soil.toLocaleString();
  const soilPct = Math.min((soil / 4095) * 100, 100);
  document.getElementById('soilBarFill').style.width = `${soilPct}%`;

  const soilMoistEstimate = ((soil / 4095) * 100).toFixed(1);
  document.getElementById('soilPercentEstimate').textContent = `≈ ${soilMoistEstimate}% Moisture (${getSoilDescription(soil, thresholds.soil)})`;

  const soilChip = document.getElementById('soilChip');
  if (soil < thresholds.soil) {
    soilChip.className = 'status-chip chip-alert';
    soilChip.textContent = 'DRY / PUMP ACTIVE';
  } else {
    soilChip.className = 'status-chip chip-normal';
    soilChip.textContent = 'MOIST / HEALTHY';
  }

  // --- CARD 3: TEMPERATURE ---
  document.getElementById('tempValue').textContent = formatTempNumber(temperature);
  document.getElementById('tempUnitLabel').textContent = `°${state.units.temp}`;
  const tempScalePct = Math.min(Math.max((temperature / 50) * 100, 0), 100);
  document.getElementById('tempBarFill').style.width = `${tempScalePct}%`;

  const tempNote = document.getElementById('tempSecondary');
  if (temperature > thresholds.temp) {
    tempNote.textContent = '⚠️ Thermal Canopy Defense Triggered';
    tempNote.style.color = 'var(--accent-rose)';
  } else {
    tempNote.textContent = 'Optimal Crop Growth Zone (18 - 32°C)';
    tempNote.style.color = 'var(--text-secondary)';
  }

  // --- CARD 4: HUMIDITY ---
  document.getElementById('humidityValue').textContent = humidity.toFixed(1);
  document.getElementById('humidityBarFill').style.width = `${humidity}%`;
  
  // Calculate Vapor Pressure Deficit (VPD) estimate
  const vpd = calculateVPD(temperature, humidity);
  document.getElementById('vpdEstimate').textContent = `Vapor Deficit (VPD): ~${vpd} kPa (${getVpdDescription(vpd)})`;

  // --- ACTUATOR 1: CANOPY SERVO CARD ---
  const canopyCardPill = document.getElementById('canopyStatePill');
  const servoNeedle = document.getElementById('servoNeedle');
  const servoReadout = document.getElementById('servoAngleReadout');
  servoReadout.textContent = `${servoAngle}°`;
  servoNeedle.style.transform = `rotate(${servoAngle}deg)`;

  if (shade === 'CLOSED') {
    canopyCardPill.className = 'actuator-state-pill active-shield';
    canopyCardPill.textContent = 'CLOSED (SHIELDING)';
  } else {
    canopyCardPill.className = 'actuator-state-pill';
    canopyCardPill.textContent = 'OPEN (CANOPY UP)';
  }

  // Breakdown triggers
  const trigLightFired = light > thresholds.light;
  const trigTempFired = temperature > thresholds.temp;
  
  const trigLightRow = document.getElementById('trigLightRow');
  trigLightRow.className = `trigger-row ${trigLightFired ? 'fired' : ''}`;
  document.getElementById('trigLightIcon').textContent = trigLightFired ? '🔴' : '⚪';
  document.getElementById('trigLightVal').textContent = `${trigLightFired ? 'TRUE (EXCEEDED)' : 'FALSE'} (${light})`;

  const trigTempRow = document.getElementById('trigTempRow');
  trigTempRow.className = `trigger-row ${trigTempFired ? 'fired' : ''}`;
  document.getElementById('trigTempIcon').textContent = trigTempFired ? '🔴' : '⚪';
  document.getElementById('trigTempVal').textContent = `${trigTempFired ? 'TRUE (OVERHEAT)' : 'FALSE'} (${formatTemp(temperature)})`;

  // --- ACTUATOR 2: WATER PUMP CARD ---
  const pumpCardPill = document.getElementById('pumpStatePill');
  const pumpFlowStatus = document.getElementById('pumpFlowStatus');
  const pumpSpinRing = document.getElementById('pumpSpinRing');

  if (pump === 'ON') {
    pumpCardPill.className = 'actuator-state-pill active-pump';
    pumpCardPill.textContent = 'RUNNING (DRIP ACTIVE)';
    pumpFlowStatus.textContent = 'DRIPPING';
    pumpFlowStatus.style.color = 'var(--accent-cyan)';
    pumpSpinRing.style.borderColor = 'var(--accent-cyan)';
  } else {
    pumpCardPill.className = 'actuator-state-pill';
    pumpCardPill.textContent = 'OFF (STANDBY)';
    pumpFlowStatus.textContent = 'STANDBY';
    pumpFlowStatus.style.color = '#fff';
    pumpSpinRing.style.borderColor = '#1e293b';
  }

  const trigSoilFired = soil < thresholds.soil;
  const trigSoilRow = document.getElementById('trigSoilRow');
  trigSoilRow.className = `trigger-row ${trigSoilFired ? 'fired' : ''}`;
  document.getElementById('trigSoilIcon').textContent = trigSoilFired ? '🔴' : '⚪';
  document.getElementById('trigSoilVal').textContent = `${trigSoilFired ? 'TRUE (DRY SOIL)' : 'FALSE'} (${soil})`;

  // Render SVG Physical Twin
  canopyVisualizer.update(telemetry, thresholds);

  // Push to Live Chart
  pushChartHistory(telemetry);
}

// ==============================================================================
// 7. HELPER UTILITIES
// ==============================================================================
function getSunlightDescription(val) {
  if (val < 500) return 'Dusk / Night';
  if (val < 1500) return 'Cloudy / Shaded';
  if (val < 2500) return 'Clear Daylight';
  return 'Intense Solar Radiation';
}

function getSoilDescription(val, thresh) {
  if (val < thresh) return 'Moisture Deficit - Watering';
  if (val < 2600) return 'Balanced Field Capacity';
  return 'Heavily Hydrated';
}

function calculateVPD(tempC, rh) {
  // Saturated Vapor Pressure (VPsat in kPa)
  const vpsat = 0.61078 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  // Actual Vapor Pressure (VPact)
  const vpact = vpsat * (rh / 100);
  return Math.max(0, Number((vpsat - vpact).toFixed(2)));
}

function getVpdDescription(vpd) {
  if (vpd < 0.4) return 'Transpiration Inhibited';
  if (vpd <= 1.4) return 'Optimal Growth Transpiration';
  return 'High Transpiration Stress';
}

function formatTemp(tempC) {
  if (state.units.temp === 'F') {
    return `${((tempC * 9/5) + 32).toFixed(1)} °F`;
  }
  return `${tempC.toFixed(1)} °C`;
}

function formatTempNumber(tempC) {
  if (state.units.temp === 'F') {
    return ((tempC * 9/5) + 32).toFixed(1);
  }
  return tempC.toFixed(1);
}

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600).toString().padStart(2, '0');
  const mins = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
  const secs = (totalSec % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

function logTerminal(text, type = 'system') {
  const terminal = document.getElementById('terminalBody');
  if (!terminal) return;

  const now = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement('div');
  line.className = `term-line term-${type}`;
  line.textContent = `[${now}] ${text}`;

  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;

  // Limit terminal history to 80 lines
  while (terminal.children.length > 80) {
    terminal.removeChild(terminal.firstChild);
  }
}

function updateStatusDot(status, modeText, subText) {
  const dot = document.getElementById('statusDot');
  const modeEl = document.getElementById('sourceModeText');
  const subEl = document.getElementById('sourceSubText');

  dot.className = `status-indicator-dot ${status}`;
  modeEl.textContent = modeText;
  subEl.textContent = subText;
}

// ==============================================================================
// 8. EVENT LISTENERS & USER CONTROLS
// ==============================================================================
function setupEventListeners() {
  // Mode Switchers
  const modeLiveBtn = document.getElementById('modeLiveBtn');
  const modeSimBtn = document.getElementById('modeSimBtn');
  const simBadge = document.getElementById('simModeBadge');

  // --- WOKWI TWO-WAY REMOTE CONTROL HANDLERS ---
  const btnSetAutoMode = document.getElementById('btnSetAutoMode');
  const btnSetManualMode = document.getElementById('btnSetManualMode');

  btnSetAutoMode?.addEventListener('click', () => {
    mqttManager.publishCommand({ mode: 'AUTO' });
    soundFx.playAlertChime();
  });

  btnSetManualMode?.addEventListener('click', () => {
    mqttManager.publishCommand({ mode: 'MANUAL' });
    soundFx.playAlertChime();
  });

  const remoteServoSlider = document.getElementById('remoteServoSlider');
  const cmdAngleBadge = document.getElementById('cmdAngleBadge');

  remoteServoSlider?.addEventListener('input', (e) => {
    const angle = Number(e.target.value);
    if (cmdAngleBadge) cmdAngleBadge.textContent = `${angle}°`;
  });

  remoteServoSlider?.addEventListener('change', (e) => {
    const angle = Number(e.target.value);
    mqttManager.publishCommand({ mode: 'MANUAL', servoAngle: angle });
    soundFx.playServoHum(angle);
  });

  document.querySelectorAll('.cmd-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const angle = Number(btn.dataset.angle);
      if (remoteServoSlider) remoteServoSlider.value = angle;
      if (cmdAngleBadge) cmdAngleBadge.textContent = `${angle}°`;
      mqttManager.publishCommand({ mode: 'MANUAL', servoAngle: angle });
      soundFx.playServoHum(angle);
    });
  });

  document.getElementById('btnPumpOn')?.addEventListener('click', () => {
    mqttManager.publishCommand({ mode: 'MANUAL', pump: 'ON' });
    soundFx.playPumpClick(true);
  });

  document.getElementById('btnPumpOff')?.addEventListener('click', () => {
    mqttManager.publishCommand({ mode: 'MANUAL', pump: 'OFF' });
    soundFx.playPumpClick(false);
  });

  document.getElementById('btnPushThreshToWokwi')?.addEventListener('click', () => {
    mqttManager.publishCommand({
      lightThresh: state.thresholds.light,
      soilThresh: state.thresholds.soil,
      tempThresh: state.thresholds.temp
    });
    logTerminal(`[THRESHOLDS PUSHED] Light > ${state.thresholds.light}, Soil < ${state.thresholds.soil}, Temp > ${state.thresholds.temp}°C`, 'warn');
  });

  modeLiveBtn.addEventListener('click', () => {
    state.mode = 'mqtt';
    modeLiveBtn.classList.add('active');
    modeSimBtn.classList.remove('active');
    simBadge.textContent = 'LIVE PHYSICAL TWIN';
    simBadge.className = 'badge-pill pulse-badge';
    
    if (state.simTimer) clearInterval(state.simTimer);
    mqttManager.connect();
    logTerminal('Switched to LIVE MQTT Mode. Subscribed to telemetry stream.', 'system');
  });

  modeSimBtn.addEventListener('click', () => {
    state.mode = 'sim';
    modeSimBtn.classList.add('active');
    modeLiveBtn.classList.remove('active');
    simBadge.textContent = 'SIMULATION TESTBED ACTIVE';
    simBadge.className = 'badge-pill sim-badge';
    
    updateStatusDot('sim', 'MODE: PHYSICS SIMULATOR', 'Interactive Controls Active');
    logTerminal('Switched to SIMULATOR TESTBED Mode. Sliders and physics loop active.', 'system');

    // Run 1Hz simulation loop
    if (state.simTimer) clearInterval(state.simTimer);
    state.simTimer = setInterval(updateSimulationTick, 1000);
    updateSimulationTick();
  });

  // Sound FX Toggle
  const btnSound = document.getElementById('btnSoundToggle');
  const soundIcon = document.getElementById('soundIcon');
  btnSound.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    soundIcon.textContent = state.audioEnabled ? '🔊' : '🔇';
    logTerminal(`Audio FX ${state.audioEnabled ? 'Enabled' : 'Muted'}`, 'system');
    if (state.audioEnabled) soundFx.playAlertChime();
  });

  // Temperature Unit Toggle (°C / °F)
  const tempUnitBtn = document.getElementById('tempUnitBtn');
  tempUnitBtn.addEventListener('click', () => {
    state.units.temp = state.units.temp === 'C' ? 'F' : 'C';
    tempUnitBtn.textContent = `°${state.units.temp}`;
    renderAll();
  });

  // Simulator Sliders Input Handlers
  document.getElementById('rangeLight').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.telemetry.light = val;
    document.getElementById('simValLight').textContent = `${val} ADC`;
    triggerSimStep();
  });

  document.getElementById('rangeSoil').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.telemetry.soil = val;
    document.getElementById('simValSoil').textContent = `${val} ADC`;
    triggerSimStep();
  });

  document.getElementById('rangeTemp').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.telemetry.temperature = val;
    document.getElementById('simValTemp').textContent = `${val} °C`;
    triggerSimStep();
  });

  document.getElementById('rangeHumidity').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.telemetry.humidity = val;
    document.getElementById('simValHumidity').textContent = `${val} %`;
    triggerSimStep();
  });

  function triggerSimStep() {
    if (state.mode !== 'sim') {
      // Auto-switch to simulator when user moves sliders
      modeSimBtn.click();
    }
    const logic = runFirmwareLogic(state.telemetry.light, state.telemetry.soil, state.telemetry.temperature);
    state.telemetry.shade = logic.shade;
    state.telemetry.servoAngle = logic.servoAngle;
    state.telemetry.pump = logic.pump;
    renderAll();
  }

  // Toggle Broadcast Simulator to HiveMQ
  document.getElementById('chkMqttBroadcast').addEventListener('change', (e) => {
    state.broadcastSimToMqtt = e.target.checked;
    logTerminal(`Sim MQTT Broadcast: ${state.broadcastSimToMqtt ? 'ENABLED' : 'DISABLED'}`, 'warn');
  });

  // Toggle Sensor Jitter
  document.getElementById('chkNoiseJitter').addEventListener('change', (e) => {
    state.noiseJitter = e.target.checked;
  });

  // Preset Scenario Buttons
  const scenarioBtns = document.querySelectorAll('.scenario-btn');
  scenarioBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const scen = btn.dataset.scenario;
      applyScenario(scen);
    });
  });

  function applyScenario(scen) {
    if (state.mode !== 'sim') {
      modeSimBtn.click();
    }

    switch (scen) {
      case 'heatwave':
        state.telemetry.light = 3400;
        state.telemetry.soil = 1800;
        state.telemetry.temperature = 38.5;
        state.telemetry.humidity = 42.0;
        logTerminal('Scenario Applied: ☀️ Scorching Midday Heatwave (Canopy Closes)', 'warn');
        break;
      case 'drought':
        state.telemetry.light = 2100;
        state.telemetry.soil = 820;
        state.telemetry.temperature = 31.0;
        state.telemetry.humidity = 35.0;
        logTerminal('Scenario Applied: 🏜️ Arid Drought (Irrigation Pump Starts)', 'warn');
        break;
      case 'ideal':
        state.telemetry.light = 1800;
        state.telemetry.soil = 2400;
        state.telemetry.temperature = 24.0;
        state.telemetry.humidity = 60.0;
        logTerminal('Scenario Applied: 🌿 Ideal Spring Morning (All Normal)', 'system');
        break;
      case 'storm':
        state.telemetry.light = 350;
        state.telemetry.soil = 3800;
        state.telemetry.temperature = 19.5;
        state.telemetry.humidity = 92.0;
        logTerminal('Scenario Applied: 🌧️ Night Rainstorm (Canopy Open, Pump Off)', 'system');
        break;
      case 'critical':
        state.telemetry.light = 3950;
        state.telemetry.soil = 600;
        state.telemetry.temperature = 42.0;
        state.telemetry.humidity = 28.0;
        logTerminal('Scenario Applied: 🚨 Emergency Critical (Canopy Closed + Pump Running)', 'err');
        break;
    }

    syncSlidersWithTelemetry();
    triggerSimStep();
  }

  // Terminal buttons
  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('terminalBody').innerHTML = '';
  });

  document.getElementById('btnCopyJson').addEventListener('click', () => {
    const jsonStr = JSON.stringify(state.telemetry, null, 2);
    navigator.clipboard.writeText(jsonStr).then(() => {
      logTerminal('Latest JSON payload copied to clipboard!', 'system');
    });
  });

  // Modal Handlers
  setupModals();
}

function setupModals() {
  // Wokwi Setup Modal
  const btnWokwiGuide = document.getElementById('btnWokwiGuide');
  const modalWokwi = document.getElementById('modalWokwi');
  const wokwiPre = document.getElementById('wokwiJsonContent');

  // Load wokwi-diagram.json text into pre tag
  fetch('wokwi-diagram.json')
    .then(r => r.text())
    .then(text => {
      wokwiPre.textContent = text;
    })
    .catch(() => {
      wokwiPre.textContent = '// See wokwi-diagram.json in project root';
    });

  btnWokwiGuide.addEventListener('click', () => {
    modalWokwi.removeAttribute('hidden');
  });

  document.getElementById('btnCopyWokwiJson').addEventListener('click', () => {
    navigator.clipboard.writeText(wokwiPre.textContent).then(() => {
      alert('Wokwi diagram.json copied to clipboard!');
    });
  });

  // MQTT Settings Modal
  const btnConfigMqtt = document.getElementById('btnConfigMqtt');
  const modalMqtt = document.getElementById('modalMqtt');

  btnConfigMqtt.addEventListener('click', () => {
    document.getElementById('cfgMqttHost').value = state.mqttConfig.host;
    document.getElementById('cfgMqttPort').value = state.mqttConfig.port;
    document.getElementById('cfgMqttPath').value = state.mqttConfig.path;
    document.getElementById('cfgMqttTopic').value = state.mqttConfig.topic;
    modalMqtt.removeAttribute('hidden');
  });

  document.getElementById('btnSaveMqtt').addEventListener('click', () => {
    state.mqttConfig.host = document.getElementById('cfgMqttHost').value.trim();
    state.mqttConfig.port = Number(document.getElementById('cfgMqttPort').value.trim());
    state.mqttConfig.path = document.getElementById('cfgMqttPath').value.trim();
    state.mqttConfig.topic = document.getElementById('cfgMqttTopic').value.trim();
    modalMqtt.setAttribute('hidden', '');
    mqttManager.connect();
  });

  document.getElementById('btnResetMqtt').addEventListener('click', () => {
    document.getElementById('cfgMqttHost').value = 'broker.hivemq.com';
    document.getElementById('cfgMqttPort').value = '8884';
    document.getElementById('cfgMqttPath').value = '/mqtt';
    document.getElementById('cfgMqttTopic').value = 'smartcanopy/demo-7f3a9c/telemetry';
  });

  // Calibration Modal
  const btnCalibrate = document.getElementById('btnCalibrate');
  const modalCalibrate = document.getElementById('modalCalibrate');

  btnCalibrate.addEventListener('click', () => {
    document.getElementById('cfgThreshLight').value = state.thresholds.light;
    document.getElementById('cfgThreshTemp').value = state.thresholds.temp;
    document.getElementById('cfgThreshSoil').value = state.thresholds.soil;
    modalCalibrate.removeAttribute('hidden');
  });

  document.getElementById('btnSaveCalib').addEventListener('click', () => {
    state.thresholds.light = Number(document.getElementById('cfgThreshLight').value);
    state.thresholds.temp = Number(document.getElementById('cfgThreshTemp').value);
    state.thresholds.soil = Number(document.getElementById('cfgThreshSoil').value);
    
    // Update marker flags on UI
    document.getElementById('lightMarker').style.left = `${(state.thresholds.light / 4095) * 100}%`;
    document.getElementById('lightMarker').querySelector('.marker-flag').textContent = state.thresholds.light;
    
    document.getElementById('soilMarker').style.left = `${(state.thresholds.soil / 4095) * 100}%`;
    document.getElementById('soilMarker').querySelector('.marker-flag').textContent = state.thresholds.soil;

    document.getElementById('tempMarker').style.left = `${(state.thresholds.temp / 50) * 100}%`;
    document.getElementById('tempMarker').querySelector('.marker-flag').textContent = `${state.thresholds.temp}°C`;

    modalCalibrate.setAttribute('hidden', '');
    logTerminal(`Thresholds calibrated: Light > ${state.thresholds.light}, Temp > ${state.thresholds.temp}°C, Soil < ${state.thresholds.soil}`, 'system');
    renderAll();
  });

  document.getElementById('btnResetCalib').addEventListener('click', () => {
    document.getElementById('cfgThreshLight').value = 2500;
    document.getElementById('cfgThreshTemp').value = 35.0;
    document.getElementById('cfgThreshSoil').value = 1400;
  });

  // Generic Modal Close Buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      const target = document.getElementById(modalId);
      if (target) target.setAttribute('hidden', '');
    });
  });

  // Click outside dialog to close
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.setAttribute('hidden', '');
      }
    });
  });
}

// ==============================================================================
// 9. INITIALIZATION ENTRY POINT
// ==============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  setupEventListeners();
  syncSlidersWithTelemetry();
  renderAll();

  // Connect to live MQTT broker immediately
  mqttManager.connect();
});
