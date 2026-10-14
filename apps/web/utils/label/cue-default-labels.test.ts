import { describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import {
  findCueDefaultLabels,
  getCueDefaultLabels,
} from "@/utils/label/cue-default-labels";

describe("findCueDefaultLabels", () => {
  it("finds the labels Cue's sorting rules used to create", () => {
    const labels = [
      "To Reply",
      "Awaiting Reply",
      "FYI",
      "Actioned",
      "Newsletter",
      "Marketing",
      "Work",
      "Cold Email",
      "Receipt",
    ].map((name, index) => ({ id: `Label_${index}`, name }));

    expect(findCueDefaultLabels(labels).map((label) => label.name)).toEqual([
      "To Reply",
      "Awaiting Reply",
      "FYI",
      "Actioned",
      "Newsletter",
      "Marketing",
    ]);
  });

  it("matches names the way label actions do, ignoring case and separators", () => {
    const labels = [
      { id: "1", name: "to-reply" },
      { id: "2", name: "fyi" },
      { id: "3", name: "Clients/Newsletter" },
    ];

    expect(findCueDefaultLabels(labels).map((label) => label.id)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("getCueDefaultLabels", () => {
  it("lists Gmail's matching labels with how many emails each holds", async () => {
    const provider = mockProvider("google", {
      getLabels: vi.fn().mockResolvedValue([
        { id: "Label_1", name: "To Reply", type: "user" },
        { id: "Label_2", name: "Work", type: "user" },
        { id: "Label_3", name: "Newsletter", type: "user" },
      ]),
      getLabelById: vi.fn(async (id: string) =>
        id === "Label_1"
          ? { id, name: "To Reply", type: "user", messagesTotal: 12 }
          : null,
      ),
    });

    await expect(getCueDefaultLabels(provider)).resolves.toEqual([
      { id: "Label_1", name: "To Reply", messagesTotal: 12 },
      { id: "Label_3", name: "Newsletter", messagesTotal: null },
    ]);
    expect(provider.getLabels).toHaveBeenCalledWith({ includeHidden: true });
  });

  it("leaves Outlook categories alone", async () => {
    const provider = mockProvider("microsoft", {
      getLabels: vi
        .fn()
        .mockResolvedValue([{ id: "cat-1", name: "To Reply", type: "user" }]),
      getLabelById: vi.fn(),
    });

    await expect(getCueDefaultLabels(provider)).resolves.toEqual([]);
    expect(provider.getLabels).not.toHaveBeenCalled();
  });
});

function mockProvider(
  name: "google" | "microsoft",
  methods: Pick<EmailProvider, "getLabels" | "getLabelById">,
) {
  return { name, ...methods } as unknown as EmailProvider;
}
