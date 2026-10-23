"use client";

import { useCallback, useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  type ImportantPerson,
  importantPeopleIndex,
  normalizeImportantPersonAddress,
  type SetImportantPersonInput,
  supportsImportantPeople,
} from "@inboxzero/mail-core/important-people";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import {
  announceImportantPeopleChange,
  IMPORTANT_PEOPLE_KEY,
  isImportantPeopleKey,
} from "@/utils/mail-engine/important-people-changes";

const NO_PEOPLE: ImportantPerson[] = [];

/**
 * The people starred as Important in these accounts, read from this device's
 * mail store. Nothing about them is sent to Cue's servers.
 */
export function useImportantPeople(accountIds: readonly string[]) {
  const contextClient = useOptionalMailClient();
  const client = contextClient ?? getActiveMailClient();
  const supported = supportsImportantPeople(client);
  const ids = useMemo(() => [...new Set(accountIds)].sort(), [accountIds]);
  const { data } = useSWR(
    supported && ids.length ? [IMPORTANT_PEOPLE_KEY, ids.join("\u0000")] : null,
    () => (supported ? client.queryImportantPeople(ids) : NO_PEOPLE),
    { shouldRetryOnError: false, keepPreviousData: true },
  );
  const people = data ?? NO_PEOPLE;
  const index = useMemo(() => importantPeopleIndex(people), [people]);
  const isImportant = useCallback(
    (accountId: string, addressOrHeader: string) =>
      supported && index.has(accountId, addressOrHeader),
    [index, supported],
  );
  return { supported, people, isImportant };
}

/**
 * Stars or unstars someone everywhere it shows at once, then saves it to the
 * local store. A failed save puts the stars back as they were and rejects.
 */
export function useSetImportantPerson() {
  const contextClient = useOptionalMailClient();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (input: SetImportantPersonInput) => {
      const client = contextClient ?? getActiveMailClient();
      const email = normalizeImportantPersonAddress(input.email);
      if (!supportsImportantPeople(client) || !email)
        throw new Error("important_people_unavailable");
      const addedAtMs = Date.now();
      await mutate<ImportantPerson[]>(
        isImportantPeopleKey,
        (current) =>
          applyStar(current ?? NO_PEOPLE, { ...input, email }, addedAtMs),
        { revalidate: false },
      );
      try {
        await client.setImportantPerson({ ...input, email });
        announceImportantPeopleChange();
      } finally {
        await mutate(isImportantPeopleKey);
      }
    },
    [contextClient, mutate],
  );
}

function applyStar(
  people: ImportantPerson[],
  input: SetImportantPersonInput,
  addedAtMs: number,
) {
  const accounts = new Set(input.accountIds);
  const others = people.filter(
    (person) =>
      !(accounts.has(person.accountId) && person.email === input.email),
  );
  if (!input.important) return others;
  const kept = people.filter(
    (person) => accounts.has(person.accountId) && person.email === input.email,
  );
  const added = [...accounts]
    .filter(
      (accountId) => !kept.some((person) => person.accountId === accountId),
    )
    .map((accountId) => ({ accountId, email: input.email, addedAtMs }));
  return [...others, ...kept, ...added];
}
