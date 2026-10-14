export function mailEngineConnectionCopy(
  connection: "ready" | "offline" | "blocked_auth" | undefined,
) {
  if (connection === "blocked_auth") {
    return {
      title: "Reconnect this account to keep getting mail",
      description:
        "Cue lost access, so new mail is paused. Nothing in your mailbox has changed.",
      action: "Reconnect",
    };
  }
  if (connection === "offline") {
    return {
      title: "Can't reach your mailbox right now.",
      description:
        "Showing the mail Cue already has. It catches up on its own.",
    };
  }
}
