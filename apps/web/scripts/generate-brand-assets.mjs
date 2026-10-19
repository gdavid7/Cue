// Regenerates every raster brand asset from the Signal logo geometry below:
// an open ring "C" with an accent dot in its opening.
//
//   pnpm --filter inbox-zero-ai exec node scripts/generate-brand-assets.mjs
//
// Chromium comes from @playwright/test. Set CHROMIUM_PATH to use a browser
// that is already installed. If `pngquant` is on PATH the splash screens are
// quantized afterwards.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..", "..");

const INK = { light: "#242424", dark: "#E9EAEC" };
const ACCENT = { light: "#2563EB", dark: "#60A5FA" };
const TILE_ACCENT = "#5B9BFF";
const CHARCOAL = "#26282C";
const TILE_TOP = "#2B2E33";
const TILE_BOTTOM = "#1B1D20";
const TAGLINE = "The better email";

// Mark geometry on a 24x24 grid. The small variant is heavier so it holds up
// at 16-32px.
const MARK = {
  regular: {
    ring: "M16.49 6.18A7.6 7.6 0 1 0 16.49 17.82",
    ringWidth: 3.4,
    dot: { cx: 19.2, cy: 12, r: 2.5 },
  },
  small: {
    ring: "M15.42 5.72A7.4 7.4 0 1 0 15.42 18.28",
    ringWidth: 4.2,
    dot: { cx: 18.9, cy: 12, r: 3.1 },
  },
};

const WORDMARK_LETTERS = [
  "M15.46 7.49A8.5 8.5 0 1 0 15.46 20.51",
  "M21.4 11.5V18a4.5 4.5 0 0 0 9 0M30.4 11.5V22.5",
  "M35.9 17H46.9A5.5 5.5 0 1 0 45.49 20.68",
];

function markGroup({ ink, accent, variant = "regular" }) {
  const m = MARK[variant];
  return `<path d="${m.ring}" fill="none" stroke="${ink}" stroke-width="${m.ringWidth}" stroke-linecap="round"/><circle cx="${m.dot.cx}" cy="${m.dot.cy}" r="${m.dot.r}" fill="${accent}"/>`;
}

function lettersGroup(ink) {
  return WORDMARK_LETTERS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join("");
}

function markSvg({ theme, size, variant }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${markGroup({ ink: INK[theme], accent: ACCENT[theme], variant })}</svg>`;
}

function wordmarkSvg({ theme, height }) {
  const width = (48.4 / 20) * height;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 4 48.4 20" width="${width}" height="${height}">${lettersGroup(INK[theme])}</svg>`;
}

function lockupSvg({ theme, width }) {
  const height = (28 / 84.9) * width;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84.9 28" width="${width}" height="${height}"><g transform="scale(1.17)">${markGroup({ ink: INK[theme], accent: ACCENT[theme] })}</g><g transform="translate(36.5 0)">${lettersGroup(INK[theme])}</g></svg>`;
}

// Full-bleed square tile, as used for maskable and store icons.
function tileSvg({ size, radius = 0, markScale = 0.66 }) {
  const m = MARK.regular;
  const scale = (size * markScale) / 24;
  const offset = (size - 24 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TILE_TOP}"/><stop offset="1" stop-color="${TILE_BOTTOM}"/></linearGradient></defs><rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/><g transform="translate(${offset} ${offset}) scale(${scale})"><path d="${m.ring}" fill="none" stroke="#FFFFFF" stroke-width="${m.ringWidth}" stroke-linecap="round"/><circle cx="${m.dot.cx}" cy="${m.dot.cy}" r="${m.dot.r}" fill="${TILE_ACCENT}"/></g></svg>`;
}

// Favicon tile for 16 and 32px: rounded corners, heavier mark, no padding.
function faviconSvg(size) {
  const m = MARK.small;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${TILE_BOTTOM}"/><g transform="scale(${size / 24})"><path d="${m.ring}" fill="none" stroke="#FFFFFF" stroke-width="${m.ringWidth}" stroke-linecap="round"/><circle cx="${m.dot.cx}" cy="${m.dot.cy}" r="${m.dot.r}" fill="${TILE_ACCENT}"/></g></svg>`;
}

// app/icon.svg: transparent, follows the browser's color scheme.
function adaptiveMarkSvg() {
  const m = MARK.small;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96"><style>.si{stroke:${INK.light}}.fa{fill:${ACCENT.light}}@media (prefers-color-scheme:dark){.si{stroke:${INK.dark}}.fa{fill:${ACCENT.dark}}}</style><path d="${m.ring}" fill="none" class="si" stroke-width="${m.ringWidth}" stroke-linecap="round"/><circle cx="${m.dot.cx}" cy="${m.dot.cy}" r="${m.dot.r}" class="fa"/></svg>\n`;
}

const IOS_SPLASH_SIZES = {
  "4__iPhone_SE__iPod_touch_5th_generation_and_later": [640, 1136],
  "iPhone_8__iPhone_7__iPhone_6s__iPhone_6__4.7__iPhone_SE": [750, 1334],
  iPhone_11__iPhone_XR: [828, 1792],
  iPhone_13_mini__iPhone_12_mini__iPhone_11_Pro__iPhone_XS__iPhone_X: [
    1125, 2436,
  ],
  iPhone_14__iPhone_13_Pro__iPhone_13__iPhone_12_Pro__iPhone_12: [1170, 2532],
  iPhone_15_Pro__iPhone_15__iPhone_14_Pro: [1179, 2556],
  iPhone_8_Plus__iPhone_7_Plus__iPhone_6s_Plus__iPhone_6_Plus: [1242, 2208],
  iPhone_11_Pro_Max__iPhone_XS_Max: [1242, 2688],
  iPhone_14_Plus__iPhone_13_Pro_Max__iPhone_12_Pro_Max: [1284, 2778],
  iPhone_15_Pro_Max__iPhone_15_Plus__iPhone_14_Pro_Max: [1290, 2796],
  "8.3__iPad_Mini": [1488, 2266],
  "9.7__iPad_Pro__7.9__iPad_mini__9.7__iPad_Air__9.7__iPad": [1536, 2048],
  "10.2__iPad": [1620, 2160],
  "10.9__iPad_Air": [1640, 2360],
  "10.5__iPad_Air": [1668, 2224],
  "11__iPad_Pro__10.5__iPad_Pro": [1668, 2388],
  "11__iPad_Pro_M4": [1668, 2420],
  "12.9__iPad_Pro": [2048, 2732],
  "13__iPad_Pro_M4": [2064, 2752],
};

const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();

  async function render({ width, height, body, background = "transparent" }) {
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;background:${background};overflow:hidden">${body}</body></html>`,
    );
    return page.screenshot({
      type: "png",
      omitBackground: background === "transparent",
    });
  }

  const tile = (size, opts) =>
    render({ width: size, height: size, body: tileSvg({ size, ...opts }) });

  const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };

  const app = (...p) => join(webRoot, "app", ...p);
  const pub = (...p) => join(webRoot, "public", ...p);

  // Browser and PWA icons.
  const icon512 = await tile(512);
  write(app("icon.png"), icon512);
  write(app("icon.svg"), adaptiveMarkSvg());
  write(app("apple-icon.png"), await tile(180));
  write(pub("icons", "icon-512x512.png"), icon512);
  write(pub("icons", "icon-192x192.png"), await tile(192));

  const ico16 = await render({
    width: 16,
    height: 16,
    body: faviconSvg(16),
  });
  const ico32 = await render({
    width: 32,
    height: 32,
    body: faviconSvg(32),
  });
  write(app("favicon.ico"), buildIco([ico16, ico32], [16, 32]));

  // Desktop app icon: rounded tile inside the standard macOS margin.
  const desktopSvg = tileSvg({ size: 824, radius: 185 });
  write(
    join(repoRoot, "apps", "desktop", "build", "icon.png"),
    await render({
      width: 1024,
      height: 1024,
      body: `<div style="position:absolute;left:100px;top:100px">${desktopSvg}</div>`,
    }),
  );

  // Docs.
  write(join(repoRoot, "docs", "favicon.png"), icon512);
  for (const theme of ["light", "dark"]) {
    write(
      join(repoRoot, "docs", "logo", `${theme}.svg`),
      `${lockupSvg({ theme, width: 339.6 })}\n`,
    );
  }

  // Wordmark for the email header, drawn at 2x the 32px display height.
  const wordmarkHeight = 64;
  write(
    pub("logo-wordmark.png"),
    await render({
      width: Math.round((48.4 / 20) * wordmarkHeight),
      height: wordmarkHeight,
      body: wordmarkSvg({ theme: "light", height: wordmarkHeight }),
    }),
  );

  // Open Graph image.
  write(
    app("opengraph-image.jpg"),
    await renderJpeg(page, {
      width: 1200,
      height: 630,
      background: `linear-gradient(180deg, ${TILE_TOP}, ${TILE_BOTTOM})`,
      body: `<div style="position:absolute;left:96px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:44px">${lockupSvg({ theme: "dark", width: 420 })}<div style="font:500 52px/1.1 ${FONT};letter-spacing:-0.02em;color:${INK.dark}">${TAGLINE}</div></div>`,
    }),
  );

  // Notetaker bot camera image.
  write(
    pub("images", "meetings", "cue-notetaker.jpg"),
    await renderJpeg(page, {
      width: 1920,
      height: 1080,
      background: `radial-gradient(circle at 50% 50%, ${TILE_TOP}, ${TILE_BOTTOM})`,
      body: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${markSvg({ theme: "dark", size: 360 })}</div>`,
    }),
  );

  // iOS splash screens: lockup centered on charcoal.
  for (const [name, [short, long]] of Object.entries(IOS_SPLASH_SIZES)) {
    for (const orientation of ["portrait", "landscape"]) {
      const width = orientation === "portrait" ? short : long;
      const height = orientation === "portrait" ? long : short;
      const lockupWidth = Math.round(Math.min(width, height) * 0.5);
      write(
        pub("splash_screens", `${name}_${orientation}.png`),
        await render({
          width,
          height,
          background: CHARCOAL,
          body: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${lockupSvg({ theme: "dark", width: lockupWidth })}</div>`,
        }),
      );
    }
  }

  await browser.close();
  optimizeSplashScreens();
}

async function renderJpeg(page, { width, height, body, background }) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;background:${background};overflow:hidden">${body}</body></html>`,
  );
  return page.screenshot({ type: "jpeg", quality: 90 });
}

// ICO with PNG-compressed images, one directory entry per size.
function buildIco(pngs, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((png, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sizes[i] % 256, 0);
    entry.writeUInt8(sizes[i] % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

// Flat backgrounds quantize to a small palette with no visible loss.
function optimizeSplashScreens() {
  const files = readSplashFiles(join(webRoot, "public", "splash_screens"));
  const attempts = [
    ["pngquant", ["--force", "--ext", ".png", "--quality=70-95", ...files]],
    ...files.map((file) => [
      "convert",
      [file, "-colors", "64", "-dither", "None", `PNG8:${file}`],
    ]),
  ];
  try {
    execFileSync(...attempts[0]);
    return;
  } catch {}
  try {
    for (const attempt of attempts.slice(1)) execFileSync(...attempt);
  } catch {
    console.warn("pngquant and ImageMagick unavailable; splash not quantized");
  }
}

function readSplashFiles(dir) {
  return Object.keys(IOS_SPLASH_SIZES).flatMap((name) =>
    ["portrait", "landscape"].map((o) => join(dir, `${name}_${o}.png`)),
  );
}

await main();
