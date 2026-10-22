import type {
  Admission,
  SubmitConversationCommand,
  SubmitMetadataCommand,
} from "../commands";
import type {
  DraftReadResult,
  DraftSaveResult,
  SaveDraft,
  SubmitSend,
} from "../drafts";
import type {
  AccountSession,
  ConversationKey,
  DraftKey,
  LocalRevision,
  MessageKey,
  OperationKey,
} from "../identities";
import type {
  OperationState,
  OperationStatus,
  PreparedOperation,
  TargetOutcome,
} from "../operations";
import type {
  ContactSuggestion,
  ContactSuggestionQuery,
  ConversationQuery,
  Coverage,
  MailPredicate,
  MailboxCountsQuery,
  MailboxCountsView,
  MailboxView,
  MessageSearchPage,
  MessageSearchQuery,
  FileSender,
  FilesPage,
  FilesQuery,
  PersonCard,
  PersonCardQuery,
  QuerySnapshot,
  SemanticMatch,
} from "../queries";
import type {
  BodyObservation,
  ConversationMembershipPage,
  ProviderChange,
  SyncPage,
} from "../sync";
import type { MessageAttachmentDescriptor, MessageMetadata } from "../messages";

export type ConversationView = {
  key: ConversationKey;
  messages: Array<{
    key: MessageKey;
    metadata: MessageMetadata;
    content:
      | { status: "not_requested" | "queued" | "unavailable" }
      | {
          status: "available";
          html: string | null;
          /** Null when the message has HTML; derive text from `html`. */
          text: string | null;
          attachments: MessageAttachmentDescriptor[];
          isMeetingInvitation: boolean;
        };
    pendingOperationIds: string[];
    /** The send operation that produced this message, once it is confirmed. */
    sendOperationId?: string;
  }>;
  /**
   * Sends from this device the provider hasn't confirmed yet, oldest first.
   * Absent from desktop engines older than the web app.
   */
  outgoing?: Array<{
    operationId: string;
    status: OperationStatus;
    metadata: MessageMetadata;
    html: string;
  }>;
  nextPage: string | null;
  coverage: Coverage[];
};

export type ClaimedWork =
  | {
      kind: "command";
      attemptId: string;
      operation: PreparedOperation;
    }
  | {
      kind: "inspect";
      attemptId: string;
      receiptId: string | null;
      operation: PreparedOperation;
    }
  | {
      kind: "sync";
      jobId: string;
      accountId: string;
      session: AccountSession;
      position: {
        streamId: string;
        generation: string;
        checkpoint: string | null;
      };
    }
  | {
      kind: "prepare";
      attemptId: string;
      commandId: string;
      accountId: string;
      session: AccountSession;
      conversation: ConversationKey;
      resolutionId: string;
      page: string | null;
    }
  | {
      kind: "hydrate";
      jobId: string;
      attemptId: string;
      session: AccountSession;
      keys: MessageKey[];
      purpose: "metadata" | "body";
    }
  | {
      kind: "search";
      jobId: string;
      attemptId: string;
      accountId: string;
      session: AccountSession;
      predicate: MailPredicate;
      page: string | null;
    };

export type SyncStreamPosition = {
  streamId: string;
  generation: string;
  checkpoint: string | null;
};

export type BootstrapScan = {
  accountId: string;
  scopeId: string;
  bootstrapId: string;
  page: string | null;
  from: SyncStreamPosition;
  catchUpFrom: SyncStreamPosition | null;
  nextAttemptAtMs: number | null;
  errorCode: string | null;
};

export type AccountSyncState = {
  accountId: string;
  generation: string;
  assistantCursor: string | null;
  streams: Array<SyncStreamPosition & { accountId: string }>;
  stream: (SyncStreamPosition & { accountId: string }) | null;
};

export type AssistantEntryRecord = {
  id: string;
  revision: string;
  messageId: string | null;
  conversationId: string | null;
  kind: string;
  payload: unknown;
};

export type MailStoreInspection = {
  revision: LocalRevision;
  accounts: Array<{
    accountId: string;
    provider: "google" | "microsoft";
    generation: string;
    assistantCursor: string | null;
    connection: "ready" | "offline" | "blocked_auth";
  }>;
  messages: Array<{
    accountId: string;
    messageId: string;
    conversationId: string;
    confirmed: MessageMetadata;
    effective: MessageMetadata & { pendingOperationIds: string[] };
    deleted: boolean;
  }>;
  operations: OperationState[];
  operationTargets: Array<{
    accountId: string;
    operationId: string;
    messageId: string;
    outcome: "applied" | "rejected" | "uncertain" | null;
    code: string | null;
  }>;
  assistantEntries: Array<AssistantEntryRecord & { accountId: string }>;
  coverage: Coverage[];
  streams: Array<{
    accountId: string;
    streamId: string;
    generation: string;
    checkpoint: string | null;
  }>;
};

/** What a message is embedded from, for semantic search. */
export type EmbeddingSource = {
  key: MessageKey;
  receivedAtMs: number;
  subject: string;
  from: string;
  /** The start of the body, or the preview when no body is stored. */
  body: string;
  fromBody: boolean;
};

export type MessageEmbedding = Pick<
  EmbeddingSource,
  "key" | "receivedAtMs" | "fromBody"
> & {
  /** A unit vector as signed bytes, each component times 127. */
  vector: Int8Array;
};

/**
 * The mail semantic search covers: messages received since `sinceMs`, and
 * no more than the newest `maxMessages` of them.
 */
export type EmbeddingCap = {
  model: string;
  sinceMs: number;
  maxMessages: number;
};

/** Where a pass over the embedding backlog has reached, newest first. */
export type EmbeddingBacklogCursor = { receivedAtMs: number; key: MessageKey };

export type MailStoreInspectionInput = {
  accountIds?: string[];
  limit?: number;
};

export interface MailStore {
  admitConversations(input: SubmitConversationCommand): Promise<Admission>;
  admitMetadata(input: SubmitMetadataCommand): Promise<Admission>;
  admitSend(input: SubmitSend): Promise<Admission>;
  applyAssistantEntries(input: {
    accountId: string;
    cursor?: string | null;
    entries: AssistantEntryRecord[];
  }): Promise<LocalRevision>;
  applyBootstrapPage(input: {
    session: AccountSession;
    scopeId: string;
    bootstrapId: string;
    previousPage: string | null;
    nextPage: string | null;
    from: SyncStreamPosition;
    catchUpFrom: SyncStreamPosition | null;
    requestId: string;
    changes: ProviderChange[];
    requiredHydration: MessageKey[];
    bodies: BodyObservation[];
    ownerId: string;
    /** The store's `readRevision()` just before the provider read was sent. */
    requestedAt?: LocalRevision;
    /** On the last page: the scan covered only mail from this time on. */
    windowStartMs?: number;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  /**
   * Merges one page of a conversation's membership read outside any command,
   * as when a reader opens it. The last page marks the conversation complete
   * and settles the membership of commands preparing it, queuing any that
   * have nothing left to prepare.
   */
  applyConversationMembership(input: {
    session: AccountSession;
    page: ConversationMembershipPage;
    /** The store's `readRevision()` just before the provider read was sent. */
    requestedAt?: LocalRevision;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  applyHydration(input: {
    session: AccountSession;
    requestId: string;
    attemptId?: string;
    changes: ProviderChange[];
    bodies: BodyObservation[];
    /**
     * Adds only messages the store has no copy of. For reads made outside
     * the store's own sync, which may predate a change it has since made or
     * confirmed at the same provider version.
     */
    onlyMissing?: boolean;
    /** The store's `readRevision()` just before the provider read was sent. */
    requestedAt?: LocalRevision;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  applyPreparationPage(input: {
    accountId: string;
    commandId: string;
    attemptId: string;
    session: AccountSession;
    previousPage: string | null;
    page: ConversationMembershipPage;
    /** The store's `readRevision()` just before the provider read was sent. */
    requestedAt?: LocalRevision;
  }): Promise<Admission | { status: "stale" }>;
  applySyncPage(input: {
    page: SyncPage;
    ownerId: string;
    bodies?: BodyObservation[];
    /** The store's `readRevision()` just before the provider read was sent. */
    requestedAt?: LocalRevision;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  /** Confirms locally a cancellation the server made for a held send. */
  cancelHeldSend(
    key: OperationKey,
  ): Promise<
    | { status: "cancelled"; revision: LocalRevision }
    | { status: "too_late" | "not_found" }
  >;
  cancelOperation(
    key: OperationKey,
  ): Promise<
    | { status: "cancelled"; revision: LocalRevision }
    | { status: "too_late" | "not_found" }
  >;
  claimWork(input: {
    ownerId: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<ClaimedWork | null>;
  close(): Promise<void>;
  completeJob(input: { jobId: string; attemptId: string }): Promise<void>;
  countMessageEmbeddings(input: {
    accountId: string;
    model: string;
  }): Promise<number>;
  deferBootstrapScan(input: {
    session: AccountSession;
    scopeId: string;
    bootstrapId: string;
    page: string;
    nextAttemptAtMs: number;
    errorCode: string;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  /** Releases a claimed job so it is not claimed again before `retryAtMs`. */
  deferJob(input: {
    jobId: string;
    attemptId: string;
    retryAtMs: number;
  }): Promise<void>;
  deferPreparation(input: {
    accountId: string;
    commandId: string;
    attemptId: string;
    nextAttemptAtMs: number | null;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  enqueueHydration(input: {
    keys: MessageKey[];
    purpose: "metadata" | "body";
  }): Promise<LocalRevision>;
  enqueueSearch(input: {
    accountId: string;
    predicate: MailPredicate;
    page: string | null;
  }): Promise<LocalRevision>;
  ensureAccount(input: {
    accountId: string;
    provider: "google" | "microsoft";
    generation: string;
  }): Promise<LocalRevision>;
  evictReplaceableContent(): Promise<{ evictedBodies: number }>;
  failOperation(
    key: OperationKey,
    code: string,
  ): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  failPreparation(input: {
    accountId: string;
    commandId: string;
    attemptId: string;
    session: AccountSession;
    code: string;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  /**
   * Queues a preparing command whose every conversation's membership is
   * known. `claimWork` also does this for any it finds, so a host stopped
   * between settling the membership and this call recovers.
   */
  finishPreparation(input: {
    accountId: string;
    commandId: string;
  }): Promise<Admission | { status: "stale" }>;
  /**
   * Removes mailbox drafts the provider confirmed deleted, before sync reports
   * it. Messages that aren't drafts stay; a later provider patch restores one.
   */
  forgetDeletedDrafts(input: {
    accountId: string;
    messageIds: string[];
  }): Promise<LocalRevision>;
  getDiagnostics(accountId: string): Promise<{
    accountId: string;
    revision: LocalRevision;
    connection: "ready" | "offline" | "blocked_auth";
    coverage: Coverage[];
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
  }>;
  indexContactBacklog(): Promise<{ remaining: boolean }>;
  /** Indexes one short batch of stored bodies missing from local search. */
  indexSearchBacklog(): Promise<{ remaining: boolean }>;
  inspect(input?: MailStoreInspectionInput): Promise<MailStoreInspection>;
  /**
   * Drops vectors outside the cap or of mail gone, and resolves how many
   * with where the cap starts, for a pass's backlog reads.
   */
  pruneMessageEmbeddings(
    input: EmbeddingCap,
  ): Promise<{ dropped: number; sinceMs: number }>;
  purgeAccount(accountId: string): Promise<LocalRevision>;
  readAccountSyncStates(): Promise<AccountSyncState[]>;
  readBootstrapScan(input: {
    session: AccountSession;
    scopeId: string;
  }): Promise<BootstrapScan | null>;
  readContactSuggestions(
    query: ContactSuggestionQuery,
  ): Promise<ContactSuggestion[]>;
  readConversation(
    key: ConversationKey,
    page: { after: string | null; pageSize: number },
  ): Promise<{ revision: LocalRevision; view: ConversationView }>;
  /**
   * `complete` when every message of the conversation is local (sync covered
   * the whole mailbox, or its membership was merged); `preparing` when a
   * command's preparation is due by `nowMs` to read its membership.
   */
  readConversationMembershipState(
    key: ConversationKey,
    nowMs: number,
  ): Promise<"complete" | "preparing" | "incomplete">;
  readDraft(key: DraftKey): Promise<DraftReadResult>;
  /**
   * The next messages received since `sinceMs` without a current vector,
   * newest first, older than `before` when set.
   */
  readEmbeddingBacklog(input: {
    model: string;
    sinceMs: number;
    limit: number;
    before: EmbeddingBacklogCursor | null;
  }): Promise<EmbeddingSource[]>;
  readFileSenders(accountIds: string[]): Promise<FileSender[]>;
  readFiles(query: FilesQuery): Promise<FilesPage>;
  readFilesNotOnDevice(accountIds: string[]): Promise<number>;
  /**
   * A send already handed to the server to deliver at its `sendAtMs`, which
   * only the server can still stop.
   */
  readHeldSend(key: OperationKey): Promise<PreparedOperation | null>;
  readMailboxCounts(query: MailboxCountsQuery): Promise<{
    revision: LocalRevision;
    view: MailboxCountsView;
  }>;
  readMailboxView(query: ConversationQuery): Promise<{
    revision: LocalRevision;
    view: MailboxView;
  }>;
  readMailboxWindow(
    query: ConversationQuery,
    pageCount: number,
  ): Promise<{
    revision: LocalRevision;
    view: MailboxView;
  }>;
  readMessageSearch(query: MessageSearchQuery): Promise<MessageSearchPage>;
  readOperation(key: OperationKey): Promise<{
    revision: LocalRevision;
    operation: OperationState | null;
  }>;
  readPersonCard(query: PersonCardQuery): Promise<PersonCard>;
  /**
   * The store's current revision. Taken just before a provider read is sent
   * and passed back as that read's `requestedAt`, it orders the read against
   * local changes on one clock shared by every engine on this database.
   */
  readRevision(): Promise<LocalRevision>;
  readSemanticMatches(input: {
    accountId: string;
    model: string;
    vector: Int8Array;
    limit: number;
    minSimilarity: number;
  }): Promise<SemanticMatch[]>;
  /** Resolves `true` when the stored connection state changed. */
  recordConnection(input: {
    accountId: string;
    connection: "ready" | "offline" | "blocked_auth";
  }): Promise<boolean>;
  registerSyncScopes(input: {
    session: AccountSession;
    scopeIds: string[];
  }): Promise<boolean>;
  releaseDeferredOperations(input: {
    accountIds: string[];
    nowMs: number;
  }): Promise<void>;
  saveDraft(input: SaveDraft): Promise<DraftSaveResult>;
  settleAttempt(input: {
    attemptId: string;
    operation: PreparedOperation;
    result:
      | {
          status: "confirmed";
          receiptId: string | null;
          observations: ProviderChange[];
          bodies?: BodyObservation[];
          targets: TargetOutcome[];
        }
      | { status: "accepted"; receiptId: string; retryAfterMs: number }
      | {
          status: "not_dispatched";
          reason: "throttled" | "blocked_auth" | "unavailable";
          retryAfterMs: number | null;
        }
      | { status: "rejected"; code: string; targets: TargetOutcome[] }
      | { status: "uncertain"; receiptId: string | null };
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  startBootstrapScan(input: {
    session: AccountSession;
    scopeId: string;
    bootstrapId: string;
    page: string | null;
    from: SyncStreamPosition;
    catchUpFrom: SyncStreamPosition | null;
    nowMs: number;
  }): Promise<
    { status: "committed"; revision: LocalRevision } | { status: "stale" }
  >;
  tombstoneUnseen(input: {
    session: AccountSession;
    scopeId: string;
    seenMessageIds: string[];
  }): Promise<LocalRevision>;
  writeMessageEmbeddings(input: {
    model: string;
    embeddings: MessageEmbedding[];
  }): Promise<void>;
}

export type { QuerySnapshot };
