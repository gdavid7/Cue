"use client";

import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyInput({
  value,
  masked,
}: {
  value: string;
  masked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(!masked);

  return (
    <div className="flex w-full flex-1 items-center gap-1">
      <input
        className="block w-full flex-1 rounded-md border-input bg-background shadow-sm focus:border-ring focus:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:ring-border sm:text-sm"
        name="copy-input"
        type={visible ? "text" : "password"}
        value={value}
        readOnly
        disabled
      />
      {masked && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? (
            <EyeOffIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </Button>
      )}
      <Button
        variant="outline"
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
        }}
      >
        <CopyIcon className="mr-2 size-4" />
        {copied ? "Copied!" : "Copy"}
      </Button>
    </div>
  );
}
