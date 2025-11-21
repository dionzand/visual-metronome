const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

class MetronomeServer {
  constructor(scoreData, displaySettings = null, repeatSong = false) {
    this.scoreData = scoreData;
    this.repeatSong = repeatSong;
    this.displaySettings = displaySettings || {
      lightColor: '#ff0000',
      progressBarColor: '#ff0000',
      progressBarWidth: 4,
      backgroundColor: '#000000',
      textColor: '#ffffff',
      chordColor: '#ffcc00'
    };
    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new Server(this.httpServer);

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

    // Build flat bar structure for easier navigation
    this.buildBarStructure();

    // Callbacks
    this.onClientCountChange = null;
    this.onSongEnd = null;

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
          timeSignature: section.timeSignature,
          chords: bar.chords,
          redirect: bar.redirect,
          accentPattern: bar.accentPattern || [],
          subdivision: bar.subdivision || 'none'
        });
      });
    });

    this.totalBars = this.flatBars.length;
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

  notifyClientCountChange() {
    if (this.onClientCountChange) {
      this.onClientCountChange(this.connectedClients);
    }
  }

  async start() {
    return new Promise((resolve) => {
      const port = 3000;
      this.httpServer.listen(port, () => {
        console.log(`Metronome server started on port ${port}`);
        resolve(port);
      });
    });
  }

  stop() {
    this.pause();
    if (this.httpServer) {
      this.httpServer.close();
      console.log('Metronome server stopped');
    }
  }

  play() {
    if (this.isPlaying) return;

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

    this.startPlaybackLoop();
    this.io.emit('playback-started');
  }

  pause() {
    if (!this.isPlaying) return;

    this.isPlaying = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

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

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.io.emit('playback-stopped');
  }

  seekToBar(absoluteBarNumber) {
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

    this.updateInterval = setInterval(() => {
      if (!this.isPlaying) return;

      const now = Date.now();
      const barInfo = this.getCurrentBarInfo();

      if (!barInfo) {
        this.stopPlayback();
        return;
      }

      const barDuration = this.getBarDuration(barInfo.tempo, barInfo.timeSignature);
      const beatDuration = barDuration / barInfo.timeSignature.beats;
      const elapsed = now - this.barStartTime;

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
      }

      // Send state update to all clients
      const state = this.getCurrentState();
      state.subdivision = barInfo.subdivision;
      state.subdivisionCount = subdivisionCount;
      state.currentSubdivision = currentSubdivision;
      this.io.emit('state-update', state);

    }, updateRate);
  }

  advanceToNextBar() {
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

    // Check for redirect
    if (currentBarInfo && currentBarInfo.redirect) {
      this.seekToBar(currentBarInfo.redirect);
      return;
    }

    // Check for loop
    if (this.loopEnabled && this.loopEnd && currentAbsoluteBar >= this.loopEnd) {
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
          // Don't restart countoff on loop - go straight to bar 1
        } else {
          // Stop playback at end of song
          this.stopPlayback();
          return;
        }
      }
    }

    this.currentBeat = 0;
    this.barStartTime = Date.now();
  }

  getBarDuration(tempo, timeSignature) {
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
    const barDuration = this.getBarDuration(barInfo.tempo, barInfo.timeSignature);
    const elapsed = now - this.barStartTime;
    const progress = Math.min(elapsed / barDuration, 1);

    return {
      isPlaying: true,
      barNumber: barInfo.absoluteNumber || 0,
      beat: this.currentBeat,
      progress: progress,
      chords: barInfo.chords || '',
      sectionName: barInfo.sectionName || '',
      songName: this.scoreData.name || 'Untitled',
      timeSignature: barInfo.timeSignature,
      tempo: barInfo.tempo || 120,
      isCountoff: this.inCountoff,
      countoffBarsRemaining: this.countoffBarsRemaining,
      accentPattern: barInfo.accentPattern || [],
      subdivision: barInfo.subdivision || 'none'
    };
  }
}

module.exports = MetronomeServer;
