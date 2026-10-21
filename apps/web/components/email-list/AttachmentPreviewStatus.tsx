import { Loader2 } from "lucide-react";

export const PREVIEW_UNAVAILABLE = "Preview isn't available for this file.";
export const PREVIEW_TOO_LARGE =
  "This file is too large to preview. Download it to view it.";

export function PreviewSpinner() {
  return <Loader2 className="size-6 animate-spin text-muted-foreground" />;
}

export function PreviewMessage({ children }: { children: string }) {
  return (
    <p className="px-6 text-center text-muted-foreground text-sm">{children}</p>
  );
}
