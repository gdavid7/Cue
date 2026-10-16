// A provider hosts third-party app connections for us: it runs the app's OAuth,
// stores the tokens, and exposes the connected app as an MCP server. Swapping
// the provider behind an app only changes the app's registry entry.
export type IntegrationProvider = {
  isConfigured(): boolean;
  // The hosted link is a bearer link: whoever opens it authorizes their app
  // under our account id. The provider remembers which connection the link
  // creates for the user who started it, so only that one can be completed.
  getConnectUrl(
    args: ProviderAppArgs & { userId: string; callbackUrl: string },
  ): Promise<string>;
  // Called when the user who started the link returns from the provider.
  // Completes only the connection their link created, and only when the
  // callback names that same connection; anything else fails closed.
  completeConnection(
    args: ProviderAppArgs & {
      userId: string;
      connectedAccountId: string | null;
    },
  ): Promise<boolean>;
  // Called when a callback arrives without its starter's state: someone else
  // opened the link, so the connection they authorized is thrown away.
  discardConnection(args: { connectedAccountId: string }): Promise<void>;
  // Apps that take a key instead of OAuth (e.g. Canvas: a school's address and
  // a personal access token). Throws CredentialsRejectedError when the app
  // turns the credentials down, and keeps nothing in that case.
  connectWithCredentials(
    args: ProviderAppArgs & {
      credentials: Record<string, string>;
      // A read-only tool the app answers only for valid credentials
      verifyTool: string;
    },
  ): Promise<void>;
  // Runs one tool for the account's connection to the app, outside a chat.
  // Throws ConnectionExpiredError when the app's authorization has lapsed.
  executeTool(
    args: ProviderAppArgs & { tool: string; args: Record<string, unknown> },
  ): Promise<unknown>;
  // Runs a read-only tool to confirm the connection still works, and forgets
  // any remembered lapse when it does. Throws like executeTool.
  checkConnection(args: ProviderAppArgs & { tool: string }): Promise<unknown>;
  // Whether the provider still holds a working authorization for the app
  getConnectionStatus(
    args: ProviderAppArgs,
  ): Promise<"active" | "needs_reconnect">;
  disconnect(args: ProviderAppArgs): Promise<void>;
  getMcpServer(
    args: ProviderAppArgs & { allowedTools: string[] },
  ): Promise<{ url: string; headers: Record<string, string> }>;
};

export type IntegrationProviderId = "composio";

type ProviderAppArgs = {
  app: string;
  emailAccountId: string;
  // How users authenticate with the app; OAuth unless the registry says so
  authScheme?: "OAUTH2" | "API_KEY";
};

export class CredentialsRejectedError extends Error {}

// The app answered a tool call with its own error (e.g. a 500 from Canvas).
// Not an authorization problem: retrying later may work.
export class AppToolError extends Error {
  readonly app: string;
  readonly tool: string;

  constructor(app: string, tool: string, message: string) {
    super(message);
    this.name = "AppToolError";
    this.app = app;
    this.tool = tool;
  }
}

// The app's authorization expired or was revoked; only reconnecting fixes it.
// `confirmed` when the provider itself holds no working authorization; an
// app's auth-looking error alone can also mean one resource is off limits
// (Canvas answers both with a 401), so it needs re-checking.
export class ConnectionExpiredError extends Error {
  readonly app: string;
  readonly confirmed: boolean;

  constructor(
    app: string,
    message: string,
    { confirmed = false }: { confirmed?: boolean } = {},
  ) {
    super(message);
    this.name = "ConnectionExpiredError";
    this.app = app;
    this.confirmed = confirmed;
  }
}
