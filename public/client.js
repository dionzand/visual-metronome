const socket = io({
  transports: ['websocket', 'polling'],
  upgrade: true,
  rememberUpgrade: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 10
});

let currentBeat = -1;
let currentSubdivision = -1;
let scoreData = null;
let currentBeatsInBar = 0;
let lightElements = [];
let backgroundFlashTimeout = null;
let lastTempo = null;
let displaySettings = {
  lightColor: '#ffffff',
  progressBarColor: '#ffffff',
  progressBarWidth: 4,
  backgroundColor: '#000000',
  backgroundFlashColor: '#808080',
  textColor: '#ffffff',
  chordColor: '#ffcc00'
};

// Click Track Class
class ClickTrack {
  constructor() {
    this.audioContext = null;
    this.enabled = false;
    this.volume = 0.75;
    this.serverTimeOffset = 0; // Difference between server and client time (ms)
    this.manualOffset = 0; // Manual delay adjustment (ms, positive only - delays clicks to sync with fastest device)
    this.lastBeat = -1;
    this.lastBar = -1;
    this.audioContextStartTime = 0; // When AudioContext was created (Date.now())
    this.audioContextStartAudioTime = 0; // AudioContext.currentTime when created
  }

  init() {
    // Create AudioContext on first user interaction to avoid browser restrictions
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.audioContextStartTime = Date.now();
      this.audioContextStartAudioTime = this.audioContext.currentTime;
    }
  }

  stop() {
    // Reset state when playback stops
    this.lastBeat = -1;
    this.lastBar = -1;
  }

  updateSettings(settings) {
    this.enabled = settings.enabled;
    this.volume = settings.volume / 100; // Convert 0-100 to 0-1
  }

  setManualOffset(offsetMs) {
    // Clamp to positive values only (delay only, can't advance)
    this.manualOffset = Math.max(0, offsetMs);
    // Save to localStorage for persistence
    localStorage.setItem('clickTrackManualOffset', this.manualOffset.toString());
    console.log('Manual delay set to:', this.manualOffset, 'ms');
  }

  loadManualOffset() {
    const saved = localStorage.getItem('clickTrackManualOffset');
    if (saved !== null) {
      // Clamp to positive values
      this.manualOffset = Math.max(0, parseFloat(saved));
      console.log('Loaded manual delay:', this.manualOffset, 'ms');
    }
  }

  updateTimeOffset(serverTimestamp) {
    // Calculate offset between server and client clocks
    const clientTime = Date.now();
    const newOffset = serverTimestamp - clientTime;

    // Use exponential moving average to smooth out network jitter
    if (this.serverTimeOffset === 0) {
      this.serverTimeOffset = newOffset;
    } else {
      // Slower smoothing (0.95/0.05) for more stable offset
      this.serverTimeOffset = this.serverTimeOffset * 0.95 + newOffset * 0.05;
    }
  }

  /**
   * Convert server timestamp (Date.now() format) to AudioContext time
   * Adds manual delay for fine-tuning sync across devices
   */
  serverTimeToAudioTime(serverTimeMs) {
    // Convert server time to client time using measured offset
    const clientTimeMs = serverTimeMs - this.serverTimeOffset;

    // Calculate elapsed time since AudioContext was created
    const elapsedMs = clientTimeMs - this.audioContextStartTime;

    // Convert to AudioContext time (seconds since context start)
    const audioTime = this.audioContextStartAudioTime + (elapsedMs / 1000);

    // Add manual delay (convert ms to seconds, positive only)
    // This delays clicks to match the fastest/earliest device
    const adjustedTime = audioTime + (this.manualOffset / 1000);

    return adjustedTime;
  }

  playClick(isAccent, when = null) {
    if (!this.enabled || !this.audioContext) return;

    const now = this.audioContext.currentTime;
    const playTime = when !== null ? when : now;

    // Don't schedule in the past (with small tolerance for jitter)
    if (playTime < now - 0.05) {
      console.warn('Click scheduled too far in past, skipping:', (playTime - now).toFixed(3), 's');
      return;
    }

    // If slightly in past, play immediately
    const actualPlayTime = playTime < now ? now : playTime;

    // Create oscillator for beep sound
    const osc = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    // Frequency: 800Hz for accent, 400Hz for normal beat
    osc.frequency.value = isAccent ? 800 : 400;

    // Volume envelope
    gainNode.gain.value = 0;
    gainNode.gain.setValueAtTime(0, actualPlayTime);
    gainNode.gain.linearRampToValueAtTime(this.volume * (isAccent ? 1.0 : 0.6), actualPlayTime + 0.001);
    gainNode.gain.exponentialRampToValueAtTime(0.01, actualPlayTime + 0.05);

    // Connect and play
    osc.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    osc.start(actualPlayTime);
    osc.stop(actualPlayTime + 0.05);
  }

  onBeat(state) {
    if (!this.enabled || !state.isPlaying) return;

    // Initialize AudioContext if needed
    if (!this.audioContext) {
      this.init();
      this.loadManualOffset();
    }

    // Update time offset for sync
    if (state.serverTimestamp) {
      this.updateTimeOffset(state.serverTimestamp);
    }

    // Only trigger click once per beat
    if (state.beat !== this.lastBeat || state.barNumber !== this.lastBar) {
      this.lastBeat = state.beat;
      this.lastBar = state.barNumber;

      // Don't play click during fermata
      if (!state.isFermata) {
        // Play immediately with manual delay offset
        const now = this.audioContext.currentTime;
        const playTime = now + (this.manualOffset / 1000); // Add manual delay in seconds

        console.log(`Beat ${state.beat}, bar ${state.barNumber}, accent: ${state.isAccent}, delay: ${this.manualOffset}ms`);

        this.playClick(state.isAccent, playTime);
      }
    }
  }
}

// Create click track instance
const clickTrack = new ClickTrack();

// DOM elements
const statusEl = document.getElementById('status');
const barNumberEl = document.getElementById('barNumber');
const chordsEl = document.getElementById('chords');
const progressLineEl = document.getElementById('progressLine');
const progressTrailEl = document.getElementById('progressTrail');
const metronomeLightsEl = document.getElementById('metronomeLights');
const waitingMessageEl = document.getElementById('waitingMessage');
const timeSignatureEl = document.getElementById('timeSignature');
const sectionNameEl = document.getElementById('sectionName');
const songNameEl = document.getElementById('songName');
const fermataSymbolEl = document.getElementById('fermataSymbol');
const fermataInfoEl = document.getElementById('fermataInfo');
const tempoChangeIndicatorEl = document.getElementById('tempoChangeIndicator');
const runtimeEl = document.getElementById('runtime');

// Create lights dynamically based on number of beats
function createLights(numBeats) {
  if (numBeats === currentBeatsInBar && lightElements.length === numBeats) return;

  currentBeatsInBar = numBeats;
  metronomeLightsEl.innerHTML = '';
  lightElements = [];

  // Calculate size based on number of beats
  // Base size is 120px, scale down for more beats
  let size = 120;
  let gap = 25;

  if (numBeats > 8) {
    size = Math.max(50, 120 - (numBeats - 8) * 7);
    gap = Math.max(12, 25 - (numBeats - 8) * 1.5);
  } else if (numBeats > 4) {
    size = Math.max(80, 120 - (numBeats - 4) * 10);
    gap = Math.max(15, 25 - (numBeats - 4) * 2.5);
  }

  metronomeLightsEl.style.gap = `${gap}px`;

  // Get RGB values from light color for styling
  const r = parseInt(displaySettings.lightColor.slice(1, 3), 16);
  const g = parseInt(displaySettings.lightColor.slice(3, 5), 16);
  const b = parseInt(displaySettings.lightColor.slice(5, 7), 16);
  const dimColor = `rgba(${Math.floor(r * 0.4)}, ${Math.floor(g * 0.4)}, ${Math.floor(b * 0.4)}, 0.3)`;

  for (let i = 0; i < numBeats; i++) {
    const light = document.createElement('div');
    light.className = 'light';
    light.style.width = `${size}px`;
    light.style.height = `${size}px`;
    light.style.backgroundColor = dimColor;
    light.dataset.lightColor = displaySettings.lightColor;
    metronomeLightsEl.appendChild(light);
    lightElements.push(light);
  }
}

// Socket event handlers
socket.on('connect', () => {
  console.log('Connected to server');
  statusEl.textContent = 'Connected';
  statusEl.className = 'status connected';
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  statusEl.textContent = 'Disconnected';
  statusEl.className = 'status disconnected';
});

socket.on('playback-started', () => {
  console.log('Playback started');
  // Start video playback in sync with score
  if (videoBackground && videoBackground.src) {
    videoBackground.play().catch(err => console.log('Video play error:', err));
  }
});

socket.on('playback-paused', () => {
  console.log('Playback paused');
  // Pause video
  if (videoBackground && videoBackground.src) {
    videoBackground.pause();
  }
});

socket.on('playback-stopped', () => {
  console.log('Playback stopped');
  // Stop and reset video
  if (videoBackground && videoBackground.src) {
    videoBackground.pause();
    videoBackground.currentTime = 0;
  }
});

socket.on('score-data', (data) => {
  console.log('Received score data:', data);
  scoreData = data;
  // Time signature and tempo will be updated dynamically during playback

  // Load video background if specified in score
  if (data.videoBackground && data.videoBackground.url) {
    loadVideo(data.videoBackground.url);
    if (data.videoBackground.opacity !== undefined) {
      videoOpacity.value = data.videoBackground.opacity;
      videoBackground.style.opacity = data.videoBackground.opacity / 100;
      videoOpacityValue.textContent = `${data.videoBackground.opacity}%`;
    }
  } else {
    // Clear video if score doesn't have one
    clearVideo();
  }
});

socket.on('display-settings', (settings) => {
  console.log('Received display settings:', settings);
  displaySettings = settings;
  applyDisplaySettings();
});

socket.on('click-settings', (settings) => {
  console.log('Received click settings:', settings);
  clickTrack.updateSettings(settings);
  updateClickControlsUI(settings);
});

function updateClickControlsUI(settings) {
  const clickControlsEl = document.getElementById('clickControls');
  const clickStatusIconEl = document.getElementById('clickStatusIcon');
  const clickStatusTextEl = document.getElementById('clickStatusText');
  const clientVolumeSlider = document.getElementById('clientClickVolume');
  const clientVolumeValue = document.getElementById('clientClickVolumeValue');

  if (settings.enabled) {
    clickControlsEl.style.display = 'block';
    clickStatusIconEl.textContent = '🔊';
    clickStatusTextEl.textContent = 'Click: ON';

    // Update volume slider display
    clientVolumeSlider.value = settings.volume;
    clientVolumeValue.textContent = settings.volume + '%';

    // Also update the actual click track volume
    clickTrack.volume = settings.volume / 100;
  } else {
    clickControlsEl.style.display = 'none';
  }
}

// Client-side volume and sync controls
document.addEventListener('DOMContentLoaded', () => {
  console.log('Client controls initializing...');

  const clientVolumeSlider = document.getElementById('clientClickVolume');
  const clientVolumeValue = document.getElementById('clientClickVolumeValue');

  if (!clientVolumeSlider || !clientVolumeValue) {
    console.error('Volume control elements not found!');
    return;
  }

  clientVolumeSlider.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value);
    clientVolumeValue.textContent = volume + '%';
    clickTrack.volume = volume / 100;
    console.log('Client volume changed to:', volume, '%');
  });

  // Delay adjustment controls (positive values only - delay to match fastest device)
  const syncOffsetValue = document.getElementById('syncOffsetValue');
  const syncPlus = document.getElementById('syncPlus');
  const syncReset = document.getElementById('syncReset');

  if (!syncOffsetValue || !syncPlus || !syncReset) {
    console.error('Delay control elements not found!');
    return;
  }

  function updateSyncDisplay() {
    const offset = clickTrack.manualOffset;
    syncOffsetValue.textContent = `${offset}ms`;
  }

  syncPlus.addEventListener('click', () => {
    clickTrack.setManualOffset(clickTrack.manualOffset + 1);
    updateSyncDisplay();
  });

  syncReset.addEventListener('click', () => {
    clickTrack.setManualOffset(0);
    updateSyncDisplay();
  });

  // Load and display saved offset
  clickTrack.loadManualOffset();
  updateSyncDisplay();

  console.log('Client controls initialized successfully');
});

socket.on('playback-started', () => {
  console.log('Playback started');
  waitingMessageEl.style.display = 'none';
  progressLineEl.style.left = '0%';
});

socket.on('playback-paused', () => {
  console.log('Playback paused');
  waitingMessageEl.style.display = 'block';
  waitingMessageEl.textContent = 'Paused';

  // Stop click track
  clickTrack.stop();
});

socket.on('playback-stopped', () => {
  console.log('Playback stopped');
  waitingMessageEl.style.display = 'block';
  waitingMessageEl.textContent = 'Waiting for playback to start...';
  barNumberEl.textContent = '--';
  chordsEl.textContent = '';
  sectionNameEl.textContent = '';
  songNameEl.textContent = '';
  timeSignatureEl.textContent = '';
  progressLineEl.style.left = '0%';
  progressTrailEl.style.left = '0%';

  // Stop click track
  clickTrack.stop();

  // Hide fermata elements
  fermataSymbolEl.classList.remove('active');
  fermataInfoEl.classList.remove('active');

  // Hide tempo change indicator and reset tempo tracking
  tempoChangeIndicatorEl.classList.remove('active');
  lastTempo = null;

  // Show lights and clear them
  metronomeLightsEl.style.display = 'flex';
  lightElements.forEach(light => {
    light.classList.remove('active', 'accented', 'subdivision');
  });

  // Clear background flash timeout and reset background
  if (backgroundFlashTimeout) {
    clearTimeout(backgroundFlashTimeout);
    backgroundFlashTimeout = null;
  }
  document.body.style.backgroundColor = displaySettings.backgroundColor;
  document.body.classList.remove('first-beat', 'accented-beat');

  currentBeat = -1;
  currentSubdivision = -1;
});

socket.on('state-update', (state) => {
  if (!state.isPlaying) return;

  // Hide waiting message when playback is active (for clients connecting mid-song)
  if (waitingMessageEl.style.display !== 'none') {
    waitingMessageEl.style.display = 'none';
  }

  // Handle click track
  clickTrack.onBeat(state);

  // Get first section's tempo for initial display
  let currentTempo = state.tempo || (scoreData && scoreData.sections && scoreData.sections[0] ? scoreData.sections[0].tempo : 120);

  // Find current section to get actual tempo
  if (scoreData && scoreData.sections && state.barNumber > 0) {
    let barCount = 0;
    for (const section of scoreData.sections) {
      barCount += section.bars.length;
      if (state.barNumber <= barCount) {
        currentTempo = section.tempo;
        break;
      }
    }
  }

  // Update time signature and tempo
  timeSignatureEl.textContent = `${state.timeSignature.beats}/${state.timeSignature.noteValue} @ ${currentTempo} BPM`;

  // Update runtime display
  if (state.runtime !== undefined) {
    updateRuntimeDisplay(state.runtime);
  }

  // Show tempo change indicator if we're in a tempo transition
  if (state.isTempoTransition) {
    // Determine direction by comparing current tempo to last tempo
    if (lastTempo !== null) {
      if (currentTempo > lastTempo) {
        tempoChangeIndicatorEl.textContent = '↗ Tempo Rising';
      } else if (currentTempo < lastTempo) {
        tempoChangeIndicatorEl.textContent = '↘ Tempo Falling';
      } else {
        // Tempo hasn't changed yet, keep previous text or set default
        if (!tempoChangeIndicatorEl.textContent) {
          tempoChangeIndicatorEl.textContent = 'Tempo Transitioning';
        }
      }
    } else {
      // First update in transition, set generic message
      tempoChangeIndicatorEl.textContent = 'Tempo Transitioning';
    }
    tempoChangeIndicatorEl.classList.add('active');
  } else {
    tempoChangeIndicatorEl.classList.remove('active');
  }

  lastTempo = currentTempo;

  // Handle fermata bars
  if (state.isFermata) {
    // Show fermata symbol and info
    fermataSymbolEl.classList.add('active');
    const durationText = state.fermataDurationType === 'seconds'
      ? `${state.fermataDuration} seconds`
      : `${state.fermataDuration} beats`;
    fermataInfoEl.textContent = `Hold for ${durationText}`;
    fermataInfoEl.classList.add('active');
    // Hide lights for fermata
    metronomeLightsEl.style.display = 'none';
  } else {
    // Hide fermata elements
    fermataSymbolEl.classList.remove('active');
    fermataInfoEl.classList.remove('active');
    // Show lights for normal bars
    metronomeLightsEl.style.display = 'flex';
    // Create/update lights based on time signature
    createLights(state.timeSignature.beats);
  }

  // Update song name
  songNameEl.textContent = state.songName || '';

  // Update section name
  if (state.isCountoff) {
    sectionNameEl.textContent = 'COUNTOFF';
    sectionNameEl.className = 'section-name countoff';
    barNumberEl.textContent = '0';
  } else {
    sectionNameEl.textContent = state.sectionName || '';
    sectionNameEl.className = 'section-name';
    // Display bar number with beat number (e.g., "5|3" for beat 3 in bar 5)
    barNumberEl.textContent = `${state.barNumber}|${state.beat + 1}`;
  }

  // Update chords
  if (state.chords) {
    chordsEl.textContent = state.chords;
  } else {
    chordsEl.textContent = '';
  }

  // Update progress line and trail - move from left (0%) to right (100%)
  const progress = Math.min(state.progress * 100, 100);
  progressLineEl.style.left = `${progress}%`;
  progressTrailEl.style.left = `${progress}%`;

  // Update metronome lights with accent pattern and subdivisions (only for non-fermata bars)
  if (!state.isFermata) {
    const isAccented = state.accentPattern && state.accentPattern.includes(state.beat);
    const subdivisionIndex = state.currentSubdivision || 0;
    updateMetronomeLights(state.beat, subdivisionIndex, isAccented);
  }
});

// Vamp warning handler
socket.on('vamp-state-update', (vampState) => {
  const vampWarningEl = document.getElementById('vampWarning');
  if (vampWarningEl) {
    vampWarningEl.style.display = vampState.enabled ? 'block' : 'none';
  }
});

function updateMetronomeLights(beat, subdivisionIndex, isAccented) {
  // Create unique identifier for beat + subdivision
  const currentCombined = beat * 100 + subdivisionIndex;
  const lastCombined = currentBeat * 100 + currentSubdivision;

  if (currentCombined === lastCombined) return;

  currentBeat = beat;
  currentSubdivision = subdivisionIndex;

  // Get light color values
  const lightColor = displaySettings.lightColor;
  const r = parseInt(lightColor.slice(1, 3), 16);
  const g = parseInt(lightColor.slice(3, 5), 16);
  const b = parseInt(lightColor.slice(5, 7), 16);
  const dimColor = `rgba(${Math.floor(r * 0.4)}, ${Math.floor(g * 0.4)}, ${Math.floor(b * 0.4)}, 0.3)`;

  // Deactivate all lights first
  lightElements.forEach(light => {
    light.classList.remove('active', 'accented', 'subdivision');
    light.style.background = dimColor;
    light.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.5)';
    light.style.transform = 'scale(1)';
  });

  // Clear any pending background flash timeout
  if (backgroundFlashTimeout) {
    clearTimeout(backgroundFlashTimeout);
    backgroundFlashTimeout = null;
  }

  // Get the base background color and flash color
  const baseBackgroundColor = displaySettings.backgroundColor;
  const flashColor = displaySettings.backgroundFlashColor;

  // For accented beats, add stronger background flash (only on main beat, not subdivisions)
  // Accented beats take priority over first beat
  if (isAccented && subdivisionIndex === 0) {
    document.body.style.backgroundColor = flashColor;

    backgroundFlashTimeout = setTimeout(() => {
      document.body.style.backgroundColor = baseBackgroundColor;
      backgroundFlashTimeout = null;
    }, 250);
  }
  // Accent first beat with background color change (only on beat 0, subdivision 0, if not already accented)
  else if (beat === 0 && subdivisionIndex === 0) {
    document.body.style.backgroundColor = flashColor;

    backgroundFlashTimeout = setTimeout(() => {
      document.body.style.backgroundColor = baseBackgroundColor;
      backgroundFlashTimeout = null;
    }, 200);
  }

  // Determine if this is a main beat or subdivision
  const isMainBeat = subdivisionIndex === 0;

  // Light up the corresponding beat's light
  if (beat >= 0 && beat < lightElements.length) {
    const light = lightElements[beat];

    if (isAccented && isMainBeat) {
      // Accented beat - brightest
      light.style.background = `radial-gradient(circle, #ffffff 30%, ${lightColor} 100%)`;
      light.style.boxShadow = `0 0 70px ${lightColor}, 0 0 120px rgba(${r}, ${g}, ${b}, 0.8), 0 0 180px rgba(${r}, ${g}, ${b}, 0.5)`;
      light.style.transform = 'scale(1.2)';
    } else if (!isMainBeat) {
      // Subdivision - dimmer
      const lighterColor = `rgb(${Math.min(255, r + 50)}, ${Math.min(255, g + 50)}, ${Math.min(255, b + 50)})`;
      light.style.background = `radial-gradient(circle, ${lighterColor} 0%, ${lightColor} 100%)`;
      light.style.boxShadow = `0 0 30px rgba(${r}, ${g}, ${b}, 0.6), 0 0 50px rgba(${r}, ${g}, ${b}, 0.4)`;
      light.style.transform = 'scale(0.9)';
    } else {
      // Normal beat
      light.style.background = `radial-gradient(circle, #ffffff 0%, ${lightColor} 100%)`;
      light.style.boxShadow = `0 0 50px rgba(${r}, ${g}, ${b}, 0.9), 0 0 80px rgba(${r}, ${g}, ${b}, 0.6)`;
      light.style.transform = 'scale(1.1)';
    }
  }

  // Different durations for different beat types
  let dimDelay = 100;
  if (isAccented && isMainBeat) {
    dimDelay = 150; // Accented main beats stay longest
  } else if (isMainBeat) {
    dimDelay = 100; // Regular main beats
  } else {
    dimDelay = 60; // Subdivisions are shorter
  }

  setTimeout(() => {
    lightElements.forEach(light => {
      light.classList.remove('active', 'accented', 'subdivision');
      light.style.background = dimColor;
      light.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.5)';
      light.style.transform = 'scale(1)';
    });
  }, dimDelay);
}

// Apply display settings to the page
function applyDisplaySettings() {
  // Background color
  document.body.style.backgroundColor = displaySettings.backgroundColor;

  // Text colors
  barNumberEl.style.color = displaySettings.textColor;
  songNameEl.style.color = hexToRgba(displaySettings.textColor, 0.5);
  sectionNameEl.style.color = hexToRgba(displaySettings.textColor, 0.3);
  timeSignatureEl.style.color = hexToRgba(displaySettings.textColor, 0.25);
  waitingMessageEl.style.color = hexToRgba(displaySettings.textColor, 0.3);

  // Chord color
  chordsEl.style.color = displaySettings.chordColor;

  // Progress line - simple solid color, no blur
  progressLineEl.style.width = `${displaySettings.progressBarWidth}px`;
  progressLineEl.style.background = displaySettings.progressBarColor;

  // Update CSS custom properties for lights
  document.documentElement.style.setProperty('--light-color', displaySettings.lightColor);

  // Recreate lights with new color
  if (currentBeatsInBar > 0) {
    const numBeats = currentBeatsInBar;
    currentBeatsInBar = 0; // Force recreate
    createLights(numBeats);
  }
}

// Helper function to convert hex to rgba
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Initialize with default 4 lights
createLights(4);

// Apply initial settings
applyDisplaySettings();

// Hamburger Menu Toggle
const hamburgerButton = document.getElementById('hamburgerButton');
const hamburgerMenu = document.getElementById('hamburgerMenu');

hamburgerButton.addEventListener('click', (e) => {
  e.stopPropagation();
  hamburgerButton.classList.toggle('active');
  hamburgerMenu.classList.toggle('active');
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (!hamburgerButton.contains(e.target) && !hamburgerMenu.contains(e.target)) {
    hamburgerButton.classList.remove('active');
    hamburgerMenu.classList.remove('active');
  }

  // Close video controls when clicking outside
  const videoControls = document.getElementById('videoControls');
  const videoMenuBtn = document.getElementById('videoMenuBtn');
  if (videoControls && !videoControls.contains(e.target) && !videoMenuBtn.contains(e.target)) {
    videoControls.classList.remove('active');
  }
});

// Runtime display function
function updateRuntimeDisplay(runtimeMs) {
  const totalSeconds = Math.floor(runtimeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((runtimeMs % 1000) / 10);

  const formattedTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  runtimeEl.textContent = formattedTime;
}

// Video background controls
const videoBackground = document.getElementById('videoBackground');
const videoMenuBtn = document.getElementById('videoMenuBtn');
const videoControls = document.getElementById('videoControls');
const videoUrlInput = document.getElementById('videoUrlInput');
const loadVideoBtn = document.getElementById('loadVideoBtn');
const clearVideoBtn = document.getElementById('clearVideoBtn');
const videoOpacity = document.getElementById('videoOpacity');
const videoOpacityValue = document.getElementById('videoOpacityValue');

// Load saved video settings
function loadVideoSettings() {
  const savedUrl = localStorage.getItem('videoBackgroundUrl');
  const savedOpacity = localStorage.getItem('videoBackgroundOpacity');

  if (savedUrl) {
    videoUrlInput.value = savedUrl;
    loadVideo(savedUrl);
  }

  if (savedOpacity) {
    videoOpacity.value = savedOpacity;
    videoBackground.style.opacity = savedOpacity / 100;
    videoOpacityValue.textContent = `${savedOpacity}%`;
  }
}

function loadVideo(url) {
  if (!url) return;

  videoBackground.src = url;
  videoBackground.classList.add('active');
  localStorage.setItem('videoBackgroundUrl', url);
}

function clearVideo() {
  videoBackground.src = '';
  videoBackground.classList.remove('active');
  videoUrlInput.value = '';
  localStorage.removeItem('videoBackgroundUrl');
}

// Video menu button
videoMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  videoControls.classList.toggle('active');
  hamburgerMenu.classList.remove('active');
  hamburgerButton.classList.remove('active');
});

// Load video button
loadVideoBtn.addEventListener('click', () => {
  const url = videoUrlInput.value.trim();
  if (url) {
    loadVideo(url);
    videoControls.classList.remove('active');
  }
});

// Clear video button
clearVideoBtn.addEventListener('click', () => {
  clearVideo();
  videoControls.classList.remove('active');
});

// Video opacity control
videoOpacity.addEventListener('input', (e) => {
  const opacity = e.target.value;
  videoBackground.style.opacity = opacity / 100;
  videoOpacityValue.textContent = `${opacity}%`;
  localStorage.setItem('videoBackgroundOpacity', opacity);
});

// Load video settings on page load
loadVideoSettings();
