// Every schema_migrations row is keyed by an id from this map. Ids are stored
// on users' devices, so never renumber or reuse one: two branches picking the
// same id would make one of their migrations silently skip.
export const LOCAL_MIGRATIONS = {
  mailbox: { id: 1, name: "0001-mailbox" },
  roleConversationIndex: { id: 2, name: "0002-role-conversation-index" },
  messageMembershipIndex: { id: 3, name: "0003-message-membership-index" },
  inboxUnreadExcludesArchive: {
    id: 5,
    name: "0005-inbox-unread-excludes-archive",
  },
  cleanTextMessageSearch: { id: 7, name: "0007-clean-text-message-search" },
  compressedMessageBodies: { id: 8, name: "0008-compressed-message-bodies" },
  emptyMeetingInvitationBodies: {
    id: 9,
    name: "0009-empty-meeting-invitation-bodies",
  },
  contactSuggestions: { id: 10, name: "0010-contact-suggestions" },
  incrementalConversationIndex: {
    id: 11,
    name: "0011-incremental-conversation-index",
  },
  messageEmbeddings: { id: 12, name: "0012-message-embeddings" },
  stemmedMessageSearch: { id: 13, name: "0013-stemmed-message-search" },
  contactNameTokens: { id: 14, name: "0014-contact-name-tokens" },
  filesOrderIndex: { id: 15, name: "0015-files-order-index" },
  internetMessageIds: { id: 16, name: "0016-internet-message-ids" },
  conversationMessageKeys: {
    id: 17,
    name: "0017-conversation-message-keys",
  },
  importantPeople: { id: 18, name: "0018-important-people" },
  operationsAccountStatusIndex: {
    id: 19,
    name: "0019-operations-account-status-index",
  },
  // 20 is taken by the drafts-lane index on another branch.
  senderUtcOffsets: { id: 21, name: "0021-sender-utc-offsets" },
} as const;
