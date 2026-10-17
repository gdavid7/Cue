"use client";

import dynamic from "next/dynamic";
import { Loading } from "@/components/Loading";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";

// Every app page mounts this dialog, but its content is only needed once
// settings are opened.
const SettingsContent = dynamic(
  () =>
    import("@/app/(app)/settings/SettingsContent").then(
      (mod) => mod.SettingsContent,
    ),
  { loading: () => <Loading /> },
);

export function SettingsDialog() {
  const { isSettingsOpen, closeSettings } = useSettingsDialog();

  return (
    <Dialog
      open={isSettingsOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto px-6 py-6">
          <SettingsContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
