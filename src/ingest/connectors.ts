// Connectors pull data from a source and hand back normalized objects.
//
// The demo connector replays fixtures. A real connector (Gmail via its API, or via
// an integration layer such as Composio for OAuth + token refresh) implements the
// same interface, so nothing downstream changes when real accounts are connected.

import type { Account, SourceObject } from "../core/types.ts";
import { calendarEvents, demoUser, driveFiles, genericRecords, gmailMessages, outlookMessages } from "./fixtures.ts";
import { fromRecord } from "./generic.ts";
import { fromGcal, fromGdrive, fromGmail, fromOutlook } from "./normalize.ts";

export interface SourceConnector {
  account: Account;
  /** Return everything new since `cursor` plus the cursor to use next time. */
  sync(cursor?: string): Promise<{ objects: SourceObject[]; cursor: string }>;
}

class DemoConnector implements SourceConnector {
  account: Account;
  private produce: () => SourceObject[];

  constructor(account: Account, produce: () => SourceObject[]) {
    this.account = account;
    this.produce = produce;
  }

  async sync(cursor?: string) {
    // Fixtures never change, so a second sync returns nothing new.
    return { objects: cursor ? [] : this.produce(), cursor: "demo-synced" };
  }
}

export function demoConnectors(): SourceConnector[] {
  const acct = (id: string) => demoUser.accounts.find((a) => a.id === id)! as Account;
  return [
    new DemoConnector(acct("acct_gmail"), () =>
      gmailMessages.map((m) => ({ kind: "message", value: fromGmail(m, "acct_gmail") }) as const)),
    new DemoConnector(acct("acct_outlook"), () =>
      outlookMessages.map((m) => ({ kind: "message", value: fromOutlook(m, "acct_outlook") }) as const)),
    new DemoConnector(acct("acct_gcal"), () =>
      calendarEvents.map((e) => ({ kind: "event", value: fromGcal(e, "acct_gcal") }) as const)),
    new DemoConnector(acct("acct_gdrive"), () =>
      driveFiles.map((f) => ({ kind: "doc", value: fromGdrive(f, "acct_gdrive") }) as const)),
    // One connector per long-tail app, all through the same generic mapper.
    ...["acct_slack", "acct_notion"].map((accountId) =>
      new DemoConnector(acct(accountId), () =>
        genericRecords
          .filter((r) => r.accountId === accountId)
          .map((r, i) => ({
            kind: "item",
            value: fromRecord(r.app, r.type, r.record, { provider: r.app, sourceId: `${r.type}_${i}`, accountId }, r.hints),
          }) as const))),
  ];
}
