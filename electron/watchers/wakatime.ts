import path from "path";
import { app, nativeImage, Notification, shell, Tray } from "electron";
import isDev from "electron-is-dev";
import { autoUpdater } from "electron-updater";

import type { Category, EntityType } from "../utils/types";
import type { AppData } from "../utils/validators";
import { AppsManager } from "../helpers/apps-manager";
import { DesktopWindow } from "../helpers/window-manager";
import { ConfigFile } from "../helpers/config-file";
import { Dependencies } from "../helpers/dependencies";
import { MonitoringManager } from "../helpers/monitoring-manager";
import { PropertiesManager } from "../helpers/properties-manager";
import { SettingsManager } from "../helpers/settings-manager";
import { exec, getCLIPath, getDeepLinkUrl, getPlatfrom } from "../utils";
import { DeepLink } from "../utils/constants";
import { Logging, LogLevel } from "../utils/logging";

export class Wakatime {
  private lastEntitiy = "";
  private lastTime: number = 0;
  private lastCodeTimeFetched: number = 0;
  private lastCodeTimeText = "";
  private lastCategory: Category = "coding";
  private tray?: Tray | null;
  private versionString: string;
  private lastCheckedForUpdates: number = 0;
  private lastPromptedToUpdateAt: number = 0;
  private lastPromptedToUpdateVersion: string = "";

  constructor() {
    const version = `${getPlatfrom()}-wakatime/${app.getVersion()}`;
    this.versionString = version;
    process.on("uncaughtException", async function (error, origin) {
      await Dependencies.reportError(error, origin, version);
      Logging.instance().log(error.toString(), LogLevel.ERROR);
    });
  }

  init(tray: Tray | null) {
    this.tray = tray;

    if (PropertiesManager.shouldLogToFile) {
      Logging.instance().activateLoggingToFile();
    }

    const debugMode = ConfigFile.getSetting("settings", "debug") === "true";
    if (debugMode) {
      Logging.instance().enableDebugLogging();
    }

    Logging.instance().log(`Starting WakaTime v${app.getVersion()}`);

    if (SettingsManager.shouldRegisterAsLogInItem()) {
      SettingsManager.registerAsLogInItem();
    }

    this.setupAutoUpdater();
    this.checkForUpdates();

    Dependencies.installDependencies();

    AppsManager.instance()
      .loadApps()
      .then((apps) => {
        if (!PropertiesManager.hasLaunchedBefore) {
          for (const app of apps) {
            if (app.isDefaultEnabled) {
              MonitoringManager.set(app, true);
            }
          }
          PropertiesManager.hasLaunchedBefore = true;
        }

        if (
          apps.find(
            (app) => app.isBrowser && MonitoringManager.isMonitored(app.path),
          )
        ) {
          (async () => {
            const browser = await Dependencies.recentBrowserExtension();
            if (browser && Notification.isSupported()) {
              const notification = new Notification({
                title: "Warning",
                subtitle: `WakaTime ${browser} extension detected. It’s recommended to only track browsing activity with the ${browser} extension or The Desktop app, but not both.`,
              });
              notification.show();
            }
          })();
        }
      });

    this.checkForApiKey();

    this.fetchToday();
  }

  checkForApiKey() {
    const key = ConfigFile.getSetting("settings", "api_key");
    if (!key) {
      this.openSettingsDeepLink();
    }
  }

  openSettingsDeepLink() {
    shell.openExternal(getDeepLinkUrl(DeepLink.settings));
  }

  private shouldSendHeartbeat(
    entity: string,
    time: number,
    isWrite: boolean,
    category: Category,
  ) {
    if (isWrite) {
      return true;
    }
    if (category !== this.lastCategory) {
      return true;
    }
    if (entity && this.lastEntitiy !== entity) {
      return true;
    }
    if (this.lastTime + 120 < time) {
      return true;
    }
  }

  async sendHeartbeat(props: {
    appData?: AppData;
    windowInfo: DesktopWindow;
    entity: string;
    entityType: EntityType;
    category: Category | null;
    project: string | null;
    language: string | null;
    isWrite: boolean;
  }) {
    const {
      appData,
      entity,
      entityType,
      isWrite,
      language,
      project,
      windowInfo,
    } = props;
    const category = props.category ?? "coding";
    const time = Date.now() / 1000;

    if (!this.shouldSendHeartbeat(entity, time, isWrite, category)) {
      return;
    }
    const windowPath = windowInfo.info.path;
    if (!windowPath || !MonitoringManager.isMonitored(windowPath)) {
      return;
    }

    const appName = windowInfo.info.name || appData?.name;
    if (!appName) {
      return;
    }

    this.lastEntitiy = entity;
    this.lastCategory = category;
    this.lastTime = time;

    const args: string[] = [
      "--entity",
      entity,
      "--entity-type",
      entityType,
      "--category",
      category,
      "--plugin",
      `${this.pluginString(appData, windowInfo)}`,
    ];

    if (project) {
      args.push("--project", project);
    }
    if (isWrite) {
      args.push("--write");
    }
    if (language) {
      args.push("--language", language);
    }

    const cli = getCLIPath();
    Logging.instance().log(`Sending heartbeat: ${cli} ${args}`);

    try {
      const [output, err] = await exec(cli, ...args);
      if (err) {
        Logging.instance().log(
          `Error sending heartbeat: ${err}`,
          LogLevel.ERROR,
        );
        this.tray?.displayBalloon({
          icon: nativeImage.createFromPath(
            path.join(process.env.VITE_PUBLIC!, "trayIcon.png"),
          ),
          title: "WakaTime Error",
          content: `Error when running wakatime-cli: ${err}`,
        });
        if (`${err}`.includes("ENOENT")) {
          this.tray?.setImage(
            nativeImage.createFromPath(
              path.join(process.env.VITE_PUBLIC!, "trayIconRed.png"),
            ),
          );
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: "WakaTime Error",
              body: "Unable to execute WakaTime cli. Please make sure WakaTime is not being blocked by AV software.",
              icon: nativeImage.createFromPath(
                path.join(process.env.VITE_PUBLIC!, "trayIconRed.png"),
              ),
            });
            notification.show();
          }
        } else if (`${err}`.includes("EPERM")) {
          this.tray?.setImage(
            nativeImage.createFromPath(
              path.join(process.env.VITE_PUBLIC!, "trayIconRed.png"),
            ),
          );
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: "WakaTime Error",
              body: "Microsoft Defender is blocking WakaTime. Please allow WakaTime to run so it can upload code stats to your dashboard.",
              icon: nativeImage.createFromPath(
                path.join(process.env.VITE_PUBLIC!, "trayIconRed.png"),
              ),
            });
            notification.show();
          }
        }
      } else {
        this.tray?.setImage(
          nativeImage.createFromPath(
            path.join(process.env.VITE_PUBLIC!, "trayIcon.png"),
          ),
        );
      }
      if (output) {
        Logging.instance().log(
          `Output from wakatime-cli when sending heartbeat: ${output}`,
          LogLevel.ERROR,
          true,
        );
      }
    } catch (error) {
      Logging.instance().log(
        `Exception when sending heartbeat: ${error}`,
        LogLevel.ERROR,
        true,
      );
    }

    await this.fetchToday();
    this.checkForUpdates();
  }

  public async fetchToday() {
    if (!PropertiesManager.showCodeTimeInStatusBar) {
      // tray.setTitle is only available on darwin/macOS
      this.tray?.setTitle("");
      this.tray?.setToolTip("Wakatime");
      return;
    }

    const time = Date.now() / 1000;
    if (this.lastCodeTimeFetched + 120 > time) {
      this.tray?.setTitle(` ${this.lastCodeTimeText}`);
      this.tray?.setToolTip(` ${this.lastCodeTimeText}`);
      return;
    }

    this.lastCodeTimeFetched = time;

    const args: string[] = [
      "--today",
      "--today-hide-categories",
      "true",
      "--plugin",
      `${this.pluginString()}`,
    ];

    const cli = getCLIPath();
    Logging.instance().log(`Fetching code time: ${cli} ${args.join(" ")}`);

    try {
      const [output, err] = await exec(cli, ...args);
      if (err) {
        Logging.instance().log(
          `Error fetching code time: ${err}`,
          LogLevel.ERROR,
        );
        return;
      }
      this.lastCodeTimeText = output;
      this.tray?.setTitle(` ${output}`);
      this.tray?.setToolTip(` ${output}`);
    } catch (error) {
      Logging.instance().log(
        `Failed to fetch code time: ${error}`,
        LogLevel.ERROR,
      );
    }
  }

  public setupAutoUpdater() {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "wakatime",
      repo: "desktop-wakatime",
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;

    autoUpdater.on("checking-for-update", () => {
      Logging.instance().log("Checking for updates");
    });
    autoUpdater.on("update-available", async (res) => {
      Logging.instance().log(
        `New version available. Version: ${res.version}, Files: ${res.files.map((file) => file.url).join(", ")}`,
      );
      if (!this.canPromptToUpdate(res.version)) {
        Logging.instance().log(
          "Already prompted to update this version recently, will download again in a week.",
        );
        return;
      }
      await autoUpdater.downloadUpdate();
    });
    autoUpdater.on("update-downloaded", (res) => {
      Logging.instance().log(
        `Update Downloaded. Downloaded file: ${res.downloadedFile}, Version: ${res.version}, `,
      );
      if (!this.canPromptToUpdate(res.version)) {
        Logging.instance().log(
          "Already prompted to update this version recently, will ask again in a week.",
        );
        return;
      }

      this.lastPromptedToUpdateVersion = res.version;
      this.lastPromptedToUpdateAt = Date.now();
      autoUpdater.quitAndInstall();
    });
    autoUpdater.on("update-not-available", () => {
      Logging.instance().log("Update not available");
    });
    autoUpdater.on("update-cancelled", () => {
      Logging.instance().log("Update cancelled");
    });
    autoUpdater.on("error", (err) => {
      Logging.instance().log(
        `electron-updater error. Error: ${err.message}`,
        LogLevel.ERROR,
      );
    });
  }

  // Only prompt for same version once per week, or if app is restarted
  private canPromptToUpdate(newVersion: string) {
    if (this.lastPromptedToUpdateAt + 604800 * 1000 < Date.now()) return true;
    if (this.lastPromptedToUpdateVersion !== newVersion) return true;
    return false;
  }

  public async checkForUpdates() {
    if (!PropertiesManager.autoUpdateEnabled || isDev) return;
    if (this.lastCheckedForUpdates + 600 * 1000 > Date.now()) return;

    await autoUpdater.checkForUpdatesAndNotify();
  }

  pluginString(appData?: AppData, windowInfo?: DesktopWindow) {
    const appName = windowInfo?.info.name || appData?.name;
    if (!appName) {
      return this.versionString;
    }

    const appNameSafe = appName.replace(/\s/g, "");
    const appVersion = appData?.version?.replace(/\s/g, "") || "unknown";

    return `${appNameSafe}/${appVersion} ${this.versionString}`.replace(
      /[\u{0080}-\u{FFFF}]/gu,
      "",
    );
  }
}
