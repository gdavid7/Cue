import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * User-level handlers (`actionClientUser` actions and `withAuth` routes) are
 * not bound to an account by middleware, so an account id they take comes
 * straight from the caller. Each must check that the account belongs to the
 * signed-in user. A new handler that takes an account id fails here until its
 * check is recorded below, and the recorded check must appear in its code.
 */
const OWNERSHIP_CHECKS: Record<string, { check: RegExp; how: string }> = {
  "utils/actions/all-accounts.ts#updateAllAccountsSelectionAction": {
    how: "rejects ids outside the user's accounts",
    check: /where: \{ userId \}[\s\S]*ownedAccountIds\.has\(id\)/,
  },
  "utils/actions/email-account-cookie.ts#setLastEmailAccountAction": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId \}/,
  },
  "utils/actions/rule.ts#copyRulesFromAccountAction": {
    how: "compares both accounts' owner with the user",
    check:
      /sourceAccount\.account\.userId !== userId[\s\S]*targetAccount\.account\.userId !== userId/,
  },
  "utils/actions/user.ts#deleteEmailAccountAction": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId \}/,
  },
  "app/api/email-send-operations/[mutationId]/route.ts": {
    how: "compares the operation's account owner with the user",
    check: /emailAccount\.account\.userId !== request\.auth\.userId/,
  },
  "app/api/email-stream/route.ts": {
    how: "validates the account against the user",
    check: /getEmailAccount\(\{ userId, emailAccountId \}\)/,
  },
  "app/api/mail-stream/route.ts": {
    how: "validates the account against the user",
    check:
      /getEmailAccount\(\{ userId: request\.auth\.userId, emailAccountId \}\)/,
  },
  "app/api/user/meeting-recorder/meetings/[meetingId]/draft/route.ts": {
    how: "validates the account against the user",
    check:
      /getEmailAccount\(\{\s*userId: request\.auth\.userId,\s*emailAccountId,/,
  },
  "app/api/messages/attachment/route.ts": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId: request\.auth\.userId \}/,
  },
  "app/api/messages/raw/route.ts": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId: request\.auth\.userId \}/,
  },
  "app/api/google/linking/auth-url/route.ts": {
    how: "finds the reconnect target among the user's accounts",
    check:
      /findReconnectTarget\(\{\s*emailAccountId: reconnectEmailAccountId,\s*userId,/,
  },
  "app/api/outlook/linking/auth-url/route.ts": {
    how: "finds the reconnect target among the user's accounts",
    check:
      /findReconnectTarget\(\{\s*emailAccountId: reconnectEmailAccountId,\s*userId,/,
  },
  "app/api/mobile/all-inboxes/archive/route.ts": {
    how: "loads only accounts with the user's id",
    check: /id: \{ in: accountIds \},\s*userId: request\.auth\.userId/,
  },
  "app/api/mobile/all-inboxes/route.ts": {
    how: "loads the account filtered by userId",
    check:
      /getConnectedEmailAccounts\(\{\s*userId: request\.auth\.userId,\s*accountId,/,
  },
  "app/api/mobile/otps/route.ts": {
    how: "loads the account filtered by userId",
    check: /\{ id: accountId \} : \{\}\),\s*userId: request\.auth\.userId/,
  },
  "app/api/team-comments/conversations/route.ts": {
    how: "the share lookup requires the user's own member for that account",
    check: /getShareForSource\(actor, \{\s*emailAccountId: sourceAccountId,/,
  },
  "app/api/user/email-accounts/[emailAccountId]/route.ts": {
    how: "delegates to deleteEmailAccountAction, checked above",
    check: /deleteEmailAccountAction\(\{ emailAccountId \}\)/,
  },
};

const ACCOUNT_ID = String.raw`\w*[aA]ccountIds?\b`;
// An action's input is what it destructures or reads from `parsedInput`.
const ACTION_ACCOUNT_INPUT = new RegExp(
  String.raw`parsedInput\s*:\s*\{[^}]*${ACCOUNT_ID}|parsedInput\.${ACCOUNT_ID}`,
);
// A route's input is its query, the account header, a path segment or a
// parsed field.
const ROUTE_ACCOUNT_INPUT = new RegExp(
  [
    String.raw`\.get\(\s*["']${ACCOUNT_ID}["']`,
    "EMAIL_ACCOUNT_HEADER",
    String.raw`${ACCOUNT_ID}\s*:\s*z\.`,
  ].join("|"),
);
const ACCOUNT_PATH_SEGMENT = /\[\w*[aA]ccountId\]/;
const WEB_ROOT = path.resolve(import.meta.dirname, "..");

describe("user-level handlers that take an account id", () => {
  const handlers = findUserLevelHandlers().filter(
    (handler) => handler.takesAccountId,
  );

  it("are all reviewed for an ownership check", () => {
    expect(handlers.map((handler) => handler.key).sort()).toEqual(
      Object.keys(OWNERSHIP_CHECKS).sort(),
    );
  });

  it.each(
    handlers.map((handler) => [handler.key, handler.source] as const),
  )("%s checks the account belongs to the user", (key, source) => {
    const entry = OWNERSHIP_CHECKS[key];
    expect(entry, `${key} has no recorded ownership check`).toBeDefined();
    expect(source).toMatch(entry.check);
  });
});

function findUserLevelHandlers() {
  const handlers: { key: string; source: string; takesAccountId: boolean }[] =
    [];

  for (const file of listFiles(path.join(WEB_ROOT, "utils/actions"))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("actionClientUser")) continue;
    // Each exported action runs to the next export.
    for (const part of source.split(/\n(?=export (?:const|async function) )/)) {
      const match = /^export const (\w+) = actionClientUser\b/.exec(part);
      if (!match) continue;
      handlers.push({
        key: `${relative(file)}#${match[1]}`,
        source: part,
        takesAccountId: ACTION_ACCOUNT_INPUT.test(part),
      });
    }
  }

  for (const file of listFiles(path.join(WEB_ROOT, "app/api"))) {
    if (path.basename(file) !== "route.ts") continue;
    const source = readFileSync(file, "utf8");
    if (!/\bwithAuth\(/.test(source)) continue;
    handlers.push({
      key: relative(file),
      source,
      takesAccountId:
        ROUTE_ACCOUNT_INPUT.test(source) ||
        ACCOUNT_PATH_SEGMENT.test(relative(file)),
    });
  }

  return handlers;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function relative(file: string) {
  return path.relative(WEB_ROOT, file).split(path.sep).join("/");
}
