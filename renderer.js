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
let loopCurrentBarEnabled = false;
let tapTimes = {};
let totalBars = 0;
let scoreName = 'Untitled Score';
let selectedSetlistIndex = -1;
let tempoPercentage = 100;

// Display settings
let displaySettings = {
  lightColor: '#ffffff',
  progressBarColor: '#ffffff',
  progressBarWidth: 4,
  backgroundColor: '#000000',
  backgroundFlashColor: '#808080',
  textColor: '#ffffff',
  chordColor: '#ffcc00'
};

// OSC settings
let oscSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 8000
};

// MIDI settings
let midiSettings = {
  enabled: false,
  outputPort: ''
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
  document.getElementById('saveSetlist').addEventListener('click', saveSetlist);
  document.getElementById('loadSetlist').addEventListener('click', loadSetlist);
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

  // OSC settings
  document.getElementById('oscEnabled').addEventListener('change', (e) => {
    oscSettings.enabled = e.target.checked;
    updateOscSettings();
  });
  document.getElementById('oscHost').addEventListener('blur', (e) => {
    oscSettings.host = e.target.value || '127.0.0.1';
    updateOscSettings();
  });
  document.getElementById('oscPort').addEventListener('blur', (e) => {
    oscSettings.port = parseInt(e.target.value) || 8000;
    updateOscSettings();
  });
  document.getElementById('testOsc').addEventListener('click', testOscConnection);

  // MIDI settings
  document.getElementById('midiEnabled').addEventListener('change', (e) => {
    midiSettings.enabled = e.target.checked;
    updateMidiSettings();
  });
  document.getElementById('midiOutput').addEventListener('change', (e) => {
    midiSettings.outputPort = e.target.value;
    updateMidiSettings();
  });
  document.getElementById('refreshMidiPorts').addEventListener('click', refreshMidiPorts);

  // Load MIDI ports on startup
  refreshMidiPorts();

  // Server control
  document.getElementById('startServer').addEventListener('click', startServer);
  document.getElementById('stopServer').addEventListener('click', stopServer);

  // Playback control
  document.getElementById('play').addEventListener('click', play);
  document.getElementById('pause').addEventListener('click', pause);
  document.getElementById('stop').addEventListener('click', stop);
  document.getElementById('loopCurrentBar').addEventListener('click', toggleLoopCurrentBar);
  document.getElementById('prevSong').addEventListener('click', previousSong);
  document.getElementById('nextSong').addEventListener('click', nextSong);

  // Manual sync controls
  document.getElementById('syncMinus50').addEventListener('click', () => adjustSyncOffset(-50));
  document.getElementById('syncMinus10').addEventListener('click', () => adjustSyncOffset(-10));
  document.getElementById('syncPlus10').addEventListener('click', () => adjustSyncOffset(10));
  document.getElementById('syncPlus50').addEventListener('click', () => adjustSyncOffset(50));
  document.getElementById('syncMinusBeat').addEventListener('click', () => adjustSyncByBeat(-1));
  document.getElementById('syncPlusBeat').addEventListener('click', () => adjustSyncByBeat(1));
  document.getElementById('syncReset').addEventListener('click', resetSyncOffset);
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
      case 'l':
      case 'L':
        e.preventDefault();
        toggleLoopCurrentBar();
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
  if (!serverRunning) return;

  const currentAbsoluteBar = await ipcRenderer.invoke('get-current-bar');
  const targetBar = Math.max(1, currentAbsoluteBar - 1);

  // Use direct jump for keyboard shortcuts
  await ipcRenderer.invoke('seek-to-bar', { barNumber: targetBar, mode: 'direct' });
}

async function jumpToNextBar() {
  if (!serverRunning) return;

  const currentAbsoluteBar = await ipcRenderer.invoke('get-current-bar');
  const targetBar = Math.min(totalBars, currentAbsoluteBar + 1);

  // Use direct jump for keyboard shortcuts
  await ipcRenderer.invoke('seek-to-bar', { barNumber: targetBar, mode: 'direct' });
}

// Section management
function addSection() {
  const sectionNumber = sections.length + 1;
  // Use tempo from previous section, or default to 120
  const previousTempo = sections.length > 0 ? sections[sections.length - 1].tempo : 120;
  const previousTimeSignature = sections.length > 0 ? sections[sections.length - 1].timeSignature : { beats: 4, noteValue: 4 };

  sections.push({
    name: `Section ${sectionNumber}`,
    tempo: previousTempo,
    timeSignature: { ...previousTimeSignature },
    tempoTransitionBars: 0,
    bars: [{
      chords: '',
      redirect: null,
      redirectCount: 1,
      isFermata: false,
      fermataDuration: 4,
      fermataDurationType: 'beats',
      accentPattern: [],
      subdivision: 'none',
      showAdvanced: false,
      startRepeat: false,
      endRepeat: false,
      volta: null,
      segno: false,
      coda: false,
      dalSegno: false,
      daCapo: false,
      toCoda: false,
      fine: false
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

        <div class="section-field" title="Transition happens in the PREVIOUS section's last X bars. Number of bars to gradually transition from previous tempo to this section's tempo">
          <label>Tempo Transition (bars):</label>
          <input type="number"
                 class="section-tempo-transition"
                 data-section="${sectionIndex}"
                 value="${section.tempoTransitionBars || 0}"
                 min="0"
                 max="${sectionIndex > 0 ? sections[sectionIndex - 1].bars.length : 0}"
                 ${sectionIndex === 0 ? 'disabled' : ''}>
        </div>

        <div class="section-field">
          <label>&nbsp;</label>
          <button class="delete-section-btn" data-section="${sectionIndex}" title="Delete this section">✕ Delete Section</button>
        </div>
      </div>

      <div class="bars-in-section">
        <div class="bars-in-section-controls">
          <button class="add-bar-to-section" data-section="${sectionIndex}">Add Bar</button>
          <input type="number" class="add-bars-count" data-section="${sectionIndex}" value="4" min="1" max="100" style="width: 60px;">
          <button class="add-multiple-bars" data-section="${sectionIndex}">Add Bars</button>
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
          <label>Times to redirect:</label>
          <input type="number"
                 class="bar-redirect-count"
                 data-section="${sectionIndex}"
                 data-bar="${barIndex}"
                 value="${bar.redirectCount || 1}"
                 min="1"
                 max="99"
                 ${!bar.redirect ? 'disabled' : ''}>
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
          <label class="checkbox-label" style="display: inline-flex; padding: 8px 0;">
            <input type="checkbox"
                   class="bar-is-fermata"
                   data-section="${sectionIndex}"
                   data-bar="${barIndex}"
                   ${bar.isFermata ? 'checked' : ''}>
            Fermata bar (hold for duration)
          </label>
        </div>

        <div class="advanced-field fermata-settings" style="display: ${bar.isFermata ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div>
            <label>Fermata Duration:</label>
            <input type="number"
                   class="bar-fermata-duration"
                   data-section="${sectionIndex}"
                   data-bar="${barIndex}"
                   value="${bar.fermataDuration || 4}"
                   min="0.5"
                   step="0.5"
                   style="width: 100%; padding: 6px 10px; background: #252525; color: #e0e0e0; border: 1px solid #444; border-radius: 4px;">
          </div>
          <div>
            <label>Duration Type:</label>
            <select class="bar-fermata-duration-type"
                    data-section="${sectionIndex}"
                    data-bar="${barIndex}"
                    style="width: 100%; padding: 6px 10px; background: #252525; color: #e0e0e0; border: 1px solid #444; border-radius: 4px;">
              <option value="beats" ${!bar.fermataDurationType || bar.fermataDurationType === 'beats' ? 'selected' : ''}>Beats</option>
              <option value="seconds" ${bar.fermataDurationType === 'seconds' ? 'selected' : ''}>Seconds</option>
            </select>
          </div>
        </div>

        <div class="advanced-field" style="display: ${bar.isFermata ? 'none' : 'block'};">
          <label>Accent Pattern (check beats to accent):</label>
          <div class="accent-pattern">
            ${accentCheckboxes.join('')}
          </div>
        </div>

        <div class="advanced-field" style="display: ${bar.isFermata ? 'none' : 'block'};">
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

        <div class="advanced-field" style="border-top: 1px solid #444; padding-top: 10px; margin-top: 10px;">
          <label style="font-weight: 600; margin-bottom: 8px; display: block;">Repeat/Volta Markers:</label>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-start-repeat"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.startRepeat ? 'checked' : ''}>
              Start Repeat |:
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-end-repeat"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.endRepeat ? 'checked' : ''}>
              End Repeat :|
            </label>
            <div>
              <label style="font-size: 0.9em;">Ending #:</label>
              <input type="text"
                     class="bar-volta"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     value="${bar.volta ? (Array.isArray(bar.volta) ? bar.volta.join(',') : bar.volta) : ''}"
                     placeholder="1,2 or 1,2,3"
                     style="width: 100%; padding: 6px 10px; background: #252525; color: #e0e0e0; border: 1px solid #444; border-radius: 4px;">
            </div>
          </div>
        </div>

        <div class="advanced-field" style="border-top: 1px solid #444; padding-top: 10px; margin-top: 10px;">
          <label style="font-weight: 600; margin-bottom: 8px; display: block;">Navigation Markers:</label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-segno"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.segno ? 'checked' : ''}>
              Segno 𝄋 (target)
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-coda"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.coda ? 'checked' : ''}>
              Coda ⊕ (target)
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-dal-segno"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.dalSegno ? 'checked' : ''}>
              D.S. (to Segno)
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-da-capo"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.daCapo ? 'checked' : ''}>
              D.C. (to start)
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-to-coda"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.toCoda ? 'checked' : ''}>
              To Coda →⊕
            </label>
            <label class="checkbox-label">
              <input type="checkbox"
                     class="bar-fine"
                     data-section="${sectionIndex}"
                     data-bar="${barIndex}"
                     ${bar.fine ? 'checked' : ''}>
              Fine (end)
            </label>
          </div>
        </div>

        <div class="advanced-field">
          <label>OSC Trigger (send when bar starts):</label>
          <input type="text"
                 class="bar-osc-address"
                 data-section="${sectionIndex}"
                 data-bar="${barIndex}"
                 value="${bar.oscAddress || ''}"
                 placeholder="/trigger/play">
          <input type="text"
                 class="bar-osc-args"
                 data-section="${sectionIndex}"
                 data-bar="${barIndex}"
                 value="${bar.oscArgs || ''}"
                 placeholder="arguments (comma-separated)">
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

  // Section tempo transition
  document.querySelectorAll('.section-tempo-transition').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      let value = parseInt(e.target.value) || 0;

      // Validate: transition happens in PREVIOUS section, so check previous section's bar count
      if (sectionIndex > 0) {
        const previousSection = sections[sectionIndex - 1];
        const maxTransitionBars = previousSection.bars.length;

        // Update max attribute
        e.target.max = maxTransitionBars;

        // Clamp value
        if (value > maxTransitionBars) {
          value = maxTransitionBars;
          e.target.value = value;
        }
      }

      sections[sectionIndex].tempoTransitionBars = value;
    });
    input.addEventListener('blur', (e) => {
      updateServerIfRunning();
    });
  });

  // Update tempo transition max values based on previous section bar counts
  updateTempoTransitionMaxValues();

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

  document.querySelectorAll('.add-multiple-bars').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const countInput = document.querySelector(`.add-bars-count[data-section="${sectionIndex}"]`);
      const count = parseInt(countInput.value) || 1;
      addBarsToSection(sectionIndex, count);
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

      // Enable/disable redirect count input
      const countInput = document.querySelector(`.bar-redirect-count[data-section="${sectionIndex}"][data-bar="${barIndex}"]`);
      if (countInput) {
        countInput.disabled = !e.target.value;
      }

      updateServerIfRunning();
    });
  });

  // Bar redirect count
  document.querySelectorAll('.bar-redirect-count').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].redirectCount = parseInt(e.target.value) || 1;
    });
    input.addEventListener('blur', (e) => {
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

  // Fermata checkbox
  document.querySelectorAll('.bar-is-fermata').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].isFermata = e.target.checked;
      renderSections(); // Re-render to show/hide fermata settings
      updateServerIfRunning();
    });
  });

  // Fermata duration
  document.querySelectorAll('.bar-fermata-duration').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].fermataDuration = parseFloat(e.target.value) || 4;
    });
    input.addEventListener('blur', () => updateServerIfRunning());
  });

  // Fermata duration type
  document.querySelectorAll('.bar-fermata-duration-type').forEach(select => {
    select.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].fermataDurationType = e.target.value;
      updateServerIfRunning();
    });
  });

  // Start Repeat checkbox
  document.querySelectorAll('.bar-start-repeat').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].startRepeat = e.target.checked;
      updateServerIfRunning();
    });
  });

  // End Repeat checkbox
  document.querySelectorAll('.bar-end-repeat').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].endRepeat = e.target.checked;
      updateServerIfRunning();
    });
  });

  // Volta/Ending number (supports comma-separated values like "1,2,3")
  document.querySelectorAll('.bar-volta').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      const inputValue = e.target.value.trim();

      if (!inputValue) {
        sections[sectionIndex].bars[barIndex].volta = null;
        return;
      }

      // Parse comma-separated values
      const voltaNumbers = inputValue
        .split(',')
        .map(v => parseInt(v.trim()))
        .filter(v => !isNaN(v) && v > 0);

      sections[sectionIndex].bars[barIndex].volta = voltaNumbers.length > 0 ? voltaNumbers : null;
    });
    input.addEventListener('blur', () => updateServerIfRunning());
  });

  // Segno checkbox
  document.querySelectorAll('.bar-segno').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].segno = e.target.checked;
      updateServerIfRunning();
    });
  });

  // Coda checkbox
  document.querySelectorAll('.bar-coda').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].coda = e.target.checked;
      updateServerIfRunning();
    });
  });

  // Dal Segno checkbox
  document.querySelectorAll('.bar-dal-segno').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].dalSegno = e.target.checked;
      updateServerIfRunning();
    });
  });

  // Da Capo checkbox
  document.querySelectorAll('.bar-da-capo').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].daCapo = e.target.checked;
      updateServerIfRunning();
    });
  });

  // To Coda checkbox
  document.querySelectorAll('.bar-to-coda').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].toCoda = e.target.checked;
      updateServerIfRunning();
    });
  });

  // Fine checkbox
  document.querySelectorAll('.bar-fine').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].fine = e.target.checked;
      updateServerIfRunning();
    });
  });

  // OSC trigger fields
  document.querySelectorAll('.bar-osc-address').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].oscAddress = e.target.value;
    });
    input.addEventListener('blur', () => updateServerIfRunning());
  });

  document.querySelectorAll('.bar-osc-args').forEach(input => {
    input.addEventListener('input', (e) => {
      const sectionIndex = parseInt(e.target.dataset.section);
      const barIndex = parseInt(e.target.dataset.bar);
      sections[sectionIndex].bars[barIndex].oscArgs = e.target.value;
    });
    input.addEventListener('blur', () => updateServerIfRunning());
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
    redirectCount: 1,
    isFermata: false,
    fermataDuration: 4,
    fermataDurationType: 'beats',
    accentPattern: [],
    subdivision: 'none',
    showAdvanced: false,
    startRepeat: false,
    endRepeat: false,
    volta: null,
    segno: false,
    coda: false,
    dalSegno: false,
    daCapo: false,
    toCoda: false,
    fine: false
  });
  calculateTotalBars();
  renderSections(); // Re-render everything to update all redirect options
  updateTempoTransitionMaxValues(); // Update max values for tempo transitions
  updateServerIfRunning();
}

function addBarsToSection(sectionIndex, count) {
  for (let i = 0; i < count; i++) {
    sections[sectionIndex].bars.push({
      chords: '',
      redirect: null,
      redirectCount: 1,
      isFermata: false,
      fermataDuration: 4,
      fermataDurationType: 'beats',
      accentPattern: [],
      subdivision: 'none',
      showAdvanced: false,
      startRepeat: false,
      endRepeat: false,
      volta: null,
      segno: false,
      coda: false,
      dalSegno: false,
      daCapo: false,
      toCoda: false,
      fine: false
    });
  }
  calculateTotalBars();
  renderSections();
  updateTempoTransitionMaxValues(); // Update max values for tempo transitions
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
  updateTempoTransitionMaxValues(); // Update max values for tempo transitions
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
    updateTempoTransitionMaxValues(); // Update max values for tempo transitions
    updateServerIfRunning();
  }
}

function calculateTotalBars() {
  totalBars = sections.reduce((sum, section) => sum + section.bars.length, 0);
}

function updateTempoTransitionMaxValues() {
  // Update max values for tempo transition inputs based on previous section bar counts
  document.querySelectorAll('.section-tempo-transition').forEach(input => {
    const sectionIndex = parseInt(input.dataset.section);

    if (sectionIndex > 0) {
      const previousSection = sections[sectionIndex - 1];
      const maxTransitionBars = previousSection.bars.length;

      // Update max attribute
      input.max = maxTransitionBars;

      // Clamp current value if it exceeds the max
      const currentValue = parseInt(input.value) || 0;
      if (currentValue > maxTransitionBars) {
        input.value = maxTransitionBars;
        sections[sectionIndex].tempoTransitionBars = maxTransitionBars;
      }
    }
  });
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

  // Get selected jump mode
  const jumpMode = document.querySelector('input[name="jumpMode"]:checked').value;

  await ipcRenderer.invoke('seek-to-bar', { barNumber, mode: jumpMode });
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

async function saveSetlist() {
  if (setlist.length === 0) {
    await showAlert('No songs in setlist to save.');
    return;
  }

  const setlistData = {
    name: 'Setlist',
    songs: setlist
  };

  const result = await ipcRenderer.invoke('save-setlist', setlistData);
  if (result.success) {
    await showAlert(`Setlist saved to ${result.filePath}`);
  }
}

async function loadSetlist() {
  const result = await ipcRenderer.invoke('load-setlist');

  if (result.success) {
    const data = result.data;
    if (data.songs && Array.isArray(data.songs)) {
      setlist = data.songs;
      currentSongIndex = 0;
      selectedSetlistIndex = -1;
      renderSetlist();
      updateSetlistControls();
      updateSongSelect();
      await showAlert(`Loaded setlist with ${setlist.length} songs!`);
    } else {
      await showAlert('Invalid setlist file format.');
    }
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
            redirectCount: 1,
            isFermata: false,
            fermataDuration: 4,
            fermataDurationType: 'beats',
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

  // Read current OSC settings from UI
  oscSettings.enabled = document.getElementById('oscEnabled').checked;
  oscSettings.host = document.getElementById('oscHost').value || '127.0.0.1';
  oscSettings.port = parseInt(document.getElementById('oscPort').value) || 8000;

  // Read current MIDI settings from UI
  midiSettings.enabled = document.getElementById('midiEnabled').checked;
  midiSettings.outputPort = document.getElementById('midiOutput').value;

  // Read port from UI
  const port = parseInt(document.getElementById('serverPort').value) || 3000;

  const result = await ipcRenderer.invoke('start-server', { scoreData, displaySettings, repeatSong, oscSettings, midiSettings, port });

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
    document.getElementById('loopCurrentBar').disabled = false;
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
  document.getElementById('syncOffsetDisplay').textContent = '0 ms';
  document.getElementById('startServer').disabled = false;
  document.getElementById('stopServer').disabled = true;
  document.getElementById('play').disabled = true;
  document.getElementById('pause').disabled = true;
  document.getElementById('stop').disabled = true;
  document.getElementById('loopCurrentBar').disabled = true;
  loopCurrentBarEnabled = false;
  updateLoopCurrentBarButton();
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
  } else {
    // Reset sync offset display when stopping
    document.getElementById('syncOffsetDisplay').textContent = '0 ms';
    // Disable loop current bar when stopping
    if (loopCurrentBarEnabled) {
      loopCurrentBarEnabled = false;
      updateLoopCurrentBarButton();
    }
  }
}

async function toggleLoopCurrentBar() {
  if (!serverRunning) return;

  loopCurrentBarEnabled = !loopCurrentBarEnabled;
  const result = await ipcRenderer.invoke('toggle-loop-current-bar', loopCurrentBarEnabled);

  if (!result.success) {
    await showAlert(result.error);
    loopCurrentBarEnabled = !loopCurrentBarEnabled; // Revert on error
  }

  updateLoopCurrentBarButton();
}

function updateLoopCurrentBarButton() {
  const button = document.getElementById('loopCurrentBar');
  if (loopCurrentBarEnabled) {
    button.style.background = '#28a745';
    button.style.color = 'white';
    button.textContent = '◉ Looping Current Bar';
  } else {
    button.style.background = '#6c757d';
    button.style.color = 'white';
    button.textContent = 'Loop Current Bar';
  }
}

// Display settings functions
function applyDisplaySettings() {
  displaySettings = {
    lightColor: document.getElementById('lightColor').value,
    progressBarColor: document.getElementById('progressBarColor').value,
    progressBarWidth: parseInt(document.getElementById('progressBarWidth').value),
    backgroundColor: document.getElementById('backgroundColor').value,
    backgroundFlashColor: document.getElementById('backgroundFlashColor').value,
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
    lightColor: '#ffffff',
    progressBarColor: '#ffffff',
    progressBarWidth: 4,
    backgroundColor: '#000000',
    backgroundFlashColor: '#808080',
    textColor: '#ffffff',
    chordColor: '#ffcc00'
  };

  // Update UI
  document.getElementById('lightColor').value = displaySettings.lightColor;
  document.getElementById('progressBarColor').value = displaySettings.progressBarColor;
  document.getElementById('progressBarWidth').value = displaySettings.progressBarWidth;
  document.getElementById('progressBarWidthDisplay').textContent = `${displaySettings.progressBarWidth}px`;
  document.getElementById('backgroundColor').value = displaySettings.backgroundColor;
  document.getElementById('backgroundFlashColor').value = displaySettings.backgroundFlashColor;
  document.getElementById('textColor').value = displaySettings.textColor;
  document.getElementById('chordColor').value = displaySettings.chordColor;

  // Send to server if running
  if (serverRunning) {
    ipcRenderer.invoke('update-display-settings', displaySettings);
  }
}

// OSC functions
async function updateOscSettings() {
  if (serverRunning) {
    await ipcRenderer.invoke('update-osc-settings', oscSettings);
  }
}

async function testOscConnection() {
  const result = await ipcRenderer.invoke('test-osc', oscSettings);
  if (result.success) {
    await showAlert('OSC test message sent! Check your OSC receiver.');
  } else {
    await showAlert(`OSC error: ${result.error}`);
  }
}

// MIDI functions
async function refreshMidiPorts() {
  const result = await ipcRenderer.invoke('get-midi-ports');
  const select = document.getElementById('midiOutput');
  const currentValue = select.value;

  select.innerHTML = '<option value="">Select MIDI output...</option>';

  if (result.success && result.ports) {
    result.ports.forEach(port => {
      const option = document.createElement('option');
      option.value = port;
      option.textContent = port;
      if (port === currentValue) option.selected = true;
      select.appendChild(option);
    });
  }
}

async function updateMidiSettings() {
  if (serverRunning) {
    await ipcRenderer.invoke('update-midi-settings', midiSettings);
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

// Listen for sync offset updates
ipcRenderer.on('sync-offset-update', (event, offset) => {
  document.getElementById('syncOffsetDisplay').textContent = `${offset >= 0 ? '+' : ''}${offset} ms`;
});

// Manual sync functions
async function adjustSyncOffset(ms) {
  if (!serverRunning) return;
  await ipcRenderer.invoke('adjust-sync-offset', ms);
}

async function adjustSyncByBeat(direction) {
  if (!serverRunning) return;
  await ipcRenderer.invoke('adjust-sync-by-beat', direction);
}

async function resetSyncOffset() {
  if (!serverRunning) return;
  await ipcRenderer.invoke('reset-sync-offset');
}

// Initialize on load
init();
