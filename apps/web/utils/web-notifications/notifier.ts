import {
  createNewMailTracker,
  newMailNotificationTag,
  senderDisplayName,
  type TrackedConversation,
} from "@/utils/web-notifications/new-mail";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";
import {
  type ImportantPerson,
  importantPeopleIndex,
} from "@inboxzero/mail-core/important-people";

const MAX_INDIVIDUAL_NOTIFICATIONS = 3;
// Mail from an important person skips the triage wait, but a burst of it
// still lands as one batch rather than a notification per message.
const IMPORTANT_BATCH_MS = 750;

export function createNewMailNotifier(deps: {
  startedAtMs: number;
  getMode: () => WebNotificationMode;
  /**
   * The reader paused notifications on this browser. Read on every check, so
   * a pause set in another tab applies to whichever tab holds the lock.
   */
  isQuiet: () => boolean;
  /** Whether this tab is the one allowed to notify when several are open. */
  isLeader: () => boolean;
  /** The reader is already looking at Cue, so a notification adds nothing. */
  isForeground: () => boolean;
  notify: (conversations: TrackedConversation[]) => void;
  /**
   * Message ids Cue's triage sorted as bulk (newsletters, marketing) for an
   * account, or null when they can't be loaded.
   */
  loadBulkMessageIds: (accountId: string) => Promise<Set<string> | null>;
  /**
   * Who the reader starred as Important in these accounts, read on this
   * device, or null when stars can't be read. While a Cue tab is open their
   * mail notifies in "important" mode whatever triage made of it; server
   * push can't see these stars.
   */
  loadImportantPeople: (
    accountIds: string[],
  ) => Promise<ImportantPerson[] | null>;
  /**
   * Thread ids the reader muted for an account, or null when they can't be
   * loaded. The server archives a muted conversation's new mail, but the tab
   * can see it in the inbox first.
   */
  loadMutedThreadIds: (accountId: string) => Promise<Set<string> | null>;
  /** Triage runs after mail arrives, so "important" waits for it. */
  triageSettleMs: number;
}) {
  const tracker = createNewMailTracker({ startedAtMs: deps.startedAtMs });
  // Accounts watched before this browser finished their first sync.
  let awaitingSync = new Set<string>();
  const pending: TrackedConversation[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let importantTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function canNotify() {
    return (
      !disposed &&
      deps.getMode() !== "off" &&
      !deps.isQuiet() &&
      deps.isLeader() &&
      !deps.isForeground()
    );
  }

  async function fromImportantPeople(conversations: TrackedConversation[]) {
    const accountIds = [...new Set(conversations.map((c) => c.accountId))];
    const people = await deps.loadImportantPeople(accountIds).catch(() => null);
    const index = importantPeopleIndex(people ?? []);
    return new Set(conversations.filter((c) => index.has(c.accountId, c.from)));
  }

  async function dropMuted(conversations: TrackedConversation[]) {
    const accountIds = [...new Set(conversations.map((c) => c.accountId))];
    const mutedByAccount = new Map(
      await Promise.all(
        accountIds.map(
          async (accountId) =>
            [accountId, await deps.loadMutedThreadIds(accountId)] as const,
        ),
      ),
    );
    return conversations.filter(
      (conversation) =>
        !mutedByAccount.get(conversation.accountId)?.has(conversation.threadId),
    );
  }

  async function dropBulk(conversations: TrackedConversation[]) {
    const accountIds = [...new Set(conversations.map((c) => c.accountId))];
    const [bulkByAccount, important] = await Promise.all([
      Promise.all(
        accountIds.map(
          async (accountId) =>
            [accountId, await deps.loadBulkMessageIds(accountId)] as const,
        ),
      ).then((entries) => new Map(entries)),
      fromImportantPeople(conversations),
    ]);
    return conversations.filter(
      (conversation) =>
        important.has(conversation) ||
        !bulkByAccount.get(conversation.accountId)?.has(conversation.id),
    );
  }

  // Mail from an important person needs no triage, so it doesn't wait for
  // it; whatever is left waits for triage as before.
  function notifyImportantSoon() {
    if (importantTimer) return;
    importantTimer = setTimeout(() => {
      importantTimer = undefined;
      fromImportantPeople([...pending])
        .then((important) => {
          const due = pending.filter((c) => important.has(c));
          if (due.length === 0) return;
          for (const conversation of due)
            pending.splice(pending.indexOf(conversation), 1);
          return dropMuted(due);
        })
        .then((unmuted) => {
          if (unmuted?.length && canNotify()) deps.notify(unmuted);
        })
        .catch(() => undefined);
    }, IMPORTANT_BATCH_MS);
  }

  return {
    /**
     * Until an account finishes its first sync its list is a stale cache or a
     * partial backfill, so its mail is ignored, and the snapshot where it
     * becomes synced only seeds it. Other accounts notify meanwhile.
     */
    handle(
      conversations: TrackedConversation[],
      unsyncedAccountIds: ReadonlySet<string> = new Set(),
    ) {
      const nowSynced = new Set(
        [...awaitingSync].filter((id) => !unsyncedAccountIds.has(id)),
      );
      awaitingSync = new Set(unsyncedAccountIds);
      const fresh = tracker
        .take(conversations.filter((c) => !unsyncedAccountIds.has(c.accountId)))
        .filter((c) => !nowSynced.has(c.accountId));
      if (fresh.length === 0 || !canNotify()) return;

      if (deps.getMode() === "all") {
        dropMuted(fresh)
          .then((unmuted) => {
            if (unmuted.length > 0 && canNotify()) deps.notify(unmuted);
          })
          .catch(() => undefined);
        return;
      }
      // One timer and one triage lookup per account for everything that
      // arrives while it waits.
      pending.push(...fresh);
      notifyImportantSoon();
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = pending.splice(0);
        if (!canNotify()) return;
        dropMuted(batch)
          .then(dropBulk)
          .then((kept) => {
            if (kept.length > 0 && canNotify()) deps.notify(kept);
          })
          .catch(() => undefined);
      }, deps.triageSettleMs);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (importantTimer) clearTimeout(importantTimer);
      timer = undefined;
      importantTimer = undefined;
      pending.length = 0;
    },
  };
}

type NotificationConstructor = new (
  title: string,
  options?: NotificationOptions,
) => Pick<Notification, "close" | "onclick">;

/** Sender and subject only; the message body never leaves the mail list. */
export function showNewMailNotifications({
  conversations,
  Notification: NotificationImpl,
  icon,
  summaryTitle,
  openThread,
  focusWindow,
}: {
  conversations: TrackedConversation[];
  Notification: NotificationConstructor;
  icon?: string;
  summaryTitle: (count: number) => string;
  openThread: (conversation: TrackedConversation) => void;
  focusWindow: () => void;
}) {
  const individual = conversations.slice(0, MAX_INDIVIDUAL_NOTIFICATIONS);
  const rest = conversations.slice(MAX_INDIVIDUAL_NOTIFICATIONS);

  for (const conversation of individual) {
    show({
      title: senderDisplayName(conversation.from),
      body: conversation.subject,
      tag: newMailNotificationTag(conversation.accountId, conversation.id),
      target: conversation,
    });
  }
  if (rest.length > 0) {
    show({
      title: summaryTitle(rest.length),
      body: [...new Set(rest.map((c) => senderDisplayName(c.from)))]
        .slice(0, 3)
        .join(", "),
      tag: `cue-mail-more-${rest[0].id}`,
      target: rest[0],
    });
  }

  function show(input: {
    title: string;
    body: string;
    tag: string;
    target: TrackedConversation;
  }) {
    const notification = new NotificationImpl(input.title, {
      body: input.body,
      tag: input.tag,
      icon,
    });
    notification.onclick = () => {
      focusWindow();
      notification.close();
      openThread(input.target);
    };
  }
}

/**
 * Elects one tab to notify. Web Locks queue waiters, so when the leader tab
 * closes the next waiting tab takes over; without the API each tab notifies
 * and the shared notification tag lets the browser collapse duplicates.
 */
export function claimNotifierLeadership({
  locks,
  onChange,
}: {
  locks: Pick<LockManager, "request"> | undefined;
  onChange: (leader: boolean) => void;
}) {
  if (!locks) {
    onChange(true);
    return () => undefined;
  }
  const abort = new AbortController();
  let release: (() => void) | undefined;
  locks
    .request(
      NOTIFIER_LOCK_NAME,
      { signal: abort.signal },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          onChange(true);
        }),
    )
    .catch(() => undefined);
  return () => {
    abort.abort();
    release?.();
  };
}

const NOTIFIER_LOCK_NAME = "cue:web-notifier";
