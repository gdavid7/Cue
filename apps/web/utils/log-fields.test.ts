import { describe, expect, it } from "vitest";
import {
  capLogFields,
  LOG_FIELDS_OVERFLOW_KEY,
  MAX_LOG_FIELD_PATHS,
} from "./log-fields";

describe("capLogFields", () => {
  it("leaves an event within the cap untouched", () => {
    const fields = {
      scope: "test",
      error: { name: "Error", message: "failed", stack: "Error: failed" },
      ids: ["a", "b"],
    };

    expect(capLogFields(fields)).toBe(fields);
  });

  it("keeps an event with data-keyed records to the cap and carries the rest as one JSON string", () => {
    const byCaller = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`caller-${index}`, index]),
    );

    const capped = capLogFields({
      scope: "gmail-quota",
      totalUnits: 4950,
      byCaller,
    });

    expect(flattenKeys(capped).length).toBeLessThanOrEqual(MAX_LOG_FIELD_PATHS);
    expect(capped).toMatchObject({ scope: "gmail-quota", totalUnits: 4950 });
    const overflow = JSON.parse(String(capped[LOG_FIELDS_OVERFLOW_KEY]));
    const keptCallers = Object.keys(capped.byCaller as object);
    // Nothing is lost: every caller is either a column or in the overflow.
    expect([...keptCallers, ...Object.keys(overflow.byCaller)].sort()).toEqual(
      Object.keys(byCaller).sort(),
    );
  });

  it("keeps shallow fields such as an error's name, message and stack ahead of nested detail", () => {
    const capped = capLogFields({
      scope: "api",
      error: {
        config: Object.fromEntries(
          Array.from({ length: 60 }, (_, index) => [
            `param${index}`,
            { value: index },
          ]),
        ),
        name: "GaxiosError",
        message: "Request failed",
        stack: "GaxiosError: Request failed",
      },
      errorMessage: "Request failed",
    });

    expect(capped).toMatchObject({
      scope: "api",
      errorMessage: "Request failed",
      error: {
        name: "GaxiosError",
        message: "Request failed",
        stack: "GaxiosError: Request failed",
      },
    });
    expect(flattenKeys(capped).length).toBe(MAX_LOG_FIELD_PATHS);
  });
});

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}
