const { ipcRenderer } = require('electron');

// Async dialog helpers (fixes Windows input focus bug with synchronous dialogs)
async function showAlert(message) {
  await ipcRenderer.invoke('show-message-box', {
    type: 'info',
    message: message,
    buttons: ['OK']
  });
}

async function showConfirm(message) {
  const result = await ipcRenderer.invoke('show-message-box', {
    type: 'question',
    message: message,
    buttons: ['Cancel', 'OK'],
    defaultId: 1,
    cancelId: 0
  });
  return result.response === 1; // Returns true if OK was clicked
}

// State
let sections = [];
let serverRunning = false;
let setlist = [];
let currentSongIndex = 0;
let autoAdvance = false;
let pauseBetweenSongs = 3;
let repeatSong = false;
let loopEnabled = false;
let loopStart = null;
let loopEnd = null;
let tapTimes = {};
let totalBars = 0;
let scoreName = 'Untitled Score';
let selectedSetlistIndex = -1;
let tempoPercentage = 100;

// Display settings
let displaySettings = {
  lightColor: '#ff0000',
  progressBarColor: '#ff0000',
  progressBarWidth: 4,
  backgroundColor: '#000000',
  textColor: '#ffffff',
  chordColor: '#ffcc00'
};

// Initialize
function init() {
  addSection();
  setupEventListeners();
  setupKeyboardShortcuts();
  calculateTotalBars();
}

function setupEventListeners() {
  // Tab navigation
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', (e) => {
      const tabName = e.target.dataset.tab;
      switchTab(tabName);
    });
  });

  // Score name
  document.getElementById('scoreName').addEventListener('input', (e) => {
    scoreName = e.target.value;
  });

  // Sections
  document.getElementById('addSection').addEventListener('click', addSection);

  // Countoff setting
  document.getElementById('countoff').addEventListener('change', () => {
    updateServerIfRunning();
  });

  // Loop & Navigation
  document.getElementById('enableLoop').addEventListener('click', enableLoop);
  document.getElementById('disableLoop').addEventListener('click', disableLoop);
  document.getElementById('jumpBtn').addEventListener('click', jumpToBar);

  // Setlist
  document.getElementById('addCurrentToSetlist').addEventListener('click', addToSetlist);
  document.getElementById('loadScoreToSetlist').addEventListener('click', loadScoreToSetlist);
  document.getElementById('clearSetlist').addEventListener('click', clearSetlist);
  document.getElementById('moveUp').addEventListener('click', moveSetlistItemUp);
  document.getElementById('moveDown').addEventListener('click', moveSetlistItemDown);
  document.getElementById('autoAdvance').addEventListener('change', (e) => {
    autoAdvance = e.target.checked;
    document.getElementById('autoAdvanceSettings').style.display = autoAdvance ? 'block' : 'none';
  });

  document.getElementById('pauseBetweenSongs').addEventListener('change', (e) => {
    pauseBetweenSongs = parseInt(e.target.value) || 3;
  });

  document.getElementById('repeatSong').addEventListener('change', (e) => {
    repeatSong = e.target.checked;
    if (serverRunning) {
      ipcRenderer.invoke('set-repeat', repeatSong);
    }
  });

  // Song selection
  document.getElementById('currentSongSelect').addEventListener('change', (e) => {
    const index = parseInt(e.target.value);
    if (index >= 0 && index < setlist.length) {
      loadSongFromSetlist(index);
    }
  });

  // File operations
  document.getElementById('saveScore').addEventListener('click', saveScore);
  document.getElementById('loadScore').addEventListener('click', loadScore);
  document.getElementById('importMusicXML').addEventListener('click', importMusicXML);
  document.getElementById('newScore').addEventListener('click', newScore);

  // Tempo percentage
  document.getElementById('tempoPercentage').addEventListener('input', (e) => {
    tempoPercentage = parseInt(e.target.value);
    document.getElementById('tempoPercentageDisplay').textContent = `${tempoPercentage}%`;
    updateServerIfRunning();
  });

  document.getElementById('resetTempoPercentage').addEventListener('click', () => {
    tempoPercentage = 100;
    document.getElementById('tempoPercentage').value = 100;
    document.getElementById('tempoPercentageDisplay').textContent = '100%';
    updateServerIfRunning();
  });

  // Display settings
  document.getElementById('progressBarWidth').addEventListener('input', (e) => {
    document.getElementById('progressBarWidthDisplay').textContent = `${e.target.value}px`;
  });

  document.getElementById('applyDisplaySettings').addEventListener('click', applyDisplaySettings);
  document.getElementById('resetDisplaySettings').addEventListener('click', resetDisplaySettings);

  // Server control
  document.getElementById('startServer').addEventListener('click', startServer);
  document.getElementById('stopServer').addEventListener('click', stopServer);

  // Playback control
  document.getElementById('play').addEventListener('click', play);
  document.getElementById('pause').addEventListener('click', pause);
  document.getElementById('stop').addEventListener('click', stop);
  document.getElementById('prevSong').addEventListener('click', previousSong);
  document.getElementById('nextSong').addEventListener('click', nextSong);
}

function switchTab(tabName) {
  // Hide all tab contents
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });

  // Deactivate all tab buttons
  document.querySelectorAll('.tab-button').forEach(button => {
    button.classList.remove('active');
  });

  // Show selected tab content
  document.getElementById(tabName).classList.add('active');

  // Activate selected tab button
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

function setupKeyboardShortcuts() {
  // Make sure input fields can receive keyboard input
  document.addEventListener('keydown', (e) => {
    const target = e.target;

    // Explicitly allow ALL keyboard input in input fields
    if (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable) {
      // Don't prevent default, don't stop propagation
      // Just return and let the browser handle it
      return;
    }

    // Only process shortcuts if we're NOT in an input field
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlayPause();
        break;
      case 's':
      case 'S':
        e.preventDefault();
        stop();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        previousSong();
        break;
      case 'ArrowRight':
        e.preventDefault();
        nextSong();
        break;
      case 'ArrowUp':
        e.preventDefault();
        jumpToPreviousBar();
        break;
      case 'ArrowDown':
        e.preventDefault();
        jumpToNextBar();
        break;
    }
  }, false); // Use bubble phase, not capture
}

async function togglePlayPause() {
  if (!serverRunning) return;

  // Check if we're currently playing by checking the result from the server
  const status = await ipcRenderer.invoke('get-playback-status');

  if (status.isPlaying) {
    await pause();
  } else {
    await play();
  }
}

async function jumpToPreviousBar() {
  const jumpInput = document.getElementById('jumpToBar');
  const current = parseInt(jumpInput.value) || 1;
  jumpInput.value = Math.max(1, current - 1);
  await jumpToBar();
}

async function jumpToNextBar() {
  const jumpInput = document.getElementById('jumpToBar');
  const current = parseInt(jumpInput.value) || 1;
  jumpInput.value = Math.min(totalBars, current + 1);
  await jumpToBar();
}

// Section management
function addSection() {
  const sectionNumber = sections.length + 1;
  sections.push({
    name: `Section ${sectionNumber}`,
    tempo: 120,
    timeSignature: {
      beats: 4,
      noteValue: 4
    },
    bars: [{
      chords: '',
      redirect: null,
      accentPattern: [],
      subdivision: 'none',
      showAdvanced: false
    }]
  });
  renderSections();
  calculateTotalBars();
  updateServerIfRunning();
}


function renderSections() {
  const container = document.getElementById('sectionsContainer');
  container.innerHTML = '';

  sections.forEach((section, sectionIndex) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section-item';

    sectionDiv.innerHTML = `
      <div class="section-header">
        <div class="section-field">
          <label>Section Name:</label>
          <input type="text"
                 class="section-name"
                 data-section="${sectionIndex}"
                 value="${section.name}">
        </div>

        <div class="section-field">
          <label>Tempo (BPM):</label>
          <div class="tempo-with-tap">
            <input type="number"
                   class="section-tempo"
                   data-section="${sectionIndex}"
                   value="${section.tempo}"
                   min="20"
                   max="300">
            <button class="tap-tempo-btn" data-section="${sectionIndex}">Tap</button>
          </div>
        </div>

        <div class="section-field">
          <label>Time Signature:</label>
          <div class="section-time-signature">
            <input type="number"
                   class="section-ts-beats"
                   data-section="${sectionIndex}"
                   value="${section.timeSignature.beats}"
                   min="1"
                   max="16">
            <span>/</span>
            <select class="section-ts-note" data-section="${sectionIndex}">
              <option value="2" ${section.timeSignature.noteValue === 2 ? 'selected' : ''}>2</option>
              <option value="4" ${section.timeSignature.noteValue === 4 ? 'selected' : ''}>4</option>
              <option value="8" ${section.timeSignature.noteValue === 8 ? 'selected' : ''}>8</option>
              <option value="16" ${section.timeSignature.noteValue === 16 ? 'selected' : ''}>16</option>
            </select>
          </div>
        </div>

        <div class="section-field">
          <label>&nbsp;</label>
          <button class="delete-section-btn" data-section="${sectionIndex}" title="Delete this section">✕ Delete Section</button>
        </div>
      </div>

      <div class="bars-in-section">
        <div class="bars-in-section-controls">
          <button class="add-bar-to-section" data-section="${sectionIndex}">Add Bar</button>
        </div>
        <div class="bars-container" data-section="${sectionIndex}"></div>
      </div>
    `;

    container.appendChild(sectionDiv);

    // Render bars for this section
    renderBarsForSection(sectionIndex);
  });

  // Add event listeners
  attachSectionEventListeners();
}

function renderBarsForSection(sectionIndex) {
  const container = document.querySelector(`.bars-container[data-section="${sectionIndex}"]`);
  const section = sections[sectionIndex];

  if (!container) return;

  container.innerHTML = '';

  // Calculate absolute bar numbers
  let absoluteBarNumber = 1;
  for (let i = 0; i < sectionIndex; i++) {
    absoluteBarNumber += sections[i].bars.length;
  }

  section.bars.forEach((bar, barIndex) => {
    const currentAbsoluteBar = absoluteBarNumber + barIndex;

    const barDiv = document.createElement('div');
    barDiv.className = 'bar-item-wrapper';

    // Generate accent pattern checkboxes
    const accentCheckboxes = [];
    for (let i = 0; i < section.timeSignature.beats; i++) {
      const isAccented = bar.accentPattern && bar.accentPattern.includes(i);
      accentCheckboxes.push(`
        <label class="accent-checkbox">
          <input type="checkbox"
                 class="accent-beat"
                 data-section="${sectionIndex}"
                 data-bar="${barIndex}"
                 data-beat="${i}"
                 ${isAccented ? 'checked' : ''}>
          ${i + 1}
        </label>
      `);
    }

    barDiv.innerHTML = `
      <div class="bar-item">
        <div class="bar-number">Bar ${currentAbsoluteBar}</div>

        <div class="bar-field">
          <label>Chord(s):</label>
          <input type="text"
                 class="bar-chords"
                 data-section="${sectionIndex}"
                 data-bar="${barIndex}"
                 value="${bar.chords || ''}"
                 placeholder="e.g., Cmaj7, G7">
        </div>

        <div class="bar-field">
          <label>Redirect to bar:</label>
          <select class="bar-redirect"
                  data-section="${sectionIndex}"
                  data-bar="${barIndex}">
            <option value="">None</option>
            ${generateRedirectOptions(currentAbsoluteBar, bar.redirect)}
          </select>
        </div>

        <div class="bar-field">
          <div class="toggle-advanced" data-section="${sectionIndex}" data-bar="${barIndex}">
            <span class="triangle">${bar.showAdvanced ? '▼' : '▶'}</span> Advanced
          </div>
        </div>

        <div class="bar-field">
          <button class="delete-bar-btn" data-section="${sectionIndex}" data-bar="${barIndex}" title="Delete this bar">✕</button>
        </div>
      </div>

      <div class="bar-advanced ${bar.showAdvanced ? 'show' : ''}" data-section="${sectionIndex}" data-bar="${barIndex}">
        <div class="advanced-field">
          <label>Accent Pattern (check beats to accent):</label>
          <div class="accent-pattern">
            ${accentCheckboxes.join('')}
          </div>
        </div>

        <div class="advanced-field">
          <label>Subdivision:</label>
          <select class="bar-subdivision" data-section="${sectionIndex}" data-bar="${barIndex}">
            <option value="none" ${!bar.subdivision || bar.subdivision === 'none' ? 'selected' : ''}>None</option>
            <option value="8th" ${bar.subdivision === '8th' ? 'selected' : ''}>8th notes</option>
            <option value="16th" ${bar.subdivision === '16th' ? 'selected' : ''}>16th notes</option>
            <option value="triplet" ${bar.subdivision === 'triplet' ? 'selected' : ''}>Triplets</option>
            <option value="quintuplet" ${bar.subdivision === 'quintuplet' ? 'selected' : ''}>Quintuplets</option>
            <option value="sextuplet" ${bar.subdivision === 'sextuplet' ? 'selected' : ''}>Sextuplets</option>
          </select>
        </div>
      </div>
    `;

    container.appendChild(barDiv);
  });
}

function generateRedirectOptions(currentBar, selectedRedirect) {
  let options = '';
  for (let i = 1; i <= totalBars; i++) {
    if (i !== currentBar) {
      const selected = selectedRedirect === i ? 'selected' : '';
      options += `<option value="${i}" ${selected}>Bar ${i}</option>`;
    }
  }
  return options;
}

function attachSectionEventListeners() {
  // Section name - don't re-render on input
  document.querySelectorAll('.section-name').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      sections[sectionIndex].name = e.target.value;
      // Don't call updateServerIfRunning here to avoid interrupting typing
    });
    input.addEventListener('blur', (e) => {
      updateServerIfRunning();
    });
  });

  // Section tempo
  document.querySelectorAll('.section-tempo').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      sections[sectionIndex].tempo = parseInt(e.target.value);
      // Update server on blur to avoid interrupting typing
    });
    input.addEventListener('blur', (e) => {
      updateServerIfRunning();
    });
  });

  // Section time signature
  document.querySelectorAll('.section-ts-beats').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      sections[sectionIndex].timeSignature.beats = parseInt(e.target.value);
    });
    input.addEventListener('blur', (e) => {
      updateServerIfRunning();
    });
  });

  document.querySelectorAll('.section-ts-note').forEach(select => {
    select.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      sections[sectionIndex].timeSignature.noteValue = parseInt(e.target.value);
      updateServerIfRunning();
    });
  });

  // Tap tempo buttons per section
  document.querySelectorAll('.tap-tempo-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      handleTapTempo(sectionIndex, e.target);
    });
  });

  // Add/Remove bar buttons
  document.querySelectorAll('.add-bar-to-section').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      addBarToSection(sectionIndex);
    });
  });


  // Bar chords - don't update server while typing
  document.querySelectorAll('.bar-chords').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].chords = e.target.value;
      // Don't update server while typing
    });
    input.addEventListener('blur', (e) => {
      updateServerIfRunning();
    });
  });

  // Bar redirects
  document.querySelectorAll('.bar-redirect').forEach(select => {
    select.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].redirect = e.target.value ? parseInt(e.target.value) : null;
      updateServerIfRunning();
    });
  });

  // Toggle advanced options
  document.querySelectorAll('.toggle-advanced').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].showAdvanced = !sections[sectionIndex].bars[barIndex].showAdvanced;
      renderSections();
    });
  });

  // Accent pattern checkboxes
  document.querySelectorAll('.accent-beat').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      const beat = parseInt(e.target.dataset.beat);

      if (!sections[sectionIndex].bars[barIndex].accentPattern) {
        sections[sectionIndex].bars[barIndex].accentPattern = [];
      }

      if (e.target.checked) {
        if (!sections[sectionIndex].bars[barIndex].accentPattern.includes(beat)) {
          sections[sectionIndex].bars[barIndex].accentPattern.push(beat);
        }
      } else {
        sections[sectionIndex].bars[barIndex].accentPattern =
          sections[sectionIndex].bars[barIndex].accentPattern.filter(b => b !== beat);
      }
      updateServerIfRunning();
    });
  });

  // Subdivision dropdown
  document.querySelectorAll('.bar-subdivision').forEach(select => {
    select.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].subdivision = e.target.value;
      updateServerIfRunning();
    });
  });

  // Delete section buttons
  document.querySelectorAll('.delete-section-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      deleteSection(sectionIndex);
    });
  });

  // Delete bar buttons
  document.querySelectorAll('.delete-bar-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      deleteBar(sectionIndex, barIndex);
    });
  });
}

function addBarToSection(sectionIndex) {
  sections[sectionIndex].bars.push({
    chords: '',
    redirect: null,
    accentPattern: [],
    subdivision: 'none',
    showAdvanced: false
  });
  calculateTotalBars();
  renderSections(); // Re-render everything to update all redirect options
  updateServerIfRunning();
}


async function deleteBar(sectionIndex, barIndex) {
  const section = sections[sectionIndex];

  if (section.bars.length === 1) {
    if (await showConfirm('This is the last bar in this section. Delete the entire section?')) {
      deleteSection(sectionIndex);
    }
    return;
  }

  sections[sectionIndex].bars.splice(barIndex, 1);
  calculateTotalBars();
  renderSections();
  updateServerIfRunning();
}

async function deleteSection(sectionIndex) {
  if (sections.length === 1) {
    await showAlert('Cannot delete the last section. At least one section is required.');
    return;
  }

  const sectionName = sections[sectionIndex].name;
  const barCount = sections[sectionIndex].bars.length;

  if (await showConfirm(`Delete section "${sectionName}" with ${barCount} bar(s)?`)) {
    sections.splice(sectionIndex, 1);
    calculateTotalBars();
    renderSections();
    updateServerIfRunning();
  }
}

function calculateTotalBars() {
  totalBars = sections.reduce((sum, section) => sum + section.bars.length, 0);
}

// Tap tempo per section
function handleTapTempo(sectionIndex, buttonElement) {
  const now = Date.now();

  // Visual feedback
  buttonElement.classList.add('active');
  setTimeout(() => buttonElement.classList.remove('active'), 100);

  // Initialize tap times for this section if needed
  if (!tapTimes[sectionIndex]) {
    tapTimes[sectionIndex] = [];
  }

  // Reset if more than 3 seconds since last tap
  if (tapTimes[sectionIndex].length > 0) {
    const timeSinceLastTap = now - tapTimes[sectionIndex][tapTimes[sectionIndex].length - 1];
    if (timeSinceLastTap > 3000) {
      tapTimes[sectionIndex] = [];
    }
  }

  tapTimes[sectionIndex].push(now);

  // Keep only last 20 taps for better averaging
  if (tapTimes[sectionIndex].length > 20) {
    tapTimes[sectionIndex].shift();
  }

  // Calculate tempo from total duration divided by number of intervals
  if (tapTimes[sectionIndex].length >= 2) {
    // Calculate average BPM from first tap to last tap
    const totalDuration = now - tapTimes[sectionIndex][0];
    const numberOfIntervals = tapTimes[sectionIndex].length - 1;
    const avgInterval = totalDuration / numberOfIntervals;
    const bpm = Math.round(60000 / avgInterval);

    // Validate BPM is in reasonable range
    if (bpm >= 20 && bpm <= 300) {
      // Apply to this section only
      sections[sectionIndex].tempo = bpm;
      renderSections();
      updateServerIfRunning();
    }
  }
}

// Loop & Navigation
async function enableLoop() {
  const start = parseInt(document.getElementById('loopStart').value);
  const end = parseInt(document.getElementById('loopEnd').value);

  if (!start || !end || start < 1 || end > totalBars || start > end) {
    await showAlert('Invalid loop range. Please check bar numbers.');
    return;
  }

  loopEnabled = true;
  loopStart = start;
  loopEnd = end;

  updateServerLoopSettings();
  await showAlert(`Loop enabled: Bar ${start} to ${end}`);
}

async function disableLoop() {
  loopEnabled = false;
  loopStart = null;
  loopEnd = null;
  updateServerLoopSettings();
  await showAlert('Loop disabled');
}

async function updateServerLoopSettings() {
  if (serverRunning) {
    await ipcRenderer.invoke('set-loop', { enabled: loopEnabled, start: loopStart, end: loopEnd });
    await updateServerIfRunning(); // Also update the full score data
  }
}

async function jumpToBar() {
  const barNumber = parseInt(document.getElementById('jumpToBar').value);

  if (!barNumber || barNumber < 1 || barNumber > totalBars) {
    await showAlert(`Invalid bar number. Valid range: 1-${totalBars}`);
    return;
  }

  await ipcRenderer.invoke('seek-to-bar', barNumber);
}

// Setlist management
async function addToSetlist() {
  const scoreData = getCurrentScoreData();

  if (scoreData.sections.length === 0 || scoreData.sections.every(s => s.bars.length === 0)) {
    await showAlert('Please add at least one bar before adding to setlist');
    return;
  }

  scoreData.name = scoreName;
  setlist.push(scoreData);
  renderSetlist();
  updateSetlistControls();
  updateSongSelect();
}

async function loadScoreToSetlist() {
  const result = await ipcRenderer.invoke('load-score');

  if (result.success) {
    const scoreData = result.data;
    setlist.push(scoreData);
    renderSetlist();
    updateSetlistControls();
    updateSongSelect();
    await showAlert(`Added "${scoreData.name || 'Untitled'}" to setlist!`);
  }
}

function moveSetlistItemUp() {
  if (selectedSetlistIndex > 0) {
    const temp = setlist[selectedSetlistIndex];
    setlist[selectedSetlistIndex] = setlist[selectedSetlistIndex - 1];
    setlist[selectedSetlistIndex - 1] = temp;
    selectedSetlistIndex--;
    if (currentSongIndex === selectedSetlistIndex + 1) {
      currentSongIndex = selectedSetlistIndex;
    } else if (currentSongIndex === selectedSetlistIndex) {
      currentSongIndex++;
    }
    renderSetlist();
    updateSongSelect();
  }
}

function moveSetlistItemDown() {
  if (selectedSetlistIndex >= 0 && selectedSetlistIndex < setlist.length - 1) {
    const temp = setlist[selectedSetlistIndex];
    setlist[selectedSetlistIndex] = setlist[selectedSetlistIndex + 1];
    setlist[selectedSetlistIndex + 1] = temp;
    selectedSetlistIndex++;
    if (currentSongIndex === selectedSetlistIndex - 1) {
      currentSongIndex = selectedSetlistIndex;
    } else if (currentSongIndex === selectedSetlistIndex) {
      currentSongIndex--;
    }
    renderSetlist();
    updateSongSelect();
  }
}

async function clearSetlist() {
  if (setlist.length === 0) return;

  if (await showConfirm('Clear entire setlist?')) {
    setlist = [];
    currentSongIndex = 0;
    selectedSetlistIndex = -1;
    renderSetlist();
    updateSetlistControls();
    updateSongSelect();
  }
}

function renderSetlist() {
  const container = document.getElementById('setlistContainer');

  if (setlist.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">No songs in setlist</div>';
    return;
  }

  container.innerHTML = '';

  setlist.forEach((song, index) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = `setlist-item ${index === selectedSetlistIndex ? 'selected' : ''} ${serverRunning && index === currentSongIndex ? 'playing' : ''}`;

    const totalBarsInSong = song.sections.reduce((sum, s) => sum + s.bars.length, 0);

    itemDiv.innerHTML = `
      <div class="setlist-item-info-section">
        <div class="setlist-item-name">${index + 1}. ${song.name || 'Untitled'}</div>
        <div class="setlist-item-details">${song.sections.length} sections, ${totalBarsInSong} bars</div>
      </div>
      <div class="setlist-item-controls">
        <button class="select-song-btn" data-index="${index}">Select</button>
        <button class="remove-song-btn" data-index="${index}">Remove</button>
      </div>
    `;

    container.appendChild(itemDiv);
  });

  // Add event listeners
  document.querySelectorAll('.select-song-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      selectSetlistItem(index);
    });
  });

  document.querySelectorAll('.remove-song-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      removeSongFromSetlist(index);
    });
  });

  // Update move buttons
  document.getElementById('moveUp').disabled = selectedSetlistIndex <= 0;
  document.getElementById('moveDown').disabled = selectedSetlistIndex < 0 || selectedSetlistIndex >= setlist.length - 1;
}

function selectSetlistItem(index) {
  selectedSetlistIndex = index;
  renderSetlist();
}

async function loadSongFromSetlist(index) {
  if (index < 0 || index >= setlist.length) return;

  currentSongIndex = index;
  loadScoreData(setlist[currentSongIndex]);
  updateSongSelect();
  renderSetlist();

  if (serverRunning) {
    await restartServer();
  }
}

async function removeSongFromSetlist(index) {
  if (await showConfirm(`Remove "${setlist[index].name || 'Untitled'}" from setlist?`)) {
    setlist.splice(index, 1);
    if (selectedSetlistIndex >= setlist.length) {
      selectedSetlistIndex = setlist.length - 1;
    }
    if (currentSongIndex >= setlist.length) {
      currentSongIndex = Math.max(0, setlist.length - 1);
    }
    renderSetlist();
    updateSetlistControls();
    updateSongSelect();
  }
}

function updateSongSelect() {
  const select = document.getElementById('currentSongSelect');
  select.innerHTML = '';

  if (setlist.length === 0) {
    select.innerHTML = '<option value="">No songs in setlist</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;

  setlist.forEach((song, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `${index + 1}. ${song.name || 'Untitled'}`;
    if (index === currentSongIndex) {
      option.selected = true;
    }
    select.appendChild(option);
  });
}

function updateSetlistControls() {
  const hasSetlist = setlist.length > 0;
  document.getElementById('prevSong').disabled = !hasSetlist;
  document.getElementById('nextSong').disabled = !hasSetlist;
}

async function previousSong() {
  if (setlist.length === 0) return;

  currentSongIndex = (currentSongIndex - 1 + setlist.length) % setlist.length;
  loadScoreData(setlist[currentSongIndex]);
  updateSongSelect();
  renderSetlist();

  if (serverRunning) {
    await restartServer();
  }
}

async function nextSong() {
  if (setlist.length === 0) return;

  currentSongIndex = (currentSongIndex + 1) % setlist.length;
  loadScoreData(setlist[currentSongIndex]);
  updateSongSelect();
  renderSetlist();

  if (serverRunning) {
    await restartServer();
  }
}

async function restartServer() {
  const scoreData = getCurrentScoreData();
  await ipcRenderer.invoke('update-score', scoreData);
}

async function updateServerIfRunning() {
  if (serverRunning) {
    const scoreData = getCurrentScoreData();
    await ipcRenderer.invoke('update-score', scoreData);
  }
}

// Score data management
function getCurrentScoreData() {
  return {
    name: scoreName,
    countoff: parseInt(document.getElementById('countoff').value) || 0,
    sections: sections,
    loop: {
      enabled: loopEnabled,
      start: loopStart,
      end: loopEnd
    },
    tempoPercentage: tempoPercentage
  };
}

function loadScoreData(data) {
  scoreName = data.name || 'Untitled Score';
  document.getElementById('scoreName').value = scoreName;
  document.getElementById('countoff').value = data.countoff || 0;
  sections = data.sections || [];

  if (data.loop) {
    loopEnabled = data.loop.enabled || false;
    loopStart = data.loop.start || null;
    loopEnd = data.loop.end || null;

    if (loopStart) document.getElementById('loopStart').value = loopStart;
    if (loopEnd) document.getElementById('loopEnd').value = loopEnd;
  }

  renderSections();
  calculateTotalBars();
}

async function newScore() {
  if (await showConfirm('Create new score? Unsaved changes will be lost.')) {
    scoreName = 'Untitled Score';
    document.getElementById('scoreName').value = scoreName;
    sections = [];
    loopEnabled = false;
    loopStart = null;
    loopEnd = null;
    document.getElementById('countoff').value = 1;
    document.getElementById('loopStart').value = '';
    document.getElementById('loopEnd').value = '';
    addSection();
  }
}

// File operations
async function saveScore() {
  const scoreData = getCurrentScoreData();
  const result = await ipcRenderer.invoke('save-score', scoreData);

  if (result.success) {
    await showAlert(`Score saved successfully to ${result.filePath}`);
  }
}

async function loadScore() {
  const result = await ipcRenderer.invoke('load-score');

  if (result.success) {
    loadScoreData(result.data);
    await showAlert('Score loaded successfully!');
  }
}

async function importMusicXML() {
  const result = await ipcRenderer.invoke('load-musicxml');

  if (result.success) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(result.data, 'text/xml');

      // Extract score name from title
      const titleEl = xmlDoc.querySelector('work-title');
      scoreName = titleEl ? titleEl.textContent : 'Imported Score';
      document.getElementById('scoreName').value = scoreName;

      // Parse MusicXML structure
      sections = [];
      let currentSection = null;
      let currentSectionName = 'Section 1';
      let currentTempo = 120;
      let currentTimeSignature = { beats: 4, noteValue: 4 };
      let barCount = 0;

      const parts = xmlDoc.querySelectorAll('part');
      if (parts.length > 0) {
        const measures = parts[0].querySelectorAll('measure');

        measures.forEach((measure, index) => {
          barCount++;

          // Check for tempo changes
          const sound = measure.querySelector('sound[tempo]');
          if (sound) {
            const newTempo = parseInt(sound.getAttribute('tempo'));
            if (newTempo !== currentTempo) {
              // Start new section on tempo change
              if (currentSection && currentSection.bars.length > 0) {
                sections.push(currentSection);
              }
              currentTempo = newTempo;
              currentSection = {
                name: `Section ${sections.length + 1}`,
                tempo: currentTempo,
                timeSignature: { ...currentTimeSignature },
                bars: []
              };
            }
          }

          // Check for time signature changes
          const time = measure.querySelector('time');
          if (time) {
            const beats = time.querySelector('beats');
            const beatType = time.querySelector('beat-type');
            if (beats && beatType) {
              const newTS = {
                beats: parseInt(beats.textContent),
                noteValue: parseInt(beatType.textContent)
              };
              if (newTS.beats !== currentTimeSignature.beats ||
                  newTS.noteValue !== currentTimeSignature.noteValue) {
                // Start new section on time signature change
                if (currentSection && currentSection.bars.length > 0) {
                  sections.push(currentSection);
                }
                currentTimeSignature = newTS;
                currentSection = {
                  name: `Section ${sections.length + 1}`,
                  tempo: currentTempo,
                  timeSignature: { ...currentTimeSignature },
                  bars: []
                };
              }
            }
          }

          // Check for rehearsal marks (section names)
          const rehearsal = measure.querySelector('rehearsal');
          if (rehearsal) {
            if (currentSection && currentSection.bars.length > 0) {
              sections.push(currentSection);
            }
            currentSectionName = rehearsal.textContent || `Section ${sections.length + 1}`;
            currentSection = {
              name: currentSectionName,
              tempo: currentTempo,
              timeSignature: { ...currentTimeSignature },
              bars: []
            };
          }

          // Initialize section if not exists
          if (!currentSection) {
            currentSection = {
              name: currentSectionName,
              tempo: currentTempo,
              timeSignature: { ...currentTimeSignature },
              bars: []
            };
          }

          // Extract chord symbols
          const harmony = measure.querySelector('harmony');
          let chords = '';
          if (harmony) {
            const root = harmony.querySelector('root-step');
            const kind = harmony.querySelector('kind');
            if (root) {
              chords = root.textContent;
              const alter = harmony.querySelector('root-alter');
              if (alter) {
                const alterValue = parseInt(alter.textContent);
                if (alterValue === 1) chords += '#';
                else if (alterValue === -1) chords += 'b';
              }
              if (kind && kind.textContent !== 'major') {
                chords += kind.textContent;
              }
            }
          }

          // Add bar to current section
          currentSection.bars.push({
            chords: chords,
            redirect: null,
            accentPattern: [],
            subdivision: 'none',
            showAdvanced: false
          });
        });

        // Add final section
        if (currentSection && currentSection.bars.length > 0) {
          sections.push(currentSection);
        }
      }

      // If no sections created, create a default one
      if (sections.length === 0) {
        sections.push({
          name: 'Section 1',
          tempo: 120,
          timeSignature: { beats: 4, noteValue: 4 },
          bars: []
        });
      }

      renderSections();
      calculateTotalBars();

      await showAlert(`Imported ${barCount} bars from MusicXML!`);
    } catch (error) {
      await showAlert(`Error parsing MusicXML: ${error.message}`);
      console.error('MusicXML parse error:', error);
    }
  }
}

// Server control
async function startServer() {
  // Use setlist song if available, otherwise use current score editor
  let scoreData;
  if (setlist.length > 0) {
    scoreData = setlist[currentSongIndex];
  } else {
    scoreData = getCurrentScoreData();
  }

  if (!scoreData.sections || scoreData.sections.length === 0 || scoreData.sections.every(s => s.bars.length === 0)) {
    await showAlert('Please add at least one bar before starting the server');
    return;
  }

  // Read current display settings from UI
  applyDisplaySettings();

  const result = await ipcRenderer.invoke('start-server', { scoreData, displaySettings, repeatSong });

  if (result.success) {
    serverRunning = true;
    document.getElementById('serverStatus').textContent = `Server: Running on port ${result.port}`;
    document.getElementById('serverStatus').classList.add('running');
    document.getElementById('serverUrl').textContent = result.url;
    document.getElementById('startServer').disabled = true;
    document.getElementById('stopServer').disabled = false;
    document.getElementById('play').disabled = false;
    document.getElementById('pause').disabled = false;
    document.getElementById('stop').disabled = false;
    updateSetlistControls();
    updateSongSelect();

    await showAlert(`Server started!\nOpen this URL on client devices:\n${result.url}`);
  }
}

async function stopServer() {
  await ipcRenderer.invoke('stop-server');
  serverRunning = false;
  document.getElementById('serverStatus').textContent = 'Server: Stopped';
  document.getElementById('serverStatus').classList.remove('running');
  document.getElementById('serverUrl').textContent = '';
  document.getElementById('connectedClients').textContent = 'Clients: 0';
  document.getElementById('startServer').disabled = false;
  document.getElementById('stopServer').disabled = true;
  document.getElementById('play').disabled = true;
  document.getElementById('pause').disabled = true;
  document.getElementById('stop').disabled = true;
  updateSetlistControls();
  updateSongSelect();
}

// Playback control
async function play() {
  const result = await ipcRenderer.invoke('play-metronome');
  if (!result.success) {
    await showAlert(result.error);
  }
}

async function pause() {
  const result = await ipcRenderer.invoke('pause-metronome');
  if (!result.success) {
    await showAlert(result.error);
  }
}

async function stop() {
  const result = await ipcRenderer.invoke('stop-metronome');
  if (!result.success) {
    await showAlert(result.error);
  }
}

// Display settings functions
function applyDisplaySettings() {
  displaySettings = {
    lightColor: document.getElementById('lightColor').value,
    progressBarColor: document.getElementById('progressBarColor').value,
    progressBarWidth: parseInt(document.getElementById('progressBarWidth').value),
    backgroundColor: document.getElementById('backgroundColor').value,
    textColor: document.getElementById('textColor').value,
    chordColor: document.getElementById('chordColor').value
  };

  // Send to server if running
  if (serverRunning) {
    ipcRenderer.invoke('update-display-settings', displaySettings);
  }
}

function resetDisplaySettings() {
  displaySettings = {
    lightColor: '#ff0000',
    progressBarColor: '#ff0000',
    progressBarWidth: 4,
    backgroundColor: '#000000',
    textColor: '#ffffff',
    chordColor: '#ffcc00'
  };

  // Update UI
  document.getElementById('lightColor').value = displaySettings.lightColor;
  document.getElementById('progressBarColor').value = displaySettings.progressBarColor;
  document.getElementById('progressBarWidth').value = displaySettings.progressBarWidth;
  document.getElementById('progressBarWidthDisplay').textContent = `${displaySettings.progressBarWidth}px`;
  document.getElementById('backgroundColor').value = displaySettings.backgroundColor;
  document.getElementById('textColor').value = displaySettings.textColor;
  document.getElementById('chordColor').value = displaySettings.chordColor;

  // Send to server if running
  if (serverRunning) {
    ipcRenderer.invoke('update-display-settings', displaySettings);
  }
}

// Listen for client count updates
ipcRenderer.on('client-count-update', (event, count) => {
  document.getElementById('connectedClients').textContent = `Clients: ${count}`;
});

// Listen for song end (for auto-advance)
ipcRenderer.on('song-ended', async () => {
  if (autoAdvance && setlist.length > 0 && !repeatSong) {
    // Stop current playback first
    await ipcRenderer.invoke('stop-metronome');

    // Wait for the configured pause time, then advance
    setTimeout(async () => {
      await nextSong();
      // Play next song (nextSong calls restartServer which resets countoff)
      setTimeout(() => play(), 500);
    }, pauseBetweenSongs * 1000);
  }
  // If repeatSong is true, the server handles looping automatically
});

// Initialize on load
init();
