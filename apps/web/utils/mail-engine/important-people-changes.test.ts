import { describe, expect, it, vi } from "vitest";
import {
  announceImportantPeopleChange,
  relayImportantPeopleChanges,
} from "@/utils/mail-engine/important-people-changes";
import {
  createMemoryTabBus,
  type TabMailMessage,
} from "@/utils/mail-engine/tab-channel";

describe("relaying Important star changes between tabs", () => {
  it("tells other tabs when this one changes a star", () => {
    const bus = createMemoryTabBus();
    const otherTab: TabMailMessage[] = [];
    bus.subscribe((message) => otherTab.push(message));
    const stop = relayImportantPeopleChanges(bus, vi.fn());

    announceImportantPeopleChange();

    expect(otherTab).toEqual([{ type: "importantPeopleChanged" }]);
    stop();
  });

  it("reads stars again when another tab changes one", () => {
    const bus = createMemoryTabBus();
    const refresh = vi.fn();
    const stop = relayImportantPeopleChanges(bus, refresh);

    bus.post({ type: "ready" });
    expect(refresh).not.toHaveBeenCalled();
    bus.post({ type: "importantPeopleChanged" });
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops relaying once the tab's engine goes", () => {
    const bus = createMemoryTabBus();
    const refresh = vi.fn();
    const posted: TabMailMessage[] = [];
    bus.subscribe((message) => posted.push(message));
    relayImportantPeopleChanges(bus, refresh)();

    announceImportantPeopleChange();
    bus.post({ type: "importantPeopleChanged" });

    expect(posted).toEqual([{ type: "importantPeopleChanged" }]);
    expect(refresh).not.toHaveBeenCalled();
  });
});
