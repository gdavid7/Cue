import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureDesktopApplicationMenu } from "./application-menu";

const { app, Menu } = vi.hoisted(() => ({
  app: {
    getVersion: vi.fn(() => "0.2.0"),
    setAboutPanelOptions: vi.fn(),
    showAboutPanel: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(
      (template: MenuItemConstructorOptions[]) => template,
    ),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock("electron", () => ({ app, Menu }));

describe("desktop application menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets Windows users check for updates and view the installed version", () => {
    const checkForUpdates = vi.fn();
    configureDesktopApplicationMenu({
      checkForUpdates,
      createWindow: vi.fn(),
      recordDiagnostics: vi.fn(),
      platform: "win32",
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(template);
    const help = template.find((item) => item.role === "help");
    const submenu = help?.submenu as MenuItemConstructorOptions[];
    const update = submenu.find((item) => item.label === "Check for Updates…");
    expect(update?.click).toBe(checkForUpdates);

    const about = submenu.find((item) => item.label === "About Cue");
    expect(about?.click).toEqual(expect.any(Function));
    about?.click?.({} as never, {} as never, {} as never);

    expect(app.setAboutPanelOptions).toHaveBeenCalledWith({
      applicationName: "Cue",
      applicationVersion: "0.2.0",
    });
    expect(app.showAboutPanel).toHaveBeenCalledOnce();
  });

  it.each([
    "darwin",
    "win32",
  ] as const)("hides Check for Updates on %s when the build has no update feed", (platform) => {
    configureDesktopApplicationMenu({
      createWindow: vi.fn(),
      recordDiagnostics: vi.fn(),
      platform,
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    const items = template.flatMap(
      (item) => (item.submenu as MenuItemConstructorOptions[]) ?? [],
    );
    expect(items.some((item) => item.label === "Check for Updates…")).toBe(
      false,
    );
    const appMenu = template.find((item) => item.label === "Cue");
    const appItems = (appMenu?.submenu as MenuItemConstructorOptions[]) ?? [];
    for (let i = 1; i < appItems.length; i++) {
      expect(
        appItems[i].type === "separator" &&
          appItems[i - 1].type === "separator",
      ).toBe(false);
    }
  });

  it("adds New Window to the File menu", () => {
    const createWindow = vi.fn();
    configureDesktopApplicationMenu({
      checkForUpdates: vi.fn(),
      createWindow,
      recordDiagnostics: vi.fn(),
      platform: "darwin",
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    const file = template.find((item) => item.label === "File");
    const submenu = file?.submenu as MenuItemConstructorOptions[];
    const newWindow = submenu.find((item) => item.label === "New Window");
    expect(newWindow?.accelerator).toBe("CommandOrControl+N");
    newWindow?.click?.({} as never, {} as never, {} as never);
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("offers Restart to Update once a download is ready", () => {
    const checkForUpdates = vi.fn();
    configureDesktopApplicationMenu({
      checkForUpdates,
      createWindow: vi.fn(),
      recordDiagnostics: vi.fn(),
      updateReady: true,
      platform: "darwin",
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    const appMenu = template.find((item) => item.label === "Cue");
    const submenu = appMenu?.submenu as MenuItemConstructorOptions[];
    const update = submenu.find((item) => item.label === "Restart to Update");
    expect(update?.click).toBe(checkForUpdates);
  });

  it("shows download progress in the menu while an update is downloading", () => {
    configureDesktopApplicationMenu({
      checkForUpdates: vi.fn(),
      createWindow: vi.fn(),
      recordDiagnostics: vi.fn(),
      downloadPercent: 42,
      platform: "darwin",
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    const appMenu = template.find((item) => item.label === "Cue");
    const submenu = appMenu?.submenu as MenuItemConstructorOptions[];
    expect(
      submenu.some((item) => item.label === "Downloading update… 42%"),
    ).toBe(true);
  });

  it.each([
    "darwin",
    "win32",
  ] as const)("offers Record Diagnostics in the Help menu on %s", (platform) => {
    const recordDiagnostics = vi.fn();
    configureDesktopApplicationMenu({
      checkForUpdates: vi.fn(),
      createWindow: vi.fn(),
      recordDiagnostics,
      platform,
    });

    const template: MenuItemConstructorOptions[] =
      Menu.buildFromTemplate.mock.results[0].value;
    const help = template.find((item) => item.role === "help");
    const submenu = help?.submenu as MenuItemConstructorOptions[];
    const record = submenu.find((item) => item.label === "Record Diagnostics…");
    expect(record?.click).toBe(recordDiagnostics);
  });
});
