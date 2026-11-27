const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  addWordToDictionary: (word) => ipcRenderer.invoke('spellcheck:add-word', word),
  addWordsToDictionary: (words) => ipcRenderer.invoke('spellcheck:add-words', words),
  getSpellCheckerLanguages: () => ipcRenderer.invoke('spellcheck:get-languages'),
  setSpellCheckerLanguages: (languages) => ipcRenderer.invoke('spellcheck:set-languages', languages),
});
