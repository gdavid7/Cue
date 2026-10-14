import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { isMailPath } from "@/utils/mail-url";

export type MailEngineRuntimeMode = "desktop-ipc" | "browser" | "unavailable";

export function selectMailEngineRuntimeMode(input: {
  desktopIpc: boolean;
  opfs: boolean;
}): MailEngineRuntimeMode {
  if (input.desktopIpc) return "desktop-ipc";
  if (input.opfs) return "browser";
  return "unavailable";
}

export function shouldStartMailEngine(input: {
  pathname: string | null;
  browserRequested?: boolean;
  desktopIpc: boolean;
}): boolean {
  if (input.desktopIpc || input.browserRequested) return true;
  if (input.pathname && isMailPath(input.pathname)) return true;
  const segments = input.pathname?.split("/").filter(Boolean) ?? [];
  if (segments.length === 2) {
    return [
      "mail",
      "home",
      "compose",
      "bulk-archive",
      "quick-bulk-archive",
      "bulk-unsubscribe",
      "smart-categories",
    ].includes(segments[1]);
  }
  return (
    segments.length === 3 &&
    segments[1] === "debug" &&
    segments[2] === "mail-queue"
  );
}

/**
 * The provider the engine should boot with, or null while the account list is
 * still loading. Booting before the provider is known starts the wrong engine
 * for Microsoft accounts and forces an abort + reboot behind the owner lock.
 * If the list fails to load, Google keeps the previous default.
 */
export function resolveMailEngineProvider(input: {
  accountsLoading: boolean;
  provider: string;
}): "google" | "microsoft" | null {
  if (isMicrosoftProvider(input.provider)) return "microsoft";
  if (input.provider) return "google";
  return input.accountsLoading ? null : "google";
}
