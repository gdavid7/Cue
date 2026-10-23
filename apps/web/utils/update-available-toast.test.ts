import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { showUpdateAvailableToast } from "@/utils/update-available-toast";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), dismiss: vi.fn() } }));

describe("showUpdateAvailableToast", () => {
  // Sonner removes a toast after its action unless the click is prevented; a
  // reload cancelled at the page's leave prompt must leave Reload usable.
  it("keeps the toast up after Reload so a cancelled reload can be retried", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    showUpdateAvailableToast(onReload, onDismiss);
    const [title, options] = vi.mocked(toast.info).mock.calls[0];
    expect(title).toBe("Update available");
    expect(options?.onDismiss).toBe(onDismiss);
    const action = options?.action as {
      label: string;
      onClick: (event: { preventDefault: () => void }) => void;
    };
    const event = { preventDefault: vi.fn() };
    action.onClick(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
