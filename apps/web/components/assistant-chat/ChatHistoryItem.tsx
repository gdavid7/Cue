"use client";

import { useRef, useState } from "react";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatHistoryEntry } from "@/components/assistant-chat/chat-history-types";
import { getChatHistoryLabel } from "@/components/assistant-chat/chat-history-types";

export function ChatHistoryItem({
  chat,
  onSelect,
  onRename,
  onDelete,
}: {
  chat: ChatHistoryEntry;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  return (
    <div className="group/chat-row relative flex items-center">
      <DropdownMenuItem
        ref={rowRef}
        className="flex-1 truncate pr-9 pointer-coarse:pr-11"
        // The history menu keeps Tab, so the options button beside the row
        // can't be tabbed to; ArrowRight opens them, as it would a submenu.
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight") return;
          e.preventDefault();
          setMenuOpen(true);
        }}
        onSelect={() => onSelect()}
        onPointerLeave={(e) => {
          if (menuOpen) e.preventDefault();
        }}
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{getChatHistoryLabel(chat)}</span>
          <span className="truncate text-muted-foreground text-xs">
            {chat.disconnected ? `${chat.email} · Disconnected` : chat.email}
          </span>
        </span>
      </DropdownMenuItem>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Chat options"
            className={
              "absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 focus:outline-none pointer-coarse:size-9 " +
              (menuOpen
                ? "opacity-100"
                : "opacity-0 group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 pointer-coarse:opacity-100")
            }
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setMenuOpen(true);
            }}
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="right"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Dismissed from the keyboard with the history menu still open:
            // carry on from this row rather than losing focus.
            if (document.activeElement === document.body) {
              rowRef.current?.focus();
            }
          }}
          onFocusOutside={(e) => e.preventDefault()}
        >
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              onRename();
            }}
          >
            <PencilIcon className="mr-2 size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              onDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2Icon className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
