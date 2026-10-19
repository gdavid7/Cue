"use client";

import dynamic from "next/dynamic";
import { Loading } from "@/components/Loading";
import { loadChunk } from "@/utils/load-chunk";

const importComposeEmailForm = () => import("./ComposeEmailForm");

// keep bundle size down by importing dynamically on use
export const ComposeEmailFormLazy = dynamic(
  () => importComposeEmailForm().then((mod) => mod.ComposeEmailForm),
  {
    loading: () => <Loading />,
  },
);

/**
 * Loads the composer's code ahead of the first "c", which would otherwise
 * wait on the editor's chunks. A background load never reloads the page.
 */
export function preloadComposeEmailForm() {
  loadChunk(importComposeEmailForm, { reloadOnFailure: false }).catch(
    () => undefined,
  );
}
