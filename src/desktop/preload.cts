import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload: only `electron` may be required at runtime. Secrets go page -> main only.
const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;
const subscribe = <T,>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld("launcherApi", {
  getState: () => invoke("launcher:getState"),
  pickFolder: () => invoke("launcher:pickFolder"),
  runSetup: (answers: unknown) => invoke("launcher:runSetup", answers),
  updateSecrets: (answers: unknown) => invoke("launcher:updateSecrets", answers),
  setToggles: (toggles: unknown) => invoke("launcher:setToggles", toggles),
  showClaimCode: () => invoke("launcher:showClaimCode"),
  copyClaimCode: () => invoke("launcher:copyClaimCode"),
  openClaimPage: () => invoke("launcher:openClaimPage"),
  openGateway: () => invoke("launcher:openGateway"),
  openPath: (target: unknown) => invoke("launcher:openPath", target),
  openExternal: (url: unknown) => invoke("launcher:openExternal", url),
  retry: (service: unknown) => invoke("launcher:retry", service),
  resetPassword: (req: unknown) => invoke("launcher:resetPassword", req),
  beginTotpReset: (req: unknown) => invoke("launcher:beginTotpReset", req),
  finishTotpReset: (req: unknown) => invoke("launcher:finishTotpReset", req),
  cancelTotpReset: () => invoke("launcher:cancelTotpReset"),
  onState: (callback: (state: unknown) => void) => subscribe("launcher:state", callback),
  onClaimCode: (callback: (payload: unknown) => void) => subscribe("launcher:claimCode", callback),
});
