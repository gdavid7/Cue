import type { MailClient } from "./engine";
import type { ConversationQuery, MailPredicate } from "./queries";

/**
 * One thing an engine can do beyond the fixed protocol surface: a query
 * order, a predicate kind, or an optional `MailClient` method.
 */
export type MailEngineFeature =
  | `order:${string}`
  | `predicate:${string}`
  | `method:${string}`;

/**
 * What a connected engine reported at connect time. An engine bundled with an
 * older desktop build, or an older tab acting as owner, may reject query
 * shapes and methods this build knows, so features read this before choosing
 * a shape instead of waiting for a rejection.
 */
export type MailEngineCapabilities = readonly MailEngineFeature[];

/**
 * What engines that predate capability reporting accept. It stands in
 * whenever an engine reports nothing, so never add to it: a new order,
 * predicate or method belongs in what this build advertises instead.
 */
export const BASELINE_MAIL_ENGINE_CAPABILITIES: MailEngineCapabilities =
  Object.freeze([
    "order:newest_first",
    "predicate:all",
    "predicate:any",
    "predicate:not",
    "predicate:role",
    "predicate:mailbox",
    "predicate:read",
    "predicate:starred",
    "predicate:inbox_section",
    "predicate:membership",
    "predicate:address",
    "predicate:received",
    "predicate:has_attachment",
    "predicate:message",
    "predicate:text",
    "predicate:search",
    "predicate:account",
  ]);

// Typed against the query schema, so a new order or predicate kind fails the
// type check until it is advertised here. Kept free of the schema's runtime
// so the desktop preload can import it.
const QUERY_ORDERS = {
  newest_first: true,
  oldest_first: true,
} satisfies Record<ConversationQuery["order"], true>;

const PREDICATE_KINDS = {
  all: true,
  any: true,
  not: true,
  role: true,
  mailbox: true,
  read: true,
  starred: true,
  inbox_section: true,
  membership: true,
  address: true,
  received: true,
  has_attachment: true,
  message: true,
  conversation: true,
  text: true,
  search: true,
  account: true,
} satisfies Record<MailPredicate["kind"], true>;

const OPTIONAL_METHODS = {
  queryContactSuggestions: true,
  searchMessages: true,
  queryPersonCard: true,
  queryNeverReadSenders: true,
  queryWaitingOnYou: true,
  querySenderHistory: true,
  queryFiles: true,
  queryFileSenders: true,
  queryFilesNotOnDevice: true,
  searchSemantic: true,
  observeMailboxWindow: true,
  ensureAccount: true,
  forgetDeletedDrafts: true,
  ingestMessages: true,
  getWaitingSummary: true,
} satisfies Record<OptionalMailClientMethod, true>;

/** The orders and predicate kinds this build's query schema accepts. */
export const MAIL_QUERY_FEATURES: MailEngineCapabilities = Object.freeze([
  ...Object.keys(QUERY_ORDERS).map((order) => `order:${order}` as const),
  ...Object.keys(PREDICATE_KINDS).map((kind) => `predicate:${kind}` as const),
]);

/**
 * What an engine in this build advertises: every query shape it accepts and
 * the optional methods the given client actually answers.
 */
export function describeMailEngineCapabilities(
  client: Partial<MailClient>,
): MailEngineCapabilities {
  const methods = Object.keys(OPTIONAL_METHODS)
    .filter(
      (method) => typeof client[method as keyof MailClient] === "function",
    )
    .map((method) => `method:${method}` as const);
  return [...MAIL_QUERY_FEATURES, ...methods];
}

/**
 * Reads what an engine reported. Anything but a list, as from an engine that
 * predates reporting, means the baseline; tokens this build doesn't know are
 * kept, so a newer engine's report survives a round trip.
 */
export function parseMailEngineCapabilities(
  reported: unknown,
): MailEngineCapabilities {
  if (!Array.isArray(reported)) return BASELINE_MAIL_ENGINE_CAPABILITIES;
  return reported.filter(isMailEngineFeature);
}

/**
 * Whether a feature can use this order, predicate kind or method through the
 * client. A method also needs the client to relay it, since a relay (another
 * tab, the desktop bridge) can be narrower than the engine behind it.
 */
export function mailClientSupports(
  client: Partial<MailClient> | null | undefined,
  feature: MailEngineFeature,
) {
  if (!client) return false;
  const reported = client.capabilities ?? BASELINE_MAIL_ENGINE_CAPABILITIES;
  if (!reported.includes(feature)) return false;
  if (!feature.startsWith("method:")) return true;
  const method = feature.slice("method:".length) as keyof MailClient;
  return typeof client[method] === "function";
}

type OptionalMailClientMethod = {
  [K in keyof MailClient]-?: undefined extends MailClient[K]
    ? NonNullable<MailClient[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[Exclude<keyof MailClient, "close">];

function isMailEngineFeature(value: unknown): value is MailEngineFeature {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^(order|predicate|method):[A-Za-z0-9_]+$/.test(value)
  );
}
