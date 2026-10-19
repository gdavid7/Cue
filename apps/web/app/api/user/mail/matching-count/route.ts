import { NextResponse } from "next/server";
import { matchingScopeSchema } from "@/utils/actions/mail-bulk-matching.validation";
import { withEmailProvider } from "@/utils/middleware";

export type GetMatchingCountResponse = { count: number | null };

// How many conversations a view holds, for the select-all banner. Null when
// the provider can only estimate, and the banner then names no number.
export const GET = withEmailProvider(
  "user/mail/matching-count",
  async (request) => {
    const parsed = matchingScopeSchema.safeParse(
      parseJson(new URL(request.url).searchParams.get("scope")),
    );
    if (!parsed.success)
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
    const scope = parsed.data;
    const count = await request.emailProvider.countMatchingConversations(scope);
    return NextResponse.json({ count } satisfies GetMatchingCountResponse);
  },
);

function parseJson(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
