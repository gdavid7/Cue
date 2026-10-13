import type { PostHog } from "posthog-js";

export const landingPageAnalytics = {
  videoClicked: (posthog: PostHog, videoId: string) => {
    posthog?.capture?.("Landing Page Video Clicked", { video_id: videoId });
  },
  videoStarted: (posthog: PostHog, videoId: string) => {
    posthog?.capture?.("Landing Page Video Started", { video_id: videoId });
  },
  videoProgress: (
    posthog: PostHog,
    videoId: string,
    progressPercent: number,
  ) => {
    posthog?.capture?.("Landing Page Video Progress", {
      video_id: videoId,
      progress_percent: progressPercent,
    });
  },
  videoCompleted: (posthog: PostHog, videoId: string) => {
    posthog?.capture?.("Landing Page Video Completed", { video_id: videoId });
  },
  videoClosed: (posthog: PostHog, videoId: string) => {
    posthog?.capture?.("Landing Page Video Closed", { video_id: videoId });
  },
  getStartedClicked: (posthog: PostHog) => {
    posthog?.capture?.("Clicked Get Started");
  },
  talkToSalesClicked: (posthog: PostHog) => {
    posthog?.capture?.("Clicked talk to sales");
  },
  logInClicked: (posthog: PostHog, position?: string) => {
    posthog?.capture?.("Clicked Log In", position ? { position } : undefined);
  },
  signUpClicked: (posthog: PostHog, position?: string) => {
    posthog?.capture?.("Clicked Sign Up", position ? { position } : undefined);
  },
  pricingCtaClicked: (
    posthog: PostHog,
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
  appDownloadClicked: (posthog: PostHog, platform: "ios" | "android") => {
    posthog?.capture?.("Clicked App Download", { platform });
  },
};
