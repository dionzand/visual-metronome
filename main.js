const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const MetronomeServer = require('./server');

// Get the local IPv4 address (prefer 192.168.x.x or 10.x.x.x ranges)
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let fallbackIP = null;

  for (const name of Object.keys(interfaces)) {
    // Skip virtual adapters (WSL, VPN, Docker, etc.)
    const lowerName = name.toLowerCase();
    if (lowerName.includes('wsl') || lowerName.includes('virtual') ||
        lowerName.includes('vethernet') || lowerName.includes('docker')) {
      continue;
    }

    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        // Prefer 192.168.x.x or 10.x.x.x (common home/office networks)
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
          return iface.address;
        }
        // Keep as fallback
        if (!fallbackIP) {
          fallbackIP = iface.address;
        }
      }
    }
  }
  return fallbackIP || 'localhost';
}

let mainWindow;
let metronomeServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (metronomeServer) {
    metronomeServer.stop();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for file operations
ipcMain.handle('save-score', async (event, scoreData) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Score',
    defaultPath: 'score.json',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (filePath) {
    await fs.writeFile(filePath, JSON.stringify(scoreData, null, 2));
    return { success: true, filePath };
  }
  return { success: false };
});

ipcMain.handle('load-score', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Score',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (filePaths && filePaths.length > 0) {
    const data = await fs.readFile(filePaths[0], 'utf-8');
    return { success: true, data: JSON.parse(data) };
  }
  return { success: false };
});

ipcMain.handle('load-musicxml', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import MusicXML',
    filters: [
      { name: 'MusicXML Files', extensions: ['xml', 'musicxml', 'mxl'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (filePaths && filePaths.length > 0) {
    const data = await fs.readFile(filePaths[0], 'utf-8');
    return { success: true, data: data };
  }
  return { success: false };
});

// IPC handlers for server control
ipcMain.handle('start-server', async (event, data) => {
  if (metronomeServer) {
    metronomeServer.stop();
  }

  const { scoreData, displaySettings, repeatSong } = data;
  metronomeServer = new MetronomeServer(scoreData, displaySettings, repeatSong);
  const port = await metronomeServer.start();
  setupServerCallbacks();

  const localIP = getLocalIP();
  return { success: true, port, url: `http://${localIP}:${port}` };
});

ipcMain.handle('update-display-settings', async (event, displaySettings) => {
  if (metronomeServer) {
    metronomeServer.updateDisplaySettings(displaySettings);
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('set-repeat', async (event, repeat) => {
  if (metronomeServer) {
    metronomeServer.setRepeat(repeat);
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('stop-server', async () => {
  if (metronomeServer) {
    metronomeServer.stop();
    metronomeServer = null;
  }
  return { success: true };
});

ipcMain.handle('play-metronome', async () => {
  if (metronomeServer) {
    metronomeServer.play();
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('pause-metronome', async () => {
  if (metronomeServer) {
    metronomeServer.pause();
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('stop-metronome', async () => {
  if (metronomeServer) {
    metronomeServer.stopPlayback();
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('get-playback-status', async () => {
  if (metronomeServer) {
    return { isPlaying: metronomeServer.isPlaying };
  }
  return { isPlaying: false };
});

ipcMain.handle('seek-to-bar', async (event, barNumber) => {
  if (metronomeServer) {
    metronomeServer.seekToBar(barNumber);
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('set-loop', async (event, loopSettings) => {
  if (metronomeServer) {
    metronomeServer.setLoop(loopSettings);
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

ipcMain.handle('update-score', async (event, scoreData) => {
  if (metronomeServer) {
    metronomeServer.updateScore(scoreData);
    return { success: true };
  }
  return { success: false, error: 'Server not started' };
});

// IPC handlers for async dialogs (fixes Windows input focus bug)
ipcMain.handle('show-message-box', async (event, options) => {
  const result = await dialog.showMessageBox(mainWindow, options);
  return result;
});

ipcMain.on('focus-fix', () => {
  if (mainWindow) {
    mainWindow.blur();
    mainWindow.focus();
  }
});

// Relay client count updates from server to renderer
function setupServerCallbacks() {
  if (metronomeServer) {
    metronomeServer.onClientCountChange = (count) => {
      if (mainWindow) {
        mainWindow.webContents.send('client-count-update', count);
      }
    };

    metronomeServer.onSongEnd = () => {
      if (mainWindow) {
        mainWindow.webContents.send('song-ended');
      }
    };
  }
}
