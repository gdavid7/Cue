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
  "app/api/user/last-email-account/route.ts#POST": {
    how: "looks the account up by id and userId",
    check: /where: \{ id: parsed\.data\.emailAccountId, userId \}/,
  },
  "utils/actions/feedback.ts#submitFeedbackAction": {
    how: "keeps the account only when it is the user's own",
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
  "app/api/mail-version/route.ts#GET": {
    how: "reads versions only for accounts the user owns",
    check: /readKeyForOwnedAccounts\(\{\s*userId,/,
    delegate: {
      file: "utils/redis/account-validation.ts",
      check:
        /export async function readKeyForOwnedAccounts\([\s\S]*?getOwnerKey\(\{ userId, emailAccountId \}\)[\s\S]*?confirmOwnership\(\{ userId, emailAccountId \}\)/,
    },
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
  "app/api/team-comments/conversations/route.ts#POST": {
    how: "shareConversation loads the user's own membership and requires the source account to be that membership's",
    check:
      /shareConversation\(\s*\{ userId: request\.auth\.userId, memberId \}/,
    delegate: {
      file: "utils/team-comments/conversations.ts",
      check:
        /export async function shareConversation\([\s\S]*?getOwnedMember\(actor\);\s*if \(member\.emailAccountId !== input\.source\.emailAccountId\)/,
    },
  },
  "app/api/threads/all/route.ts#GET": {
    how: "its query schema can't be read in full (threadsQuery uses imported helpers), but it only loads the user's own accounts",
    check:
      /getConnectedEmailAccounts\(\{\s*userId: request\.auth\.userId,\s*includeInAllAccounts: true,/,
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
const ROUTE_READS_BODY = /\b(?:request|req)\.json\(\)/;
const SCHEMA_PARSE_CALL =
  /(?:\b(\w+)|\))\s*\.(?:safeParse|parse|safeParseAsync|parseAsync)\(/g;
const ACCOUNT_PATH_SEGMENT = /\[\w*[aA]ccountId\]/;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// Imports whose names are never schemas that could hold an account id.
const NON_SCHEMA_MODULES = /^(?:zod|zod\/.*|@\/generated\/prisma.*)$/;
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

describe("schema reading", () => {
  const modules = fakeModules({
    "schemas.ts": {
      schemas: {
        sourceSchema: "z.object({ emailAccountId: id })",
        plainSchema: "z.object({ name: z.string() })",
        refinedSchema:
          "z.object({ name: z.string() }).refine((value) => isAllowed(value))",
      },
      imports: { isAllowed: { module: "helpers.ts", name: "isAllowed" } },
    },
    "route.ts": {
      imports: {
        sourceSchema: { module: "schemas.ts", name: "sourceSchema" },
        plainSchema: { module: "schemas.ts", name: "plainSchema" },
        refinedSchema: { module: "schemas.ts", name: "refinedSchema" },
        externalSchema: { module: null, name: "externalSchema" },
        renamedSchema: { module: "schemas.ts", name: "sourceSchema" },
      },
    },
    "helpers.ts": {},
  });
  const route = modules.load("route.ts");

  it("follows named schemas, by module, to an account id at any depth", () => {
    expect(
      inputSchemaText(
        ".inputSchema(z.object({ source: renamedSchema })).action(",
        route,
        modules.load,
      ),
    ).toMatch(SCHEMA_ACCOUNT_KEY);
  });

  it("calls a schema unreadable when any imported part isn't a known schema", () => {
    expect(
      inputSchemaText(
        ".inputSchema(externalSchema).action(",
        route,
        modules.load,
      ),
    ).toBeNull();
    expect(
      inputSchemaText(
        ".inputSchema(refinedSchema).action(",
        route,
        modules.load,
      ),
    ).toBeNull();
  });

  it("counts a route that parses a schema holding an account id, body or query", () => {
    expect(
      routeTakesAccountId(
        "const body = sourceSchema.parse(await request.json());",
        route,
        modules.load,
      ),
    ).toBe(true);
    expect(
      routeTakesAccountId(
        "const query = sourceSchema.parse(Object.fromEntries(url.searchParams));",
        route,
        modules.load,
      ),
    ).toBe(true);
  });

  it("counts a route that reads its body without a schema it can read", () => {
    expect(
      routeTakesAccountId(
        "const body = await request.json(); use(body.thing);",
        route,
        modules.load,
      ),
    ).toBe(true);
    expect(
      routeTakesAccountId(
        "const body = externalSchema.parse(await request.json());",
        route,
        modules.load,
      ),
    ).toBe(true);
  });

  it("leaves a route alone whose body schema has no account id", () => {
    expect(
      routeTakesAccountId(
        "const body = plainSchema.parse(await request.json());",
        route,
        modules.load,
      ),
    ).toBe(false);
  });
});

/** A module's schemas and imports, so names resolve where they are defined. */
type ModuleInfo = {
  file: string;
  schemas: Map<string, string>;
  /** Imported name → its module (null for a package) and exported name. */
  imports: Map<string, { module: string | null; name: string }>;
};
type LoadModule = (file: string) => ModuleInfo;

function findUserLevelHandlers() {
  const handlers: { key: string; source: string; takesAccountId: boolean }[] =
    [];
  const load = createModuleLoader();

  for (const file of listFiles(path.join(WEB_ROOT, "utils/actions"))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("actionClientUser")) continue;
    const module = load(file);
    for (const declaration of topLevelDeclarations(source)) {
      if (!/=\s*actionClientUser\b/.test(declaration.source)) continue;
      const schema = inputSchemaText(declaration.source, module, load);
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
    const module = load(file);
    for (const declaration of declarations) {
      if (!HTTP_METHODS.includes(declaration.name)) continue;
      if (!/=\s*withAuth\(/.test(declaration.source)) continue;
      const reached = withLocalDependencies(declaration, declarations);
      handlers.push({
        key: `${relative(file)}#${declaration.name}`,
        source: reached,
        takesAccountId:
          ACCOUNT_PATH_SEGMENT.test(relative(file)) ||
          routeTakesAccountId(reached, module, load),
      });
    }
  }

  return handlers;
}

function routeTakesAccountId(
  handler: string,
  module: ModuleInfo,
  load: LoadModule,
) {
  if (ROUTE_ACCOUNT_INPUT.test(handler)) return true;
  const parseCalls = [...handler.matchAll(SCHEMA_PARSE_CALL)].filter(
    (match) => match[1] !== "JSON",
  );
  // Any named schema the handler parses with, whatever it parses: body,
  // query or path. Schemas written inline are in the handler, read above.
  const parsedWith = parseCalls.flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
  const parsesAccountId = parsedWith.some((name) => {
    if (!module.schemas.has(name) && !module.imports.has(name)) return false;
    const text = expandText(name, module, load, new Set());
    return text === null || SCHEMA_ACCOUNT_KEY.test(text);
  });
  if (parsesAccountId) return true;
  // A body read without a schema may hold anything.
  return ROUTE_READS_BODY.test(handler) && !parseCalls.length;
}

/** The schema an action validates, with the named schemas it is built from. */
function inputSchemaText(action: string, module: ModuleInfo, load: LoadModule) {
  const start = action.indexOf(".inputSchema(");
  if (start < 0) return "";
  const end = action.indexOf(".action(", start);
  const expression = action.slice(
    start + ".inputSchema(".length,
    end < 0 ? undefined : end,
  );
  return expandText(expression, module, load, new Set());
}

/**
 * Replaces each named schema with its definition, looked up in the module
 * that defines it. Returns null when a part is imported from anything but a
 * known schema, since it may hold anything.
 */
function expandText(
  text: string,
  module: ModuleInfo,
  load: LoadModule,
  seen: Set<string>,
): string | null {
  let unreadable = false;
  const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const expandIn = (target: ModuleInfo, name: string) => {
    const key = `${target.file}#${name}`;
    if (seen.has(key)) return name;
    seen.add(key);
    const inner = expandText(
      target.schemas.get(name) ?? "",
      target,
      load,
      seen,
    );
    if (inner === null) unreadable = true;
    return inner ?? name;
  };
  const expanded = code.replace(/\b\w+\b/g, (word) => {
    if (module.schemas.has(word)) return expandIn(module, word);
    const imported = module.imports.get(word);
    if (!imported) return word;
    const target = imported.module === null ? null : load(imported.module);
    if (target?.schemas.has(imported.name))
      return expandIn(target, imported.name);
    unreadable = true;
    return word;
  });
  return unreadable ? null : expanded;
}

// `z.…`, or a schema derived from another (`commentInput.omit(…)`).
const SCHEMA_DECLARATION =
  /^[^=]*=\s*(?:z\s*\.|\w+\s*\.(?:omit|pick|extend|merge|partial|required|and|or|array|optional|nullable|refine|superRefine|transform)\()/;

function createModuleLoader(): LoadModule {
  const modules = new Map<string, ModuleInfo>();
  const empty = (file: string): ModuleInfo => ({
    file,
    schemas: new Map(),
    imports: new Map(),
  });
  const load: LoadModule = (file) => {
    const cached = modules.get(file);
    if (cached) return cached;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      const missing = empty(file);
      modules.set(file, missing);
      return missing;
    }
    const module = empty(file);
    modules.set(file, module);
    for (const declaration of topLevelDeclarations(source)) {
      if (SCHEMA_DECLARATION.test(declaration.source))
        module.schemas.set(declaration.name, declaration.source);
    }
    for (const [local, imported] of importsOf(source, file))
      module.imports.set(local, imported);
    return module;
  };
  return load;
}

/** Each imported name, resolved to the file it comes from. */
function importsOf(source: string, file: string) {
  const imports = new Map<string, { module: string | null; name: string }>();
  for (const match of source.matchAll(
    /import\s+(type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+["']([^"']+)["']/g,
  )) {
    const [, typeOnly, defaultName, named, specifier] = match;
    // Zod and Prisma's generated enums are never schemas holding an id.
    if (typeOnly || NON_SCHEMA_MODULES.test(specifier)) continue;
    const module = resolveModule(specifier, file);
    if (defaultName) imports.set(defaultName, { module, name: "default" });
    for (const part of named?.split(",") ?? []) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const [name, local = name] = trimmed.split(/\s+as\s+/);
      imports.set(local, { module, name });
    }
  }
  return imports;
}

/** The file an import names, or null for a package. */
function resolveModule(specifier: string, fromFile: string) {
  const base = specifier.startsWith("@/")
    ? path.join(WEB_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** Modules for the tests above, by file name. */
function fakeModules(
  files: Record<
    string,
    {
      schemas?: Record<string, string>;
      imports?: Record<string, { module: string | null; name: string }>;
    }
  >,
) {
  const load: LoadModule = (file) => ({
    file,
    schemas: new Map(Object.entries(files[file]?.schemas ?? {})),
    imports: new Map(Object.entries(files[file]?.imports ?? {})),
  });
  return { load };
}

type Declaration = { name: string; source: string };

function topLevelDeclarations(source: string): Declaration[] {
  return source
    .split(
      /\n(?=(?:export )?(?:async )?(?:function|const|let|class|type|interface) )/,
    )
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
