'use strict';

/**
 * Bridge for the standalone pet process. Nothing about the main app leaks here.
 *
 * Both windows share this preload: the mascot uses the `pet:*` half, the
 * medallion the `launcher:*` half, and the state/refresh/quit calls are common.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('state:refresh'),
  frames: () => ipcRenderer.invoke('pet:frames'),
  showWindow: () => ipcRenderer.invoke('window:show'),

  // visibility, shared by both windows
  showPet: () => ipcRenderer.invoke('pet:show'),
  hidePet: () => ipcRenderer.invoke('pet:hide'),
  togglePet: () => ipcRenderer.invoke('pet:toggle'),

  // the mascot window
  dragBegin: () => ipcRenderer.invoke('pet:drag-begin'),
  dragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  follow: () => ipcRenderer.invoke('pet:follow'),
  clamp: () => ipcRenderer.invoke('pet:clamp'),
  moveTo: (x, y) => ipcRenderer.invoke('pet:move-to', { x, y }),
  snap: () => ipcRenderer.invoke('pet:snap'),
  menu: () => ipcRenderer.invoke('pet:menu'),
  // click-through: the renderer does the hit test, the main process holds the flag
  setInteractive: (on) => ipcRenderer.invoke('pet:interactive', Boolean(on)),

  // the medallion window
  launcherDragBegin: () => ipcRenderer.invoke('launcher:drag-begin'),
  launcherDragEnd: () => ipcRenderer.invoke('launcher:drag-end'),
  launcherFollow: () => ipcRenderer.invoke('launcher:follow'),
  launcherClamp: () => ipcRenderer.invoke('launcher:clamp'),
  launcherMenu: () => ipcRenderer.invoke('launcher:menu'),
  launcherSetInteractive: (on) => ipcRenderer.invoke('launcher:interactive', Boolean(on)),

  onState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },

  // The main process polls the OS cursor (a window that ignores the mouse gets
  // no pointer events at all) and asks the renderer, which holds the art and so
  // owns the hit test. The handler's return value is the answer.
  onHitTest: (handler) => {
    const listener = (_event, point) => handler(point);
    ipcRenderer.on('pet:hit-test', listener);
    return () => ipcRenderer.removeListener('pet:hit-test', listener);
  },
});
