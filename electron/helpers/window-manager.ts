import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Logging, LogLevel } from "../utils/logging";

const execFileAsync = promisify(execFile);

type XWinModule = typeof import("@miniben90/x-win");

export interface DesktopWindowInfo {
  processId?: number | null;
  path: string | null;
  name: string;
  execName?: string | null;
}

export interface DesktopWindow {
  id: string;
  title: string;
  url: string | null;
  info: DesktopWindowInfo;
  getIcon(): Promise<string | null>;
}

export interface WindowManager {
  init(): Promise<void>;
  activeWindow(): DesktopWindow | null;
  subscribeActiveWindow(callback: (window: DesktopWindow) => void): number;
  unsubscribeActiveWindow(subscriptionId: number): void;
  getOpenWindows(): Promise<DesktopWindow[]>;
}

let cachedXWin: XWinModule | null = null;

function getXWin(): XWinModule {
  if (!cachedXWin) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedXWin = require("@miniben90/x-win");
  }
  return cachedXWin;
}

class XWinWindowManager implements WindowManager {
  async init() {
    return;
  }

  activeWindow(): DesktopWindow | null {
    try {
      const windowInfo = getXWin().activeWindow();
      return convertXWinWindow(windowInfo);
    } catch (_error) {
      return null;
    }
  }

  subscribeActiveWindow(callback: (window: DesktopWindow) => void): number {
    const id = getXWin().subscribeActiveWindow((windowInfo) => {
      callback(convertXWinWindow(windowInfo));
    });
    return id;
  }

  unsubscribeActiveWindow(subscriptionId: number) {
    getXWin().unsubscribeActiveWindow(subscriptionId);
  }

  async getOpenWindows() {
    const windows = await getXWin().openWindowsAsync();
    const converted = await Promise.all(
      windows.map(async (windowInfo) => convertXWinWindow(windowInfo)),
    );
    return converted;
  }
}

class LinuxWindowManager implements WindowManager {
  private isReady = false;
  private dependenciesAvailable = false;
  private lastActiveWindow: DesktopWindow | null = null;
  private subscriptions = new Map<number, NodeJS.Timeout>();
  private nextSubscriptionId = 1;

  async init() {
    if (this.isReady) {
      return;
    }
    const wmctrlExists = await commandExists("wmctrl");
    const xpropExists = await commandExists("xprop");
    this.dependenciesAvailable = wmctrlExists && xpropExists;
    this.isReady = true;
    if (!this.dependenciesAvailable) {
      Logging.instance().log(
        "Missing wmctrl or xprop; Linux window tracking disabled.",
        LogLevel.WARN,
        true,
      );
    }
  }

  activeWindow(): DesktopWindow | null {
    return this.lastActiveWindow;
  }

  subscribeActiveWindow(callback: (window: DesktopWindow) => void): number {
    if (!this.dependenciesAvailable) {
      return -1;
    }

    const subscriptionId = this.nextSubscriptionId++;

    const poll = async () => {
      try {
        const window = await this.fetchActiveWindow();
        if (!window) {
          return;
        }
        const changed = this.lastActiveWindow?.id !== window.id;
        this.lastActiveWindow = window;
        if (changed) {
          callback(window);
        }
      } catch (error) {
        Logging.instance().log(
          `Failed to poll active window: ${error}`,
          LogLevel.ERROR,
          true,
        );
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    timer.unref?.();
    this.subscriptions.set(subscriptionId, timer);
    return subscriptionId;
  }

  unsubscribeActiveWindow(subscriptionId: number) {
    const timer = this.subscriptions.get(subscriptionId);
    if (timer) {
      clearInterval(timer);
      this.subscriptions.delete(subscriptionId);
    }
  }

  async getOpenWindows(): Promise<DesktopWindow[]> {
    if (!this.dependenciesAvailable) {
      return [];
    }

    const { stdout } = await execFileAsync("wmctrl", ["-lp"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const windows: DesktopWindow[] = [];

    for (const line of lines) {
      const parsed = parseWmctrlLine(line);
      if (!parsed) {
        continue;
      }
      const window = await this.buildWindowFromId(parsed.windowId, parsed.pid, parsed.title);
      if (window) {
        windows.push(window);
      }
    }

    return dedupeWindowsById(windows);
  }

  private async fetchActiveWindow(): Promise<DesktopWindow | null> {
    if (!this.dependenciesAvailable) {
      return null;
    }

    const { stdout } = await execFileAsync("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
    const match = stdout.match(/window id # (0x[0-9a-f]+)/i);
    if (!match) {
      return null;
    }
    const windowId = match[1];
    return this.buildWindowFromId(windowId);
  }

  private async buildWindowFromId(
    windowId: string,
    pidFromWmctrl?: number,
    fallbackTitle?: string,
  ): Promise<DesktopWindow | null> {
    try {
      const { stdout } = await execFileAsync("xprop", [
        "-id",
        windowId,
        "_NET_WM_PID",
        "_NET_WM_NAME",
        "WM_CLASS",
        "_GTK_APPLICATION_ID",
      ]);

      const pid = extractNumber(stdout, /_NET_WM_PID\(CARDINAL\) = (\d+)/) ?? pidFromWmctrl;
      const title =
        extractString(stdout, /_NET_WM_NAME\((?:UTF8_STRING|STRING)\) = \"([^\"]*)\"/) ||
        fallbackTitle ||
        "";

      const wmClassRaw = extractList(stdout, /WM_CLASS\(STRING\) = (.+)/);
      const gtkAppId = extractString(
        stdout,
        /_GTK_APPLICATION_ID\((?:UTF8_STRING|STRING)\) = \"([^\"]+)\"/,
      );

      const processPath = pid ? await resolveProcessPath(pid) : null;
      const execName = processPath ? path.parse(processPath).name : wmClassRaw?.[0] ?? null;
      const appName =
        wmClassRaw?.[wmClassRaw.length - 1] ??
        gtkAppId ??
        processPath ? path.parse(processPath).name : title;

      return {
        id: windowId,
        title,
        url: null,
        info: {
          processId: pid ?? null,
          path: processPath,
          name: appName,
          execName,
        },
        getIcon: async () => null,
      } satisfies DesktopWindow;
    } catch (error) {
      Logging.instance().log(
        `Failed to inspect window ${windowId}: ${error}`,
        LogLevel.DEBUG,
      );
      if (pidFromWmctrl) {
        const processPath = await resolveProcessPath(pidFromWmctrl);
        if (!processPath) {
          return null;
        }
        const execName = path.parse(processPath).name;
        return {
          id: windowId,
          title: fallbackTitle ?? execName,
          url: null,
          info: {
            processId: pidFromWmctrl,
            path: processPath,
            name: execName,
            execName,
          },
          getIcon: async () => null,
        } satisfies DesktopWindow;
      }
      return null;
    }
  }
}

function parseWmctrlLine(line: string) {
  const match = line.match(/^(\S+)\s+-?\d+\s+(\d+)\s+\S+\s+(.*)$/);
  if (!match) {
    return null;
  }
  const [, windowId, pidRaw, title] = match;
  return {
    windowId,
    pid: Number.parseInt(pidRaw, 10),
    title,
  };
}

function dedupeWindowsById(windows: DesktopWindow[]) {
  const map = new Map<string, DesktopWindow>();
  for (const window of windows) {
    if (!map.has(window.id)) {
      map.set(window.id, window);
    }
  }
  return [...map.values()];
}

async function resolveProcessPath(pid: number) {
  const exePath = `/proc/${pid}/exe`;
  try {
    const resolved = await fs.promises.readlink(exePath);
    return resolved;
  } catch (_error) {
    return null;
  }
}

async function commandExists(command: string) {
  try {
    await execFileAsync("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch (_error) {
    return false;
  }
}

function extractNumber(source: string, regex: RegExp) {
  const match = source.match(regex);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1]!, 10);
}

function extractString(source: string, regex: RegExp) {
  const match = source.match(regex);
  if (!match) {
    return null;
  }
  return match[1]!;
}

function extractList(source: string, regex: RegExp) {
  const match = source.match(regex);
  if (!match) {
    return null;
  }
  return match[1]!
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function convertIconData(icon: unknown): Promise<string | null> {
  if (!icon) {
    return null;
  }
  if (typeof icon === "string") {
    return icon;
  }
  if (Buffer.isBuffer(icon)) {
    return `data:image/png;base64,${icon.toString("base64")}`;
  }
  if (Array.isArray(icon)) {
    const buffer = Buffer.from(icon as number[]);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }
  return null;
}

function convertXWinWindow(windowInfo: any): DesktopWindow {
  return {
    id:
      windowInfo.handle?.toString() ??
      `${windowInfo.info?.processId ?? ""}-${windowInfo.info?.name ?? "unknown"}`,
    title: windowInfo.title ?? windowInfo.info?.name ?? "",
    url: windowInfo.url ?? null,
    info: {
      processId: windowInfo.info?.processId ?? null,
      path: windowInfo.info?.path ?? null,
      name: windowInfo.info?.name ?? windowInfo.title ?? "",
      execName: windowInfo.info?.execName ?? null,
    },
    getIcon: async () => {
      try {
        const icon = await windowInfo.getIconAsync?.();
        return await convertIconData(icon?.data ?? icon);
      } catch (_error) {
        return null;
      }
    },
  } satisfies DesktopWindow;
}

const windowManager: WindowManager =
  process.platform === "linux" ? new LinuxWindowManager() : new XWinWindowManager();

export { windowManager };
