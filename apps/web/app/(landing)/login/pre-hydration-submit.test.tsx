import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewSignInForm } from "@/app/(landing)/app-review/sign-in/ReviewSignInForm";
import { EmailOtpForm } from "@/app/(landing)/login/email/EmailOtpForm";
import { RequestAccessForm } from "@/app/(landing)/login/RequestAccessForm";
import SSOLoginPage from "@/app/(landing)/login/sso/page";

vi.mock("@/utils/auth-client", () => ({ emailOtp: {}, signIn: {} }));
vi.mock("@/utils/actions/access", () => ({ requestAccessAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/utils/analytics/posthog-client", () => ({
  posthog: { capture: vi.fn() },
}));

// Until React hydrates a server-rendered form, a click on its submit button
// submits it natively: a GET that puts the typed email (or password) in the
// URL, where it reaches request logs and browser history, and sends nothing.
describe("sign-in forms rendered on the server", () => {
  it.each<[string, ReactElement]>([
    ["email code", <EmailOtpForm key="otp" callbackURL="/settings" />],
    ["request access", <RequestAccessForm key="access" />],
    ["app review", <ReviewSignInForm key="review" />],
    ["SSO", <SSOLoginPage key="sso" />],
  ])("keep the %s submit button disabled until hydration", (_, form) => {
    const html = renderToString(form);
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(submit).toBeDefined();
    expect(submit).toMatch(/\sdisabled=""/);
  });
});
