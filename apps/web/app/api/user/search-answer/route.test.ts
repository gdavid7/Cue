import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

const mocks = vi.hoisted(() => ({
  searchContext: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (
      _scope: string,
      handler: (request: NextRequest & Record<string, unknown>) => unknown,
    ) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: {
            userId: "user-1",
            emailAccountId: "account-1",
            email: "david@example.com",
          },
          emailProvider: {},
          logger: createScopedLogger("search-answer-test"),
        }),
      ),
}));
vi.mock("@/utils/thread-context/search-context", () => ({
  searchContext: mocks.searchContext,
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => ({
    userId: "user-1",
    email: "david@example.com",
    user: { aiApiKey: "key", aiProvider: null, aiModel: null },
  }),
}));
vi.mock("@/utils/premium/limits", () => ({
  assertHasAiAccess: async () => undefined,
}));
vi.mock("@/utils/llms/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: () => ({}),
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => mocks.generateObject,
}));

import { GET } from "./route";

const PROFESSOR_EMAIL = {
  id: "thread-prof",
  kind: "email",
  title: "CSE 151B: milestone 2 due Friday at 11:59pm",
  snippet: "Milestone 2 is due Friday at 11:59pm. Each group submits one PDF.",
  at: "2026-10-11T16:00:00Z",
  why: [],
};
const CANVAS_ASSIGNMENT = {
  id: "assignment-1",
  kind: "assignment",
  title: "Milestone 2: model evaluation and write-up",
  snippet: "Due Friday 11:59pm",
  at: "2026-10-16T06:59:00Z",
  url: "https://canvas.example.edu/assignments/1",
  source: "CSE 151B",
  why: [],
};
const KEVIN_EMAIL = {
  id: "thread-kevin",
  kind: "email",
  title: "CSE 151B milestone 2: meet Wednesday?",
  snippet: "Can we meet Wednesday at 4pm?",
  at: "2026-10-13T01:40:00Z",
  why: [],
};

describe("GET /api/user/search-answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchContext.mockResolvedValue({
      results: [PROFESSOR_EMAIL, KEVIN_EMAIL, CANVAS_ASSIGNMENT],
    });
  });

  it("answers a question from the sources it cites", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        answer: "Milestone 2 is due Friday at 11:59pm.",
        sourceIds: ["s1", "s3"],
      },
    });

    const body = await get("When is milestone 2 due?");

    expect(body).toEqual({
      answer: "Milestone 2 is due Friday at 11:59pm.",
      sources: [
        {
          id: "thread-prof",
          kind: "email",
          title: PROFESSOR_EMAIL.title,
        },
        {
          id: "assignment-1",
          kind: "assignment",
          title: CANVAS_ASSIGNMENT.title,
          url: CANVAS_ASSIGNMENT.url,
          source: "CSE 151B",
        },
      ],
    });
  });

  it("shows no answer for a plain search", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { answer: null, sourceIds: [] },
    });

    expect(await get("Kevin")).toBeNull();
  });

  it("skips the model when nothing matches", async () => {
    mocks.searchContext.mockResolvedValue({ results: [] });

    expect(await get("quarterly offsite")).toBeNull();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});

async function get(q: string) {
  const response = await GET(
    new NextRequest(
      `http://localhost:3000/api/user/search-answer?q=${encodeURIComponent(q)}`,
    ),
    { params: Promise.resolve({}) },
  );
  return response.json();
}
