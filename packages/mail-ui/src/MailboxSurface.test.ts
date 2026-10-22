import { describe, expect, it } from "vitest";
import { findVisibleRows } from "./MailboxSurface";

// Rows 40px tall from y=0, as getBoundingClientRect reports them.
const rowAt = (index: number) => ({ top: index * 40, bottom: index * 40 + 40 });

describe("findVisibleRows", () => {
  it("counts the rows partly in view at either edge", () => {
    expect(findVisibleRows(50, 100, 300, rowAt)).toEqual({ start: 2, end: 8 });
  });

  it("leaves out a row that only touches an edge", () => {
    expect(findVisibleRows(50, 80, 320, rowAt)).toEqual({ start: 2, end: 8 });
  });

  it("is empty when the list is scrolled past every row", () => {
    expect(findVisibleRows(5, 400, 600, rowAt)).toEqual({ start: 5, end: 5 });
    expect(findVisibleRows(0, 0, 600, rowAt)).toEqual({ start: 0, end: 0 });
  });
});
