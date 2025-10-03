import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { AppData } from "../../utils/validators";
import { allApps } from "../../watchers/apps";
import type { MonitoredApp } from "../../utils/types";

const execFileAsync = promisify(execFile);

const DESKTOP_DIRECTORIES = [
  "/usr/share/applications",
  "/usr/local/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  "/var/lib/snapd/desktop/applications",
  path.join(os.homedir(), ".local/share/applications"),
];

const ICON_DIRECTORIES = [
  "/usr/share/icons/hicolor",
  "/usr/share/pixmaps",
  path.join(os.homedir(), ".local/share/icons"),
  path.join(os.homedir(), ".icons"),
];

const EXEC_PLACEHOLDER = /%.*/g;

type DesktopEntry = Record<string, string>;

type LinuxAppMetadata = {
  id: MonitoredApp;
  isBrowser?: boolean;
  isDefaultEnabled?: boolean;
  isElectronApp?: boolean;
};

const LINUX_APP_METADATA: Record<string, LinuxAppMetadata> = {
  brave: { id: "brave", isBrowser: true },
  "brave-browser": { id: "brave", isBrowser: true },
  "google-chrome": { id: "chrome", isBrowser: true },
  chrome: { id: "chrome", isBrowser: true },
  chromium: { id: "chrome", isBrowser: true },
  firefox: { id: "firefox", isBrowser: true },
  "microsoft-edge": { id: "microsoft_edge", isBrowser: true },
  "microsoft-edge-beta": { id: "microsoft_edge", isBrowser: true },
  notion: { id: "notion", isDefaultEnabled: true, isElectronApp: true },
  "notion-app": { id: "notion", isDefaultEnabled: true, isElectronApp: true },
  "figma-linux": { id: "figma", isDefaultEnabled: true, isElectronApp: true },
  figma: { id: "figma", isDefaultEnabled: true, isElectronApp: true },
  slack: { id: "slack", isDefaultEnabled: true, isElectronApp: true },
  zoom: { id: "zoom", isDefaultEnabled: true, isElectronApp: true },
  "zoom-original": { id: "zoom", isDefaultEnabled: true, isElectronApp: true },
  postman: { id: "postman", isDefaultEnabled: true, isElectronApp: true },
  linear: { id: "linear", isDefaultEnabled: true, isElectronApp: true },
  "linear-linux": { id: "linear", isDefaultEnabled: true, isElectronApp: true },
};

export async function getInstalledAppsLinux(): Promise<AppData[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const desktopFiles = await collectDesktopFiles();
  const apps: AppData[] = [];

  for (const desktopFile of desktopFiles) {
    try {
      const app = await buildAppData(desktopFile);
      if (app) {
        apps.push(app);
      }
    } catch (_error) {
      // ignore malformed desktop entries
    }
  }

  const deduped = dedupeByPath(apps);
  return deduped.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectDesktopFiles() {
  const files: string[] = [];
  for (const directory of DESKTOP_DIRECTORIES) {
    try {
      const entries = await fs.promises.readdir(directory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".desktop")) {
          files.push(path.join(directory, entry.name));
        }
      }
    } catch (_error) {
      // directory might not exist, ignore
    }
  }
  return files;
}

async function buildAppData(desktopFile: string): Promise<AppData | null> {
  const content = await fs.promises.readFile(desktopFile, { encoding: "utf-8" });
  const entry = parseDesktopEntry(content);
  if (!entry) {
    return null;
  }

  if (entry.Type !== "Application") {
    return null;
  }

  if (entry.NoDisplay === "true" || entry.Hidden === "true") {
    return null;
  }

  const name = getDesktopName(entry);
  if (!name) {
    return null;
  }

  const execCommand = entry.TryExec || entry.Exec;
  if (!execCommand) {
    return null;
  }

  const { command, execName } = await resolveExecCommand(execCommand);
  if (!command || !execName) {
    return null;
  }

  const metadata = getMetadataForExec(execName);
  const icon = await resolveIcon(entry.Icon);

  return {
    path: command,
    icon,
    name,
    bundleId: entry["X-GNOME-Application-ID"] || entry.DesktopId || null,
    id: metadata?.id ?? sanitizeId(name),
    isBrowser: metadata?.isBrowser ?? false,
    isDefaultEnabled: metadata?.isDefaultEnabled ?? false,
    isElectronApp: metadata?.isElectronApp ?? false,
    version: null,
    execName,
  } satisfies AppData;
}

function parseDesktopEntry(content: string): DesktopEntry | null {
  const lines = content.split(/\r?\n/);
  let withinDesktopEntry = false;
  const data: DesktopEntry = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[")) {
      withinDesktopEntry = line === "[Desktop Entry]";
      continue;
    }

    if (!withinDesktopEntry) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      data[key] = value;
    }
  }

  if (Object.keys(data).length === 0) {
    return null;
  }
  return data;
}

function getDesktopName(entry: DesktopEntry) {
  if (entry.Name) {
    return entry.Name;
  }
  const localized = Object.keys(entry)
    .filter((key) => key.startsWith("Name["))
    .map((key) => entry[key])
    .find(Boolean);
  return localized ?? null;
}

async function resolveExecCommand(execValue: string) {
  const tokens = tokenizeExec(execValue.replace(EXEC_PLACEHOLDER, "").trim());
  if (tokens.length === 0) {
    return { command: null, execName: null };
  }

  const commandIndex = tokens.findIndex((token) => !token.includes("=") && token !== "env");
  if (commandIndex === -1) {
    return { command: null, execName: null };
  }

  const commandToken = tokens[commandIndex];

  if (commandToken === "env") {
    return { command: null, execName: null };
  }

  const resolved = await resolveExecutablePath(commandToken);
  if (!resolved) {
    return { command: null, execName: null };
  }

  return {
    command: resolved,
    execName: path.parse(resolved).name,
  };
}

function tokenizeExec(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quoteChar: string | null = null;

  for (const char of command) {
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quoteChar = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

async function resolveExecutablePath(command: string) {
  const expanded = command.startsWith("~")
    ? path.join(os.homedir(), command.slice(1))
    : command;

  if (expanded.includes("/")) {
    const candidate = await resolveIfExists(expanded);
    if (candidate) {
      return candidate;
    }
  }

  const pathVariable = process.env.PATH ?? "";
  for (const directory of pathVariable.split(":")) {
    const candidate = path.join(directory, expanded);
    const resolved = await resolveIfExists(candidate);
    if (resolved) {
      return resolved;
    }
  }

  try {
    const { stdout } = await execFileAsync("which", [expanded]);
    if (stdout) {
      const candidate = stdout.split(/\r?\n/)[0]?.trim();
      if (candidate) {
        const resolved = await resolveIfExists(candidate);
        if (resolved) {
          return resolved;
        }
      }
    }
  } catch (_error) {
    /* empty */
  }

  return null;
}

async function resolveIfExists(filePath: string) {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    return await fs.promises.realpath(filePath);
  } catch (_error) {
    return null;
  }
}

function getMetadataForExec(execName: string): LinuxAppMetadata | undefined {
  const lowerExec = execName.toLowerCase();
  if (LINUX_APP_METADATA[lowerExec]) {
    return LINUX_APP_METADATA[lowerExec];
  }

  const entry = allApps.find((app) => {
    const linuxExec = (app as unknown as { linux?: { execName?: string } }).linux?.execName;
    return linuxExec?.toLowerCase() === lowerExec;
  }) as (typeof allApps)[number] & { linux?: { execName?: string } };

  if (!entry) {
    return undefined;
  }

  return {
    id: entry.id,
    isBrowser: entry.isBrowser,
    isDefaultEnabled: entry.isDefaultEnabled,
    isElectronApp: entry.isElectronApp,
  } satisfies LinuxAppMetadata;
}

async function resolveIcon(iconField?: string) {
  if (!iconField) {
    return null;
  }

  if (path.isAbsolute(iconField)) {
    return await loadIcon(iconField);
  }

  for (const directory of ICON_DIRECTORIES) {
    const pngPath = await findIconInDirectory(directory, iconField, ".png");
    if (pngPath) {
      return await loadIcon(pngPath);
    }
    const svgPath = await findIconInDirectory(directory, iconField, ".svg");
    if (svgPath) {
      return await loadIcon(svgPath);
    }
  }

  return null;
}

async function findIconInDirectory(directory: string, iconName: string, extension: string) {
  const potentialPath = path.join(directory, `${iconName}${extension}`);
  try {
    await fs.promises.access(potentialPath, fs.constants.R_OK);
    return potentialPath;
  } catch (_error) {
    /* empty */
  }

  try {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const nested = await findIconInDirectory(
        path.join(directory, entry.name),
        iconName,
        extension,
      );
      if (nested) {
        return nested;
      }
    }
  } catch (_error) {
    /* empty */
  }

  return null;
}

async function loadIcon(iconPath: string) {
  try {
    const data = await fs.promises.readFile(iconPath);
    const ext = path.extname(iconPath).toLowerCase();
    const mimeType = ext === ".svg" ? "image/svg+xml" : "image/png";
    return `data:${mimeType};base64,${data.toString("base64")}`;
  } catch (_error) {
    return null;
  }
}

function sanitizeId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function dedupeByPath(apps: AppData[]) {
  const seen = new Map<string, AppData>();
  for (const app of apps) {
    if (!seen.has(app.path)) {
      seen.set(app.path, app);
    }
  }
  return [...seen.values()];
}
