import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import { getOrCreateReferralCode } from "@/utils/referral/referral-code";
import { getComposeSignature } from "./compose-signature";

const mockedEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_BASE_URL: "https://app.example.com",
  NEXT_PUBLIC_BRAND_NAME: "Inbox Zero",
  NEXT_PUBLIC_DISABLE_REFERRAL_SIGNATURE: false as boolean | undefined,
}));

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: mockedEnv }));
vi.mock("@/utils/referral/referral-code", () => ({
  getOrCreateReferralCode: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));

const logger = createScopedLogger("compose-signature-test");
const args = { emailAccountId: "account", userId: "user", logger };

describe("getComposeSignature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnv.NEXT_PUBLIC_DISABLE_REFERRAL_SIGNATURE = false;
    vi.mocked(getOrCreateReferralCode).mockResolvedValue({ code: "abc123" });
  });

  it("returns the account signature and a footer with the referral link", async () => {
    mockAccount({
      signature: "<div>Example Person</div>",
      includeSentWithSignature: true,
    });

    expect(await getComposeSignature(args)).toEqual({
      signatureHtml: "<div>Example Person</div>",
      footerHtml:
        '<div>Sent with <a href="https://app.example.com/?ref=abc123">Inbox Zero</a></div>',
    });
  });

  it("leaves the footer out when the account or the deployment turns it off", async () => {
    mockAccount({ signature: "", includeSentWithSignature: false });
    expect(await getComposeSignature(args)).toEqual({
      signatureHtml: "",
      footerHtml: "",
    });

    mockedEnv.NEXT_PUBLIC_DISABLE_REFERRAL_SIGNATURE = true;
    mockAccount({ signature: "", includeSentWithSignature: true });
    expect((await getComposeSignature(args)).footerHtml).toBe("");
  });

  it("still adds the footer when the referral lookup fails", async () => {
    vi.mocked(getOrCreateReferralCode).mockRejectedValue(new Error("down"));
    mockAccount({ signature: "", includeSentWithSignature: true });

    expect((await getComposeSignature(args)).footerHtml).toBe(
      '<div>Sent with <a href="https://app.example.com">Inbox Zero</a></div>',
    );
  });

  it("takes Gmail's default send-as signature when the account never set one", async () => {
    mockAccount({ signature: null, provider: "google" });
    mockProviderSignatures([
      {
        email: "alias@example.com",
        signature: "<b>Alias</b>",
        isDefault: false,
      },
      { email: "me@example.com", signature: "<b>Me</b>", isDefault: true },
    ]);

    expect((await getComposeSignature(args)).signatureHtml).toBe("<b>Me</b>");
    expect(prisma.emailAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "account", signature: null },
      data: { signature: "<b>Me</b>" },
    });
  });

  it("does not ask Gmail again once the signature was set or cleared", async () => {
    mockAccount({ signature: "", provider: "google" });

    expect((await getComposeSignature(args)).signatureHtml).toBe("");
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("leaves Outlook signatures alone because they can't be read", async () => {
    mockAccount({ signature: null, provider: "microsoft" });

    expect((await getComposeSignature(args)).signatureHtml).toBe("");
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(prisma.emailAccount.updateMany).not.toHaveBeenCalled();
  });

  it("composes without a signature, and retries later, when Gmail fails", async () => {
    mockAccount({ signature: null, provider: "google" });
    vi.mocked(createEmailProvider).mockRejectedValue(new Error("down"));

    expect((await getComposeSignature(args)).signatureHtml).toBe("");
    expect(prisma.emailAccount.updateMany).not.toHaveBeenCalled();
  });
});

function mockAccount({
  signature,
  includeSentWithSignature = false,
  provider = "google",
}: {
  signature: string | null;
  includeSentWithSignature?: boolean;
  provider?: string;
}) {
  prisma.emailAccount.findUnique.mockResolvedValue({
    signature,
    includeSentWithSignature,
    account: { provider },
  } as never);
}

function mockProviderSignatures(
  signatures: { email: string; signature: string; isDefault: boolean }[],
) {
  vi.mocked(createEmailProvider).mockResolvedValue({
    getSignatures: vi.fn().mockResolvedValue(signatures),
  } as never);
}
