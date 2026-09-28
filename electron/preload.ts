import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between the UI and the main process: one generic API call plus app events. */
contextBridge.exposeInMainWorld('billforce', {
  platform: 'electron',
  invoke: (name: string, input?: unknown) => ipcRenderer.invoke('bf:invoke', name, input),
  onEvent: (cb: (event: string) => void) => {
    const handler = (_e: unknown, event: string) => cb(event);
    ipcRenderer.on('bf:event', handler);
    return () => ipcRenderer.removeListener('bf:event', handler);
  },
  /** What closing the window would do to the page (renderer guards.ts): the main process words its question by it. */
  setCloseWarning: (warning: unknown) => ipcRenderer.send('bf:close-warning', warning),
});
