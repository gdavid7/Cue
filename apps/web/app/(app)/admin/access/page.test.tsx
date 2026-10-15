import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { env } from "@/env";
import { PageHeader } from "@/components/PageHeader";
import { AccessRequests } from "@/app/(app)/admin/access/AccessRequests";
import { AddToBeta } from "@/app/(app)/admin/access/AddToBeta";
import AdminAccessPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: {
    ADMINS: ["founder@example.com"],
    NEXT_PUBLIC_BASE_URL: "https://cue.example",
    AUTH_WAITLIST_ENABLED: false,
    AUTH_ALLOWED_EMAILS: ["founder@example.com"],
  },
}));

describe("/admin/access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.accessRequest.findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    Object.assign(env, { AUTH_ALLOWED_EMAILS: ["founder@example.com"] });
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access and loads no requests when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminAccessPage();

    expect(page.props.title).toBe("No Access");
    expect(prisma.accessRequest.findMany).not.toHaveBeenCalled();
  });

  it("lists requests for the founder", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com", name: "Dee" },
    });

    const page = await AdminAccessPage();

    expect(page.props.title).toBeUndefined();
    expect(prisma.accessRequest.findMany).toHaveBeenCalledTimes(1);
  });

  it("puts the add-someone card above the request list", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com", name: "Dee" },
    });

    const children = childTypes(await AdminAccessPage());

    expect(children[0]).toBe(PageHeader);
    expect(children[1]).toBe(AddToBeta);
    expect(children.indexOf(AddToBeta)).toBeLessThan(
      children.indexOf(AccessRequests),
    );
  });

  // Production runs with the waitlist off and an allow-list, where approvals
  // here also let people in; the header must not say sign-up is open.
  it.each([
    [{ AUTH_ALLOWED_EMAILS: ["founder@example.com"] }, /approved here/],
    [{ AUTH_ALLOWED_EMAILS: undefined }, /anyone can sign up/],
  ])("describes who can sign up with the waitlist off (%j)", async (overrides, expected) => {
    Object.assign(env, overrides);
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com", name: "Dee" },
    });

    const header = (await AdminAccessPage()).props.children[0];

    expect(header.props.description).toMatch(expected);
  });
});

function childTypes(page: { props: { children: unknown[] } }) {
  return page.props.children
    .filter(
      (child): child is { type: unknown } =>
        !!child && typeof child === "object",
    )
    .map((child) => child.type);
}
