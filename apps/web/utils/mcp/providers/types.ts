// A provider hosts third-party app connections for us: it runs the app's OAuth,
// stores the tokens, and exposes the connected app as an MCP server. Swapping
// the provider behind an app only changes the app's registry entry.
export type IntegrationProvider = {
  isConfigured(): boolean;
  getConnectUrl(
    args: ProviderAppArgs & { callbackUrl: string },
  ): Promise<string>;
  // Called when the user returns from the provider; keeps only the newest
  // active connection so reconnecting replaces the old account
  completeConnection(args: ProviderAppArgs): Promise<boolean>;
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
  // Runs one tool for the account's connection to the app, outside a chat
  executeTool(
    args: ProviderAppArgs & { tool: string; args: Record<string, unknown> },
  ): Promise<unknown>;
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
