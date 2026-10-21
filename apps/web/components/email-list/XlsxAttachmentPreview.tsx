"use client";

import { useEffect, useState } from "react";
import readXlsxFile, {
  type CellValue,
  type Sheet,
} from "read-excel-file/browser";
import {
  PREVIEW_UNAVAILABLE,
  PreviewMessage,
  PreviewSpinner,
} from "@/components/email-list/AttachmentPreviewStatus";
import { cn } from "@/utils";

// Enough to recognise a sheet; past this the browser slows and Download is better.
const MAX_ROWS = 500;
const MAX_COLUMNS = 52;

/**
 * Renders an Excel workbook's values as tables, one sheet at a time, in the
 * browser; the file never leaves the device. Formatting, charts and formulas
 * aren't shown, only what the cells hold.
 */
export default function XlsxAttachmentPreview({ file }: { file: Blob }) {
  const [sheets, setSheets] = useState<Sheet[]>();
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    readXlsxFile(file).then(
      (result) => {
        if (!cancelled) setSheets(result);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (failed) return <PreviewMessage>{PREVIEW_UNAVAILABLE}</PreviewMessage>;
  if (!sheets) return <PreviewSpinner />;

  const sheet = sheets[active] ?? sheets[0];
  const rows = sheet?.data ?? [];
  const shownRows = rows.slice(0, MAX_ROWS);
  const columnCount = Math.min(
    MAX_COLUMNS,
    Math.max(0, ...shownRows.map((row) => row.length)),
  );
  const truncated =
    rows.length > MAX_ROWS || rows.some((row) => row.length > MAX_COLUMNS);

  return (
    <div className="flex size-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">
        {columnCount === 0 ? (
          <p className="p-6 text-muted-foreground text-sm">
            This sheet is empty.
          </p>
        ) : (
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className={cn(HEADER_CELL, "left-0 z-20")} />
                {Array.from({ length: columnCount }, (_, column) => (
                  <th className={HEADER_CELL} key={column} scope="col">
                    {columnName(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row, rowIndex) => (
                // Rows have no identity beyond their position in the sheet.
                <tr key={rowIndex}>
                  <th
                    className="sticky left-0 z-10 border-r border-b bg-muted px-2 py-1 text-right font-normal text-muted-foreground"
                    scope="row"
                  >
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: columnCount }, (_, column) => (
                    <td
                      className={cn(
                        "max-w-xs truncate whitespace-nowrap border-r border-b px-2 py-1",
                        typeof row[column] === "number" && "text-right",
                      )}
                      key={column}
                    >
                      {formatCell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {truncated ? (
        <p className="border-t px-4 py-2 text-muted-foreground text-xs">
          Showing the first {MAX_ROWS} rows and {MAX_COLUMNS} columns. Download
          the file to see all of it.
        </p>
      ) : null}
      {sheets.length > 1 ? (
        <div
          aria-label="Sheets"
          className="flex shrink-0 gap-1 overflow-x-auto border-t bg-muted/40 px-2 py-1.5"
          role="group"
        >
          {sheets.map((item, index) => (
            <button
              aria-pressed={index === active}
              className={cn(
                "shrink-0 rounded-md px-3 py-1 text-xs",
                index === active
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-muted",
              )}
              key={item.sheet}
              onClick={() => setActive(index)}
              type="button"
            >
              {item.sheet}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const HEADER_CELL =
  "sticky top-0 z-10 border-r border-b bg-muted px-2 py-1 font-normal text-muted-foreground";

function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function formatCell(value: CellValue | null | undefined) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}
