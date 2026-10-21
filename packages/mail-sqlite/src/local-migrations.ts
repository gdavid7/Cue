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
} as const;
