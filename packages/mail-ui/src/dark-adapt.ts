export type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };
type Hsl = { h: number; s: number; l: number };

// The reader's dark card tone and foreground (#2D2F34 / #E9EAEC), so an
// adapted email sits on the same surface as the rest of the thread.
export const DARK_MAIL_SURFACE: Rgb = { r: 45, g: 47, b: 52 };
const FOREGROUND_HSL = rgbToHsl({ r: 233, g: 234, b: 236 });
const SURFACE_HSL = rgbToHsl(DARK_MAIL_SURFACE);
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

const LIGHT_BACKGROUND_LUMINANCE = 0.4;
// Vivid fills such as brand buttons and banners keep their color; only
// near-neutral and pastel light fills move to the dark surface.
const BRAND_COLOR_CHROMA = 0.5;
const MIN_TEXT_CONTRAST = 4.5;

const SKIPPED_ELEMENTS = new Set([
  "IMG",
  "PICTURE",
  "SVG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "STYLE",
  "HEAD",
  "META",
  "LINK",
  "TITLE",
  "BASE",
  "BR",
  "WBR",
]);
const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;
const LOGO_MAX_WIDTH = 400;
const LOGO_MAX_HEIGHT = 160;
const TRANSPARENT_IMAGE_SOURCE =
  /^data:image\/(?:svg\+xml|png|gif|webp)|^blob:|\.(?:svg|png|gif|webp)(?:[?#&%]|$)/i;
// A card the size of the image plus a few pixels, drawn without changing the
// layout: the fill sits behind transparent pixels and the spread shadow pads it.
const IMAGE_BACKING: [string, string][] = [
  ["background-color", "rgb(241, 242, 244)"],
  ["box-shadow", "0 0 0 6px rgb(241, 242, 244)"],
  ["border-radius", "3px"],
];

/**
 * The fill an element should get on the dark surface, or null to keep it.
 * Light neutral and pastel fills map to the surface, lighter ones landing
 * closer to it so nested cards keep their order; vivid colors stay as sent.
 */
export function adaptBackgroundColor(color: Rgb): Rgb | null {
  if (relativeLuminance(color) <= LIGHT_BACKGROUND_LUMINANCE) return null;
  if (chroma(color) >= BRAND_COLOR_CHROMA) return null;

  const { h, s, l } = rgbToHsl(color);
  const surface = SURFACE_HSL;
  const lightness = surface.l + (1 - l) * 0.45;
  if (chroma(color) < 0.08) return hslToRgb({ ...surface, l: lightness });
  return hslToRgb({ h, s: s * 0.5, l: lightness });
}

/**
 * Text that no longer reads against its new background, moved to a
 * lightness that does (at least WCAG AA) while keeping its hue, so links and
 * brand-colored headings stay recognizable. Null keeps the color.
 */
export function adaptTextColor(color: Rgb, background: Rgb): Rgb | null {
  if (contrastRatio(color, background) >= MIN_TEXT_CONTRAST) return null;

  const hsl = chroma(color) < 0.08 ? FOREGROUND_HSL : rgbToHsl(color);
  // Mirrors the lightness, so black lands on the app's foreground and grays
  // keep their relative emphasis.
  let lightness = Math.min(
    FOREGROUND_HSL.l,
    Math.max(1 - rgbToHsl(color).l, 0.6),
  );
  let candidate = hslToRgb({ ...hsl, l: lightness });
  while (
    contrastRatio(candidate, background) < MIN_TEXT_CONTRAST &&
    lightness < 1
  ) {
    lightness = Math.min(1, lightness + 0.02);
    candidate = hslToRgb({ ...hsl, l: lightness });
  }
  return candidate;
}

/**
 * Whether the sender styled the email for dark mode themselves: a
 * `color-scheme` meta tag or property that includes dark, or a
 * `prefers-color-scheme: dark` media query.
 */
export function hasAuthoredDarkSupport(html: string) {
  if (/prefers-color-scheme\s*:\s*dark/i.test(html)) return true;
  if (/(?:supported-)?color-scheme\s*:\s*[^;{}()"'<>]*\bdark\b/i.test(html))
    return true;
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']?([\w-]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (name !== "color-scheme" && name !== "supported-color-schemes") continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
      tag,
    );
    if (/\bdark\b/i.test(content?.slice(1).join(" ") ?? "")) return true;
  }
  return false;
}

/**
 * Whether an image should sit on a small light backing once the area behind it
 * turns dark. Logos and wordmarks are often dark artwork on a transparent
 * background and would vanish on the dark surface; photos and banners are
 * opaque and too large to be one, and JPEGs cannot be transparent at all.
 */
export function needsLightBacking({
  src,
  width,
  height,
}: {
  src: string;
  width: number;
  height: number;
}) {
  if (!width || !height) return false;
  if (width > LOGO_MAX_WIDTH || height > LOGO_MAX_HEIGHT) return false;
  return TRANSPARENT_IMAGE_SOURCE.test(src);
}

/**
 * Restyles a rendered light email for the dark reader from outside the frame,
 * so nothing has to run inside the sandboxed document. Every computed style is
 * read before anything is written, so the document recalculates its styles
 * once. A document too large for the budget is left exactly as sent.
 */
export function adaptMailDocumentForDarkMode(
  mailDocument: Document,
  {
    maxElements = 6000,
    budgetMs = 120,
    now = () => performance.now(),
  }: { maxElements?: number; budgetMs?: number; now?: () => number } = {},
): { adapted: boolean } {
  const view = mailDocument.defaultView;
  const root = mailDocument.documentElement;
  if (!view || !root) return { adapted: false };
  if (mailDocument.getElementsByTagName("*").length > maxElements)
    return { adapted: false };

  const startedAt = now();
  const writes: [HTMLElement, string, string][] = [];
  type Backdrop = { original: Rgb; current: Rgb; adapted: boolean };
  const stack: [Element, Backdrop][] = [
    [root, { original: WHITE, current: DARK_MAIL_SURFACE, adapted: true }],
  ];
  let visited = 0;

  while (stack.length) {
    const [element, parent] = stack.pop()!;
    visited += 1;
    if (visited % 64 === 0 && now() - startedAt > budgetMs)
      return { adapted: false };

    const style = view.getComputedStyle(element);
    // Text over a picture was chosen for that picture; leave the region whole.
    if (style.backgroundImage && style.backgroundImage !== "none") continue;

    let backdrop = parent;
    const fill = parseCssColor(style.backgroundColor);
    if (fill && fill.a > 0) {
      const original = fill.a < 1 ? blend(fill, parent.original) : fill;
      const adapted = adaptBackgroundColor(original);
      if (adapted) {
        writes.push([
          element as HTMLElement,
          "background-color",
          toCss(adapted),
        ]);
        backdrop = { original, current: adapted, adapted: true };
      } else {
        backdrop = { original, current: original, adapted: false };
      }
    }

    if (backdrop.adapted) {
      const color = parseCssColor(style.color);
      const adapted = color && adaptTextColor(color, backdrop.current);
      if (color && adapted)
        writes.push([
          element as HTMLElement,
          "color",
          toCss({ ...adapted, a: color.a }),
        ]);
    }

    if (parent.adapted || backdrop.adapted) {
      for (const side of BORDER_SIDES) {
        if (style.getPropertyValue(`border-${side}-style`) === "none") continue;
        if (style.getPropertyValue(`border-${side}-width`) === "0px") continue;
        const border = parseCssColor(
          style.getPropertyValue(`border-${side}-color`),
        );
        const adapted = border && border.a > 0 && adaptBackgroundColor(border);
        if (adapted)
          writes.push([
            element as HTMLElement,
            `border-${side}-color`,
            toCss(adapted),
          ]);
      }
    }

    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index]!;
      const tagName = child.tagName.toUpperCase();
      if (tagName === "IMG" && backdrop.adapted) {
        const image = child as HTMLImageElement;
        const { width, height } = image.getBoundingClientRect();
        if (
          needsLightBacking({
            src: image.currentSrc || image.src,
            width,
            height,
          })
        )
          for (const [property, value] of IMAGE_BACKING)
            writes.push([image, property, value]);
      }
      if (!SKIPPED_ELEMENTS.has(tagName)) stack.push([child, backdrop]);
    }
  }

  for (const [element, property, value] of writes) {
    element.style?.setProperty(property, value, "important");
  }
  return { adapted: true };
}

export function parseCssColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([\da-f]{3}|[\da-f]{6})$/.exec(trimmed)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(trimmed)?.[1];
  if (!rgb) return null;
  const parts = rgb
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  const [r, g, b, a = 1] = parts;
  return { r: r!, g: g!, b: b!, a };
}

export function relativeLuminance({ r, g, b }: Rgb) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.039_28
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(first: Rgb, second: Rgb) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function chroma({ r, g, b }: Rgb) {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function blend(color: Rgba, backdrop: Rgb): Rgb {
  const mix = (top: number, bottom: number) =>
    Math.round(top * color.a + bottom * (1 - color.a));
  return {
    r: mix(color.r, backdrop.r),
    g: mix(color.g, backdrop.g),
    b: mix(color.b, backdrop.b),
  };
}

function toCss({ r, g, b, a = 1 }: Rgb & { a?: number }) {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === red) h = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sectors: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [red, green, blue] = sectors[Math.floor(h / 60) % 6]!;
  return {
    r: Math.round((red + m) * 255),
    g: Math.round((green + m) * 255),
    b: Math.round((blue + m) * 255),
  };
}
