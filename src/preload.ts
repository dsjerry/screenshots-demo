import { contextBridge, ipcRenderer } from 'electron';
import { CH } from './shared/channels';
import type { ScreenshotsApi } from './shared/api';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: ScreenshotsApi = {
  overlay: {
    boot: () => ipcRenderer.invoke(CH.overlayBoot),
    selection: (cb) => on(CH.overlaySelection, cb),
    teardown: (cb) => on(CH.overlayTeardown, cb),
    ready: () => ipcRenderer.invoke(CH.overlayReady),
    input: (payload) => ipcRenderer.invoke(CH.overlayInput, payload),
    tool: (payload) => ipcRenderer.invoke(CH.overlayTool, payload),
    action: (payload) => ipcRenderer.invoke(CH.overlayAction, payload),
    shapes: (payload) => ipcRenderer.invoke(CH.overlayShapes, payload),
    draft: (payload) => ipcRenderer.invoke(CH.overlayDraft, payload),
    inFlight: (payload) => ipcRenderer.invoke(CH.overlayInFlight, payload),
    remoteShapes: (cb) => on(CH.overlayRemoteShapes, cb),
    remoteDraft: (cb) => on(CH.overlayRemoteDraft, cb),
    editState: (payload) => ipcRenderer.invoke(CH.overlayEditState, payload),
    focus: () => ipcRenderer.invoke(CH.overlayFocus),
    copyText: (payload) => ipcRenderer.invoke(CH.overlayCopyText, payload),
    compose: (cb) => on(CH.overlayCompose, cb),
    export: (payload) => ipcRenderer.invoke(CH.overlayExport, payload),
  },
  pin: {
    boot: () => ipcRenderer.invoke(CH.pinBoot),
    ready: (payload) => ipcRenderer.invoke(CH.pinReady, payload),
    action: (payload) => ipcRenderer.invoke(CH.pinAction, payload),
  },
  scroll: {
    frame: (cb) => on(CH.scrollFrame, cb),
    action: (payload) => ipcRenderer.invoke(CH.scrollAction, payload),
  },
  app: {
    state: (cb) => on(CH.appState, cb),
    startSnip: () => ipcRenderer.invoke(CH.appStartSnip),
  },
};

contextBridge.exposeInMainWorld('api', api);
