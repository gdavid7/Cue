import { NextResponse } from "next/server";
import { getCueDefaultLabels } from "@/utils/label/cue-default-labels";
import { withEmailProvider } from "@/utils/middleware";

export type GetCueLabelsResponse = {
  labels: Awaited<ReturnType<typeof getCueDefaultLabels>>;
};

export const GET = withEmailProvider("user/cue-labels", async (request) => {
  const labels = await getCueDefaultLabels(request.emailProvider);
  return NextResponse.json({ labels } satisfies GetCueLabelsResponse);
});
