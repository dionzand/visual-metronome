// Socket.io connection
const socket = io({
  transports: ['websocket', 'polling'],
  upgrade: true,
  rememberUpgrade: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 10
});

// State
let scoreData = null;
let setlistData = [];
let currentSongIndex = 0;
let currentBeat = -1;
let lastDisplayedBeat = -1;
let currentBar = 1;
let currentBeatsInBar = 4;
let showAllBars = false;
let beatDimTimeout = null;
let vampState = {
  enabled: false,
  startBar: null,
  endBar: null,
  safetyBarsRemaining: 0,
  predefinedVampName: null
};
let currentTempo = 120;
let beatLightElements = [];
let displaySettings = {
  lightColor: '#ffffff',
  progressBarColor: '#ffffff',
  progressBarWidth: 4
};

// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const songNameEl = document.getElementById('songName');
const currentBarEl = document.getElementById('currentBar');
const sectionListEl = document.getElementById('sectionList');
const showAllBarsCheckbox = document.getElementById('showAllBarsCheckbox');
const predefinedVampsEl = document.getElementById('predefinedVamps');
const customVampStartEl = document.getElementById('customVampStart');
const customVampEndEl = document.getElementById('customVampEnd');
const customVampSafetyEl = document.getElementById('customVampSafety');
const enableCustomVampBtn = document.getElementById('enableCustomVampBtn');
const tempoDisplayEl = document.getElementById('tempoDisplay');
const beatIndicatorsEl = document.getElementById('beatIndicators');
const progressLineEl = document.getElementById('progressLine');
const currentSectionEl = document.getElementById('currentSection');
const currentChordsEl = document.getElementById('currentChords');
const vampBannerEl = document.getElementById('vampBanner');
const vampBannerTextEl = document.getElementById('vampBannerText');
const timeSignatureDisplayEl = document.getElementById('timeSignatureDisplay');
const safetyCountEl = document.getElementById('safetyCount');

// Transport buttons
const stopBtn = document.getElementById('stopBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const nextSongBtn = document.getElementById('nextSongBtn');
const songSelectEl = document.getElementById('songSelect');
const safetyBarBtn = document.getElementById('safetyBarBtn');
const endVampBtn = document.getElementById('endVampBtn');

// Socket Event Handlers
socket.on('connect', () => {
  console.log('Connected to server');
  statusIndicator.classList.add('connected');
  statusText.textContent = 'Connected';
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  statusIndicator.classList.remove('connected');
  statusText.textContent = 'Disconnected';
});

socket.on('score-data', (data) => {
  console.log('Received score data:', data);
  console.log('Number of sections:', data.sections ? data.sections.length : 0);
  if (data.sections && data.sections.length > 0) {
    console.log('First section time signature:', data.sections[0].timeSignature);
    console.log('First section bars:', data.sections[0].bars.length);
  }
  scoreData = data;
  songNameEl.textContent = data.name || '--';
  renderSectionList();
  renderPredefinedVamps();
  populateBarDropdowns();
});

socket.on('setlist-update', (data) => {
  console.log('Received setlist data:', data);
  setlistData = data.setlist || [];
  currentSongIndex = data.currentIndex || 0;
  renderSongSelector();
});

socket.on('current-song-index', (index) => {
  console.log('Current song index:', index);
  currentSongIndex = index;
  if (songSelectEl) {
    songSelectEl.value = index.toString();
  }
});

socket.on('state-update', (state) => {
  // Update current bar and beat
  currentBar = state.barNumber;
  currentBeat = state.beat;
  currentBeatsInBar = state.timeSignature.beats;
  currentTempo = state.tempo;

  // Update UI
  currentBarEl.textContent = state.barNumber ? `Bar ${state.barNumber}` : 'Bar --';
  currentSectionEl.textContent = state.sectionName || '--';
  currentChordsEl.textContent = state.chords || '--';
  tempoDisplayEl.textContent = `${Math.round(state.tempo)} BPM`;
  timeSignatureDisplayEl.textContent = `${state.timeSignature.beats}/${state.timeSignature.noteValue} @ ${Math.round(state.tempo)} BPM`;

  // Update progress line - move from left (0%) to right (100%)
  if (progressLineEl) {
    const progress = Math.min(state.progress * 100, 100);
    progressLineEl.style.left = `${progress}%`;
  }

  // Update beat indicators
  updateBeatIndicators(state.beat, state.isAccent, state.timeSignature.beats);

  // Highlight active section
  highlightActiveSection(state.barNumber);
});

socket.on('vamp-state-update', (state) => {
  console.log('Vamp state updated:', state);
  vampState = state;
  updateVampUI();
});

socket.on('tempo-override-update', (data) => {
  console.log('Tempo override:', data);
  // UI already updates via state-update
});

socket.on('display-settings', (settings) => {
  console.log('Display settings received:', settings);
  displaySettings = settings;
  applyDisplaySettings();
});

// Apply display settings to UI
function applyDisplaySettings() {
  // Update progress line color and width
  if (progressLineEl) {
    progressLineEl.style.width = `${displaySettings.progressBarWidth}px`;
    progressLineEl.style.background = displaySettings.progressBarColor || displaySettings.lightColor;
  }

  // Re-render beat lights with new colors if they exist
  if (beatLightElements.length > 0) {
    createBeatLights(beatLightElements.length);
  }
}

// Helper function to convert hex to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 }; // default to white
}

// Render Functions
function renderSectionList() {
  if (!scoreData) {
    console.warn('renderSectionList: No score data');
    return;
  }

  console.log('renderSectionList: Rendering', scoreData.sections.length, 'sections');

  sectionListEl.innerHTML = '';
  let absoluteBar = 1;

  scoreData.sections.forEach((section, sectionIndex) => {
    const sectionStartBar = absoluteBar;

    // Create section item
    const sectionItem = document.createElement('div');
    sectionItem.className = 'section-item';
    sectionItem.dataset.bar = sectionStartBar;
    sectionItem.innerHTML = `
      <div class="section-name">${section.name}</div>
      <div class="section-details">${section.timeSignature.beats}/${section.timeSignature.noteValue} @ ${section.tempo} BPM | Bars ${sectionStartBar}-${sectionStartBar + section.bars.length - 1}</div>
    `;
    sectionItem.addEventListener('click', () => jumpToBar(sectionStartBar));
    sectionListEl.appendChild(sectionItem);

    // If "show all bars" is enabled, add individual bars
    if (showAllBars) {
      section.bars.forEach((bar, barIndex) => {
        const barAbsoluteNumber = absoluteBar + barIndex;
        const barItem = document.createElement('div');
        barItem.className = 'bar-item';
        barItem.dataset.bar = barAbsoluteNumber;
        barItem.innerHTML = `
          <span class="bar-number">Bar ${barAbsoluteNumber}</span>
          <div class="bar-details">${bar.chords || '(no chords)'}</div>
        `;
        barItem.addEventListener('click', () => jumpToBar(barAbsoluteNumber));
        sectionListEl.appendChild(barItem);
      });
    }

    absoluteBar += section.bars.length;
  });
}

function renderPredefinedVamps() {
  if (!scoreData || !scoreData.vamps || scoreData.vamps.length === 0) {
    predefinedVampsEl.innerHTML = '<div style="color: #666; font-size: 14px;">No predefined vamps</div>';
    return;
  }

  predefinedVampsEl.innerHTML = '';

  scoreData.vamps.forEach((vamp) => {
    const vampItem = document.createElement('div');
    vampItem.className = 'vamp-item';
    vampItem.innerHTML = `
      <div class="vamp-name">${vamp.name}</div>
      <div class="vamp-details">Bars ${vamp.startBar}-${vamp.endBar} | Safety: ${vamp.safetyBars || 0}</div>
    `;
    vampItem.addEventListener('click', () => {
      enableVamp(vamp.startBar, vamp.endBar, vamp.safetyBars || 0, vamp.name);
    });
    predefinedVampsEl.appendChild(vampItem);
  });
}

function populateBarDropdowns() {
  if (!scoreData) return;

  // Calculate total bars
  let totalBars = 0;
  scoreData.sections.forEach(section => {
    totalBars += section.bars.length;
  });

  // Populate start and end dropdowns
  customVampStartEl.innerHTML = '';
  customVampEndEl.innerHTML = '';

  for (let i = 1; i <= totalBars; i++) {
    const startOption = document.createElement('option');
    startOption.value = i;
    startOption.textContent = `Bar ${i}`;
    customVampStartEl.appendChild(startOption);

    const endOption = document.createElement('option');
    endOption.value = i;
    endOption.textContent = `Bar ${i}`;
    customVampEndEl.appendChild(endOption);
  }

  // Set default values
  if (totalBars >= 4) {
    customVampStartEl.value = 1;
    customVampEndEl.value = 4;
  }
}

function createBeatLights(numBeats) {
  console.log('createBeatLights: Creating', numBeats, 'beat lights');

  beatIndicatorsEl.innerHTML = '';
  beatLightElements = [];

  // Get dim color based on light color
  const lightColor = displaySettings.lightColor;
  const r = parseInt(lightColor.slice(1, 3), 16);
  const g = parseInt(lightColor.slice(3, 5), 16);
  const b = parseInt(lightColor.slice(5, 7), 16);
  const dimColor = `rgba(${Math.floor(r * 0.4)}, ${Math.floor(g * 0.4)}, ${Math.floor(b * 0.4)}, 0.3)`;

  for (let i = 0; i < numBeats; i++) {
    const light = document.createElement('div');
    light.className = 'beat-light';
    light.style.background = dimColor;
    light.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.5)';
    beatIndicatorsEl.appendChild(light);
    beatLightElements.push(light);
  }
}

function updateBeatIndicators(beat, isAccent, beatsInBar) {
  // Create lights if needed
  if (beatLightElements.length !== beatsInBar) {
    createBeatLights(beatsInBar);
  }

  // Check if this is the same beat we just displayed (prevent flickering from duplicate events)
  if (beat === lastDisplayedBeat) {
    return;
  }

  lastDisplayedBeat = beat;

  // Get light color values
  const lightColor = displaySettings.lightColor;
  const r = parseInt(lightColor.slice(1, 3), 16);
  const g = parseInt(lightColor.slice(3, 5), 16);
  const b = parseInt(lightColor.slice(5, 7), 16);
  const dimColor = `rgba(${Math.floor(r * 0.4)}, ${Math.floor(g * 0.4)}, ${Math.floor(b * 0.4)}, 0.3)`;

  // Clear any pending dim timeout to prevent interference
  if (beatDimTimeout) {
    clearTimeout(beatDimTimeout);
    beatDimTimeout = null;
  }

  // Deactivate all lights first
  beatLightElements.forEach(light => {
    light.style.background = dimColor;
    light.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.5)';
    light.style.transform = 'scale(1)';
  });

  // Light up the corresponding beat's light
  if (beat >= 0 && beat < beatLightElements.length) {
    const light = beatLightElements[beat];

    if (isAccent) {
      // Accented beat - brightest
      light.style.background = `radial-gradient(circle, #ffffff 30%, ${lightColor} 100%)`;
      light.style.boxShadow = `0 0 70px ${lightColor}, 0 0 120px rgba(${r}, ${g}, ${b}, 0.8), 0 0 180px rgba(${r}, ${g}, ${b}, 0.5)`;
      light.style.transform = 'scale(1.2)';
    } else {
      // Normal beat
      light.style.background = `radial-gradient(circle, #ffffff 0%, ${lightColor} 100%)`;
      light.style.boxShadow = `0 0 50px rgba(${r}, ${g}, ${b}, 0.9), 0 0 80px rgba(${r}, ${g}, ${b}, 0.6)`;
      light.style.transform = 'scale(1.1)';
    }

    // Dim the light after a short delay
    const dimDelay = isAccent ? 150 : 100;
    beatDimTimeout = setTimeout(() => {
      light.style.background = dimColor;
      light.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.5)';
      light.style.transform = 'scale(1)';
      beatDimTimeout = null;
    }, dimDelay);
  }
}

function highlightActiveSection(barNumber) {
  const items = sectionListEl.querySelectorAll('.section-item, .bar-item');
  items.forEach(item => {
    const itemBar = parseInt(item.dataset.bar);
    if (itemBar === barNumber) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

function updateVampUI() {
  if (vampState.enabled) {
    vampBannerEl.style.display = 'block';
    const vampText = vampState.predefinedVampName
      ? `${vampState.predefinedVampName} (${vampState.startBar}-${vampState.endBar})`
      : `Bars ${vampState.startBar}-${vampState.endBar}`;
    vampBannerTextEl.textContent = vampText;

    // Update safety count display
    if (vampState.safetyBarsRemaining > 0) {
      safetyCountEl.style.display = 'flex';
      safetyCountEl.textContent = vampState.safetyBarsRemaining;
    } else {
      safetyCountEl.style.display = 'none';
    }

    // Enable vamp buttons
    safetyBarBtn.disabled = false;
    endVampBtn.disabled = false;
  } else {
    vampBannerEl.style.display = 'none';
    safetyCountEl.style.display = 'none';

    // Disable vamp buttons
    safetyBarBtn.disabled = true;
    endVampBtn.disabled = true;
  }
}

// Song Selector
function renderSongSelector() {
  if (!songSelectEl) return;

  songSelectEl.innerHTML = '';

  if (setlistData.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No songs in setlist';
    songSelectEl.appendChild(option);
    songSelectEl.disabled = true;
    return;
  }

  setlistData.forEach((song, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = song.name || `Song ${index + 1}`;
    if (index === currentSongIndex) {
      option.selected = true;
    }
    songSelectEl.appendChild(option);
  });

  songSelectEl.disabled = false;
}

function goToSong(songIndex) {
  const index = parseInt(songIndex);
  if (index >= 0 && index < setlistData.length) {
    console.log('Going to song:', index);
    socket.emit('conductor-go-to-song', index);
  }
}

// Control Functions
function jumpToBar(barNumber) {
  console.log('Jumping to bar:', barNumber);
  socket.emit('conductor-seek', barNumber);
}

function enableVamp(startBar, endBar, safetyBars, name = null) {
  // Validate
  if (endBar <= startBar) {
    alert('End bar must be greater than start bar');
    return;
  }

  console.log('Enabling vamp:', { startBar, endBar, safetyBars, name });
  socket.emit('conductor-vamp-enable', {
    startBar: parseInt(startBar),
    endBar: parseInt(endBar),
    safetyBars: parseInt(safetyBars),
    name: name
  });
}

function disableVamp() {
  console.log('Disabling vamp');
  socket.emit('conductor-vamp-disable');
}

function triggerSafetyBar() {
  if (!vampState.enabled) return;
  console.log('Triggering safety bar');
  socket.emit('conductor-safety-bar-trigger');
}

function adjustTempo(delta) {
  console.log('Adjusting tempo by:', delta);
  if (delta === 0) {
    // Reset
    socket.emit('conductor-tempo-reset');
  } else {
    socket.emit('conductor-tempo-adjust', delta);
  }
}

// Event Listeners
showAllBarsCheckbox.addEventListener('change', (e) => {
  showAllBars = e.target.checked;
  renderSectionList();
});

enableCustomVampBtn.addEventListener('click', () => {
  const startBar = parseInt(customVampStartEl.value);
  const endBar = parseInt(customVampEndEl.value);
  const safetyBars = parseInt(customVampSafetyEl.value);
  enableVamp(startBar, endBar, safetyBars, null);
});

// Transport controls
stopBtn.addEventListener('click', () => {
  console.log('Stop');
  socket.emit('conductor-stop');
});

playBtn.addEventListener('click', () => {
  console.log('Play');
  socket.emit('conductor-play');
});

pauseBtn.addEventListener('click', () => {
  console.log('Pause');
  socket.emit('conductor-pause');
});

nextSongBtn.addEventListener('click', () => {
  console.log('Next song');
  socket.emit('conductor-next-song');
});

songSelectEl.addEventListener('change', (e) => {
  const selectedIndex = e.target.value;
  if (selectedIndex !== '') {
    goToSong(selectedIndex);
  }
});

safetyBarBtn.addEventListener('click', () => {
  triggerSafetyBar();
});

endVampBtn.addEventListener('click', () => {
  disableVamp();
});

// Tempo controls
document.querySelectorAll('.btn-tempo').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const delta = parseInt(e.currentTarget.dataset.delta);
    adjustTempo(delta);
  });
});

// Initialize
console.log('Conductor view initialized');
updateVampUI(); // Set initial button states

// Initialize progress bar to 0%
if (progressLineEl) {
  progressLineEl.style.left = '0%';
}
