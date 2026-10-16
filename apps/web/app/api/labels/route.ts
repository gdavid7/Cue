import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";

export type UnifiedLabel = {
  id: string;
  name: string;
  type: string | null;
  color?: {
    textColor?: string | null;
    backgroundColor?: string | null;
  };
  labelListVisibility?: string;
  messageListVisibility?: string;
};

export type LabelsResponse = {
  labels: UnifiedLabel[];
};

export const maxDuration = 30;

export const GET = withEmailProvider(
  "labels",
  async (request) => {
    // Hidden labels are included so the client can honour Gmail's visibility
    // settings itself, and still offer a way back to a hidden label.
    // Failures go to the middleware, which answers a quota deferral with 503
    // and Retry-After and a Gmail rate limit with 429.
    const labels = await request.emailProvider.getLabels({
      includeHidden: true,
    });
    const unifiedLabels: UnifiedLabel[] = (labels || []).map((label) => ({
      id: label.id,
      name: label.name,
      type: label.type,
      color: label.color,
      labelListVisibility: label.labelListVisibility,
      messageListVisibility: label.messageListVisibility,
    }));
    return NextResponse.json({ labels: unifiedLabels });
  },
  { requestTiming: {}, maxDuration },
);
