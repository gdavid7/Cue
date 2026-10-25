export const AI_GENERATED_FIELD_VALUE = "___AI_GENERATE___";

export const EMAIL_ACCOUNT_HEADER = "X-Email-Account-ID";
export const EMAIL_ACCOUNT_ID_REQUIRED_ERROR = "Email account ID is required";

export const NO_REFRESH_TOKEN_ERROR_CODE = "NO_REFRESH_TOKEN";
export const MICROSOFT_AUTH_EXPIRED_ERROR_CODE = "MICROSOFT_AUTH_EXPIRED";
export const RECONNECT_REQUIRED_MESSAGE =
  "Authorization required. Please grant permissions.";
// The app session is gone. Unlike the two codes above, the mailbox grant may
// be fine: signing in again is the fix, not reconnecting the account.
export const SESSION_EXPIRED_ERROR_CODE = "SESSION_EXPIRED";

export const userMinCount = "20,000";
export const userCount = `${userMinCount}+`;

export const KNOWLEDGE_BASIC_MAX_ITEMS = 1;
export const KNOWLEDGE_BASIC_MAX_CHARS = 2000;

export const ConditionType = {
  AI: "AI",
  STATIC: "STATIC",
  LEARNED_PATTERN: "LEARNED_PATTERN",
  PRESET: "PRESET",
} as const;

export type ConditionType = (typeof ConditionType)[keyof typeof ConditionType];
export type CoreConditionType = Extract<ConditionType, "AI" | "STATIC">;

export const WELCOME_PATH = "/welcome-redirect";

export const ONBOARDING_PROCESS_EMAILS_COUNT = 20;
