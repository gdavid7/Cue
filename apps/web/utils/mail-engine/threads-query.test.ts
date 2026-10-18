import { describe, expect, it } from "vitest";
import { threadsQueryToPredicate } from "./threads-query";

describe("threadsQueryToPredicate", () => {
  it("maps unread inbox queries onto a same-message all-predicate", () => {
    expect(threadsQueryToPredicate({ type: "unread" })).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        { kind: "read", value: false },
      ],
    });
  });

  it("maps the Important view onto Gmail's IMPORTANT label across the mailbox", () => {
    expect(threadsQueryToPredicate({ type: "important" })).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "all" },
        { kind: "membership", membership: "label", id: "IMPORTANT" },
      ],
    });
  });

  it("maps Outlook inbox sections onto an inbox section predicate", () => {
    expect(
      threadsQueryToPredicate({ type: "inbox", inboxSection: "focused" }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "inbox" },
        { kind: "inbox_section", section: "focused" },
      ],
    });
  });

  it("maps match-any Outlook inbox section leaves without treating them as unread", () => {
    expect(
      threadsQueryToPredicate({
        type: "inbox",
        anyOf: [{ inboxSection: "other" }],
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "inbox" },
        {
          kind: "any",
          predicates: [{ kind: "inbox_section", section: "other" }],
        },
      ],
    });
  });

  it("maps Gmail category types onto category membership", () => {
    expect(threadsQueryToPredicate({ type: "CATEGORY_PROMOTIONS" })).toEqual({
      kind: "membership",
      membership: "category",
      id: "CATEGORY_PROMOTIONS",
    });
  });

  it("maps split labelIds onto the same-message inbox and category predicates", () => {
    expect(
      threadsQueryToPredicate({
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        {
          kind: "membership",
          membership: "category",
          id: "CATEGORY_PROMOTIONS",
        },
      ],
    });
  });

  it("maps starred split labelIds onto the starred flag, not a STARRED label", () => {
    expect(threadsQueryToPredicate({ labelIds: ["INBOX", "STARRED"] })).toEqual(
      {
        kind: "all",
        predicates: [
          { kind: "role", role: "inbox" },
          { kind: "starred", value: true },
        ],
      },
    );
  });

  it("ORs anyLabelIds on top of required inbox membership", () => {
    expect(
      threadsQueryToPredicate({
        labelIds: ["INBOX"],
        anyLabelIds: ["Label_users", "Label_customers"],
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        {
          kind: "any",
          predicates: [
            { kind: "membership", membership: "label", id: "Label_users" },
            { kind: "membership", membership: "label", id: "Label_customers" },
          ],
        },
      ],
    });
  });

  it("matches mail Cue sorted by the message ids Cue recorded for it", () => {
    const membership = {
      TO_REPLY: ["m-reply"],
      NEWSLETTER: ["m-news"],
      MARKETING: ["m-promo"],
    };

    expect(
      threadsQueryToPredicate(
        { labelIds: ["INBOX"], cue: ["TO_REPLY"] },
        membership,
      ),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        { kind: "message", ids: ["m-reply"] },
      ],
    });

    expect(
      threadsQueryToPredicate(
        {
          labelIds: ["INBOX"],
          anyOf: [{ cue: "NEWSLETTER" }, { cue: "MARKETING" }],
        },
        membership,
      ),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        {
          kind: "any",
          predicates: [
            { kind: "message", ids: ["m-news"] },
            { kind: "message", ids: ["m-promo"] },
          ],
        },
      ],
    });

    expect(
      threadsQueryToPredicate(
        {
          type: "inbox",
          excludeSplits: [
            { matchAll: true, filters: [{ kind: "CUE", value: "TO_REPLY" }] },
          ],
        },
        membership,
      ),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "inbox" },
        {
          kind: "not",
          predicate: {
            kind: "any",
            predicates: [
              {
                kind: "all",
                predicates: [{ kind: "message", ids: ["m-reply"] }],
              },
            ],
          },
        },
      ],
    });
  });

  it("matches nothing for Cue sorting it hasn't loaded, rather than the whole inbox", () => {
    expect(
      threadsQueryToPredicate({ labelIds: ["INBOX"], cue: ["TO_REPLY"] }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        { kind: "message", ids: [] },
      ],
    });
  });

  it("excludes Gmail category splits from Other using category membership", () => {
    expect(
      threadsQueryToPredicate({
        type: "inbox",
        excludeSplits: [
          {
            matchAll: true,
            filters: [{ kind: "CATEGORY", value: "CATEGORY_PROMOTIONS" }],
          },
        ],
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "inbox" },
        {
          kind: "not",
          predicate: {
            kind: "any",
            predicates: [
              {
                kind: "all",
                predicates: [
                  {
                    kind: "membership",
                    membership: "category",
                    id: "CATEGORY_PROMOTIONS",
                  },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  // What each operator matches is covered against the store in
  // search-query-predicate.test.ts.
  it("hands a typed search to the provider verbatim, inside Gmail's default scope", () => {
    expect(
      threadsQueryToPredicate({ q: " from:amy@example.com is:unread " }),
    ).toEqual({
      kind: "all",
      predicates: [
        {
          kind: "search",
          query: "from:amy@example.com is:unread",
          local: {
            kind: "all",
            predicates: [
              {
                kind: "address",
                field: "from",
                value: "amy@example.com",
                match: "address",
              },
              { kind: "read", value: false },
            ],
          },
        },
        { kind: "mailbox", mailbox: "all" },
      ],
    });
  });

  it("resolves label names with the labels it is given", () => {
    expect(
      threadsQueryToPredicate({ q: "label:work" }, undefined, {
        labels: [{ id: "Label_1", name: "Work" }],
      }),
    ).toMatchObject({
      predicates: [
        {
          kind: "search",
          local: { kind: "membership", membership: "label", id: "Label_1" },
        },
        { kind: "mailbox", mailbox: "all" },
      ],
    });
  });
});
