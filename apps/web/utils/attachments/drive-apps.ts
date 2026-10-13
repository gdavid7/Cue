// Where an email attachment can be saved: connected apps Cue reaches through
// Composio. Safe for client code.
export const DRIVE_APPS = ["googledrive", "one_drive"] as const;

export type DriveApp = (typeof DRIVE_APPS)[number];
