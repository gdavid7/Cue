import { NextResponse } from "next/server";
import { getCueMembership } from "@/utils/split-inbox/cue-membership.server";
import { withEmailAccount } from "@/utils/middleware";

export type CueMembershipResponse = Awaited<
  ReturnType<typeof getCueMembership>
>;

export const GET = withEmailAccount(
  "user/mail-splits/cue-membership",
  async (request) => {
    const result = await getCueMembership({
      emailAccountId: request.auth.emailAccountId,
    });
    return NextResponse.json(result);
  },
);
