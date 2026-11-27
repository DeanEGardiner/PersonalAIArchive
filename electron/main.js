require('dotenv').config();
const { app, BrowserWindow, Menu, MenuItem, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let expressServer = null;

const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = '127.0.0.1';

// Set application metadata
app.setName('Personal AI Archive');

// Route data storage to standard macOS Application Support path in production
if (app.isPackaged) {
  process.env.DATA_DIR = process.env.DATA_DIR || path.join(app.getPath('userData'), 'data');
}

function startServer() {
  try {
    const { server } = require('../server/index.js');
    expressServer = server;
  } catch (err) {
    console.error('[Electron] Error initializing Express server:', err);
  }
}

function waitForServer(callback, maxRetries = 40, interval = 250) {
  let attempts = 0;
  const check = () => {
    http.get(`http://${HOST}:${PORT}/api/health`, (res) => {
      if (res.statusCode === 200) {
        callback();
      } else {
        retry();
      }
    }).on('error', retry);
  };

  const retry = () => {
    attempts++;
    if (attempts >= maxRetries) {
      console.warn('[Electron] Server probe timeout; loading window.');
      callback();
    } else {
      setTimeout(check, interval);
    }
  };

  check();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    title: 'Personal AI Archive',
    backgroundColor: '#0b0f19',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  });

  // Ensure default spellchecker language is set (e.g. system locale or en-US)
  try {
    const session = mainWindow.webContents.session;
    const currentLangs = session.getSpellCheckerLanguages();
    if (!currentLangs || currentLangs.length === 0) {
      const defaultLang = app.getLocale() || 'en-US';
      session.setSpellCheckerLanguages([defaultLang.startsWith('en') ? defaultLang : 'en-US']);
    }
  } catch (err) {
    console.warn('[Electron] Spellchecker language initialization warning:', err.message);
  }

  // Handle right-click context menu with spellcheck suggestions & dictionary actions
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    if (params.misspelledWord) {
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 8)) {
          menu.append(new MenuItem({
            label: suggestion,
            click: () => mainWindow.webContents.replaceMisspelling(suggestion)
          }));
        }
      } else {
        menu.append(new MenuItem({
          label: 'No Spelling Suggestions',
          enabled: false
        }));
      }

      menu.append(new MenuItem({ type: 'separator' }));

      menu.append(new MenuItem({
        label: `Add "${params.misspelledWord}" to Dictionary`,
        click: () => {
          try {
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
          } catch (err) {
            console.error('Failed to add word to dictionary:', err);
          }
        }
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo }));
      menu.append(new MenuItem({ label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    }

    try {
      const session = mainWindow.webContents.session;
      const currentSpellLangs = session.getSpellCheckerLanguages() || [];
      const commonLangs = [
        { code: 'en-US', label: 'English (United States)' },
        { code: 'en-GB', label: 'English (United Kingdom)' },
        { code: 'en-AU', label: 'English (Australia)' },
        { code: 'en-CA', label: 'English (Canada)' }
      ];

      const langSubmenu = new Menu();
      for (const lang of commonLangs) {
        langSubmenu.append(new MenuItem({
          label: lang.label,
          type: 'checkbox',
          checked: currentSpellLangs.includes(lang.code),
          click: () => session.setSpellCheckerLanguages([lang.code])
        }));
      }

      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Spelling Language',
        submenu: langSubmenu
      }));
    } catch (_) {}

    menu.popup({ window: mainWindow, x: params.x, y: params.y });
  });

  const appUrl = `http://${HOST}:${PORT}`;
  mainWindow.loadURL(appUrl);

  // Handle external link clicks (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (!url.startsWith(`http://${HOST}:${PORT}`)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Spelling and Grammar',
          submenu: [
            {
              label: 'Check Spelling While Typing',
              type: 'checkbox',
              checked: true,
              click: (item) => {
                try {
                  mainWindow?.webContents?.session?.setSpellCheckerEnabled?.(item.checked);
                } catch (_) {}
              }
            },
            { type: 'separator' },
            {
              label: 'English (United States)',
              type: 'radio',
              checked: true,
              click: () => mainWindow?.webContents?.session?.setSpellCheckerLanguages(['en-US'])
            },
            {
              label: 'English (United Kingdom)',
              type: 'radio',
              click: () => mainWindow?.webContents?.session?.setSpellCheckerLanguages(['en-GB'])
            },
            {
              label: 'English (Australia)',
              type: 'radio',
              click: () => mainWindow?.webContents?.session?.setSpellCheckerLanguages(['en-AU'])
            },
            {
              label: 'English (Canada)',
              type: 'radio',
              click: () => mainWindow?.webContents?.session?.setSpellCheckerLanguages(['en-CA'])
            }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  // Register spellcheck IPC handlers
  ipcMain.handle('spellcheck:add-word', (event, word) => {
    if (word && typeof word === 'string') {
      try {
        mainWindow?.webContents?.session?.addWordToSpellCheckerDictionary(word.trim());
        return true;
      } catch (err) {
        console.error('Failed to add word to dictionary:', err);
      }
    }
    return false;
  });

  ipcMain.handle('spellcheck:add-words', (event, words) => {
    if (Array.isArray(words)) {
      try {
        for (const w of words) {
          if (w && typeof w === 'string') {
            mainWindow?.webContents?.session?.addWordToSpellCheckerDictionary(w.trim());
          }
        }
        return true;
      } catch (err) {
        console.error('Failed to add words to dictionary:', err);
      }
    }
    return false;
  });

  ipcMain.handle('spellcheck:get-languages', () => {
    try {
      return mainWindow?.webContents?.session?.getSpellCheckerLanguages() || ['en-US'];
    } catch (_) {
      return ['en-US'];
    }
  });

  ipcMain.handle('spellcheck:set-languages', (event, languages) => {
    try {
      if (Array.isArray(languages)) {
        mainWindow?.webContents?.session?.setSpellCheckerLanguages(languages);
        return true;
      }
    } catch (err) {
      console.error('Failed to set spellcheck languages:', err);
    }
    return false;
  });

  setupApplicationMenu();
  startServer();
  waitForServer(() => {
    createMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (expressServer && expressServer.close) {
    try {
      expressServer.close();
    } catch (_) {}
  }
});
