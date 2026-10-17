import fs from "node:fs";
import path from "node:path";
import {
  compareDesktopVersions,
  isPrereleaseDesktopVersion,
} from "../../web/utils/desktop/desktop-version.ts";

// Unset until Cue publishes its own desktop releases, so a packaged app never
// installs a build from a feed Cue does not control.
export const DESKTOP_GITHUB_REPO: string | null = null;
export const DESKTOP_UPDATE_FEED_TAG = "desktop-updates";
export const DESKTOP_TAG_PREFIX = "desktop-v";

const UPDATE_FEED_FILES = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
const FILE_FIELD = /^([ \t]*(?:- )?url: |path: )(.+)$/gm;

export function getDesktopAssetBaseUrl(
  tag: string,
  repo: string | null = DESKTOP_GITHUB_REPO,
): string | null {
  if (!repo) return null;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

export function getDesktopUpdateFeedUrl(
  repo: string | null = DESKTOP_GITHUB_REPO,
): string | null {
  return getDesktopAssetBaseUrl(DESKTOP_UPDATE_FEED_TAG, repo);
}

export function rewriteUpdateFeedYaml(
  yamlText: string,
  assetBaseUrl: string,
): string {
  const base = assetBaseUrl.replace(/\/+$/u, "");
  return yamlText.replace(
    FILE_FIELD,
    (match, prefix: string, value: string) => {
      const rewritten = rewriteFeedFileValue(value, base);
      return rewritten === value ? match : `${prefix}${rewritten}`;
    },
  );
}

export function rewriteUpdateFeedFiles(
  directory: string,
  assetBaseUrl: string,
): string[] {
  const rewritten: string[] = [];
  for (const name of UPDATE_FEED_FILES) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const next = rewriteUpdateFeedYaml(
      fs.readFileSync(file, "utf8"),
      assetBaseUrl,
    );
    fs.writeFileSync(file, next);
    rewritten.push(name);
  }
  return rewritten;
}

export function parseUpdateFeedVersion(yamlText: string): string | null {
  const match = yamlText.match(/^version:\s*['"]?([^'"\s]+)/m);
  return match?.[1] ?? null;
}

export function shouldReplaceDesktopUpdateFeed(
  nextYaml: string,
  currentYaml: string | null,
): boolean {
  const next = parseUpdateFeedVersion(nextYaml);
  if (!next || isPrereleaseDesktopVersion(next)) return false;
  if (!currentYaml) return true;
  const current = parseUpdateFeedVersion(currentYaml);
  if (!current) return true;
  return compareDesktopVersions(next, current) >= 0;
}

function rewriteFeedFileValue(value: string, base: string): string {
  const quote = value.startsWith("'") || value.startsWith('"') ? value[0] : "";
  const raw = quote ? value.slice(1, -1) : value.trim();
  if (!raw || /^https?:\/\//iu.test(raw)) return value;
  const next = `${base}/${raw}`;
  return quote ? `${quote}${next}${quote}` : next;
}
