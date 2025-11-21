const socket = io();

let currentBeat = -1;
let currentSubdivision = -1;
let scoreData = null;
let currentBeatsInBar = 0;
let lightElements = [];
let displaySettings = {
  lightColor: '#ff0000',
  progressBarColor: '#ff0000',
  progressBarWidth: 4,
  backgroundColor: '#000000',
  textColor: '#ffffff',
  chordColor: '#ffcc00'
};

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

// Create lights dynamically based on number of beats
function createLights(numBeats) {
  if (numBeats === currentBeatsInBar && lightElements.length === numBeats) return;

  currentBeatsInBar = numBeats;
  metronomeLightsEl.innerHTML = '';
  lightElements = [];

  // Calculate size based on number of beats
  // Base size is 80px, scale down for more beats
  let size = 80;
  let gap = 20;

  if (numBeats > 8) {
    size = Math.max(30, 80 - (numBeats - 8) * 5);
    gap = Math.max(8, 20 - (numBeats - 8) * 1.5);
  } else if (numBeats > 4) {
    size = Math.max(50, 80 - (numBeats - 4) * 7);
    gap = Math.max(12, 20 - (numBeats - 4) * 2);
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

socket.on('score-data', (data) => {
  console.log('Received score data:', data);
  scoreData = data;
  // Time signature and tempo will be updated dynamically during playback
});

socket.on('display-settings', (settings) => {
  console.log('Received display settings:', settings);
  displaySettings = settings;
  applyDisplaySettings();
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

  // Clear all lights
  lightElements.forEach(light => {
    light.classList.remove('active', 'accented', 'subdivision');
  });

  document.body.classList.remove('first-beat');
  currentBeat = -1;
  currentSubdivision = -1;
});

socket.on('state-update', (state) => {
  if (!state.isPlaying) return;

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

  // Create/update lights based on time signature
  createLights(state.timeSignature.beats);

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
    barNumberEl.textContent = state.barNumber;
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

  // Update metronome lights with accent pattern and subdivisions
  const isAccented = state.accentPattern && state.accentPattern.includes(state.beat);
  const subdivisionIndex = state.currentSubdivision || 0;
  updateMetronomeLights(state.beat, subdivisionIndex, isAccented);
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

  // Accent first beat with background color change (only on beat 0, subdivision 0)
  if (beat === 0 && subdivisionIndex === 0) {
    document.body.classList.add('first-beat');
    setTimeout(() => {
      document.body.classList.remove('first-beat');
    }, 150);
  }

  // For accented beats, add stronger background flash (only on main beat, not subdivisions)
  if (isAccented && subdivisionIndex === 0) {
    document.body.classList.add('accented-beat');
    setTimeout(() => {
      document.body.classList.remove('accented-beat');
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

  // Progress line
  progressLineEl.style.width = `${displaySettings.progressBarWidth}px`;
  progressLineEl.style.background = `linear-gradient(180deg,
    ${hexToRgba(displaySettings.progressBarColor, 0)} 0%,
    ${hexToRgba(displaySettings.progressBarColor, 0.8)} 20%,
    ${displaySettings.progressBarColor} 50%,
    ${hexToRgba(displaySettings.progressBarColor, 0.8)} 80%,
    ${hexToRgba(displaySettings.progressBarColor, 0)} 100%
  )`;
  progressLineEl.style.boxShadow = `0 0 20px ${hexToRgba(displaySettings.progressBarColor, 0.8)},
    0 0 40px ${hexToRgba(displaySettings.progressBarColor, 0.4)}`;

  // Progress trail (motion blur effect)
  progressTrailEl.style.background = `linear-gradient(90deg,
    ${hexToRgba(displaySettings.progressBarColor, 0.3)} 0%,
    ${hexToRgba(displaySettings.progressBarColor, 0.15)} 20%,
    ${hexToRgba(displaySettings.progressBarColor, 0.05)} 50%,
    ${hexToRgba(displaySettings.progressBarColor, 0)} 100%
  )`;

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
