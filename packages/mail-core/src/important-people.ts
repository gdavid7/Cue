import { mailClientSupports } from "./capabilities";
import type { MailClient } from "./engine";
import { normalizeAddress } from "./sender-check";

/**
 * Someone the user marked Important in one of their accounts. Kept only in
 * this device's mail store; it never reaches a server.
 */
export type ImportantPerson = {
  accountId: string;
  /** Normalised with `normalizeImportantPersonAddress`. */
  email: string;
  addedAtMs: number;
};

export type SetImportantPersonInput = {
  /** Every account the star applies to, as the person card's scope lists them. */
  accountIds: string[];
  email: string;
  important: boolean;
};

/**
 * The address a star is keyed by, from a bare address or a `Name <address>`
 * header, or null when there's no address in it. The store and every caller
 * that matches mail against stars use this, so a star always finds its mail.
 */
export function normalizeImportantPersonAddress(
  addressOrHeader: string,
): string | null {
  const trimmed = addressOrHeader.trim();
  const bracketed = trimmed.match(/<([^<>]+)>\s*$/u)?.[1];
  const email = normalizeAddress(bracketed ?? trimmed);
  if (email.length > 320) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(email)) return null;
  return email;
}

/**
 * Whether the engine behind this client keeps stars. An older desktop build
 * or an older owner tab doesn't, and then the feature hides.
 */
export function supportsImportantPeople(
  client: Partial<MailClient> | null | undefined,
): client is MailClient &
  Required<Pick<MailClient, "queryImportantPeople" | "setImportantPerson">> {
  return (
    mailClientSupports(client, "method:queryImportantPeople") &&
    mailClientSupports(client, "method:setImportantPerson")
  );
}

/** Looks up a star by account and address, whatever form the address is in. */
export function importantPeopleIndex(people: readonly ImportantPerson[]) {
  const keys = new Set(
    people.map((person) => importantPersonKey(person.accountId, person.email)),
  );
  return {
    has(accountId: string, addressOrHeader: string) {
      const email = normalizeImportantPersonAddress(addressOrHeader);
      return email !== null && keys.has(importantPersonKey(accountId, email));
    },
  };
}

function importantPersonKey(accountId: string, email: string) {
  return `${accountId}\u0000${email}`;
}
