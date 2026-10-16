import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * User-level handlers (`actionClientUser` actions and `withAuth` routes) are
 * not bound to an account by middleware, so an account id they take comes
 * straight from the caller. Each must check that the account belongs to the
 * signed-in user. A new handler that takes an account id fails here until its
 * check is recorded below, and the recorded check must appear in its code (or,
 * for a check made by a helper it calls, in that helper's file).
 */
type OwnershipCheck = {
  how: string;
  check: RegExp;
  delegate?: { file: string; check: RegExp };
};

const OWNERSHIP_CHECKS: Record<string, OwnershipCheck> = {
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
  "utils/actions/team-comments.ts#shareConversationAction": {
    how: "shareConversation loads the user's own membership and requires the source account to be that membership's",
    check:
      /shareConversation\(\s*\{ userId, memberId: parsedInput\.memberId \}/,
    delegate: {
      file: "utils/team-comments/conversations.ts",
      check:
        /export async function shareConversation\([\s\S]*?getOwnedMember\(actor\);\s*if \(member\.emailAccountId !== input\.source\.emailAccountId\)/,
    },
  },
  "utils/actions/user.ts#deleteEmailAccountAction": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId \}/,
  },
  "app/api/email-send-operations/[mutationId]/route.ts#GET": {
    how: "compares the operation's account owner with the user",
    check: /emailAccount\.account\.userId !== request\.auth\.userId/,
  },
  "app/api/email-stream/route.ts#GET": {
    how: "validates the account against the user",
    check: /getEmailAccount\(\{ userId, emailAccountId \}\)/,
  },
  "app/api/mail-stream/route.ts#GET": {
    how: "validates the account against the user",
    check:
      /getEmailAccount\(\{ userId: request\.auth\.userId, emailAccountId \}\)/,
  },
  "app/api/user/meeting-recorder/meetings/[meetingId]/draft/route.ts#GET": {
    how: "validates the account against the user",
    check:
      /getEmailAccount\(\{\s*userId: request\.auth\.userId,\s*emailAccountId,/,
  },
  "app/api/messages/attachment/route.ts#GET": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId: request\.auth\.userId \}/,
  },
  "app/api/messages/raw/route.ts#GET": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: emailAccountId, userId: request\.auth\.userId \}/,
  },
  "app/api/google/linking/auth-url/route.ts#GET": {
    how: "finds the reconnect target among the user's accounts",
    check:
      /findReconnectTarget\(\{\s*emailAccountId: reconnectEmailAccountId,\s*userId,/,
  },
  "app/api/outlook/linking/auth-url/route.ts#GET": {
    how: "finds the reconnect target among the user's accounts",
    check:
      /findReconnectTarget\(\{\s*emailAccountId: reconnectEmailAccountId,\s*userId,/,
  },
  "app/api/mobile/all-inboxes/archive/route.ts#POST": {
    how: "loads only accounts with the user's id",
    check: /id: \{ in: accountIds \},\s*userId: request\.auth\.userId/,
  },
  "app/api/mobile/all-inboxes/route.ts#GET": {
    how: "loads the account filtered by userId",
    check:
      /getConnectedEmailAccounts\(\{\s*userId: request\.auth\.userId,\s*accountId,/,
  },
  "app/api/mobile/otps/route.ts#GET": {
    how: "loads the account filtered by userId",
    check: /\{ id: accountId \} : \{\}\),\s*userId: request\.auth\.userId/,
  },
  "app/api/team-comments/conversations/route.ts#GET": {
    how: "the share lookup requires the user's own member for that account",
    check: /getShareForSource\(actor, \{\s*emailAccountId: sourceAccountId,/,
    delegate: {
      file: "utils/team-comments/conversations.ts",
      check:
        /export async function getShareForSource\([\s\S]*?getOwnedMember\(actor\);\s*if \(member\.emailAccountId !== source\.emailAccountId\)/,
    },
  },
  "app/api/user/email-accounts/[emailAccountId]/route.ts#DELETE": {
    how: "delegates to deleteEmailAccountAction, checked above",
    check: /deleteEmailAccountAction\(\{ emailAccountId \}\)/,
  },
};

const ACCOUNT_ID = String.raw`\w*[aA]ccountIds?\b`;
// An action reads an account id when it destructures or reads one from
// `parsedInput`, or when its input schema has one at any depth.
const PARSED_INPUT_ACCOUNT = new RegExp(
  String.raw`parsedInput\s*:\s*\{[^}]*${ACCOUNT_ID}|parsedInput\.${ACCOUNT_ID}`,
);
const SCHEMA_ACCOUNT_KEY = new RegExp(String.raw`${ACCOUNT_ID}\s*:`);
// Passed on whole, any field of the input may reach the code it is given to.
const PARSED_INPUT_PASSED_WHOLE =
  /parsedInput\s*\}\s*\)\s*=>[\s\S]*\bparsedInput\b(?!\s*\.)/;
// A route reads one from its query, the account header, a path segment or
// a parsed field.
const ROUTE_ACCOUNT_INPUT = new RegExp(
  [
    String.raw`\.get\(\s*["']${ACCOUNT_ID}["']`,
    "EMAIL_ACCOUNT_HEADER",
    String.raw`${ACCOUNT_ID}\s*:\s*z\.`,
  ].join("|"),
);
const ACCOUNT_PATH_SEGMENT = /\[\w*[aA]ccountId\]/;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
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
    if (entry.delegate) {
      expect(
        readFileSync(path.join(WEB_ROOT, entry.delegate.file), "utf8"),
      ).toMatch(entry.delegate.check);
    }
  });
});

function findUserLevelHandlers() {
  const handlers: { key: string; source: string; takesAccountId: boolean }[] =
    [];
  const actionFiles = listFiles(path.join(WEB_ROOT, "utils/actions")).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const schemas = new Map<string, string>();
  for (const file of actionFiles) {
    for (const declaration of topLevelDeclarations(
      readFileSync(file, "utf8"),
    )) {
      if (/=\s*z\./.test(declaration.source))
        schemas.set(declaration.name, declaration.source);
    }
  }

  for (const file of actionFiles) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("actionClientUser")) continue;
    for (const declaration of topLevelDeclarations(source)) {
      if (!/=\s*actionClientUser\b/.test(declaration.source)) continue;
      const schema = inputSchemaText(declaration.source, schemas);
      handlers.push({
        key: `${relative(file)}#${declaration.name}`,
        source: declaration.source,
        takesAccountId:
          PARSED_INPUT_ACCOUNT.test(declaration.source) ||
          (schema !== null && SCHEMA_ACCOUNT_KEY.test(schema)) ||
          // A schema this test cannot read is assumed to hold one.
          (schema === null &&
            PARSED_INPUT_PASSED_WHOLE.test(declaration.source)),
      });
    }
  }

  for (const file of listFiles(path.join(WEB_ROOT, "app/api"))) {
    if (path.basename(file) !== "route.ts") continue;
    const source = readFileSync(file, "utf8");
    const declarations = topLevelDeclarations(source);
    for (const declaration of declarations) {
      if (!HTTP_METHODS.includes(declaration.name)) continue;
      if (!/=\s*withAuth\(/.test(declaration.source)) continue;
      const reached = withLocalDependencies(declaration, declarations);
      handlers.push({
        key: `${relative(file)}#${declaration.name}`,
        source: reached,
        takesAccountId:
          ROUTE_ACCOUNT_INPUT.test(reached) ||
          ACCOUNT_PATH_SEGMENT.test(relative(file)),
      });
    }
  }

  return handlers;
}

/** The schema an action validates, with the named schemas it is built from. */
function inputSchemaText(action: string, schemas: Map<string, string>) {
  const start = action.indexOf(".inputSchema(");
  if (start < 0) return "";
  const end = action.indexOf(".action(", start);
  const expression = action.slice(
    start + ".inputSchema(".length,
    end < 0 ? undefined : end,
  );
  const named = /^\s*(\w+)\s*\)\s*$/.exec(expression)?.[1];
  if (named && !schemas.has(named)) return null;
  const seen = new Set<string>();
  const expand = (text: string): string =>
    text.replace(/\b\w+\b/g, (word) => {
      const schema = schemas.get(word);
      if (!schema || seen.has(word)) return word;
      seen.add(word);
      return expand(schema);
    });
  return expand(expression);
}

type Declaration = { name: string; source: string };

function topLevelDeclarations(source: string): Declaration[] {
  return source
    .split(/\n(?=(?:export )?(?:async )?(?:function|const|let|class) )/)
    .flatMap((part) => {
      const name =
        /^(?:export )?(?:async )?(?:function|const|let|class) (\w+)/.exec(
          part,
        )?.[1];
      return name ? [{ name, source: part }] : [];
    });
}

/** A handler's code plus the file's own helpers it calls, transitively. */
function withLocalDependencies(
  handler: Declaration,
  declarations: Declaration[],
) {
  const byName = new Map(declarations.map((item) => [item.name, item]));
  const reached = new Set([handler.name]);
  const queue = [handler];
  while (queue.length) {
    const current = queue.pop();
    if (!current) break;
    for (const word of current.source.match(/\b\w+\b/g) ?? []) {
      const dependency = byName.get(word);
      if (!dependency || reached.has(word) || HTTP_METHODS.includes(word))
        continue;
      reached.add(word);
      queue.push(dependency);
    }
  }
  return [...reached].map((name) => byName.get(name)?.source).join("\n");
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
