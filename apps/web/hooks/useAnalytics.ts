import type { PostHogClient } from "@/utils/analytics/posthog-client";

export const landingPageAnalytics = {
  videoClicked: (posthog: PostHogClient, videoId: string) => {
    posthog?.capture?.("Landing Page Video Clicked", { video_id: videoId });
  },
  videoStarted: (posthog: PostHogClient, videoId: string) => {
    posthog?.capture?.("Landing Page Video Started", { video_id: videoId });
  },
  videoProgress: (
    posthog: PostHogClient,
    videoId: string,
    progressPercent: number,
  ) => {
    posthog?.capture?.("Landing Page Video Progress", {
      video_id: videoId,
      progress_percent: progressPercent,
    });
  },
  videoCompleted: (posthog: PostHogClient, videoId: string) => {
    posthog?.capture?.("Landing Page Video Completed", { video_id: videoId });
  },
  videoClosed: (posthog: PostHogClient, videoId: string) => {
    posthog?.capture?.("Landing Page Video Closed", { video_id: videoId });
  },
  getStartedClicked: (posthog: PostHogClient) => {
    posthog?.capture?.("Clicked Get Started");
  },
  talkToSalesClicked: (posthog: PostHogClient) => {
    posthog?.capture?.("Clicked talk to sales");
  },
  logInClicked: (posthog: PostHogClient, position?: string) => {
    posthog?.capture?.("Clicked Log In", position ? { position } : undefined);
  },
  signUpClicked: (posthog: PostHogClient, position?: string) => {
    posthog?.capture?.("Clicked Sign Up", position ? { position } : undefined);
  },
  pricingCtaClicked: (
    posthog: PostHogClient,
    properties: {
      tier: string;
      cta: string;
      frequency: "monthly" | "annually";
      defaultFrequency: "monthly" | "annually";
      frequencySource: "default" | "user_selected";
    },
  ) => {
    posthog?.capture?.("Clicked Pricing CTA", properties);
  },
  appDownloadClicked: (posthog: PostHogClient, platform: "ios" | "android") => {
    posthog?.capture?.("Clicked App Download", { platform });
  },
};
