import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { callMcpTool } from "@/utils/mcp/call-tool";
import { findIntegration } from "@/utils/mcp/integrations";
import { getRemoteSelectArg } from "@/utils/mcp/tool-specs";
import { findConnectionAccountId } from "@/utils/mcp/user-connections";

export type GetIntegrationArgOptionsResponse = Awaited<
  ReturnType<typeof getData>
>;

export const GET = withEmailAccount(
  "mcp/arg-options",
  async (request, { params }) => {
    const { integration } = await params;
    const searchParams = request.nextUrl.searchParams;

    return NextResponse.json(
      await getData({
        emailAccountId: request.auth.emailAccountId,
        integration,
        tool: searchParams.get("tool"),
        argKey: searchParams.get("argKey"),
      }),
    );
  },
);

async function getData({
  emailAccountId,
  integration,
  tool,
  argKey,
}: {
  emailAccountId: string;
  integration: string;
  tool: string | null;
  argKey: string | null;
}) {
  // Never trust the URL: the integration and the arg must both be declared.
  if (!findIntegration(integration)) {
    throw new SafeError("Unknown integration");
  }

  const remoteSelect = getRemoteSelectArg({ integration, tool, argKey });
  if (!remoteSelect) {
    throw new SafeError("Unknown integration argument");
  }

  // The app may have been connected from another of the person's accounts
  const connectionAccountId =
    (await findConnectionAccountId({
      integration,
      emailAccountId,
      activeOnly: true,
    })) ?? emailAccountId;

  const content = await callMcpTool({
    emailAccountId: connectionAccountId,
    integration,
    toolName: remoteSelect.control.optionsTool,
    args: {},
  });

  return { options: remoteSelect.control.parseOptions(content) };
}
