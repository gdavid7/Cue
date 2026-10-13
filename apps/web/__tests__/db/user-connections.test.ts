import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { fetchConnectorCandidates } from "@/utils/thread-context/connector-context";
import { findConnectionAccountId } from "@/utils/mcp/user-connections";

vi.mock("server-only", () => ({}));

const { mockExecuteTool } = vi.hoisted(() => ({ mockExecuteTool: vi.fn() }));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({ executeTool: mockExecuteTool }),
}));

const PREFIX = "user-connections-test";
const userId = `${PREFIX}-user`;
const otherUserId = `${PREFIX}-other-user`;
// The person reading mail in their school account, who connected Drive from
// their personal one and OneDrive from both.
const schoolAccountId = `${PREFIX}-school`;
const personalAccountId = `${PREFIX}-personal`;
const strangerAccountId = `${PREFIX}-stranger`;

const EMPTY_RESULTS: Record<string, unknown> = {
  googledrive: { files: [] },
  one_drive: { value: [] },
  slack: { messages: { matches: [] } },
};

describe.skipIf(!process.env.RUN_DB_TESTS)(
  "connected apps shared across a person's email accounts (real database)",
  () => {
    const logger = createScopedLogger("user-connections-db-test");

    beforeEach(async () => {
      vi.clearAllMocks();
      mockExecuteTool.mockImplementation(
        async ({ app }: { app: string }) => EMPTY_RESULTS[app],
      );
      await prisma.user.deleteMany({
        where: { id: { in: [userId, otherUserId] } },
      });
      await seedAccount(userId, schoolAccountId);
      await seedAccount(userId, personalAccountId);
      await seedAccount(otherUserId, strangerAccountId);

      await connect(personalAccountId, "googledrive");
      await connect(personalAccountId, "one_drive");
      await connect(schoolAccountId, "one_drive");
      await connect(strangerAccountId, "slack");
    });

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { id: { in: [userId, otherUserId] } },
      });
    });

    it("searches each app once, through the account that connected it, and never another person's", async () => {
      await fetchConnectorCandidates({
        emailAccountId: schoolAccountId,
        keywords: ["milestone"],
        logger,
      });

      const calls = mockExecuteTool.mock.calls.map(([args]) => ({
        app: args.app,
        emailAccountId: args.emailAccountId,
      }));
      expect(calls).toHaveLength(2);
      expect(calls).toEqual(
        expect.arrayContaining([
          { app: "googledrive", emailAccountId: personalAccountId },
          { app: "one_drive", emailAccountId: schoolAccountId },
        ]),
      );
    });

    it("finds the account holding the person's connection, preferring the one being viewed", async () => {
      expect(
        await findConnectionAccountId({
          integration: "googledrive",
          emailAccountId: schoolAccountId,
        }),
      ).toBe(personalAccountId);
      expect(
        await findConnectionAccountId({
          integration: "one_drive",
          emailAccountId: schoolAccountId,
        }),
      ).toBe(schoolAccountId);
      expect(
        await findConnectionAccountId({
          integration: "slack",
          emailAccountId: schoolAccountId,
        }),
      ).toBeNull();
    });
  },
);

async function seedAccount(ownerId: string, emailAccountId: string) {
  await prisma.user.upsert({
    where: { id: ownerId },
    update: {},
    create: { id: ownerId, email: `${ownerId}@example.com` },
  });
  const account = await prisma.account.create({
    data: {
      userId: ownerId,
      provider: "google",
      providerAccountId: emailAccountId,
    },
  });
  await prisma.emailAccount.create({
    data: {
      id: emailAccountId,
      email: `${emailAccountId}@example.com`,
      userId: ownerId,
      accountId: account.id,
    },
  });
}

async function connect(emailAccountId: string, integration: string) {
  const { id } = await prisma.mcpIntegration.upsert({
    where: { name: integration },
    update: {},
    create: { name: integration },
    select: { id: true },
  });
  await prisma.mcpConnection.create({
    data: {
      name: integration,
      emailAccountId,
      integrationId: id,
      isActive: true,
    },
  });
}
