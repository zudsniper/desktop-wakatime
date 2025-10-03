import { AppData } from "../../utils/validators";
import { AppsManager } from "../apps-manager";
import { getInstalledApps as getInstalledAppsMac } from "./mac";
import { getInstalledAppsLinux } from "./linux";
import { getInstalledApps as getInstalledAppsWindows } from "./windows";

export async function getApps(): Promise<AppData[]> {
  let apps: AppData[] = [];

  if (process.platform === "win32") {
    apps = await getInstalledAppsWindows();
  } else if (process.platform === "darwin") {
    apps = await getInstalledAppsMac();
  } else if (process.platform === "linux") {
    apps = await getInstalledAppsLinux();
  }

  return apps.filter((app) => !AppsManager.isExcludedApp(app));
}
