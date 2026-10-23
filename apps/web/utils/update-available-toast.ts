import { toast } from "sonner";
import { BRAND_NAME } from "@/utils/branding";

const UPDATE_AVAILABLE_TOAST_ID = "update-available";

/**
 * Offers the user a reload onto a newer version. Never reloads by itself:
 * the page may hold a half-written reply.
 */
export function showUpdateAvailableToast(onReload: () => void) {
  toast.info("Update available", {
    action: {
      label: "Reload",
      onClick: onReload,
    },
    description: `Reload ${BRAND_NAME} to use the latest version.`,
    duration: Number.POSITIVE_INFINITY,
    id: UPDATE_AVAILABLE_TOAST_ID,
  });
}

export function dismissUpdateAvailableToast() {
  toast.dismiss(UPDATE_AVAILABLE_TOAST_ID);
}
