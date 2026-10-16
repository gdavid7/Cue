export function expandPlaywrightTargets(
  paths: readonly string[],
  appRoot: string,
): Array<{ name: string; path: string }>;

export function getFeatureGroupTargetPaths(name: string): string[] | undefined;

export function getPlaywrightTargetName(specPath: string): string;

export function getPlaywrightSpecPathFromTargetName(targetName: string): string;

type PlaywrightMailProvider = "google" | "microsoft";

export function batchPlaywrightTargets(
  targets: ReadonlyArray<{ name: string; path: string }>,
  groups?: ReadonlyArray<{
    name: string;
    specs: readonly string[];
    providers?: readonly PlaywrightMailProvider[];
  }>,
): Array<{
  name: string;
  paths: string[];
  timeoutMinutes: number;
  providers: PlaywrightMailProvider[];
}>;
