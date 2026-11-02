import { Menu, nativeImage, Tray } from "electron";
import path from "node:path";

export type SvcName = "gateway" | "telegram" | "jobrunner";

export interface SvcView {
  state: "off" | "starting" | "running" | "error";
  /** Short reason for the error state, e.g. "Port 47009 in use". */
  reason?: string;
  /** The gateway answered as an agent-007 gateway from another process: the menu offers Open. */
  elsewhere?: boolean;
}

export interface TrayModel {
  port: number;
  setupDone: boolean;
  gateway: SvcView;
  telegram: SvcView;
  jobrunner: SvcView;
  launchAtLogin: boolean;
}

export interface TrayActions {
  assetsDir: string;
  openGateway(): void;
  showClaimCode(): void;
  openSettings(): void;
  start(s: SvcName): void;
  stop(s: SvcName): void;
  restart(s: SvcName): void;
  retry(s: SvcName): void;
  openJobrunnerUi(): void;
  openLogs(): void;
  openData(): void;
  setLaunchAtLogin(on: boolean): void;
  quit(): void;
}

type IconKind = "idle" | "running" | "warn" | "error";

const TITLES: Record<SvcName, string> = { gateway: "Gateway", telegram: "Telegram agent", jobrunner: "Job runner" };

export function describe(name: SvcName, v: SvcView): string {
  if (name === "jobrunner" && (v.state === "running" || v.state === "starting")) return v.state === "running" ? "Job runner on (not isolated)" : "Job runner: starting (not isolated)";
  const word = v.state === "off" ? "off" : v.state === "error" ? `error${v.reason ? ` - ${v.reason}` : ""}` : v.state;
  return `${TITLES[name]}: ${word}`;
}

export function iconKind(m: TrayModel): IconKind {
  if (!m.setupDone) return "idle";
  if (m.gateway.state === "error" || m.telegram.state === "error" || m.jobrunner.state === "error") return "error";
  if (m.jobrunner.state === "running" || m.jobrunner.state === "starting") return "warn";
  return m.gateway.state === "running" ? "running" : "idle";
}

export class TrayController {
  private readonly tray: Tray;
  private readonly icons: Record<IconKind, Electron.NativeImage>;

  constructor(private readonly actions: TrayActions) {
    const load = (kind: IconKind) => nativeImage.createFromPath(path.join(actions.assetsDir, `tray-${kind}.png`));
    this.icons = { idle: load("idle"), running: load("running"), warn: load("warn"), error: load("error") };
    this.tray = new Tray(this.icons.idle);
    this.tray.setToolTip("agent-007");
    this.tray.on("click", () => actions.openSettings());
    this.tray.on("double-click", () => actions.openSettings());
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }

  update(m: TrayModel): void {
    if (this.tray.isDestroyed()) return;
    this.tray.setImage(this.icons[iconKind(m)]);
    const lines = ["agent-007", describe("gateway", m.gateway)];
    if (m.telegram.state !== "off") lines.push(describe("telegram", m.telegram));
    if (m.jobrunner.state !== "off") lines.push(describe("jobrunner", m.jobrunner));
    this.tray.setToolTip(lines.join("\n").slice(0, 127));
    this.tray.setContextMenu(this.buildMenu(m));
  }

  private serviceItems(name: SvcName, v: SvcView): Electron.MenuItemConstructorOptions[] {
    const a = this.actions;
    const active = v.state === "running" || v.state === "starting";
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: describe(name, v), enabled: false },
      active ? { label: `Stop ${TITLES[name].toLowerCase()}`, click: () => a.stop(name) } : { label: `Start ${TITLES[name].toLowerCase()}`, click: () => a.start(name) },
    ];
    if (active) items.push({ label: `Restart ${TITLES[name].toLowerCase()}`, click: () => a.restart(name) });
    if (v.state === "error") items.push({ label: `Retry ${TITLES[name].toLowerCase()}`, click: () => a.retry(name) });
    if (name === "gateway" && v.elsewhere) items.push({ label: "Open the running gateway", click: () => a.openGateway() });
    if (name === "jobrunner" && v.state === "running") items.push({ label: "Open settings UI", click: () => a.openJobrunnerUi() });
    return items;
  }

  private buildMenu(m: TrayModel): Menu {
    const a = this.actions;
    if (!m.setupDone) {
      return Menu.buildFromTemplate([
        { label: "agent-007: setup needed", enabled: false },
        { label: "Open setup...", click: () => a.openSettings() },
        { type: "separator" },
        { label: "Quit", click: () => a.quit() },
      ]);
    }
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: "Open agent-007", enabled: m.gateway.state === "running", click: () => a.openGateway() },
      { label: "Show claim code", enabled: m.gateway.state === "running", click: () => a.showClaimCode() },
      { label: "Settings...", click: () => a.openSettings() },
      { type: "separator" },
      ...this.serviceItems("gateway", m.gateway),
      { type: "separator" },
      ...this.serviceItems("telegram", m.telegram),
      { type: "separator" },
      ...this.serviceItems("jobrunner", m.jobrunner),
      { type: "separator" },
      { label: "Open logs folder", click: () => a.openLogs() },
      { label: "Open data folder", click: () => a.openData() },
      { label: "Launch at login", type: "checkbox", checked: m.launchAtLogin, click: (item) => a.setLaunchAtLogin(item.checked) },
      { type: "separator" },
      { label: "Quit", click: () => a.quit() },
    ];
    return Menu.buildFromTemplate(items);
  }
}
