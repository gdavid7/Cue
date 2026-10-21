import { AsyncLocalStorage } from "node:async_hooks";

export type AuditActorType =
  | "anonymous"
  | "user"
  | "email_account"
  | "api_key"
  | "admin"
  | "system"
  | "pre_auth";

export type AuditContext = {
  requestId?: string;
  source?: string;
  userId?: string;
  emailAccountId?: string;
  apiKeyId?: string;
  actorType?: AuditActorType;
};

const auditContextStorage = new AsyncLocalStorage<AuditContext>();

export function getAuditContext(): AuditContext {
  return auditContextStorage.getStore() ?? {};
}

export function runWithAuditContext<T>(
  context: AuditContext,
  callback: () => T,
): T {
  const mergedContext = mergeAuditContext(getAuditContext(), context);
  return auditContextStorage.run(mergedContext, callback);
}

/**
 * Runs a read made before the request is authenticated (such as the account
 * read that starts alongside the session) in its own context, keeping only the
 * request's id and source. The request's context is filled in as auth
 * succeeds, and the audit event is attributed when the query finishes, so
 * without this the same read would be logged under no actor or the caller
 * depending on which finished first.
 */
export function runWithPreAuthAuditContext<T>(callback: () => T): T {
  const { requestId, source } = getAuditContext();
  return auditContextStorage.run(
    normalizeAuditContext({ requestId, source, actorType: "pre_auth" }),
    callback,
  );
}

export function setAuditContext(context: AuditContext) {
  const store = auditContextStorage.getStore();
  if (!store) return;

  Object.assign(store, normalizeAuditContext(context));
}

export const __testing__ = {
  mergeAuditContext,
};

function mergeAuditContext(
  current: AuditContext,
  next: AuditContext,
): AuditContext {
  return {
    ...current,
    ...normalizeAuditContext(next),
  };
}

function normalizeAuditContext(context: AuditContext): AuditContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as AuditContext;
}
