// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "@/app/(landing)/privacy/page";
import TermsPage from "@/app/(landing)/terms/page";
import { LEGAL } from "@/utils/legal";

describe.each([
  ["privacy", PrivacyPage],
  ["terms", TermsPage],
])("%s page", (_name, Page) => {
  afterEach(cleanup);

  it("renders no drafting markers and uses the configured effective date", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";

    expect(text).not.toContain("[VERIFY");
    expect(text).not.toContain("[EFFECTIVE DATE]");
    expect(text).toContain(`Effective date: ${LEGAL.effectiveDate}`);
  });
});
