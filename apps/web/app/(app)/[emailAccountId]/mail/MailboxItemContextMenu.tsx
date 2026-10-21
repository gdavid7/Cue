"use client";

import {
  type ComponentType,
  type FormEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { EmailLabelColor } from "@/utils/email/types";
import {
  labelVisibility,
  messageVisibility,
  type LabelVisibility,
  type MessageVisibility,
} from "@/utils/gmail/constants";
import { cn } from "@/utils";

export type MailboxItem = {
  id: string;
  kind: "label" | "folder";
  name: string;
};

export type MailboxItemEdit =
  | MailboxItem
  | {
      id: string;
      kind: "label";
      color?: EmailLabelColor;
      name?: string;
      labelListVisibility?: LabelVisibility;
      messageListVisibility?: MessageVisibility;
    };

/** Gmail's per-label visibility, as the label currently has it set. */
export type MailboxItemVisibility = {
  labelList?: string;
  messageList?: string;
};

const LABEL_LIST_OPTIONS = [
  { value: labelVisibility.labelShow, name: "Show" },
  { value: labelVisibility.labelShowIfUnread, name: "Show if unread" },
  { value: labelVisibility.labelHide, name: "Hide" },
] as const;

const MESSAGE_LIST_OPTIONS = [
  { value: messageVisibility.show, name: "Show" },
  { value: messageVisibility.hide, name: "Hide" },
] as const;

export type MailboxItemColorOption = EmailLabelColor & { name: string };

export function MailboxItemContextMenu({
  children,
  item,
  typeName,
  editMode,
  currentColor,
  colorOptions = [],
  visibility,
  showOptionsButton = true,
  onEdit,
  onDelete,
}: {
  children: ReactNode;
  item: MailboxItem;
  typeName: string;
  editMode: "name" | "color" | "name-and-color";
  currentColor?: {
    backgroundColor?: string | null;
    textColor?: string | null;
  };
  colorOptions?: readonly MailboxItemColorOption[];
  /** Omitted for providers without visibility settings, which hides the menu section. */
  visibility?: MailboxItemVisibility;
  /** The collapsed rail has no room for the row's options button. */
  showOptionsButton?: boolean;
  onEdit: (edit: MailboxItemEdit) => Promise<boolean>;
  onDelete: (item: MailboxItem) => Promise<boolean>;
}) {
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [name, setName] = useState(item.name);
  const [color, setColor] = useState<EmailLabelColor | null>(null);
  // Opening a dialog from the options menu keeps focus in the dialog rather
  // than letting the closing menu hand it back to its button.
  const openedDialogFromMenu = useRef(false);
  const showsName = editMode !== "color";
  const showsColor = editMode !== "name";

  const openEditor = () => {
    setName(item.name);
    setColor(
      colorOptions.find(
        (option) =>
          option.backgroundColor.toLowerCase() ===
          currentColor?.backgroundColor?.toLowerCase(),
      ) ?? (editMode === "color" ? (colorOptions[0] ?? null) : null),
    );
    setIsEditOpen(true);
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (showsName && !nextName) return;
    if (showsColor && editMode === "color" && !color) return;

    const nameChanged = showsName && nextName !== item.name;
    const colorChanged = Boolean(
      showsColor &&
        color &&
        (color.backgroundColor.toLowerCase() !==
          currentColor?.backgroundColor?.toLowerCase() ||
          color.textColor.toLowerCase() !==
            currentColor?.textColor?.toLowerCase()),
    );

    if (!nameChanged && !colorChanged) {
      setIsEditOpen(false);
      return;
    }

    setIsSaving(true);
    try {
      const edit: MailboxItemEdit =
        item.kind === "folder"
          ? { ...item, name: nextName }
          : {
              kind: "label",
              id: item.id,
              ...(nameChanged ? { name: nextName } : {}),
              ...(colorChanged && color ? { color } : {}),
            };
      const success = await onEdit(edit);
      if (success) setIsEditOpen(false);
    } catch {
      toast.error(`Failed to update ${typeName}. Please try again.`);
    } finally {
      setIsSaving(false);
    }
  };

  const updateVisibility = async (
    update: Pick<
      Extract<MailboxItemEdit, { kind: "label" }>,
      "labelListVisibility" | "messageListVisibility"
    >,
  ) => {
    try {
      await onEdit({ kind: "label", id: item.id, ...update });
    } catch {
      toast.error(`Failed to update ${typeName}. Please try again.`);
    }
  };

  const deleteItem = async () => {
    setIsDeleting(true);
    try {
      const success = await onDelete(item);
      if (success) setIsDeleteOpen(false);
    } catch {
      toast.error(`Failed to delete ${typeName}. Please try again.`);
    } finally {
      setIsDeleting(false);
    }
  };

  const menuItems = (parts: MenuParts) => (
    <MailboxItemMenuItems
      parts={parts}
      typeName={typeName}
      visibility={visibility}
      onEdit={() => {
        openedDialogFromMenu.current = true;
        openEditor();
      }}
      onDelete={() => {
        openedDialogFromMenu.current = true;
        setIsDeleteOpen(true);
      }}
      onVisibilityChange={updateVisibility}
    />
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group/mailbox-item relative",
              // Touch has no hover to reveal the options button, so it stays
              // visible and the row's count moves clear of it.
              showOptionsButton && "[@media(hover:none)]:[&_a]:pr-9",
            )}
          >
            {children}
            {showOptionsButton && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${capitalize(typeName)} options for ${item.name}`}
                    className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground data-[state=open]:opacity-100 group-focus-within/mailbox-item:opacity-100 group-hover/mailbox-item:opacity-100 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-[''] [@media(hover:hover)]:bg-sidebar-accent [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-has-[[aria-current=page]]/mailbox-item:bg-card [@media(hover:hover)]:group-has-[[data-highlighted]]/mailbox-item:bg-card"
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-48"
                  onCloseAutoFocus={(event) => {
                    if (!openedDialogFromMenu.current) return;
                    openedDialogFromMenu.current = false;
                    event.preventDefault();
                  }}
                >
                  {menuItems(DROPDOWN_MENU_PARTS)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {menuItems(CONTEXT_MENU_PARTS)}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Edit {typeName}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitEdit}>
            {showsName && (
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label={`${typeName} name`}
                autoFocus
                maxLength={255}
              />
            )}
            {showsColor && (
              <div
                role="radiogroup"
                aria-label={`${typeName} color`}
                className={cn(
                  "grid grid-cols-[repeat(auto-fit,minmax(2rem,1fr))] gap-3 py-1",
                  showsName && "mt-5",
                )}
              >
                {colorOptions.map((option) => (
                  <button
                    key={`${option.backgroundColor}-${option.textColor}`}
                    type="button"
                    role="radio"
                    aria-label={option.name}
                    aria-checked={
                      color?.backgroundColor === option.backgroundColor &&
                      color.textColor === option.textColor
                    }
                    onClick={() => setColor(option)}
                    className={cn(
                      "mx-auto size-8 rounded-full border-2 border-background shadow-sm ring-offset-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      color?.backgroundColor === option.backgroundColor &&
                        color.textColor === option.textColor &&
                        "ring-2 ring-ring",
                    )}
                    style={{ backgroundColor: option.backgroundColor }}
                  />
                ))}
              </div>
            )}
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsEditOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={isSaving}
                disabled={
                  (showsName && !name.trim()) ||
                  (editMode === "color" && !color)
                }
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {typeName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {item.kind === "folder"
                ? `“${item.name}” and its contents will be removed from your mailbox.`
                : `“${item.name}” will be removed from your mailbox. Your emails aren't deleted, only the ${typeName}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (event) => {
                event.preventDefault();
                await deleteItem();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type MenuParts = {
  Item: ComponentType<{
    className?: string;
    onSelect?: () => void;
    children: ReactNode;
  }>;
  Label: ComponentType<{ className?: string; children: ReactNode }>;
  RadioGroup: ComponentType<{
    value?: string;
    onValueChange?: (value: string) => void;
    children: ReactNode;
  }>;
  RadioItem: ComponentType<{ value: string; children: ReactNode }>;
  Separator: ComponentType;
};

const CONTEXT_MENU_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Separator: ContextMenuSeparator,
};

const DROPDOWN_MENU_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Separator: DropdownMenuSeparator,
};

/** The same menu opens from a right click and from the row's options button. */
function MailboxItemMenuItems({
  parts: { Item, Label, RadioGroup, RadioItem, Separator },
  typeName,
  visibility,
  onEdit,
  onDelete,
  onVisibilityChange,
}: {
  parts: MenuParts;
  typeName: string;
  visibility?: MailboxItemVisibility;
  onEdit: () => void;
  onDelete: () => void;
  onVisibilityChange: (
    update: Pick<
      Extract<MailboxItemEdit, { kind: "label" }>,
      "labelListVisibility" | "messageListVisibility"
    >,
  ) => void;
}) {
  return (
    <>
      <Item className="gap-2" onSelect={onEdit}>
        <PencilIcon className="size-4" />
        Edit
      </Item>
      <Item
        className="gap-2 text-destructive focus:text-destructive"
        onSelect={onDelete}
      >
        <Trash2Icon className="size-4" />
        Delete
      </Item>
      {visibility && (
        <>
          <Separator />
          <Label className="text-muted-foreground text-xs">
            In {typeName} list
          </Label>
          <RadioGroup
            value={visibility.labelList ?? labelVisibility.labelShow}
            onValueChange={(value) =>
              onVisibilityChange({
                labelListVisibility: value as LabelVisibility,
              })
            }
          >
            {LABEL_LIST_OPTIONS.map((option) => (
              <RadioItem key={option.value} value={option.value}>
                {option.name}
              </RadioItem>
            ))}
          </RadioGroup>
          <Separator />
          <Label className="text-muted-foreground text-xs">
            In message list
          </Label>
          <RadioGroup
            value={visibility.messageList ?? messageVisibility.show}
            onValueChange={(value) =>
              onVisibilityChange({
                messageListVisibility: value as MessageVisibility,
              })
            }
          >
            {MESSAGE_LIST_OPTIONS.map((option) => (
              <RadioItem key={option.value} value={option.value}>
                {option.name}
              </RadioItem>
            ))}
          </RadioGroup>
        </>
      )}
    </>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
