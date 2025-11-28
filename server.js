const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const osc = require('node-osc');
const JZZ = require('jzz');

class MetronomeServer {
  constructor(scoreData, displaySettings = null, repeatSong = false, oscSettings = null, midiSettings = null) {
    this.scoreData = scoreData;
    this.repeatSong = repeatSong;
    this.oscSettings = oscSettings || { enabled: false, host: '127.0.0.1', port: 8000 };
    this.oscClient = null;
    this.lastTriggeredBar = -1; // Track last bar to avoid duplicate triggers

    // MIDI settings
    this.midiSettings = midiSettings || { enabled: false, outputPort: '' };
    this.midiOutput = null;
    this.midiClockInterval = null;
    this.lastMidiClockTime = 0;

    // Click track settings
    this.clickSettings = { enabled: false, mode: 'clicks-only', volume: 75 };

    if (this.oscSettings.enabled) {
      this.setupOscClient();
    }

    if (this.midiSettings.enabled && this.midiSettings.outputPort) {
      this.setupMidiOutput(); // async but we don't need to wait in constructor
    }

    this.displaySettings = displaySettings || {
      lightColor: '#ff0000',
      progressBarColor: '#ff0000',
      progressBarWidth: 4,
      backgroundColor: '#000000',
      textColor: '#ffffff',
      chordColor: '#ffcc00'
    };
    this.app = express();

    // Load SSL certificates
    const sslOptions = {
      key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
    };

    this.httpServer = https.createServer(sslOptions, this.app);
    this.io = new Server(this.httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling'],
      allowEIO3: true,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.isPlaying = false;
    this.inCountoff = false;
    this.countoffBarsRemaining = 0;
    this.currentSectionIndex = 0;
    this.currentBarInSection = 0;
    this.currentBeat = 0;
    this.barStartTime = null;
    this.updateInterval = null;
    this.connectedClients = 0;

    // Loop settings
    this.loopEnabled = scoreData.loop?.enabled || false;
    this.loopStart = scoreData.loop?.start || null;
    this.loopEnd = scoreData.loop?.end || null;

    // Pending jump settings
    this.pendingJump = null; // { barNumber, mode }

    // Sync offset for manual timing adjustment
    this.syncOffset = 0; // milliseconds

    // Repeat/volta tracking
    this.repeatStack = []; // Stack of {startBar, timesPlayed, endBar}
    this.currentPassNumber = 1; // Which pass through the repeat (1, 2, 3...)

    // D.S./D.C./Coda navigation tracking
    this.hasJumpedViaDSorDC = false; // Track if we've executed a D.S. or D.C. jump
    this.shouldWatchForToCodaOrFine = false; // After D.S./D.C., watch for To Coda or Fine

    // Loop current bar setting
    this.loopCurrentBarEnabled = false;
    this.loopCurrentBarNumber = null;

    // Build flat bar structure for easier navigation
    this.buildBarStructure();

    // Callbacks
    this.onClientCountChange = null;
    this.onSongEnd = null;

    // HTTP redirect server (will be created on start)
    this.httpRedirectServer = null;
    this.httpsPort = null;

    this.setupRoutes();
    this.setupSocketHandlers();
  }

  buildBarStructure() {
    // Create a flat array of all bars with their section info
    this.flatBars = [];
    let absoluteBarNumber = 1;

    this.scoreData.sections.forEach((section, sectionIndex) => {
      section.bars.forEach((bar, barIndex) => {
        this.flatBars.push({
          absoluteNumber: absoluteBarNumber++,
          sectionIndex: sectionIndex,
          barInSection: barIndex,
          sectionName: section.name,
          tempo: section.tempo,
          tempoTransitionBars: section.tempoTransitionBars || 0,
          timeSignature: section.timeSignature,
          chords: bar.chords,
          redirect: bar.redirect,
          redirectCount: bar.redirectCount || 1,
          isFermata: bar.isFermata || false,
          fermataDuration: bar.fermataDuration || 4,
          fermataDurationType: bar.fermataDurationType || 'beats',
          accentPattern: bar.accentPattern || [],
          subdivision: bar.subdivision || 'none',
          startRepeat: bar.startRepeat || false,
          endRepeat: bar.endRepeat || false,
          volta: bar.volta || null,
          segno: bar.segno || false,
          coda: bar.coda || false,
          dalSegno: bar.dalSegno || false,
          daCapo: bar.daCapo || false,
          toCoda: bar.toCoda || false,
          fine: bar.fine || false,
          oscAddress: bar.oscAddress || null,
          oscArgs: bar.oscArgs || null
        });
      });
    });

    this.totalBars = this.flatBars.length;

    // Initialize redirect tracking
    this.redirectTracking = {};
  }

  getAbsoluteBarNumber() {
    if (this.inCountoff) {
      return -this.countoffBarsRemaining; // Negative for countoff
    }

    let absoluteBar = 1;
    for (let i = 0; i < this.currentSectionIndex; i++) {
      absoluteBar += this.scoreData.sections[i].bars.length;
    }
    absoluteBar += this.currentBarInSection;
    return absoluteBar;
  }

  getCurrentBarInfo() {
    if (this.inCountoff) {
      const firstSection = this.scoreData.sections[0];
      return {
        absoluteNumber: 0,
        sectionIndex: 0,
        barInSection: 0,
        sectionName: 'Countoff',
        tempo: firstSection.tempo,
        timeSignature: firstSection.timeSignature,
        chords: '',
        redirect: null,
        accentPattern: [0],
        subdivision: 'none',
        isCountoff: true,
        countoffBarsRemaining: this.countoffBarsRemaining
      };
    }

    const absoluteBar = this.getAbsoluteBarNumber();
    return this.flatBars[absoluteBar - 1] || null;
  }

  setupRoutes() {
    // Enable CORS for all routes
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    this.app.use(express.static(path.join(__dirname, 'public')));

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'client.html'));
    });
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);
      this.connectedClients++;
      this.notifyClientCountChange();

      // Send current score data to newly connected client
      socket.emit('score-data', this.scoreData);

      // Send display settings
      socket.emit('display-settings', this.displaySettings);

      // Send click track settings
      socket.emit('click-settings', this.clickSettings);

      // Send current playback state
      if (this.isPlaying) {
        socket.emit('state-update', this.getCurrentState());
      }

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        this.connectedClients--;
        this.notifyClientCountChange();
      });
    });
  }

  updateDisplaySettings(settings) {
    this.displaySettings = settings;
    this.io.emit('display-settings', this.displaySettings);
  }

  setRepeat(repeat) {
    this.repeatSong = repeat;
  }

  setupOscClient() {
    try {
      if (this.oscClient) {
        this.oscClient.close();
      }
      this.oscClient = new osc.Client(this.oscSettings.host, this.oscSettings.port);
      console.log(`OSC client connected to ${this.oscSettings.host}:${this.oscSettings.port}`);
    } catch (error) {
      console.error('Failed to setup OSC client:', error);
    }
  }

  updateOscSettings(settings) {
    this.oscSettings = settings;
    if (settings.enabled) {
      this.setupOscClient();
    } else if (this.oscClient) {
      this.oscClient.close();
      this.oscClient = null;
    }
  }

  sendOscMessage(address, args) {
    if (!this.oscSettings.enabled || !this.oscClient) return;

    try {
      if (args && args.length > 0) {
        this.oscClient.send(address, ...args);
      } else {
        this.oscClient.send(address);
      }
      console.log(`OSC sent: ${address}`, args);
    } catch (error) {
      console.error('OSC send error:', error);
    }
  }

  // MIDI methods
  async setupMidiOutput() {
    try {
      if (this.midiOutput) {
        this.midiOutput.close();
      }
      const jzz = await JZZ();
      this.midiOutput = await jzz.openMidiOut(this.midiSettings.outputPort);
      console.log(`MIDI output opened: ${this.midiSettings.outputPort}`);
    } catch (error) {
      console.error('Failed to setup MIDI output:', error);
      this.midiOutput = null;
    }
  }

  updateClickSettings(settings) {
    this.clickSettings = settings;
    // Broadcast click settings to all connected clients
    this.io.emit('click-settings', this.clickSettings);
  }

  async updateMidiSettings(settings) {
    this.midiSettings = settings;

    if (settings.enabled && settings.outputPort) {
      await this.setupMidiOutput();
    } else if (this.midiOutput) {
      this.stopMidiClock();
      this.midiOutput.close();
      this.midiOutput = null;
    }
  }

  startMidiClock(tempo) {
    if (!this.midiSettings.enabled || !this.midiOutput) return;

    this.stopMidiClock();

    // Send MIDI Start message (0xFA)
    try {
      this.midiOutput.send([0xFA]);
      console.log('MIDI Start sent');
    } catch (error) {
      console.error('MIDI Start error:', error);
    }

    // MIDI clock sends 24 pulses per quarter note
    const pulsesPerQuarterNote = 24;
    const msPerBeat = 60000 / tempo;
    const msPerPulse = msPerBeat / pulsesPerQuarterNote;

    this.midiClockInterval = setInterval(() => {
      if (this.midiOutput && this.isPlaying) {
        try {
          this.midiOutput.send([0xF8]); // MIDI Clock pulse
        } catch (error) {
          console.error('MIDI Clock error:', error);
        }
      }
    }, msPerPulse);
  }

  stopMidiClock() {
    if (this.midiClockInterval) {
      clearInterval(this.midiClockInterval);
      this.midiClockInterval = null;
    }

    // Send MIDI Stop message (0xFC)
    if (this.midiOutput) {
      try {
        this.midiOutput.send([0xFC]);
        console.log('MIDI Stop sent');
      } catch (error) {
        console.error('MIDI Stop error:', error);
      }
    }
  }

  sendMidiContinue() {
    if (!this.midiSettings.enabled || !this.midiOutput) return;

    try {
      this.midiOutput.send([0xFB]); // MIDI Continue
      console.log('MIDI Continue sent');
    } catch (error) {
      console.error('MIDI Continue error:', error);
    }
  }

  updateMidiClockTempo(tempo) {
    if (!this.midiSettings.enabled || !this.midiOutput || !this.isPlaying) return;

    // Restart clock with new tempo
    this.stopMidiClock();
    this.startMidiClock(tempo);
  }

  notifyClientCountChange() {
    if (this.onClientCountChange) {
      this.onClientCountChange(this.connectedClients);
    }
  }

  async start(port = 3000) {
    this.httpsPort = port;

    // Start HTTPS server
    const httpsPromise = new Promise((resolve, reject) => {
      this.httpServer.listen(port, () => {
        console.log(`Metronome HTTPS server started on port ${port}`);
        resolve(port);
      });

      this.httpServer.on('error', (err) => {
        console.error(`Failed to start HTTPS server on port ${port}:`, err);
        reject(err);
      });
    });

    // Try to start HTTP redirect server on port 80 (optional)
    this.startHttpRedirect(port);

    return httpsPromise;
  }

  startHttpRedirect(httpsPort) {
    // Create simple HTTP server that redirects to HTTPS
    const redirectApp = express();

    redirectApp.use((req, res) => {
      const host = req.headers.host.split(':')[0]; // Get hostname without port
      const redirectUrl = `https://${host}:${httpsPort}${req.url}`;
      console.log(`HTTP redirect: ${req.url} → ${redirectUrl}`);
      res.redirect(301, redirectUrl);
    });

    this.httpRedirectServer = http.createServer(redirectApp);

    // Try ports in order: 80 (standard HTTP), 8080 (common alternative), same as HTTPS port
    const tryPorts = [80, 8080, httpsPort];

    const tryPort = (ports, index = 0) => {
      if (index >= ports.length) {
        console.log('HTTP redirect server not started (no available ports)');
        return;
      }

      const port = ports[index];
      this.httpRedirectServer.listen(port, () => {
        console.log(`HTTP redirect server started on port ${port} → HTTPS ${httpsPort}`);
      });

      this.httpRedirectServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          console.log(`Port ${port} not available for HTTP redirect, trying next...`);
          this.httpRedirectServer.close();
          tryPort(ports, index + 1);
        }
      });
    };

    tryPort(tryPorts);
  }

  stop() {
    this.pause();
    if (this.oscClient) {
      this.oscClient.close();
      this.oscClient = null;
    }
    if (this.midiOutput) {
      this.stopMidiClock();
      this.midiOutput.close();
      this.midiOutput = null;
    }
    if (this.httpRedirectServer) {
      this.httpRedirectServer.close();
      console.log('HTTP redirect server stopped');
    }
    if (this.httpServer) {
      this.httpServer.close();
      console.log('Metronome HTTPS server stopped');
    }
  }

  play() {
    if (this.isPlaying) return;

    const wasPlaying = this.barStartTime !== null; // Check if resuming
    this.isPlaying = true;
    const now = Date.now();

    // Start with countoff if specified and not resuming
    if (!this.barStartTime && this.scoreData.countoff > 0) {
      this.inCountoff = true;
      this.countoffBarsRemaining = this.scoreData.countoff;
      this.currentSectionIndex = 0;
      this.currentBarInSection = 0;
      this.currentBeat = 0;
    }

    if (!this.barStartTime) {
      this.barStartTime = now;
    }

    // Start MIDI clock
    const currentTempo = this.getCurrentTempo();
    if (wasPlaying) {
      this.sendMidiContinue();
      this.startMidiClock(currentTempo);
    } else {
      this.startMidiClock(currentTempo);
    }

    this.startPlaybackLoop();
    this.io.emit('playback-started');
  }

  getCurrentTempo() {
    if (this.inCountoff) {
      return this.scoreData.sections[0]?.tempo || 120;
    }

    const currentSection = this.scoreData.sections[this.currentSectionIndex];
    if (!currentSection) return 120;

    // Check if NEXT section has a tempo transition that affects current bars
    const nextSectionIndex = this.currentSectionIndex + 1;
    if (nextSectionIndex < this.scoreData.sections.length) {
      const nextSection = this.scoreData.sections[nextSectionIndex];
      const transitionBars = nextSection.tempoTransitionBars || 0;

      if (transitionBars > 0) {
        // Calculate how many bars from the end of current section we are
        const totalBarsInSection = currentSection.bars.length;
        const barsFromEnd = totalBarsInSection - this.currentBarInSection;

        // If we're within the transition range from the end
        if (barsFromEnd <= transitionBars) {
          const fromTempo = currentSection.tempo;
          const toTempo = nextSection.tempo;

          // Calculate progress: 0.0 at start of transition, 1.0 at end (section boundary)
          const progress = (transitionBars - barsFromEnd + 1) / transitionBars;

          // Linear interpolation
          const interpolatedTempo = fromTempo + (toTempo - fromTempo) * progress;

          return Math.round(interpolatedTempo);
        }
      }
    }

    return currentSection.tempo;
  }

  isInTempoTransition() {
    if (this.inCountoff || !this.isPlaying) return false;

    const currentSection = this.scoreData.sections[this.currentSectionIndex];
    if (!currentSection) return false;

    // Check if NEXT section has a tempo transition that affects current bars
    const nextSectionIndex = this.currentSectionIndex + 1;
    if (nextSectionIndex < this.scoreData.sections.length) {
      const nextSection = this.scoreData.sections[nextSectionIndex];
      const transitionBars = nextSection.tempoTransitionBars || 0;

      if (transitionBars > 0) {
        const totalBarsInSection = currentSection.bars.length;
        const barsFromEnd = totalBarsInSection - this.currentBarInSection;

        return barsFromEnd <= transitionBars;
      }
    }

    return false;
  }

  pause() {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    this.pendingJump = null; // Clear any pending jumps on pause

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Stop MIDI clock (will send MIDI Stop)
    this.stopMidiClock();

    this.io.emit('playback-paused');
  }

  stopPlayback() {
    this.isPlaying = false;
    this.inCountoff = false;
    this.countoffBarsRemaining = 0;
    this.currentSectionIndex = 0;
    this.currentBarInSection = 0;
    this.currentBeat = 0;
    this.barStartTime = null;
    this.lastTriggeredBar = -1; // Reset OSC trigger tracking
    this.redirectTracking = {}; // Reset redirect tracking
    this.pendingJump = null; // Clear any pending jumps
    this.syncOffset = 0; // Reset sync offset
    this.loopCurrentBarEnabled = false; // Disable loop current bar
    this.loopCurrentBarNumber = null;
    this.repeatStack = []; // Reset repeat tracking
    this.currentPassNumber = 1;
    this.hasJumpedViaDSorDC = false; // Reset D.S./D.C. navigation
    this.shouldWatchForToCodaOrFine = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Stop MIDI clock
    this.stopMidiClock();

    this.io.emit('playback-stopped');
  }

  seekToBar(absoluteBarNumber, mode = 'direct') {
    if (mode === 'direct') {
      // Jump immediately
      this.executeJump(absoluteBarNumber);
    } else {
      // Store pending jump to be executed at the appropriate time
      this.pendingJump = { barNumber: absoluteBarNumber, mode };
    }
  }

  executeJump(absoluteBarNumber) {
    // Find the section and bar for this absolute bar number
    let remaining = absoluteBarNumber;
    let sectionIndex = 0;

    for (let i = 0; i < this.scoreData.sections.length; i++) {
      const barsInSection = this.scoreData.sections[i].bars.length;

      if (remaining <= barsInSection) {
        sectionIndex = i;
        break;
      }

      remaining -= barsInSection;
      sectionIndex++;
    }

    this.currentSectionIndex = Math.min(sectionIndex, this.scoreData.sections.length - 1);
    this.currentBarInSection = remaining - 1;
    this.currentBeat = 0;
    this.inCountoff = false;
    this.barStartTime = Date.now();

    const state = this.getCurrentState();
    this.io.emit('state-update', state);
  }

  setLoop(loopSettings) {
    this.loopEnabled = loopSettings.enabled;
    this.loopStart = loopSettings.start;
    this.loopEnd = loopSettings.end;
  }

  setLoopCurrentBar(enabled) {
    this.loopCurrentBarEnabled = enabled;
    if (enabled && this.isPlaying && !this.inCountoff) {
      // Store the current bar number when enabling
      this.loopCurrentBarNumber = this.getAbsoluteBarNumber();
    } else if (!enabled) {
      this.loopCurrentBarNumber = null;
    }
  }

  adjustSyncOffset(ms) {
    if (!this.isPlaying) return this.syncOffset;

    // Adjust the sync offset
    this.syncOffset += ms;

    // Apply the offset by adjusting barStartTime
    // Positive offset = shift playback forward (earlier beat)
    // Negative offset = shift playback backward (later beat)
    this.barStartTime -= ms;

    return this.syncOffset;
  }

  adjustSyncByBeat(direction) {
    if (!this.isPlaying) return this.syncOffset;

    const barInfo = this.getCurrentBarInfo();
    if (!barInfo) return this.syncOffset;

    // Calculate beat duration
    const barDuration = this.getBarDuration(
      barInfo.tempo,
      barInfo.timeSignature,
      barInfo.isFermata,
      barInfo.fermataDuration,
      barInfo.fermataDurationType
    );
    const beatDuration = barInfo.isFermata ? barDuration : barDuration / barInfo.timeSignature.beats;

    // Adjust by one beat duration
    const adjustment = direction * beatDuration;
    this.syncOffset += adjustment;
    this.barStartTime -= adjustment;

    return Math.round(this.syncOffset);
  }

  resetSyncOffset() {
    if (!this.isPlaying) {
      this.syncOffset = 0;
      return;
    }

    // Remove the current offset from barStartTime
    this.barStartTime += this.syncOffset;
    this.syncOffset = 0;
  }

  updateScore(newScoreData) {
    this.scoreData = newScoreData;
    this.loopEnabled = newScoreData.loop?.enabled || false;
    this.loopStart = newScoreData.loop?.start || null;
    this.loopEnd = newScoreData.loop?.end || null;

    this.buildBarStructure();

    // Don't stop playback - just update the score data
    // This allows live editing while playing

    // Send new score data to all clients
    this.io.emit('score-data', this.scoreData);
  }

  getSubdivisionCount(subdivision) {
    switch (subdivision) {
      case '8th': return 2;
      case '16th': return 4;
      case 'triplet': return 3;
      case 'quintuplet': return 5;
      case 'sextuplet': return 6;
      default: return 1;
    }
  }

  startPlaybackLoop() {
    const updateRate = 1000 / 60; // 60Hz
    let lastTempo = this.getCurrentTempo();

    this.updateInterval = setInterval(() => {
      if (!this.isPlaying) return;

      const now = Date.now();
      const barInfo = this.getCurrentBarInfo();

      if (!barInfo) {
        this.stopPlayback();
        return;
      }

      // Use interpolated tempo if in transition
      const currentTempo = this.getCurrentTempo();

      const barDuration = this.getBarDuration(
        currentTempo,
        barInfo.timeSignature,
        barInfo.isFermata,
        barInfo.fermataDuration,
        barInfo.fermataDurationType
      );
      const beatDuration = barInfo.isFermata ? barDuration : barDuration / barInfo.timeSignature.beats;
      const elapsed = now - this.barStartTime;

      // Update MIDI clock if tempo has changed
      if (currentTempo !== lastTempo) {
        this.updateMidiClockTempo(currentTempo);
        lastTempo = currentTempo;
      }

      // Calculate current beat
      const newBeat = Math.floor(elapsed / beatDuration);

      // Calculate subdivision within current beat
      const subdivisionCount = this.getSubdivisionCount(barInfo.subdivision);
      const elapsedInBeat = elapsed - (newBeat * beatDuration);
      const subdivisionDuration = beatDuration / subdivisionCount;
      const currentSubdivision = Math.floor(elapsedInBeat / subdivisionDuration);

      if (elapsed >= barDuration) {
        this.advanceToNextBar();
      } else if (newBeat !== this.currentBeat) {
        this.currentBeat = newBeat;

        // Check for pending jump on next beat
        if (this.pendingJump && this.pendingJump.mode === 'nextBeat') {
          this.executeJump(this.pendingJump.barNumber);
          this.pendingJump = null;
        }
      }

      // Check for OSC trigger on bar start (beat 0, new bar)
      if (!this.inCountoff && barInfo.absoluteNumber !== this.lastTriggeredBar) {
        this.lastTriggeredBar = barInfo.absoluteNumber;
        if (barInfo.oscAddress) {
          // Parse args - split by comma and try to convert numbers
          let args = [];
          if (barInfo.oscArgs) {
            args = barInfo.oscArgs.split(',').map(arg => {
              const trimmed = arg.trim();
              const num = parseFloat(trimmed);
              return isNaN(num) ? trimmed : num;
            });
          }
          this.sendOscMessage(barInfo.oscAddress, args);
        }
      }

      // Send state update to all clients
      const state = this.getCurrentState();
      state.subdivision = barInfo.subdivision;
      state.subdivisionCount = subdivisionCount;
      state.currentSubdivision = currentSubdivision;
      this.io.emit('state-update', state);

    }, updateRate);
  }

  findMatchingStartRepeat(endBarIndex) {
    // Search backwards from endBarIndex to find matching start repeat
    for (let i = endBarIndex - 1; i >= 0; i--) {
      if (this.flatBars[i].startRepeat) {
        return i + 1; // Return 1-indexed bar number
      }
    }
    // If no start repeat found, return bar 1
    return 1;
  }

  shouldSkipBarDueToVolta(barInfo) {
    // If bar has no volta, don't skip it
    if (!barInfo.volta) return false;

    // Handle both array and single number (backwards compatibility)
    const voltaArray = Array.isArray(barInfo.volta) ? barInfo.volta : [barInfo.volta];

    // Skip this bar if currentPassNumber is NOT in the volta array
    return !voltaArray.includes(this.currentPassNumber);
  }

  getMaxVoltaInRepeatSection(startBarIndex, endBarIndex) {
    // Find the highest volta number in and around the repeat section
    // Scan from start repeat to end repeat, AND beyond end repeat to find volta bars that follow
    let maxVolta = 1;

    // First scan the repeat section itself
    for (let i = startBarIndex; i <= endBarIndex; i++) {
      const bar = this.flatBars[i];
      if (bar && bar.volta) {
        const voltaArray = Array.isArray(bar.volta) ? bar.volta : [bar.volta];
        const maxInBar = Math.max(...voltaArray);
        maxVolta = Math.max(maxVolta, maxInBar);
      }
    }

    // Then scan bars immediately after the end repeat to find additional volta endings
    // Continue scanning while we find consecutive bars with volta markers
    for (let i = endBarIndex + 1; i < this.flatBars.length; i++) {
      const bar = this.flatBars[i];
      if (bar && bar.volta) {
        const voltaArray = Array.isArray(bar.volta) ? bar.volta : [bar.volta];
        const maxInBar = Math.max(...voltaArray);
        maxVolta = Math.max(maxVolta, maxInBar);
      } else {
        // Stop when we hit a bar without volta (end of volta sequence)
        break;
      }
    }

    return maxVolta;
  }

  findSegnoBar() {
    // Find the first bar with segno marker
    for (let i = 0; i < this.flatBars.length; i++) {
      if (this.flatBars[i].segno) {
        return i + 1; // Return 1-indexed bar number
      }
    }
    return null;
  }

  findCodaBar() {
    // Find the first bar with coda marker
    for (let i = 0; i < this.flatBars.length; i++) {
      if (this.flatBars[i].coda) {
        return i + 1; // Return 1-indexed bar number
      }
    }
    return null;
  }

  advanceToNextBar() {
    // Check for loop current bar (highest priority)
    if (this.loopCurrentBarEnabled && this.loopCurrentBarNumber && !this.inCountoff) {
      this.executeJump(this.loopCurrentBarNumber);
      return;
    }

    // Check for pending jump after bar
    if (this.pendingJump && this.pendingJump.mode === 'afterBar') {
      this.executeJump(this.pendingJump.barNumber);
      this.pendingJump = null;
      return;
    }

    if (this.inCountoff) {
      this.countoffBarsRemaining--;

      if (this.countoffBarsRemaining <= 0) {
        // Countoff finished, start real song
        this.inCountoff = false;
        this.currentSectionIndex = 0;
        this.currentBarInSection = 0;
      }

      this.currentBeat = 0;
      this.barStartTime = Date.now();
      return;
    }

    const currentAbsoluteBar = this.getAbsoluteBarNumber();
    const currentBarInfo = this.flatBars[currentAbsoluteBar - 1];

    // Check for Fine marker (only active after D.S./D.C. jump)
    if (currentBarInfo && currentBarInfo.fine && this.shouldWatchForToCodaOrFine) {
      console.log('Fine marker reached - stopping playback');
      this.stopPlayback();
      return;
    }

    // Check for To Coda marker (only active after D.S./D.C. jump)
    if (currentBarInfo && currentBarInfo.toCoda && this.shouldWatchForToCodaOrFine) {
      const codaBar = this.findCodaBar();
      if (codaBar) {
        console.log(`To Coda marker - jumping to bar ${codaBar}`);
        this.shouldWatchForToCodaOrFine = false; // Disable further watching
        this.seekToBar(codaBar);
        return;
      } else {
        console.warn('To Coda marker found but no Coda marker exists');
      }
    }

    // Check for Dal Segno (D.S.) marker
    if (currentBarInfo && currentBarInfo.dalSegno && !this.hasJumpedViaDSorDC) {
      const segnoBar = this.findSegnoBar();
      if (segnoBar) {
        console.log(`Dal Segno - jumping to bar ${segnoBar}`);
        this.hasJumpedViaDSorDC = true;
        this.shouldWatchForToCodaOrFine = true;
        this.seekToBar(segnoBar);
        return;
      } else {
        console.warn('Dal Segno marker found but no Segno marker exists');
      }
    }

    // Check for Da Capo (D.C.) marker
    if (currentBarInfo && currentBarInfo.daCapo && !this.hasJumpedViaDSorDC) {
      console.log('Da Capo - jumping to bar 1');
      this.hasJumpedViaDSorDC = true;
      this.shouldWatchForToCodaOrFine = true;
      this.seekToBar(1);
      return;
    }

    // Check for redirect with limit
    if (currentBarInfo && currentBarInfo.redirect) {
      const redirectKey = `${currentAbsoluteBar}-${currentBarInfo.redirect}`;

      // Initialize tracking for this redirect if not exists
      if (!this.redirectTracking[redirectKey]) {
        this.redirectTracking[redirectKey] = 0;
      }

      // Check if we should redirect (before incrementing)
      if (this.redirectTracking[redirectKey] < currentBarInfo.redirectCount) {
        this.redirectTracking[redirectKey]++;
        this.seekToBar(currentBarInfo.redirect);
        return;
      } else {
        // Reset counter and continue to next bar
        this.redirectTracking[redirectKey] = 0;
        // Fall through to continue to next bar normally
      }
    }

    // Check for end repeat
    if (currentBarInfo && currentBarInfo.endRepeat) {
      // If this bar has a volta, check if we should honor the end repeat
      // Only process end repeat if the volta matches the current pass OR if there's no volta
      const shouldHonorEndRepeat = !currentBarInfo.volta || !this.shouldSkipBarDueToVolta(currentBarInfo);

      if (shouldHonorEndRepeat) {
        const startRepeatBar = this.findMatchingStartRepeat(currentAbsoluteBar - 1);

        // Check if we're already in this repeat
        const existingRepeat = this.repeatStack.find(r => r.startBar === startRepeatBar);

        if (existingRepeat) {
          existingRepeat.timesPlayed++;

          // Calculate max repeats based on highest volta number in the section
          const maxVoltaNumber = this.getMaxVoltaInRepeatSection(startRepeatBar - 1, currentAbsoluteBar - 1);
          const maxRepeats = maxVoltaNumber > 1 ? maxVoltaNumber : 2; // Default to 2 if no voltas

          if (existingRepeat.timesPlayed < maxRepeats) {
            // Repeat again - increment pass number and jump back
            this.currentPassNumber++;
            this.seekToBar(startRepeatBar);
            return;
          } else {
            // Done repeating - remove from stack and reset pass number
            this.repeatStack = this.repeatStack.filter(r => r.startBar !== startRepeatBar);
            this.currentPassNumber = 1;
            // Fall through to continue to next bar
          }
        } else {
          // First time encountering this repeat
          this.repeatStack.push({ startBar: startRepeatBar, timesPlayed: 1, endBar: currentAbsoluteBar });
          this.currentPassNumber = 2; // Next pass
          this.seekToBar(startRepeatBar);
          return;
        }
      } else {
        // Not honoring end repeat due to volta mismatch - clean up repeat stack
        const startRepeatBar = this.findMatchingStartRepeat(currentAbsoluteBar - 1);
        this.repeatStack = this.repeatStack.filter(r => r.startBar !== startRepeatBar);
        this.currentPassNumber = 1;
        // Fall through to continue to next bar normally
      }
    }

    // Check for loop
    if (this.loopEnabled && this.loopEnd && currentAbsoluteBar >= this.loopEnd) {
      this.lastTriggeredBar = -1; // Reset OSC tracking so triggers fire again on loop
      this.seekToBar(this.loopStart || 1);
      return;
    }

    // Advance to next bar
    const currentSection = this.scoreData.sections[this.currentSectionIndex];

    if (this.currentBarInSection + 1 < currentSection.bars.length) {
      // Stay in same section
      this.currentBarInSection++;
    } else {
      // Move to next section
      if (this.currentSectionIndex + 1 < this.scoreData.sections.length) {
        this.currentSectionIndex++;
        this.currentBarInSection = 0;
      } else {
        // End of song
        if (this.onSongEnd) {
          this.onSongEnd();
        }

        // If repeat is enabled, loop back to beginning (skip countoff on repeat)
        if (this.repeatSong) {
          this.currentSectionIndex = 0;
          this.currentBarInSection = 0;
          this.lastTriggeredBar = -1; // Reset OSC tracking so triggers fire again on loop
          // Don't restart countoff on loop - go straight to bar 1
        } else {
          // Stop playback at end of song
          this.stopPlayback();
          return;
        }
      }
    }

    // Skip bars based on volta brackets
    // Keep advancing while the current bar should be skipped
    let safetyCounter = 0;
    let skippedAnyBars = false;
    while (safetyCounter < 100) { // Prevent infinite loops
      const nextAbsoluteBar = this.getAbsoluteBarNumber();
      const nextBarInfo = this.flatBars[nextAbsoluteBar - 1];

      if (!nextBarInfo || !this.shouldSkipBarDueToVolta(nextBarInfo)) {
        break; // Found a bar we shouldn't skip
      }

      skippedAnyBars = true;

      // Check if this skipped bar has an end repeat - if so, clean up repeat state
      if (nextBarInfo.endRepeat) {
        const startRepeatBar = this.findMatchingStartRepeat(nextAbsoluteBar - 1);
        this.repeatStack = this.repeatStack.filter(r => r.startBar !== startRepeatBar);
        // DON'T reset currentPassNumber here - keep it so subsequent volta bars can be played
      }

      // Skip this bar - advance again
      const section = this.scoreData.sections[this.currentSectionIndex];
      if (this.currentBarInSection + 1 < section.bars.length) {
        this.currentBarInSection++;
      } else {
        // Move to next section
        if (this.currentSectionIndex + 1 < this.scoreData.sections.length) {
          this.currentSectionIndex++;
          this.currentBarInSection = 0;
        } else {
          // End of song while skipping
          break;
        }
      }

      safetyCounter++;
    }

    // After skipping volta bars, check if we should reset currentPassNumber
    // Reset to 1 if the current bar we landed on has no volta AND we're not in any active repeat
    const currentAbsoluteBarAfterSkip = this.getAbsoluteBarNumber();
    const currentBarInfoAfterSkip = this.flatBars[currentAbsoluteBarAfterSkip - 1];
    if (currentBarInfoAfterSkip && !currentBarInfoAfterSkip.volta && this.currentPassNumber > 1 && this.repeatStack.length === 0) {
      // We've moved past all volta bars and exited all repeats, reset to pass 1
      this.currentPassNumber = 1;
    }

    this.currentBeat = 0;
    this.barStartTime = Date.now();
  }

  getBarDuration(tempo, timeSignature, isFermata = false, fermataDuration = 4, fermataDurationType = 'beats') {
    if (isFermata) {
      if (fermataDurationType === 'seconds') {
        // Duration in seconds - convert to milliseconds
        return fermataDuration * 1000;
      } else {
        // Duration in beats - calculate based on tempo
        const tempoPercentage = this.scoreData.tempoPercentage || 100;
        const adjustedTempo = tempo * (tempoPercentage / 100);
        const beatsPerSecond = adjustedTempo / 60;
        const secondsForDuration = fermataDuration / beatsPerSecond;
        return secondsForDuration * 1000;
      }
    }

    const beatsPerBar = timeSignature.beats;
    // Apply tempo percentage (default to 100% if not set)
    const tempoPercentage = this.scoreData.tempoPercentage || 100;
    const adjustedTempo = tempo * (tempoPercentage / 100);
    const beatsPerSecond = adjustedTempo / 60;
    const secondsPerBar = beatsPerBar / beatsPerSecond;
    return secondsPerBar * 1000;
  }

  getCurrentState() {
    if (!this.isPlaying) {
      return {
        isPlaying: false,
        barNumber: 1,
        beat: 0,
        progress: 0,
        chords: '',
        sectionName: '',
        timeSignature: { beats: 4, noteValue: 4 },
        isCountoff: false
      };
    }

    const barInfo = this.getCurrentBarInfo();

    if (!barInfo) {
      return {
        isPlaying: false,
        barNumber: 1,
        beat: 0,
        progress: 0,
        chords: '',
        sectionName: '',
        timeSignature: { beats: 4, noteValue: 4 },
        isCountoff: false
      };
    }

    const now = Date.now();
    const currentTempo = this.getCurrentTempo();
    const barDuration = this.getBarDuration(
      currentTempo,
      barInfo.timeSignature,
      barInfo.isFermata,
      barInfo.fermataDuration,
      barInfo.fermataDurationType
    );
    const elapsed = now - this.barStartTime;
    const progress = Math.min(elapsed / barDuration, 1);

    // Determine if current beat is accented
    const accentPattern = barInfo.accentPattern || [];
    const isAccent = accentPattern.includes(this.currentBeat) || this.currentBeat === 1;

    return {
      isPlaying: true,
      barNumber: barInfo.absoluteNumber || 0,
      beat: this.currentBeat,
      progress: progress,
      chords: barInfo.chords || '',
      sectionName: barInfo.sectionName || '',
      songName: this.scoreData.name || 'Untitled',
      timeSignature: barInfo.timeSignature,
      tempo: currentTempo,
      isCountoff: this.inCountoff,
      countoffBarsRemaining: this.countoffBarsRemaining,
      accentPattern: barInfo.accentPattern || [],
      subdivision: barInfo.subdivision || 'none',
      isFermata: barInfo.isFermata || false,
      fermataDuration: barInfo.fermataDuration || 4,
      fermataDurationType: barInfo.fermataDurationType || 'beats',
      isTempoTransition: this.isInTempoTransition(),
      // Click track data
      serverTimestamp: Date.now(),
      isAccent: isAccent
    };
  }
}

module.exports = MetronomeServer;
