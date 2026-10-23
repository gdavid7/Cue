// Groundtruth's test helper. Copied by Groundtruth into .groundtruth/tests/support/ in the app's repo;
// edits there are overwritten on the next run, so change Groundtruth's copy instead.
//
// check() wraps the assertions that prove a claim's "then". It runs them like plain expect calls, then
// boxes the target and shows the claim, green or red, and holds so the video captures it. The overlay is
// drawn by Playwright's screencast, so it appears in the video, never in the page. The tests need
// nothing but @playwright/test to run.
//
// resetData() and scenario() put the app's data into a known starting state, with the same commands the
// verifier used (app.json next to this file, written from .groundtruth/app.yml). Call one at the start of
// every test, before the first page.goto.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

const HOLD_MS = 2000; // long enough for the recorder to capture the frame and for a person to read it

interface AppCommands {
  workdir: string;
  env: Record<string, string>;
  secrets?: { file: string; names: string[] }; // file relative to the app's repo; values are never in app.json
  reset: string | null; // null: the app stores no data on a server, so a fresh browser is already clean
  scenarios: Record<string, { description: string; run: string }>;
}

// TWIN of parseEnvText() in Groundtruth's lib/secrets.mjs: keep them alike.
function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

// Found through Playwright's testDir (.groundtruth/tests), so it works however the test file is loaded.
// The env for the app's commands: app.yml's env, then the test-account secrets from the gitignored secrets
// file, which win (the same order Groundtruth uses). A named secret that's missing stops the test.
function appCommands(): { app: AppCommands; cwd: string; env: Record<string, string> } {
  const testDir = base.info().project.testDir;
  const app = JSON.parse(fs.readFileSync(path.join(testDir, "support", "app.json"), "utf8")) as AppCommands;
  const repo = path.resolve(testDir, "..", "..");
  let secrets: Record<string, string> = {};
  const names = app.secrets?.names ?? [];
  if (names.length > 0) {
    const file = path.resolve(repo, app.secrets!.file);
    secrets = fs.existsSync(file) ? parseEnvText(fs.readFileSync(file, "utf8")) : {};
    const empty = names.filter((name) => !secrets[name]);
    if (empty.length) throw new Error(`${empty.join(", ")} not set in ${app.secrets!.file}: fill in test-account values (see groundtruth secrets).`);
  }
  return { app, cwd: path.resolve(repo, app.workdir), env: { ...app.env, ...secrets } };
}

function run(command: string, cwd: string, env: Record<string, string>) {
  try {
    execSync(command, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
  } catch (error) {
    const output = (error as { stdout?: Buffer; stderr?: Buffer });
    throw new Error(`"${command}" failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`);
  }
}

// When the starting state was ready. The video starts when the page is created, before the reset or scenario
// runs, so it begins with a blank page; Groundtruth trims the clip up to this moment.
function markReady() {
  const info = base.info();
  if (!info.annotations.some((a) => a.type === "groundtruth-ready")) info.annotations.push({ type: "groundtruth-ready", description: String(Date.now()) });
}

/** Resets the app's data to its clean starting state (a claim with no `given`). */
export async function resetData() {
  const { app, cwd, env } = appCommands();
  if (app.reset !== null) {
    const reset = app.reset;
    await base.step("reset data", async () => run(reset, cwd, env));
  }
  markReady();
}

/** Resets, then loads a named starting state (the claim's `given`). */
export async function scenario(name: string) {
  const { app, cwd, env } = appCommands();
  await base.step(`scenario: ${name}`, async () => {
    const found = app.scenarios[name];
    if (!found) throw new Error(`No scenario "${name}". Scenarios: ${Object.keys(app.scenarios).join(", ") || "none"}.`);
    if (app.reset !== null) run(app.reset, cwd, env);
    run(found.run, cwd, env);
  });
  markReady();
}

// Smooth mouse: in a filmed run, a cursor drawn in the page glides to each element before it's clicked,
// eased like a hand, instead of jumping there; the real click then lands where it stopped. It's one
// animation in the browser (not many small mouse moves, each of which Playwright would mark and slow down),
// it ignores the pointer (pointer-events: none) and is hidden from accessibility. Installed once per test
// process, on Playwright's Locator class, so every click, hover and check glides. Skipped when the video
// won't be kept (regression runs).
const GLIDE = Symbol.for("groundtruth.glide");
const cursor = new WeakMap<Page, { x: number; y: number }>();

async function glide(page: Page, target: Locator) {
  if (videoMode() !== "on") return;
  const box = await target.boundingBox({ timeout: 2000 }).catch(() => null);
  if (!box) return; // not on screen yet: let the action wait for it as usual
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const from = cursor.get(page) ?? { x: size.width / 2, y: size.height * 0.75 };
  const ms = Math.round(Math.min(700, Math.max(250, Math.hypot(to.x - from.x, to.y - from.y) * 0.9)));
  await page.evaluate(({ from, to, ms }) => new Promise<void>((resolve) => {
    let el = document.querySelector("groundtruth-cursor") as HTMLElement | null;
    if (!el) {
      el = document.createElement("groundtruth-cursor");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:22px;height:22px;";
      el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(el);
    }
    const cursorEl = el;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = ease(t);
      cursorEl.style.transform = `translate(${from.x + (to.x - from.x) * e - 3}px, ${from.y + (to.y - from.y) * e - 2}px)`;
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  }), { from, to, ms }).catch(() => {});
  cursor.set(page, to);
}

function installSmoothMouse(page: Page) {
  const proto = Object.getPrototypeOf(page.locator("body")) as Record<string | symbol, unknown>;
  if (proto[GLIDE]) return;
  proto[GLIDE] = true;
  for (const name of ["click", "dblclick", "hover", "check", "uncheck", "setChecked", "tap"]) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function (this: Locator, ...args: unknown[]) {
      await glide(this.page(), this).catch(() => {});
      return original.apply(this, args);
    };
  }
}

/**
 * Playwright's `test`, plus what Groundtruth's videos need: it notes when the video starts (so the clip can be
 * trimmed to the starting state) and turns on the smooth mouse. Import `test` and `expect` from here.
 */
export const test = base.extend<{ groundtruthVideo: void }>({
  groundtruthVideo: [async ({ page }, use, info) => {
    info.annotations.push({ type: "groundtruth-video", description: String(Date.now()) });
    installSmoothMouse(page);
    await use();
    // The clip is the video of the page check() showed its proof on (a test that opens a new tab has two
    // videos). Saved only where the video is kept: every test when all are filmed, failures otherwise.
    const kept = videoMode() === "on" || info.status !== info.expectedStatus;
    const proofPage = proofPages.get(info.testId) ?? page;
    const video = kept ? proofPage.video() : null;
    if (video) {
      const file = info.outputPath("groundtruth-clip.webm");
      await proofPage.close().catch(() => {});
      await video.saveAs(file).then(() => info.attachments.push({ name: "groundtruth-clip", path: file, contentType: "video/webm" }), () => {});
    }
  }, { auto: true }],
});
const proofPages = new Map<string, Page>(); // test id → the page its check() ran on
export { expect };

export async function check(page: Page, claim: string, target: Locator | null, assertion: () => Promise<unknown>) {
  installSmoothMouse(page); // tests that import test from @playwright/test get it from their first check on
  proofPages.set(base.info().testId, page);
  await base.step(claim, async () => {
    let failure: unknown;
    try {
      await assertion();
    } catch (error) {
      failure = error;
    }
    await mark(page, claim, target, failure === undefined);
    if (failure !== undefined) throw failure;
  });
}

// How this test is filmed: "on" keeps every video, "retain-on-failure" only failing ones, "off" none.
function videoMode(): string {
  const video = base.info().project.use.video;
  return (typeof video === "string" ? video : video?.mode) ?? "off";
}

async function mark(page: Page, claim: string, target: Locator | null, passed: boolean) {
  const mode = videoMode();
  if (mode === "off") return;
  // When the proof appears, so the review page can put a marker on the clip's timeline and show this frame.
  base.info().annotations.push({ type: "groundtruth-check", description: JSON.stringify({ claim, passed, at: Date.now() }) });
  // Hold only where the video will be kept: always when every test is filmed; on failure otherwise.
  if (mode !== "on" && passed) return;
  const colour = passed ? "#0b8259" : "#c03d29";
  // A proof can be that the target is gone ("the line disappears"): don't wait for it to come back, just
  // show the banner without a box.
  const box = target ? await target.boundingBox({ timeout: 500 }).catch(() => null) : null;
  const outline = box
    ? `<div style="position:fixed;left:${box.x - 6}px;top:${box.y - 6}px;width:${box.width + 12}px;height:${box.height + 12}px;`
      + `border:3px solid ${colour};border-radius:8px;box-shadow:0 0 0 4px ${colour}33"></div>`
    : "";
  const banner = `<div style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:80vw;`
    + `background:${colour};color:#fff;border-radius:10px;padding:10px 16px;box-shadow:0 6px 24px rgba(0,0,0,.3);`
    + `font:600 18px/1.35 system-ui,'Segoe UI',sans-serif">${passed ? "✓" : "✗"} ${escape(claim)}</div>`;
  await page.screencast.showOverlay(outline + banner, { duration: HOLD_MS });
  await page.waitForTimeout(HOLD_MS);
}

function escape(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
