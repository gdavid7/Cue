// `build` for Groundtruth's copy of Cue: the same production build CI's browser tests use (build:ci), with the
// same environment the server later starts with, so the frozen NEXT_PUBLIC_* flags and CSP origins match.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./env.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/web");
// Network settings are kept here (and only here): the build downloads fonts.
execFileSync("pnpm", ["build:ci"], { cwd: webDir, env: cleanEnv({ network: true }), stdio: "inherit" });
