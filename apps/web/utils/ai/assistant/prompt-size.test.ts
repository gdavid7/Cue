import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateTextTokens,
} from "@/utils/ai/assistant/prompt-size";

describe("estimateTextTokens", () => {
  it("counts non-Latin characters at a token or more each", () => {
    const english = "Please archive the newsletters from last week.";
    const japanese = "先週のニュースレターをアーカイブしてください。";

    expect(estimateTextTokens(japanese)).toBeGreaterThanOrEqual(
      japanese.length,
    );
    expect(estimateTextTokens(english)).toBeLessThan(english.length / 2);
  });
});

describe("estimateMessageTokens", () => {
  it("counts text, tool calls, tool results and images", () => {
    const text: ModelMessage[] = [{ role: "user", content: "x".repeat(2750) }];
    const withImage: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(2750) },
          { type: "image", image: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    const withToolResult: ModelMessage[] = [
      ...text,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "readEmail",
            output: { type: "json", value: { content: "y".repeat(2750) } },
          },
        ],
      },
    ];

    expect(estimateMessageTokens(text)).toBeGreaterThanOrEqual(1000);
    expect(estimateMessageTokens(withImage)).toBeGreaterThanOrEqual(2600);
    expect(estimateMessageTokens(withToolResult)).toBeGreaterThanOrEqual(2000);
  });
});
