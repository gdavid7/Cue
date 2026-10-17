import type { LoginProvider } from "@/utils/oauth/login-providers";

export type AuthFunnelProvider = LoginProvider | "unknown";

export function normalizeAuthProvider(value: unknown): AuthFunnelProvider {
  switch (value) {
    case "google":
    case "microsoft":
    case "apple":
    case "sso":
      return value;
    default:
      return "unknown";
  }
}
