import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { GET } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/middleware", () => ({
  withAuth:
    (_scope: string, handler: (request: NextRequest) => unknown) =>
    (request: NextRequest) => {
      Object.assign(request, {
        auth: { userId: "user-id" },
        logger: createScopedLogger("raw-message-test"),
      });
      return handler(request);
    },
}));

const getRawMessage = vi.fn();
const RAW = "Subject: Hi\r\nContent-Type: text/html\r\n\r\n<script>x</script>";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.emailAccount.findUnique.mockResolvedValue({
    id: "account-id",
    account: { provider: "google" },
  } as never);
  vi.mocked(createEmailProvider).mockResolvedValue({
    getRawMessage,
  } as never);
  getRawMessage.mockResolvedValue(Buffer.from(RAW));
});

describe("raw message", () => {
  it("shows the original as sandboxed plain text", async () => {
    const response = await GET(rawRequest(), {} as never);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-id", userId: "user-id" },
      }),
    );
    expect(getRawMessage).toHaveBeenCalledWith("message-id");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(await response.text()).toBe(RAW);
  });

  it("downloads the original as an .eml file", async () => {
    const request = rawRequest();
    request.nextUrl.searchParams.set("download", "1");

    const response = await GET(new NextRequest(request.nextUrl), {} as never);

    expect(response.headers.get("content-type")).toBe("message/rfc822");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="message.eml"',
    );
  });

  it("refuses an account the user doesn't own", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const response = await GET(rawRequest(), {} as never);

    expect(response.status).toBe(403);
    expect(getRawMessage).not.toHaveBeenCalled();
  });
});

function rawRequest() {
  return new NextRequest(
    "http://localhost/api/messages/raw?emailAccountId=account-id&messageId=message-id",
  );
}
