import { describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import {
  ACCOUNT_LINKING,
  getGoogleUserFields,
  getMicrosoftUserFields,
} from "@/utils/auth/account-linking";

vi.mock("@/utils/prisma");

const existingEmail = "dee@company.co.uk";

// Runs better-auth's own sign-in step with Cue's linking settings: an OAuth
// sign-in whose email matches an existing user, from a provider account that
// isn't linked to anyone yet.
describe("implicit account linking on social sign-in", () => {
  it("does not link a consumer Google account made with an existing user's non-Gmail address", async () => {
    const result = await signIn({
      providerId: "google",
      email: existingEmail,
      ...getGoogleUserFields({ email: existingEmail, email_verified: true }),
    });

    expect(result.error).toBe("account not linked");
    expect(result.database.account).toHaveLength(0);
  });

  it("links a Google Workspace account at that address", async () => {
    const result = await signIn({
      providerId: "google",
      email: existingEmail,
      ...getGoogleUserFields({
        email: existingEmail,
        email_verified: true,
        hd: "company.co.uk",
      }),
    });

    expect(result.error).toBeNull();
    expect(result.database.account).toHaveLength(1);
  });

  it("does not link a Microsoft account even when it marks the email verified", async () => {
    // better-auth's own reading of an id_token with email_verified: true,
    // which the mapped profile fields then override.
    const claimed = { emailVerified: true };
    const result = await signIn({
      providerId: "microsoft",
      email: existingEmail,
      ...claimed,
      ...getMicrosoftUserFields(),
    });

    expect(result.error).toBe("account not linked");
    expect(result.database.account).toHaveLength(0);
  });

  // Flows that already know the user (e.g. the OAuth proxy) pick it explicitly
  // and skip the email match, so they don't depend on trusted providers.
  it("still links when the flow selects the user explicitly", async () => {
    const result = await signIn({
      providerId: "google",
      email: existingEmail,
      selectedUserId: "existing-user",
      ...getGoogleUserFields({ email: existingEmail, email_verified: true }),
    });

    expect(result.error).toBeNull();
    expect(result.database.account).toHaveLength(1);
  });
});

async function signIn({
  providerId,
  email,
  emailVerified,
  selectedUserId,
}: {
  providerId: string;
  email: string;
  emailVerified?: boolean;
  selectedUserId?: string;
}) {
  const now = new Date();
  const database: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "existing-user",
        email: existingEmail,
        name: "Dee",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-with-enough-entropy-for-linking",
    database: memoryAdapter(database),
    account: { accountLinking: ACCOUNT_LINKING },
  });
  const context = await auth.$context;

  const result = await handleOAuthUserInfo({ context } as never, {
    userInfo: {
      id: "provider-subject",
      email,
      name: "Someone",
      emailVerified: emailVerified ?? false,
    },
    account: {
      providerId,
      accountId: "provider-subject",
      accessToken: "access-token",
    },
    callbackURL: "/",
    ...(selectedUserId
      ? {
          selectedUser: {
            userId: selectedUserId,
            profile: "preserve" as const,
          },
        }
      : {}),
  });

  return { error: result.error, database };
}
