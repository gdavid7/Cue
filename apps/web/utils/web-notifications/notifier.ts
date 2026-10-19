import {
  createNewMailTracker,
  newMailNotificationTag,
  senderDisplayName,
  type TrackedConversation,
} from "@/utils/web-notifications/new-mail";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

export function createNewMailNotifier(deps: {
  startedAtMs: number;
  getMode: () => WebNotificationMode;
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
  /** Triage runs after mail arrives, so "important" waits for it. */
  triageSettleMs: number;
}) {
  const tracker = createNewMailTracker({ startedAtMs: deps.startedAtMs });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  function canNotify() {
    return (
      !disposed &&
      deps.getMode() !== "off" &&
      deps.isLeader() &&
      !deps.isForeground()
    );
  }

  async function dropBulk(conversations: TrackedConversation[]) {
    const accountIds = [...new Set(conversations.map((c) => c.accountId))];
    const bulkByAccount = new Map(
      await Promise.all(
        accountIds.map(
          async (accountId) =>
            [accountId, await deps.loadBulkMessageIds(accountId)] as const,
        ),
      ),
    );
    return conversations.filter(
      (conversation) =>
        !bulkByAccount.get(conversation.accountId)?.has(conversation.id),
    );
  }

  return {
    handle(conversations: TrackedConversation[]) {
      const fresh = tracker.take(conversations);
      if (fresh.length === 0 || !canNotify()) return;

      if (deps.getMode() === "all") {
        deps.notify(fresh);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!canNotify()) return;
        dropBulk(fresh)
          .then((important) => {
            if (important.length > 0 && canNotify()) deps.notify(important);
          })
          .catch(() => undefined);
      }, deps.triageSettleMs);
      timers.add(timer);
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
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
