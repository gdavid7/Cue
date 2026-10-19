import type {
  Admission,
  SubmitConversationCommand,
  SubmitMetadataCommand,
} from "./commands";
import type {
  DraftReadResult,
  DraftSaveResult,
  SaveDraft,
  SubmitSend,
} from "./drafts";
import type {
  ConversationKey,
  DraftKey,
  LocalRevision,
  MessageKey,
  OperationKey,
} from "./identities";
import type { OperationState } from "./operations";
import {
  MAX_CHANGES_BATCH_READS,
  type MailboxSource,
  type SyncReadResult,
} from "./ports/mailbox-source";
import type {
  AccountSyncState,
  MailStore,
  SyncStreamPosition,
} from "./ports/mail-store";
import type {
  ExecutionResult,
  OperationExecutor,
} from "./ports/operation-executor";
import type { AssistantStateSource } from "./ports/assistant-source";
import type { ScopeDescriptor } from "./ports/mailbox-source";
import type { HostRuntime } from "./ports/runtime";
import { webCryptoSha256 } from "./canonical";
import { extractTextPredicates } from "./query-semantics";
import type {
  ContactSuggestion,
  ContactSuggestionQuery,
  ConversationQuery,
  MailPredicate,
  MailboxCountsQuery,
  MailboxCountsView,
  MailboxView,
  MessageSearchPage,
  MessageSearchQuery,
  QueryHandle,
} from "./queries";
import {
  createQueryRegistry,
  mailboxCountsQueryKey,
  mailboxQueryKey,
} from "./subscriptions";
import type { SyncPage } from "./sync";
import type { ClaimedWork, ConversationView } from "./ports/mail-store";

const MAX_BOOTSTRAP_PAGES_PER_RUN = 25;
const NON_ADVANCING_BOOTSTRAP_RETRY_MS = 60_000;
const IDLE_CATCH_UP_INTERVAL_MS = 60_000;
// A lane is abandoned after this long, so a request that never settles
// cannot keep its account from syncing again.
const SYNC_LANE_TIMEOUT_MS = 2 * 60_000;
// How long one bootstrap call may keep paging before the lane moves on to the
// account's other streams; the scan resumes on the lane's next pass.
const SYNC_LANE_BOOTSTRAP_SLICE_MS = 2000;
const SYNC_LANE_RETRY_MIN_MS = 1000;
const SYNC_LANE_RETRY_MAX_MS = 60_000;
// Folder discovery and low-priority streams (such as custom Outlook folders)
// change rarely and cost a provider call each, so they run on a slower clock.
const LOW_PRIORITY_CATCH_UP_INTERVAL_MS = 10 * 60_000;
// A sync request (a provider push, the tab coming back) refreshes them only
// when they have not run recently, so a burst of pushes stays cheap.
const LOW_PRIORITY_REQUESTED_MIN_INTERVAL_MS = 2 * 60_000;
const MAX_MAILBOX_WINDOW_PAGES = 40;
const COMMAND_REQUEST_RETRY_MIN_MS = 1000;
const COMMAND_REQUEST_RETRY_MAX_MS = 30_000;
const SEARCH_PAGE_SIZE = 50;
// A provider search page costs Gmail about 1000 of its 6000 units a minute,
// so one view's demand for rows never fetches more than this many pages.
const MAX_SEARCH_PAGES_PER_DEMAND = 2;
// Each conversation fill is an interactive provider read; anything past this
// waits its turn instead of crowding out sync and commands.
const MAX_CONVERSATION_FETCHES = 2;
const CONVERSATION_FETCH_RETRY_MS = 60_000;
// Past this a fill gives up, so the reader's loading row can't stay forever.
const CONVERSATION_FETCH_TIMEOUT_MS = 30_000;

export type WorkAdmission =
  | { status: "scheduled" | "already_satisfied" }
  | { status: "rejected"; code: "invalid_account" | "storage_unavailable" };

export type MailDiagnostics = {
  accountId: string;
  revision: LocalRevision;
  connection: "ready" | "offline" | "blocked_auth";
  coverage: import("./queries").Coverage[];
  pendingOperations: number;
  uncertainOperations: number;
  pendingJobs: number;
  oldestPendingAtMs: number | null;
  commands: Array<{
    operationId: string;
    status: OperationState["status"];
    kind: string;
    changeKind: string | null;
    change: Record<string, unknown> | null;
    messageIds: string[];
    conversationIds: string[];
  }>;
};

export type ConversationCompletion = { status: "complete" | "unavailable" };

export type MailboxWindowHandle = QueryHandle<MailboxView> & {
  loadMore(): Promise<void>;
};

export type MailboxWindowOptions = {
  pageCount?: number;
};

export type MailClient = {
  queryContactSuggestions?(
    query: ContactSuggestionQuery,
  ): Promise<ContactSuggestion[]>;
  /**
   * Reads matching messages once from the local store, without asking the
   * provider. Hosts that can't answer off the UI thread leave it out.
   */
  searchMessages?(query: MessageSearchQuery): Promise<MessageSearchPage>;
  observeMailbox(query: ConversationQuery): QueryHandle<MailboxView>;
  observeMailboxCounts(
    query: MailboxCountsQuery,
  ): QueryHandle<MailboxCountsView>;
  observeMailboxWindow?(
    query: ConversationQuery,
    options?: MailboxWindowOptions,
  ): MailboxWindowHandle;
  observeConversation(
    key: ConversationKey,
    page: { after: string | null; pageSize: number },
  ): QueryHandle<ConversationView>;
  observeOperation(key: OperationKey): QueryHandle<OperationState>;
  submitMetadata(input: SubmitMetadataCommand): Promise<Admission>;
  submitConversations(input: SubmitConversationCommand): Promise<Admission>;
  saveDraft(input: SaveDraft): Promise<DraftSaveResult>;
  readDraft(key: DraftKey): Promise<DraftReadResult>;
  submitSend(input: SubmitSend): Promise<Admission>;
  cancelOperation(
    key: OperationKey,
  ): Promise<
    | { status: "cancelled"; revision: LocalRevision }
    | { status: "too_late" | "not_found" | "unavailable" }
  >;
  requestSync(accountIds: string[]): Promise<WorkAdmission>;
  /**
   * Registers an account with the local store so its sync lane starts. Hosts
   * that register accounts themselves (desktop, on requestSync) omit it.
   */
  ensureAccount?(input: {
    accountId: string;
    provider: "google" | "microsoft";
  }): Promise<void>;
  ensureMessageContent(key: MessageKey): Promise<WorkAdmission>;
  /**
   * Makes sure the store holds every message of a conversation someone opened.
   * Until sync has covered the whole mailbox, some of its older messages may
   * not be local yet, so this asks the provider for its membership once and
   * merges it. Resolves once the conversation is complete locally, or with
   * `unavailable` when the provider couldn't answer; a later call tries again.
   */
  ensureConversationMessages(
    key: ConversationKey,
  ): Promise<ConversationCompletion>;
  /**
   * Says one caller of `ensureConversationMessages` no longer waits, as when
   * the reader moves on. A fill still queued that nobody waits for is dropped.
   */
  releaseConversationMessages(key: ConversationKey): Promise<void>;
  getDiagnostics(accountId: string): Promise<MailDiagnostics>;
  purgeAccount(accountId: string): Promise<LocalRevision>;
  /** Purges every local account outside `accountIds`; an empty list is ignored. */
  retainAccounts(accountIds: string[]): Promise<void>;
  close?(): Promise<void>;
};

export type MailEngine = MailClient & {
  runUntil(deadlineMs: number, signal?: AbortSignal): Promise<void>;
  inspect(): Promise<import("./ports/mail-store").MailStoreInspection>;
  close(): Promise<void>;
};

export function createMailEngine(input: {
  store: MailStore;
  source: MailboxSource;
  executor: OperationExecutor;
  runtime: HostRuntime;
  ownerId?: string;
  assistant?: AssistantStateSource;
  idleCatchUpIntervalMs?: number;
  /**
   * How often an account's change streams and assistant state are read with
   * nobody asking. Hosts that hear about provider changes some other way
   * (a push stream, a version poll) and call `requestSync` can stretch it;
   * retries of failed or blocked work keep `idleCatchUpIntervalMs`.
   */
  changesCatchUpIntervalMs?: number;
  syncLaneTimeoutMs?: number;
  conversationFetchTimeoutMs?: number;
  /** Committed incremental changes only; bootstrap and backfill never emit. */
  onSyncPageCommitted?: (page: SyncPage) => void;
}): MailEngine {
  const { store, source, executor, runtime } = input;
  const idleCatchUpIntervalMs =
    input.idleCatchUpIntervalMs ?? IDLE_CATCH_UP_INTERVAL_MS;
  const changesCatchUpIntervalMs =
    input.changesCatchUpIntervalMs ?? idleCatchUpIntervalMs;
  const syncLaneTimeoutMs = input.syncLaneTimeoutMs ?? SYNC_LANE_TIMEOUT_MS;
  const conversationFetchTimeoutMs =
    input.conversationFetchTimeoutMs ?? CONVERSATION_FETCH_TIMEOUT_MS;
  const ownerId = input.ownerId ?? "local-owner";
  const assistant = input.assistant;
  const queries = createQueryRegistry();
  let evictedForCurrentPressure = false;
  // Keyed by operation, so one command stuck on a failing request does not
  // slow the retry of every other command.
  const commandRequestFailures = new Map<string, number>();
  const idleCatchUpGates = new Map<string, IdleCatchUpGate>();
  const syncLanes = new Map<string, SyncLane>();
  const syncLaneRetries = new Map<
    string,
    { retryAtMs: number; delayMs: number }
  >();
  const syncLaneErrors: unknown[] = [];
  let closed = false;
  let refreshGate: Promise<void> | null = null;
  let refreshQueued = false;
  // Provider search runs only for views open in this engine, and only as far
  // as they need rows; a page left in the store by an earlier session or a
  // closed view is dropped instead of walking the whole result set.
  const providerSearches = new Map<string, ProviderSearch>();
  // Keyed by account and conversation, so concurrent opens share one read.
  // Completion itself is stored, and resets with the account.
  const conversationFetches = new Map<string, ConversationFetchEntry>();
  // When a conversation whose read failed may be asked for again; a
  // conversation the provider doesn't have never is.
  const conversationFetchRetryAt = new Map<string, number>();
  const conversationFetchAborts = new Map<string, AbortController>();
  const preparationWatchers = new Map<string, Set<() => void>>();
  let runningConversationFetches = 0;
  // Served newest first: the conversation open now matters more than ones
  // the reader passed on its way to it.
  const queuedConversationFetches: Array<{
    id: string;
    start: () => void;
    drop: () => void;
  }> = [];

  async function refreshViews() {
    refreshQueued = true;
    if (refreshGate) return refreshGate;
    refreshGate = drainRefreshes().finally(() => {
      refreshGate = null;
    });
    return refreshGate;
  }

  async function drainRefreshes() {
    while (refreshQueued) {
      refreshQueued = false;
      await queries.refreshAll();
    }
  }

  return {
    queryContactSuggestions(query) {
      return store.readContactSuggestions(query);
    },
    searchMessages(query) {
      return store.readMessageSearch(query);
    },
    observeMailbox(query) {
      const searches = watchProviderSearches(query, query.pageSize);
      const handle = queries.observe(mailboxQueryKey(query), () =>
        store.readMailboxView(query).then((result) => ({
          revision: result.revision,
          data: result.view,
        })),
      );
      return {
        ...handle,
        close() {
          searches.release();
          handle.close();
        },
      };
    },
    observeMailboxCounts(query) {
      return queries.observe(mailboxCountsQueryKey(query), () =>
        store.readMailboxCounts(query).then((result) => ({
          revision: result.revision,
          data: result.view,
        })),
      );
    },
    observeMailboxWindow(query, options) {
      let pageCount = normalizePageCount(options?.pageCount);
      const searches = watchProviderSearches(query, pageCount * query.pageSize);
      const key = `mailbox-pages:${runtime.randomId()}`;
      const handle = queries.observe(key, () =>
        store.readMailboxWindow(query, pageCount).then((result) => ({
          revision: {
            databaseEpoch: `${result.revision.databaseEpoch}:pages:${pageCount}`,
            sequence: result.revision.sequence,
          },
          data: result.view,
        })),
      );
      return {
        ...handle,
        async loadMore() {
          pageCount += 1;
          searches.want(pageCount * query.pageSize);
          await queries.refreshKey(key);
        },
        close() {
          searches.release();
          handle.close();
        },
      };
    },
    observeConversation(key, page) {
      return queries.observe(
        `conversation:${key.accountId}:${key.conversationId}:${page.after ?? ""}:${page.pageSize}`,
        () =>
          store.readConversation(key, page).then((result) => ({
            revision: result.revision,
            data: result.view,
          })),
      );
    },
    observeOperation(key) {
      return queries.observe(
        `operation:${key.accountId}:${key.operationId}`,
        async () => {
          const result = await store.readOperation(key);
          return {
            revision: result.revision,
            data: result.operation ?? {
              key,
              status: "failed",
              authority: "backend",
              attempts: 0,
              nextAttemptAtMs: null,
              error: { code: "not_found", retryable: false },
            },
          };
        },
      );
    },
    async submitMetadata(command) {
      const admission = await store.admitMetadata(command);
      await refreshViews();
      return admission;
    },
    async submitConversations(command) {
      const admission = await store.admitConversations(command);
      await refreshViews();
      return admission;
    },
    saveDraft(inputDraft) {
      return store.saveDraft(inputDraft);
    },
    readDraft(key) {
      return store.readDraft(key);
    },
    async submitSend(send) {
      const admission = await store.admitSend(send);
      await refreshViews();
      return admission;
    },
    async cancelOperation(key) {
      const local = await store.cancelOperation(key);
      if (local.status !== "too_late") {
        await refreshViews();
        return local;
      }
      const held = await store.readHeldSend(key);
      if (!held || !executor.cancel) return local;
      const remote = await executor.cancel({
        operation: held,
        signal: new AbortController().signal,
      });
      if (remote.status !== "cancelled") return { status: remote.status };
      const result = await store.cancelHeldSend(key);
      await refreshViews();
      return result;
    },
    async requestSync(accountIds) {
      if (accountIds.length === 0) {
        return { status: "rejected", code: "invalid_account" };
      }
      for (const accountId of accountIds) {
        const gate = idleCatchUpGates.get(accountId);
        if (gate) requestCatchUp(gate);
      }
      await store.releaseDeferredOperations({
        accountIds,
        nowMs: runtime.nowMs(),
      });
      return { status: "scheduled" };
    },
    async ensureMessageContent(key) {
      await store.enqueueHydration({ keys: [key], purpose: "body" });
      return { status: "scheduled" };
    },
    ensureConversationMessages(key) {
      if (closed) return Promise.resolve({ status: "unavailable" });
      const id = conversationFetchKey(key);
      const inFlight = conversationFetches.get(id);
      if (inFlight) {
        inFlight.waiters += 1;
        return inFlight.promise;
      }
      if ((conversationFetchRetryAt.get(id) ?? 0) > runtime.nowMs()) {
        return Promise.resolve({ status: "unavailable" });
      }
      const entry: ConversationFetchEntry = {
        waiters: 1,
        promise: Promise.resolve({ status: "unavailable" }),
      };
      conversationFetches.set(id, entry);
      entry.promise = fetchConversationMessages(key)
        .catch(
          (): ConversationFetch => ({
            status: "unavailable",
            retryAfterMs: CONVERSATION_FETCH_RETRY_MS,
          }),
        )
        .then((result): ConversationCompletion => {
          if (result.status === "complete") {
            conversationFetchRetryAt.delete(id);
            return result;
          }
          if (result.retryAfterMs > 0) {
            conversationFetchRetryAt.set(
              id,
              runtime.nowMs() + result.retryAfterMs,
            );
          }
          return { status: "unavailable" };
        })
        .finally(() => conversationFetches.delete(id));
      return entry.promise;
    },
    async releaseConversationMessages(key) {
      const id = conversationFetchKey(key);
      const entry = conversationFetches.get(id);
      if (!entry) return;
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters > 0) return;
      const index = queuedConversationFetches.findIndex(
        (queued) => queued.id === id,
      );
      if (index >= 0) queuedConversationFetches.splice(index, 1)[0]?.drop();
    },
    getDiagnostics(accountId) {
      return store.getDiagnostics(accountId);
    },
    async purgeAccount(accountId) {
      stopSyncLane(accountId);
      idleCatchUpGates.delete(accountId);
      stopConversationFetches(accountId);
      const revision = await store.purgeAccount(accountId);
      await refreshViews();
      return revision;
    },
    async retainAccounts(accountIds) {
      // An empty list is never a real account set, so it must not wipe the device.
      if (accountIds.length === 0) return;
      const retained = new Set(accountIds);
      const accounts = await store.readAccountSyncStates();
      let purged = false;
      for (const account of accounts) {
        if (retained.has(account.accountId)) continue;
        stopSyncLane(account.accountId);
        idleCatchUpGates.delete(account.accountId);
        stopConversationFetches(account.accountId);
        await store.purgeAccount(account.accountId);
        purged = true;
      }
      if (purged) await refreshViews();
    },
    inspect() {
      return store.inspect();
    },
    async runUntil(deadlineMs, signal) {
      if (signal?.aborted || runtime.nowMs() >= deadlineMs) return;
      const pressure = await runtime.storagePressure();
      if (!pressure) {
        evictedForCurrentPressure = false;
      } else if (!evictedForCurrentPressure) {
        const { evictedBodies } = await store.evictReplaceableContent();
        evictedForCurrentPressure = true;
        if (evictedBodies > 0) await refreshViews();
      }
      while (runtime.nowMs() < deadlineMs) {
        await yieldToHost();
        if (signal?.aborted || runtime.nowMs() >= deadlineMs) return;
        const work = await store.claimWork({
          ownerId,
          nowMs: runtime.nowMs(),
          leaseMs: 30_000,
        });
        if (!work) {
          await startSyncLanes();
          if (signal?.aborted || runtime.nowMs() >= deadlineMs) return;
          // Batches stay short and claimable work is checked between them,
          // so a large backlog never delays commands or sync.
          const contacts = await store.indexContactBacklog();
          const { remaining } = await store.indexSearchBacklog();
          if (contacts.remaining || remaining) continue;
          await waitForSyncLanes(deadlineMs, signal);
          return;
        }
        if (work.kind === "command") {
          const result = await retryOnRequestFailure(work.operation, () =>
            executor.execute({
              operation: work.operation,
              attemptId: work.attemptId,
              signal: signal ?? new AbortController().signal,
            }),
          );
          await store.settleAttempt({
            attemptId: work.attemptId,
            operation: work.operation,
            result,
          });
          await refreshViews();
          continue;
        }
        if (work.kind === "inspect") {
          const result = await retryOnRequestFailure(work.operation, () =>
            executor.inspect({
              operation: work.operation,
              receiptId: work.receiptId,
              signal: signal ?? new AbortController().signal,
            }),
          );
          await store.settleAttempt({
            attemptId: work.attemptId,
            operation: work.operation,
            result,
          });
          await refreshViews();
          continue;
        }
        if (work.kind === "prepare") {
          try {
            await prepareConversation(work, signal);
          } finally {
            notifyPreparationWatchers(conversationFetchKey(work.conversation));
          }
          continue;
        }
        if (work.kind === "hydrate") {
          if (!work.keys[0]) {
            await store.completeJob({
              jobId: work.jobId,
              attemptId: work.attemptId,
            });
            continue;
          }
          const hydrated = await source.hydrate({
            session: work.session,
            requestId: work.jobId,
            signal: signal ?? new AbortController().signal,
            keys: work.keys,
            purpose: work.purpose,
          });
          if (hydrated.status === "ok") {
            // A message the provider no longer has was deleted after the
            // last sync that saw it; keeping it leaves a row that never loads.
            const gone = hydrated.value.unresolved
              .filter((item) => item.reason === "not_found")
              .map((item) => ({
                kind: "message_deleted" as const,
                key: item.key,
                evidence: `hydrate_not_found:${work.jobId}`.slice(0, 1024),
              }));
            await store.applyHydration({
              session: work.session,
              requestId: work.jobId,
              attemptId: work.attemptId,
              changes: [...hydrated.value.changes, ...gone],
              bodies: hydrated.value.bodies,
            });
            await refreshViews();
            await store.completeJob({
              jobId: work.jobId,
              attemptId: work.attemptId,
            });
          } else {
            await store.deferJob({
              jobId: work.jobId,
              attemptId: work.attemptId,
              retryAtMs: retryAtFor(hydrated),
            });
          }
          continue;
        }
        if (work.kind === "search") {
          const search = providerSearches.get(
            providerSearchKey(work.accountId, work.predicate),
          );
          if (!search?.requestedPages.has(work.page)) {
            await store.completeJob({
              jobId: work.jobId,
              attemptId: work.attemptId,
            });
            continue;
          }
          const searched = await source.search({
            session: work.session,
            requestId: work.jobId,
            signal: signal ?? new AbortController().signal,
            predicate: work.predicate,
            page: work.page,
            pageSize: SEARCH_PAGE_SIZE,
          });
          if (
            searched.status === "paused" ||
            searched.status === "blocked_auth"
          ) {
            await store.deferJob({
              jobId: work.jobId,
              attemptId: work.attemptId,
              retryAtMs: retryAtFor(searched),
            });
            continue;
          }
          if (searched.status === "ok") {
            const { matches, changes = [], bodies = [] } = searched.value;
            if (changes.length > 0 || bodies.length > 0) {
              await store.applyHydration({
                session: work.session,
                requestId: work.jobId,
                changes,
                bodies,
              });
            }
            const fetched = new Set(bodies.map((body) => body.key.messageId));
            const unfetched = matches.filter(
              (match) => !fetched.has(match.messageId),
            );
            if (unfetched.length > 0) {
              await store.enqueueHydration({
                keys: unfetched,
                purpose: "body",
              });
            }
            search.matched += matches.length;
            search.nextPage = searched.value.nextPage;
            requestNextSearchPage(search);
            await refreshViews();
          }
          await store.completeJob({
            jobId: work.jobId,
            attemptId: work.attemptId,
          });
          continue;
        }
        const changes = await source.readChanges({
          session: work.session,
          requestId: work.jobId,
          position: work.position,
          pageSize: 50,
          signal: signal ?? new AbortController().signal,
        });
        if (changes.status === "page") {
          const applied = await store.applySyncPage({
            page: changes.page,
            ownerId,
            bodies: changes.page.bodies,
          });
          if (applied.status === "committed") {
            await refreshViews();
            await noteConnection(work.session.accountId, "ok");
            notifySyncPageCommitted(changes.page);
          }
        } else if (changes.status === "reset_required") {
          await ingestBootstrap({
            session: work.session,
            from: work.position,
            deadlineMs,
            signal,
            requestId: `${work.jobId}-reset`,
            scopeId: changes.scopeId,
          });
        } else {
          await noteConnection(work.session.accountId, changes);
        }
      }
    },
    async close() {
      closed = true;
      for (const queued of queuedConversationFetches.splice(0)) queued.drop();
      stopConversationFetches(null);
      const lanes = [...syncLanes.values()].map((lane) => lane.done);
      for (const laneKey of [...syncLanes.keys()]) stopSyncLane(laneKey);
      await Promise.allSettled(lanes);
      queries.closeAll();
      await store.close();
    },
  };

  async function prepareConversation(
    work: Extract<ClaimedWork, { kind: "prepare" }>,
    signal?: AbortSignal,
  ) {
    // A fill already reading this conversation resolves this command's
    // membership too, so one open makes one provider read.
    if (conversationFetchAborts.has(conversationFetchKey(work.conversation))) {
      await store.deferPreparation({
        accountId: work.accountId,
        commandId: work.commandId,
        attemptId: work.attemptId,
        nextAttemptAtMs: runtime.nowMs() + 1000,
      });
      return;
    }
    const membership = await source.readConversationMembership({
      session: work.session,
      requestId: work.resolutionId,
      signal: signal ?? new AbortController().signal,
      conversation: work.conversation,
      resolutionId: work.resolutionId,
      page: work.page,
      pageSize: 100,
    });
    if (membership.status !== "ok") {
      await store.deferPreparation({
        accountId: work.accountId,
        commandId: work.commandId,
        attemptId: work.attemptId,
        nextAttemptAtMs:
          membership.status === "paused"
            ? runtime.nowMs() + membership.retryAfterMs
            : runtime.nowMs() + 60_000,
      });
      await noteConnection(work.accountId, membership);
      return;
    }
    if (membership.value.status === "not_found") {
      await store.failPreparation({
        accountId: work.accountId,
        commandId: work.commandId,
        attemptId: work.attemptId,
        session: work.session,
        code: "conversation_not_found",
      });
      await refreshViews();
      return;
    }
    if (
      membership.value.status === "unsupported" ||
      membership.value.status === "restart_required"
    ) {
      if (membership.value.status === "unsupported") {
        await store.failPreparation({
          accountId: work.accountId,
          commandId: work.commandId,
          attemptId: work.attemptId,
          session: work.session,
          code: "membership_unsupported",
        });
        await refreshViews();
      } else {
        await store.deferPreparation({
          accountId: work.accountId,
          commandId: work.commandId,
          attemptId: work.attemptId,
          nextAttemptAtMs: runtime.nowMs() + 1000,
        });
      }
      return;
    }
    if (membership.value.status === "page") {
      const prepared = await store.applyPreparationPage({
        accountId: work.accountId,
        commandId: work.commandId,
        attemptId: work.attemptId,
        session: work.session,
        previousPage: work.page,
        page: membership.value.page,
      });
      if (prepared.status !== "stale" && !membership.value.page.nextPage) {
        await store.finishPreparation({
          accountId: work.accountId,
          commandId: work.commandId,
        });
      }
    }
    await refreshViews();
  }

  async function fetchConversationMessages(
    key: ConversationKey,
  ): Promise<ConversationFetch> {
    const id = conversationFetchKey(key);
    // Watching starts before the read, so a preparation landing in between
    // still wakes this fill.
    const preparation = watchPreparation(id);
    let state = await store.readConversationMembershipState(
      key,
      runtime.nowMs(),
    );
    if (state === "preparing") {
      await preparation.settled;
      state = await store.readConversationMembershipState(key, runtime.nowMs());
      // The command's own read was put off; it fills the conversation when
      // it runs, and the reader stops waiting meanwhile.
      if (state === "preparing") {
        return { status: "unavailable", retryAfterMs: 0 };
      }
    } else {
      preparation.cancel();
    }
    if (state === "complete") return { status: "complete" };
    return inConversationFetchSlot(id, async () => {
      // A command may have read the conversation while this waited its turn.
      const current = await store.readConversationMembershipState(
        key,
        runtime.nowMs(),
      );
      if (current === "complete") return { status: "complete" };
      if (current === "preparing") {
        return { status: "unavailable", retryAfterMs: 0 };
      }
      return readConversationMembers(key);
    });
  }

  // One provider read (Gmail's threads.get) per page of up to 100 messages.
  // Its patches pass the same version check as hydration, so an older copy
  // never overwrites what a sync page committed in the meantime.
  async function readConversationMembers(
    key: ConversationKey,
  ): Promise<ConversationFetch> {
    const id = conversationFetchKey(key);
    const abort = new AbortController();
    conversationFetchAborts.set(id, abort);
    const timeout = setTimeout(() => abort.abort(), conversationFetchTimeoutMs);
    try {
      return await readConversationMemberPages(key, abort.signal);
    } finally {
      clearTimeout(timeout);
      if (conversationFetchAborts.get(id) === abort) {
        conversationFetchAborts.delete(id);
      }
    }
  }

  async function readConversationMemberPages(
    key: ConversationKey,
    signal: AbortSignal,
  ): Promise<ConversationFetch> {
    const account = (await store.readAccountSyncStates()).find(
      (candidate) => candidate.accountId === key.accountId,
    );
    if (!account) {
      return {
        status: "unavailable",
        retryAfterMs: CONVERSATION_FETCH_RETRY_MS,
      };
    }
    const session = {
      accountId: account.accountId,
      generation: account.generation,
    };
    const resolutionId = runtime.randomId();
    let page: string | null = null;
    do {
      const membership: Awaited<
        ReturnType<MailboxSource["readConversationMembership"]>
      > = await untilAborted(
        source.readConversationMembership({
          session,
          requestId: runtime.randomId(),
          signal,
          conversation: key,
          resolutionId,
          page,
          pageSize: 100,
        }),
        signal,
      );
      if (membership.status !== "ok") {
        await noteConnection(key.accountId, membership);
        return {
          status: "unavailable",
          retryAfterMs:
            membership.status === "paused"
              ? membership.retryAfterMs
              : CONVERSATION_FETCH_RETRY_MS,
        };
      }
      if (membership.value.status === "not_found") {
        return {
          status: "unavailable",
          retryAfterMs: Number.POSITIVE_INFINITY,
        };
      }
      if (membership.value.status !== "page") {
        return {
          status: "unavailable",
          retryAfterMs: CONVERSATION_FETCH_RETRY_MS,
        };
      }
      const applied = await store.applyConversationMembership({
        session,
        page: membership.value.page,
      });
      // The account was reset or removed while the provider answered.
      if (applied.status === "stale") {
        return { status: "unavailable", retryAfterMs: 0 };
      }
      await refreshViews();
      page = membership.value.page.nextPage;
    } while (page);
    return { status: "complete" };
  }

  // Resolves when the command preparing a conversation next settles a read,
  // or when the fill would have given up anyway.
  function watchPreparation(id: string) {
    let done: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    const timeout = setTimeout(() => finish(), conversationFetchTimeoutMs);
    const watchers = preparationWatchers.get(id) ?? new Set<() => void>();
    preparationWatchers.set(id, watchers);
    function finish() {
      clearTimeout(timeout);
      watchers.delete(finish);
      if (watchers.size === 0 && preparationWatchers.get(id) === watchers) {
        preparationWatchers.delete(id);
      }
      done();
    }
    watchers.add(finish);
    return { settled, cancel: finish };
  }

  function notifyPreparationWatchers(id: string) {
    for (const finish of [...(preparationWatchers.get(id) ?? [])]) finish();
  }

  // An account added back after a purge starts over, without waiting out
  // the backoff its earlier fills earned.
  function stopConversationFetches(accountId: string | null) {
    const prefix =
      accountId === null
        ? ""
        : conversationFetchKey({ accountId, conversationId: "" });
    for (const [id, abort] of conversationFetchAborts) {
      if (id.startsWith(prefix)) abort.abort();
    }
    for (const id of conversationFetchRetryAt.keys()) {
      if (id.startsWith(prefix)) conversationFetchRetryAt.delete(id);
    }
    for (const id of [...preparationWatchers.keys()]) {
      if (id.startsWith(prefix)) notifyPreparationWatchers(id);
    }
  }

  async function inConversationFetchSlot(
    id: string,
    run: () => Promise<ConversationFetch>,
  ): Promise<ConversationFetch> {
    const dropped = { status: "unavailable" as const, retryAfterMs: 0 };
    if (closed || (conversationFetches.get(id)?.waiters ?? 0) === 0) {
      return dropped;
    }
    if (runningConversationFetches < MAX_CONVERSATION_FETCHES) {
      runningConversationFetches += 1;
    } else {
      // A finishing fetch hands its slot straight to the next in line.
      const started = await new Promise<boolean>((resolve) =>
        queuedConversationFetches.push({
          id,
          start: () => resolve(true),
          drop: () => resolve(false),
        }),
      );
      if (!started) return dropped;
    }
    try {
      return await run();
    } finally {
      const next = queuedConversationFetches.pop();
      if (next) next.start();
      else runningConversationFetches -= 1;
    }
  }

  function watchProviderSearches(query: ConversationQuery, wantedRows: number) {
    const observer = Symbol("mailbox-view");
    const watched: ProviderSearch[] = [];
    for (const accountId of query.accountIds) {
      for (const predicate of extractTextPredicates(query.predicate)) {
        const key = providerSearchKey(accountId, predicate);
        let search = providerSearches.get(key);
        if (!search) {
          search = {
            key,
            accountId,
            predicate,
            requestedPages: new Set([null]),
            nextPage: null,
            matched: 0,
            pagesSinceDemand: 1,
            wantedRows: new Map(),
          };
          providerSearches.set(key, search);
          store
            .enqueueSearch({ accountId, predicate, page: null })
            .catch(() => undefined);
        }
        search.wantedRows.set(observer, wantedRows);
        watched.push(search);
      }
    }
    return {
      want(rows: number) {
        for (const search of watched) {
          search.wantedRows.set(observer, rows);
          search.pagesSinceDemand = 0;
          requestNextSearchPage(search);
        }
      },
      release() {
        for (const search of watched) {
          search.wantedRows.delete(observer);
          if (
            search.wantedRows.size === 0 &&
            providerSearches.get(search.key) === search
          ) {
            providerSearches.delete(search.key);
          }
        }
      },
    };
  }

  // The next provider page is fetched only while an open view still has
  // fewer rows than it shows, never to walk the whole result set.
  function requestNextSearchPage(search: ProviderSearch) {
    const page = search.nextPage;
    if (!page || search.pagesSinceDemand >= MAX_SEARCH_PAGES_PER_DEMAND) return;
    const wantedRows = Math.max(0, ...search.wantedRows.values());
    if (search.matched >= wantedRows) return;
    search.nextPage = null;
    search.pagesSinceDemand += 1;
    search.requestedPages.add(page);
    store
      .enqueueSearch({
        accountId: search.accountId,
        predicate: search.predicate,
        page,
      })
      .catch(() => undefined);
  }

  // A request that fails mid-flight (the network dropped) may or may not have
  // reached the server. It is settled as not dispatched, which sends the same
  // operation id again soon, backing off while this command's requests keep
  // failing, instead of waiting out the claim lease. That resend is safe
  // because commands are idempotent by operation id; settling it as
  // uncertain would instead wait on an inspect with no receipt to look up.
  async function retryOnRequestFailure(
    operation: { key: { accountId: string; operationId: string } },
    run: () => Promise<ExecutionResult>,
  ): Promise<ExecutionResult> {
    const key = `${operation.key.accountId}\u0000${operation.key.operationId}`;
    try {
      const result = await run();
      commandRequestFailures.delete(key);
      return result;
    } catch {
      const failures = (commandRequestFailures.get(key) ?? 0) + 1;
      commandRequestFailures.set(key, failures);
      return {
        status: "not_dispatched",
        reason: "unavailable",
        retryAfterMs: Math.min(
          COMMAND_REQUEST_RETRY_MIN_MS * 2 ** (failures - 1),
          COMMAND_REQUEST_RETRY_MAX_MS,
        ),
      };
    }
  }

  function retryAtFor(
    result:
      | { status: "paused"; retryAfterMs: number }
      | { status: "blocked_auth" },
  ) {
    return (
      runtime.nowMs() +
      (result.status === "paused" ? result.retryAfterMs : idleCatchUpIntervalMs)
    );
  }

  async function ingestBootstrap(input: {
    session: { accountId: string; generation: string };
    from: {
      streamId: string;
      generation: string;
      checkpoint: string | null;
    };
    deadlineMs: number;
    signal?: AbortSignal;
    requestId: string;
    scopeId?: string;
    scope?: ScopeDescriptor;
  }) {
    const scopeId = input.scopeId ?? "primary";
    let scan = await store.readBootstrapScan({
      session: input.session,
      scopeId,
    });
    if (!scan) {
      const bootstrap = await source.beginBootstrap({
        session: input.session,
        requestId: input.requestId,
        signal: input.signal ?? new AbortController().signal,
        scope:
          input.scope ??
          (await resolveScope(input.session, scopeId, input.signal)),
        afterMs: null,
        initial: input.from.checkpoint === null,
        // The store keeps the window a finished scan reports.
        windowedBackfill: true,
      });
      if (bootstrap.status !== "ok") {
        await noteConnection(input.session.accountId, bootstrap);
        return;
      }
      const started = await store.startBootstrapScan({
        session: input.session,
        scopeId,
        bootstrapId: bootstrap.value.bootstrapId,
        page: bootstrap.value.enumerationToken,
        from: input.from,
        catchUpFrom: bootstrap.value.catchUpFrom,
        nowMs: runtime.nowMs(),
      });
      if (started.status === "stale") return;
      await noteConnection(input.session.accountId, "ok");
      scan = {
        accountId: input.session.accountId,
        scopeId,
        bootstrapId: bootstrap.value.bootstrapId,
        page: bootstrap.value.enumerationToken,
        from: input.from,
        catchUpFrom: bootstrap.value.catchUpFrom,
        nextAttemptAtMs: null,
        errorCode: null,
      };
    }
    const nowMs = runtime.nowMs();
    if (scan.nextAttemptAtMs !== null && scan.nextAttemptAtMs > nowMs) {
      return;
    }
    let processedPages = 0;
    while (scan.page) {
      if (processedPages > 0) await yieldToHost();
      if (input.signal?.aborted) return;
      if (processedPages > 0 && runtime.nowMs() >= input.deadlineMs) return;
      if (processedPages >= MAX_BOOTSTRAP_PAGES_PER_RUN) return;
      const enumerated = await source.enumerate({
        session: input.session,
        requestId: `${input.requestId}-enum-${processedPages + 1}`,
        signal: input.signal ?? new AbortController().signal,
        bootstrapId: scan.bootstrapId,
        page: scan.page,
        pageSize: 50,
      });
      if (
        enumerated.status === "paused" ||
        enumerated.status === "blocked_auth"
      ) {
        const paused = enumerated.status === "paused";
        await store.deferBootstrapScan({
          session: input.session,
          scopeId: scan.scopeId,
          bootstrapId: scan.bootstrapId,
          page: scan.page,
          nextAttemptAtMs:
            runtime.nowMs() +
            (paused ? enumerated.retryAfterMs : idleCatchUpIntervalMs),
          errorCode: paused ? enumerated.reason : "blocked_auth",
        });
      }
      if (enumerated.status !== "ok") {
        await noteConnection(input.session.accountId, enumerated);
        break;
      }
      const catchUpFrom: SyncStreamPosition | null =
        enumerated.value.catchUpFrom ?? scan.catchUpFrom;
      const repeatedCursor = enumerated.value.nextPage === scan.page;
      const applied = await store.applyBootstrapPage({
        session: input.session,
        scopeId: enumerated.value.scopeId,
        bootstrapId: scan.bootstrapId,
        previousPage: scan.page,
        nextPage: enumerated.value.nextPage,
        from: scan.from,
        catchUpFrom,
        requestId: `${input.requestId}-enum-${processedPages + 1}`,
        changes: enumerated.value.changes,
        requiredHydration: enumerated.value.requiredHydration,
        bodies: enumerated.value.bodies,
        ownerId,
        ...(enumerated.value.nextPage === null &&
          enumerated.value.windowStartMs !== undefined && {
            windowStartMs: enumerated.value.windowStartMs,
          }),
      });
      if (applied.status === "stale") break;
      processedPages += 1;
      // A first sync shows each page as it lands rather than after the whole
      // slice, so a new mailbox fills in from its first page of mail.
      refreshViews().catch(() => undefined);
      if (repeatedCursor) {
        await store.deferBootstrapScan({
          session: input.session,
          scopeId: enumerated.value.scopeId,
          bootstrapId: scan.bootstrapId,
          page: scan.page,
          nextAttemptAtMs: runtime.nowMs() + NON_ADVANCING_BOOTSTRAP_RETRY_MS,
          errorCode: "non_advancing_cursor",
        });
        await noteConnection(input.session.accountId, "paused");
        break;
      }
      scan = {
        ...scan,
        scopeId: enumerated.value.scopeId,
        page: enumerated.value.nextPage,
        catchUpFrom,
        nextAttemptAtMs: null,
        errorCode: null,
      };
    }
    await refreshViews();
  }

  // Each account syncs in its own lane, so a slow account or a slow request
  // never holds up another account or the command loop. A lane outlives the
  // runUntil call that started it; later calls skip accounts already running.
  async function startSyncLanes() {
    const accounts = await store.readAccountSyncStates();
    for (const account of accounts) {
      startLane(account.accountId, (signal) => catchUpAccount(account, signal));
    }
  }

  // A low-priority scope's backfill pages wait behind everything else for
  // quota, so one page can take tens of seconds. It runs in a lane of its own
  // so the account's lane stays free to read new mail the moment it is asked.
  function startBackfill(input: {
    session: { accountId: string; generation: string };
    idleGate: IdleCatchUpGate;
    stream: AccountSyncState["streams"][number];
  }) {
    const { session, idleGate, stream } = input;
    startLane(backfillLaneKey(session.accountId), async (signal) => {
      await ingestBootstrap({
        session,
        from: stream,
        deadlineMs: runtime.nowMs() + SYNC_LANE_BOOTSTRAP_SLICE_MS,
        signal,
        requestId: runtime.randomId(),
        scopeId: stream.streamId,
        scope: idleGate.activeBootstrapScopes.get(stream.streamId),
      });
      if (signal.aborted) return;
      await rememberBootstrapContinuation(idleGate, session, stream.streamId);
    });
  }

  function startLane(laneKey: string, run: (signal: AbortSignal) => unknown) {
    if (closed || syncLanes.has(laneKey)) return;
    const retry = syncLaneRetries.get(laneKey);
    if (retry && retry.retryAtMs > runtime.nowMs()) return;
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, syncLaneTimeoutMs);
    // The lane settles on abort even if a request ignores the signal.
    const aborted = new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const lane: SyncLane = {
      abort,
      done: Promise.race([run(abort.signal), aborted])
        .then(() => {
          if (timedOut) {
            failSyncLane(laneKey, new Error("Mail sync lane timed out"));
          } else {
            syncLaneRetries.delete(laneKey);
          }
        })
        .catch((error: unknown) => {
          // A purge or close stopped the lane on purpose.
          if (abort.signal.aborted && !timedOut) return;
          failSyncLane(laneKey, error);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (syncLanes.get(laneKey) === lane) syncLanes.delete(laneKey);
        }),
    };
    syncLanes.set(laneKey, lane);
  }

  function failSyncLane(laneKey: string, error: unknown) {
    const delayMs = Math.min(
      SYNC_LANE_RETRY_MAX_MS,
      (syncLaneRetries.get(laneKey)?.delayMs ?? 0) * 2 ||
        SYNC_LANE_RETRY_MIN_MS,
    );
    syncLaneRetries.set(laneKey, {
      retryAtMs: runtime.nowMs() + delayMs,
      delayMs,
    });
    syncLaneErrors.push(error);
  }

  // Stopping an account's lane also stops its backfill.
  function stopSyncLane(laneKey: string) {
    for (const key of [laneKey, backfillLaneKey(laneKey)]) {
      syncLanes.get(key)?.abort.abort();
      syncLanes.delete(key);
      syncLaneRetries.delete(key);
    }
  }

  async function waitForSyncLanes(deadlineMs: number, signal?: AbortSignal) {
    if (syncLanes.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        Promise.allSettled([...syncLanes.values()].map((lane) => lane.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(
            resolve,
            Math.max(0, deadlineMs - runtime.nowMs()),
          );
          onAbort = resolve;
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    // Reports lane failures to the host loop. Each failing account already
    // backs off on its own, so this is for visibility, not retry pacing.
    const errors = syncLaneErrors.splice(0);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Mail sync lanes failed");
    }
  }

  async function catchUpAccount(
    account: AccountSyncState,
    signal: AbortSignal,
  ) {
    let visitedStreams = 0;
    const session = {
      accountId: account.accountId,
      generation: account.generation,
    };
    const idleGate = idleCatchUpGateFor(account.accountId, account.generation);
    const shouldDiscoverScopes =
      idleGateDue(
        idleGate.nextScopeDiscoveryAtMs,
        runtime.nowMs(),
        LOW_PRIORITY_CATCH_UP_INTERVAL_MS,
      ) ||
      requestedSince(
        idleGate,
        idleGate.scopesDiscoveredAt,
        LOW_PRIORITY_REQUESTED_MIN_INTERVAL_MS,
      );
    if (shouldDiscoverScopes) {
      idleGate.scopesDiscoveredAt = checkStamp(idleGate);
    }
    const discoveredScopes = shouldDiscoverScopes
      ? await discoverBootstrapScopes(session, signal)
      : undefined;
    if (shouldDiscoverScopes) {
      // A failed discovery retries on the normal clock; an account with no
      // streams cannot start syncing until it succeeds.
      idleGate.nextScopeDiscoveryAtMs =
        runtime.nowMs() +
        (discoveredScopes
          ? LOW_PRIORITY_CATCH_UP_INTERVAL_MS
          : idleCatchUpIntervalMs);
    }
    if (discoveredScopes) {
      idleGate.lowPriorityStreams = new Set(
        discoveredScopes
          .filter((scope) => scope.priority === "low")
          .map((scope) => scope.id),
      );
    }
    if (discoveredScopes) {
      const addedScopes = await store.registerSyncScopes({
        session,
        scopeIds: discoveredScopes.map((scope) => scope.id),
      });
      if (addedScopes) await refreshViews();
    }
    const streamsById = new Map(
      account.streams.map((stream) => [stream.streamId, stream]),
    );
    for (const scope of discoveredScopes ?? []) {
      if (!streamsById.has(scope.id)) {
        idleGate.activeBootstrapScopes.set(scope.id, scope);
        streamsById.set(scope.id, {
          accountId: account.accountId,
          streamId: scope.id,
          generation: account.generation,
          checkpoint: null,
        });
      }
    }
    if (!shouldDiscoverScopes) {
      for (const scopeId of idleGate.activeBootstrapScopes.keys()) {
        if (!streamsById.has(scopeId)) {
          streamsById.set(scopeId, {
            accountId: account.accountId,
            streamId: scopeId,
            generation: account.generation,
            checkpoint: null,
          });
        }
      }
    }
    if (streamsById.size === 0) {
      await catchUpAssistantIfDue(idleGate, account, signal);
      return;
    }
    const streams = [...streamsById.values()];
    const dueStreams: typeof streams = [];
    for (const stream of streams) {
      if (visitedStreams > 0) await yieldToHost();
      visitedStreams += 1;
      if (signal.aborted) return;
      const catchUpDue =
        idleGateDue(
          idleGate.nextStreamCatchUpAtMs.get(stream.streamId) ?? 0,
          runtime.nowMs(),
          streamCatchUpInterval(idleGate, stream.streamId),
        ) ||
        requestedSince(
          idleGate,
          idleGate.streamCheckedAt.get(stream.streamId),
          idleGate.lowPriorityStreams.has(stream.streamId)
            ? LOW_PRIORITY_REQUESTED_MIN_INTERVAL_MS
            : 0,
        );
      if (
        !stream.checkpoint ||
        (await resumesBootstrap(idleGate, session, stream.streamId, catchUpDue))
      ) {
        if (idleGate.lowPriorityStreams.has(stream.streamId)) {
          // A purge or close during the scan read must not restart the backfill.
          if (signal.aborted) return;
          startBackfill({ session, idleGate, stream });
          continue;
        }
        await ingestBootstrap({
          session,
          from: stream,
          deadlineMs: runtime.nowMs() + SYNC_LANE_BOOTSTRAP_SLICE_MS,
          signal,
          requestId: runtime.randomId(),
          scopeId: stream.streamId,
          scope: idleGate.activeBootstrapScopes.get(stream.streamId),
        });
        await rememberBootstrapContinuation(idleGate, session, stream.streamId);
        continue;
      }
      if (!catchUpDue) continue;
      idleGate.streamCheckedAt.set(stream.streamId, checkStamp(idleGate));
      dueStreams.push(stream);
    }
    const readBatch = source.readChangesBatch;
    if (readBatch && dueStreams.length > 1) {
      // One request per chunk shares the provider connection and lookups
      // that a request per folder would repeat.
      for (
        let offset = 0;
        offset < dueStreams.length;
        offset += MAX_CHANGES_BATCH_READS
      ) {
        if (offset > 0) await yieldToHost();
        if (signal.aborted) return;
        const chunk = dueStreams.slice(
          offset,
          offset + MAX_CHANGES_BATCH_READS,
        );
        const results = await readBatch({
          session,
          reads: chunk.map((stream) => ({
            requestId: runtime.randomId(),
            position: stream,
          })),
          pageSize: 50,
          signal,
        });
        if (results.length !== chunk.length) {
          throw new Error("Changes batch returned the wrong number of results");
        }
        for (const [index, stream] of chunk.entries()) {
          const changes = results[index] as SyncReadResult;
          // Applying a page holds the store, so let host reads in between.
          if (index > 0) await yieldToHost();
          await applyStreamChanges({
            session,
            idleGate,
            stream,
            changes,
            signal,
          });
        }
      }
    } else {
      for (const [index, stream] of dueStreams.entries()) {
        if (index > 0) await yieldToHost();
        if (signal.aborted) return;
        const changes = await source.readChanges({
          session,
          requestId: runtime.randomId(),
          position: stream,
          pageSize: 50,
          signal,
        });
        await applyStreamChanges({
          session,
          idleGate,
          stream,
          changes,
          signal,
        });
      }
    }
    await catchUpAssistantIfDue(idleGate, account, signal);
  }

  async function applyStreamChanges({
    session,
    idleGate,
    stream,
    changes,
    signal,
  }: {
    session: { accountId: string; generation: string };
    idleGate: IdleCatchUpGate;
    stream: AccountSyncState["streams"][number];
    changes: SyncReadResult;
    signal: AbortSignal;
  }) {
    // A stopped lane may have been replaced, and its late result must not
    // move the shared catch-up schedule.
    if (signal.aborted) return;
    if (changes.status === "page") {
      const applied = await store.applySyncPage({
        page: changes.page,
        ownerId,
        bodies: changes.page.bodies,
      });
      if (applied.status === "committed") {
        if (changes.page.roundComplete) {
          idleGate.nextStreamCatchUpAtMs.set(
            stream.streamId,
            runtime.nowMs() + streamCatchUpInterval(idleGate, stream.streamId),
          );
        } else {
          idleGate.nextStreamCatchUpAtMs.delete(stream.streamId);
        }
        await refreshViews();
        await noteConnection(session.accountId, "ok");
        notifySyncPageCommitted(changes.page);
      } else {
        idleGate.nextStreamCatchUpAtMs.delete(stream.streamId);
      }
    } else if (changes.status === "reset_required") {
      // Unfinished pages resume through resumesBootstrap, so the gate
      // only slows a provider that keeps asking for a resync.
      idleGate.nextStreamCatchUpAtMs.set(
        stream.streamId,
        runtime.nowMs() + streamCatchUpInterval(idleGate, stream.streamId),
      );
      const resetStream = { ...stream, streamId: changes.scopeId };
      await ingestBootstrap({
        session,
        from: resetStream,
        deadlineMs: runtime.nowMs() + SYNC_LANE_BOOTSTRAP_SLICE_MS,
        signal,
        requestId: runtime.randomId(),
        scopeId: changes.scopeId,
      });
      await rememberBootstrapContinuation(idleGate, session, changes.scopeId);
    } else {
      // A throttled read comes back as soon as the provider allows, so new
      // mail waits out the quota window rather than a whole idle interval.
      // Any other failure retries on the idle clock, not the stretched one.
      const intervalMs = idleGate.lowPriorityStreams.has(stream.streamId)
        ? LOW_PRIORITY_CATCH_UP_INTERVAL_MS
        : idleCatchUpIntervalMs;
      const retryMs =
        changes.status === "paused" && changes.reason === "throttled"
          ? Math.max(SYNC_LANE_RETRY_MIN_MS, changes.retryAfterMs)
          : intervalMs;
      idleGate.nextStreamCatchUpAtMs.set(
        stream.streamId,
        runtime.nowMs() + Math.min(retryMs, intervalMs),
      );
      await noteConnection(session.accountId, changes);
    }
  }

  function idleCatchUpGateFor(accountId: string, generation: string) {
    const existing = idleCatchUpGates.get(accountId);
    if (existing?.generation === generation) return existing;
    const created: IdleCatchUpGate = {
      activeBootstrapScopes: new Map(),
      generation,
      lowPriorityStreams: new Set(),
      nextAssistantCatchUpAtMs: 0,
      nextScopeDiscoveryAtMs: 0,
      nextStreamCatchUpAtMs: new Map(),
      requestCount: 0,
      scopesDiscoveredAt: null,
      streamCheckedAt: new Map(),
    };
    idleCatchUpGates.set(accountId, created);
    return created;
  }

  function streamCatchUpInterval(idleGate: IdleCatchUpGate, streamId: string) {
    return idleGate.lowPriorityStreams.has(streamId)
      ? LOW_PRIORITY_CATCH_UP_INTERVAL_MS
      : changesCatchUpIntervalMs;
  }

  // Requests are counted rather than applied to deadlines, so a request that
  // lands while a check is in flight survives that check finishing, and
  // repeated requests cannot pull a check in below its minimum interval.
  function requestCatchUp(idleGate: IdleCatchUpGate) {
    idleGate.requestCount += 1;
    idleGate.nextAssistantCatchUpAtMs = 0;
  }

  function checkStamp(idleGate: IdleCatchUpGate): CheckStamp {
    return { atMs: runtime.nowMs(), requestCount: idleGate.requestCount };
  }

  function requestedSince(
    idleGate: IdleCatchUpGate,
    checked: CheckStamp | null | undefined,
    minIntervalMs: number,
  ) {
    return (
      checked != null &&
      idleGate.requestCount > checked.requestCount &&
      runtime.nowMs() - checked.atMs >= minIntervalMs
    );
  }

  async function rememberBootstrapContinuation(
    idleGate: IdleCatchUpGate,
    session: { accountId: string; generation: string },
    scopeId: string,
  ) {
    const scan = await store.readBootstrapScan({ session, scopeId });
    // A deferred scan stays active so it resumes when its retry time comes,
    // not at the next scope discovery.
    if (scan?.page) {
      if (!idleGate.activeBootstrapScopes.has(scopeId)) {
        idleGate.activeBootstrapScopes.set(scopeId, {
          id: scopeId,
          kind: "account",
          folderId: null,
        });
      }
      return;
    }
    idleGate.activeBootstrapScopes.delete(scopeId);
  }

  // A resync keeps the stream's old checkpoint until its bootstrap finishes,
  // so unfinished pages resume here instead of through another resync. A scan
  // this engine didn't start, such as one left by a restart, is picked up when
  // the stream's catch-up comes due.
  async function resumesBootstrap(
    idleGate: IdleCatchUpGate,
    session: { accountId: string; generation: string },
    scopeId: string,
    catchUpDue: boolean,
  ) {
    if (!catchUpDue && !idleGate.activeBootstrapScopes.has(scopeId)) {
      return false;
    }
    const scan = await store.readBootstrapScan({ session, scopeId });
    if (scan?.page) return true;
    idleGate.activeBootstrapScopes.delete(scopeId);
    return false;
  }

  async function discoverBootstrapScopes(
    session: { accountId: string; generation: string },
    signal?: AbortSignal,
  ): Promise<ScopeDescriptor[] | null> {
    const discovered = await source.discoverScopes({
      session,
      requestId: "bootstrap-scopes",
      signal: signal ?? new AbortController().signal,
      page: null,
    });
    if (discovered.status === "ok" && discovered.value.scopes.length > 0) {
      return discovered.value.scopes;
    }
    if (discovered.status !== "ok") {
      await noteConnection(session.accountId, discovered);
      return null;
    }
    return [{ id: "primary", kind: "account", folderId: null }];
  }

  async function catchUpAssistantIfDue(
    idleGate: IdleCatchUpGate,
    account: Pick<
      AccountSyncState,
      "accountId" | "generation" | "assistantCursor"
    >,
    signal?: AbortSignal,
  ) {
    if (
      !idleGateDue(
        idleGate.nextAssistantCatchUpAtMs,
        runtime.nowMs(),
        changesCatchUpIntervalMs,
      )
    ) {
      return;
    }
    const result = await catchUpAssistant(account, signal);
    // A failed read retries on the idle clock, not the stretched one.
    idleGate.nextAssistantCatchUpAtMs =
      result === "advanced"
        ? 0
        : runtime.nowMs() +
          (result === "failed"
            ? idleCatchUpIntervalMs
            : changesCatchUpIntervalMs);
  }

  async function catchUpAssistant(
    account: Pick<
      AccountSyncState,
      "accountId" | "generation" | "assistantCursor"
    >,
    signal?: AbortSignal,
  ): Promise<"advanced" | "caught_up" | "failed"> {
    if (!assistant) return "caught_up";
    const session = {
      accountId: account.accountId,
      generation: account.generation,
    };
    const page = await assistant.read({
      session,
      cursor: account?.assistantCursor ?? null,
      signal: signal ?? new AbortController().signal,
    });
    if (page.status !== "ok") return "failed";
    await store.applyAssistantEntries({
      accountId: session.accountId,
      cursor: page.page.nextCursor,
      entries: page.page.entries.map((entry) => ({
        id: entry.id,
        revision: entry.revision,
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        kind: entry.kind,
        payload: entry.payload,
      })),
    });
    await refreshViews();
    return page.page.nextCursor !== (account.assistantCursor ?? null)
      ? "advanced"
      : "caught_up";
  }

  async function resolveScope(
    session: { accountId: string; generation: string },
    scopeId: string,
    signal?: AbortSignal,
  ): Promise<ScopeDescriptor> {
    const discovered = await source.discoverScopes({
      session,
      requestId: `scope-${scopeId}`,
      signal: signal ?? new AbortController().signal,
      page: null,
    });
    if (discovered.status === "ok") {
      const match = discovered.value.scopes.find(
        (scope) => scope.id === scopeId,
      );
      if (match) return match;
    }
    return {
      id: scopeId,
      kind: "account",
      folderId: null,
    };
  }

  function notifySyncPageCommitted(page: SyncPage) {
    try {
      input.onSyncPageCommitted?.(page);
    } catch {
      // Optional host side effects must not interrupt committed sync.
    }
  }

  async function noteConnection(
    accountId: string,
    result: string | { status: string; reason?: "throttled" | "unavailable" },
  ) {
    const { status, reason } =
      typeof result === "string"
        ? { status: result, reason: undefined }
        : result;
    // Throttling is the provider or the sync budget pacing requests, not lost
    // connectivity, so it must not flag the account as waiting to sync.
    if (status === "paused" && reason === "throttled") return;
    const connection = CONNECTION_BY_SOURCE_STATUS[status];
    if (!connection) return;
    if (await store.recordConnection({ accountId, connection })) {
      await refreshViews();
    }
  }
}

const CONNECTION_BY_SOURCE_STATUS: Partial<
  Record<string, "ready" | "offline" | "blocked_auth">
> = {
  blocked_auth: "blocked_auth",
  paused: "offline",
  ok: "ready",
  page: "ready",
};

type SyncLane = {
  abort: AbortController;
  done: Promise<void>;
};

type ProviderSearch = {
  key: string;
  accountId: string;
  predicate: MailPredicate;
  requestedPages: Set<string | null>;
  nextPage: string | null;
  matched: number;
  pagesSinceDemand: number;
  wantedRows: Map<symbol, number>;
};

function providerSearchKey(accountId: string, predicate: MailPredicate) {
  return `${accountId}:${JSON.stringify(predicate)}`;
}

// Settles on abort even when the request ignores its signal.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Conversation fill stopped"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

type ConversationFetchEntry = {
  promise: Promise<ConversationCompletion>;
  /** Callers still waiting; a queued fill with none is dropped. */
  waiters: number;
};

type ConversationFetch =
  | { status: "complete" }
  | { status: "unavailable"; retryAfterMs: number };

function conversationFetchKey(key: ConversationKey) {
  return `${key.accountId}\u0000${key.conversationId}`;
}

type IdleCatchUpGate = {
  activeBootstrapScopes: Map<string, ScopeDescriptor>;
  generation: string;
  lowPriorityStreams: Set<string>;
  nextAssistantCatchUpAtMs: number;
  nextScopeDiscoveryAtMs: number;
  nextStreamCatchUpAtMs: Map<string, number>;
  requestCount: number;
  scopesDiscoveredAt: CheckStamp | null;
  streamCheckedAt: Map<string, CheckStamp>;
};

type CheckStamp = { atMs: number; requestCount: number };

function backfillLaneKey(accountId: string) {
  return `${accountId}\u0000backfill`;
}

function idleGateDue(nextAtMs: number, nowMs: number, intervalMs: number) {
  return nextAtMs <= nowMs || nextAtMs - nowMs > intervalMs;
}

function normalizePageCount(pageCount: number | undefined) {
  if (!pageCount || !Number.isFinite(pageCount)) return 1;
  return Math.min(MAX_MAILBOX_WINDOW_PAGES, Math.max(1, Math.floor(pageCount)));
}

export function createHostRuntime(
  overrides?: Partial<HostRuntime>,
): HostRuntime {
  return {
    nowMs: overrides?.nowMs ?? (() => Date.now()),
    randomId: overrides?.randomId ?? defaultRandomId,
    sha256: overrides?.sha256 ?? webCryptoSha256,
    storagePressure: overrides?.storagePressure ?? (() => false),
  };
}

function defaultRandomId(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  throw new Error(
    "HostRuntime.randomId is required when crypto.randomUUID is unavailable",
  );
}

/**
 * Lets queued host work run between store transactions. Synchronous SQLite
 * drivers otherwise keep every read (opening a conversation) waiting until a
 * whole run of sync pages and jobs finishes.
 */
function yieldToHost() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
