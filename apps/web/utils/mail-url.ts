/**
 * The mail screen's address, Gmail style: `/mail/u/{n}/{view}[/{threadId}]`.
 *
 * `n` is the account's position among the signed-in user's accounts in the
 * order they were connected, so the address bar never carries a database id.
 * Views are readable words (`inbox`, `sent`, `label/receipts`, a split tab's
 * slug such as `needs-reply`); an open conversation adds the provider's own
 * thread id, as Gmail does.
 */

import { OTHER_SPLIT_ID } from "@/utils/split-inbox/split-query";

export const MAIL_PATH_PREFIX = "/mail/u";

/** Set by the proxy: the mail address a layout is rendering under. */
export const MAIL_PATH_HEADER = "x-cue-mail-path";

export type MailUrlView =
  | { kind: "inbox" }
  | { kind: "split"; slug: string }
  | { kind: "type"; type: string }
  | { kind: "label"; slug: string }
  | { kind: "folder"; slug: string }
  | { kind: "search"; q: string };

export type MailUrl = {
  accountIndex: number;
  /** All Inboxes: every included account's mail in one list. */
  allInboxes?: boolean;
  view?: MailUrlView;
  threadId?: string | null;
  /** All Inboxes only: the index of the account that owns the open thread. */
  threadAccountIndex?: number | null;
};

const ALL_INBOXES_SEGMENT = "all-inboxes";
const THREAD_ACCOUNT_PARAM = "account";
const SEARCH_PARAM = "q";

/** `?type=` values and the path word each one reads as. */
const TYPE_SEGMENTS: Record<string, string> = {
  draft: "drafts",
  sent: "sent",
  archive: "archive",
  starred: "starred",
  important: "important",
  snoozed: "snoozed",
  scheduled: "scheduled",
  all: "all",
  spam: "spam",
  trash: "trash",
  focused: "focused",
  other: "other",
  files: "files",
};

const CATEGORY_PREFIX = "CATEGORY_";

const STRUCTURAL_SEGMENTS = [
  "inbox",
  "search",
  "label",
  "folder",
  "category",
  "type",
  ALL_INBOXES_SEGMENT,
];

/** Words a split tab's slug may not take, since they already name a view. */
const RESERVED_SPLIT_SLUGS: ReadonlySet<string> = new Set([
  ...STRUCTURAL_SEGMENTS,
  ...Object.values(TYPE_SEGMENTS),
]);

const TYPE_BY_SEGMENT = new Map(
  Object.entries(TYPE_SEGMENTS).map(([type, segment]) => [segment, type]),
);

export function buildMailPath(url: MailUrl): string {
  const view = url.view ?? { kind: "inbox" };
  const segments = [MAIL_PATH_PREFIX, String(url.accountIndex)];
  if (url.allInboxes) segments.push(ALL_INBOXES_SEGMENT);
  segments.push(...viewSegments(view));
  if (url.threadId) segments.push(encodeURIComponent(url.threadId));

  const params = new URLSearchParams();
  if (view.kind === "search") params.set(SEARCH_PARAM, view.q);
  if (url.threadId && url.allInboxes && url.threadAccountIndex != null)
    params.set(THREAD_ACCOUNT_PARAM, String(url.threadAccountIndex));
  const query = params.toString();
  return `${segments.join("/")}${query ? `?${query}` : ""}`;
}

/**
 * Puts a mail path's own query (`q`, `account`) over the page's other query
 * parameters — analytics, conversion events — which ride along untouched.
 */
export function withPageParams(
  mailPath: string,
  pageSearch: string,
  drop: readonly string[] = [],
) {
  const [pathname, mailQuery] = mailPath.split("?");
  const params = new URLSearchParams(pageSearch);
  for (const key of [SEARCH_PARAM, THREAD_ACCOUNT_PARAM, ...drop])
    params.delete(key);
  for (const [key, value] of new URLSearchParams(mailQuery))
    params.set(key, value);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

/**
 * The same mail address after the account list changed: the page's account
 * and an All Inboxes thread's account move to their new positions. Returns
 * null outside `/mail/u/{n}`.
 */
export function reindexMailPath({
  pathname,
  search,
  accountIndex,
  previousAccountIds,
  accountIds,
  dropParams = [],
}: {
  pathname: string;
  search: string;
  accountIndex: number;
  previousAccountIds: readonly string[];
  accountIds: readonly string[];
  /** Page parameters that no longer apply, left out of the new address. */
  dropParams?: readonly string[];
}) {
  const mail = parseMailPath(pathname, search);
  if (!mail || accountIndex < 0) return null;
  const threadAccountId =
    mail.threadAccountIndex == null
      ? undefined
      : previousAccountIds[mail.threadAccountIndex];
  const threadAccountIndex = threadAccountId
    ? accountIds.indexOf(threadAccountId)
    : -1;
  // A thread whose account is gone would otherwise open as the page's.
  const threadAccountGone =
    mail.threadAccountIndex != null && threadAccountIndex < 0;
  return withPageParams(
    buildMailPath({
      ...mail,
      accountIndex,
      threadId: threadAccountGone ? null : mail.threadId,
      threadAccountIndex: threadAccountIndex >= 0 ? threadAccountIndex : null,
    }),
    search,
    dropParams,
  );
}

/**
 * Reads a mail address back. Returns null for anything outside `/mail/u/{n}`.
 * A thread id may contain `/` (Outlook's do), so whatever follows the view is
 * the thread, whether or not the router decoded `%2F`.
 */
export function parseMailPath(
  pathname: string,
  search?: URLSearchParams | string | null,
): MailUrl | null {
  const segments = pathname
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map(safeDecode);
  if (segments[0] !== "mail" || segments[1] !== "u") return null;
  const accountIndex = parseAccountIndex(segments[2]);
  if (accountIndex === null) return null;

  const params = new URLSearchParams(search ?? undefined);
  let rest = segments.slice(3);
  const allInboxes = rest[0] === ALL_INBOXES_SEGMENT;
  if (allInboxes) rest = rest.slice(1);

  const [first, second] = rest;
  let view: MailUrlView;
  let consumed = 1;
  if (!first || first === "inbox") {
    view = { kind: "inbox" };
  } else if (first === "search") {
    const q = params.get(SEARCH_PARAM)?.trim();
    view = q ? { kind: "search", q } : { kind: "inbox" };
  } else if ((first === "label" || first === "folder") && second) {
    view = { kind: first, slug: second };
    consumed = 2;
  } else if (first === "category" && second) {
    view = { kind: "type", type: `${CATEGORY_PREFIX}${second.toUpperCase()}` };
    consumed = 2;
  } else if (first === "type" && second) {
    view = { kind: "type", type: second };
    consumed = 2;
  } else if (TYPE_BY_SEGMENT.has(first)) {
    view = { kind: "type", type: TYPE_BY_SEGMENT.get(first) ?? first };
  } else {
    view = { kind: "split", slug: first };
  }

  const threadId = rest.slice(consumed).join("/") || null;
  const threadAccountIndex =
    allInboxes && threadId
      ? parseAccountIndex(params.get(THREAD_ACCOUNT_PARAM) ?? undefined)
      : null;

  return {
    accountIndex,
    ...(allInboxes ? { allInboxes } : {}),
    view,
    threadId,
    threadAccountIndex,
  };
}

export function isMailPath(pathname: string) {
  return parseMailPath(pathname) !== null;
}

export function isSameMailView(a: MailUrlView, b: MailUrlView) {
  return viewSegments(a).join("/") === viewSegments(b).join("/");
}

/**
 * The mail address for an account, by its id. Falls back to the account's
 * legacy route, which redirects here, when the id isn't in the list yet.
 */
export function mailPathForAccount(
  accountIds: readonly string[],
  accountId: string,
  url: Omit<MailUrl, "accountIndex"> = {},
): string {
  const accountIndex = accountIds.indexOf(accountId);
  if (accountIndex < 0) return accountId ? `/${accountId}/mail` : "/mail";
  return buildMailPath({ ...url, accountIndex });
}

/**
 * Turns names into unique, readable path words. Letters in any script are
 * kept (browsers show them decoded), so a Hebrew or Japanese name still reads
 * as itself. Collisions with `reserved` words take an `inbox-` prefix, and
 * repeated names a `-2`, `-3`… suffix in the order given.
 */
export function assignSlugs(
  items: readonly { id: string; name: string }[],
  { reserved, fallback }: { reserved?: ReadonlySet<string>; fallback: string },
): Map<string, string> {
  const taken = new Set<string>();
  const slugs = new Map<string, string>();
  for (const item of items) {
    let base = slugify(item.name) || fallback;
    if (reserved?.has(base)) base = `inbox-${base}`;
    let slug = base;
    for (let n = 2; taken.has(slug) || reserved?.has(slug); n++)
      slug = `${base}-${n}`;
    taken.add(slug);
    slugs.set(item.id, slug);
  }
  return slugs;
}

/**
 * Split tabs share the top level with `sent`, `drafts`…, so those words are
 * off limits. Gmail's built-in Other tab is always slugged last, so whether an
 * account shows it never shifts the other tabs' slugs.
 */
export function getSplitSlugs(splits: readonly { id: string; name: string }[]) {
  return assignSlugs(
    [
      ...splits.filter((split) => split.id !== OTHER_SPLIT_ID),
      { id: OTHER_SPLIT_ID, name: "Other" },
    ],
    { reserved: RESERVED_SPLIT_SLUGS, fallback: "tab" },
  );
}

/** Label and folder names are slugged in id order so the result is stable. */
export function getLabelSlugs(labels: readonly { id: string; name: string }[]) {
  return assignSlugs(
    [...labels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    { fallback: "label" },
  );
}

/** Finds the id behind a slug; a raw id (from an old link) also resolves. */
export function resolveSlug(
  slugs: ReadonlyMap<string, string>,
  slug: string,
): string | null {
  for (const [id, candidate] of slugs) if (candidate === slug) return id;
  return slugs.has(slug) ? slug : null;
}

function viewSegments(view: MailUrlView): string[] {
  switch (view.kind) {
    case "inbox":
      return ["inbox"];
    case "search":
      return ["search"];
    case "split":
      return [encodeURIComponent(view.slug)];
    case "label":
    case "folder":
      return [view.kind, encodeURIComponent(view.slug)];
    case "type": {
      if (view.type === "inbox") return ["inbox"];
      const segment = TYPE_SEGMENTS[view.type];
      if (segment) return [segment];
      if (view.type.startsWith(CATEGORY_PREFIX))
        return [
          "category",
          view.type.slice(CATEGORY_PREFIX.length).toLowerCase(),
        ];
      return ["type", encodeURIComponent(view.type)];
    }
  }
}

function slugify(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseAccountIndex(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null;
  return Number(value);
}

function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
