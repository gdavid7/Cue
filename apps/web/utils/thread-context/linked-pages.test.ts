import { describe, expect, it, vi } from "vitest";
import { extractMainLinks } from "./linked-pages";

vi.mock("server-only", () => ({}));

const headers = {
  from: "Handshake <notifications@joinhandshake.com>",
  to: "david@example.com",
  subject: "New event",
  date: "2026-10-13T16:00:00Z",
};

describe("extractMainLinks", () => {
  it("keeps the links the email is about and drops the noise around them", () => {
    const links = extractMainLinks({
      headers: {
        ...headers,
        "list-unsubscribe": "<https://mail.joinhandshake.com/u/abc123>",
      },
      textHtml: `
        <a href="https://joinhandshake.com"><img src="https://cdn.joinhandshake.com/logo.png"></a>
        <a href="https://app.joinhandshake.com/login">Ingresar</a>
        <p>Tech & Finance Career Series</p>
        <a href="https://click.joinhandshake.com/ls/click?upn=aGVsbG8">Ver el evento</a>
        <a href="https://app.joinhandshake.com/events/1428571">Ver el evento</a>
        <a href="https://cdn.joinhandshake.com/banner.jpg">Banner</a>
        <a href="https://www.google.com/url?q=https://example.org/page">Redirect</a>
        <a href="https://tracker.example.net/c/Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4">Opaque</a>
        <a href="mailto:events@joinhandshake.com">Escríbenos</a>
        <a href="https://mail.joinhandshake.com/u/abc123">Darse de baja</a>
        <a href="https://joinhandshake.com/unsubscribe?u=1">Unsubscribe</a>
        <a href="https://app.joinhandshake.com/account/notifications">Ajustes</a>
      `,
      textPlain: "",
    });

    expect(links).toEqual(["https://app.joinhandshake.com/events/1428571"]);
  });

  it("puts links with words on them first, and keeps at most two", () => {
    const links = extractMainLinks({
      headers,
      textHtml: `
        <a href="https://example.org/a">https://example.org/a</a>
        <a href="https://example.org/jobs/42">Software Engineer, New Grad</a>
        <a href="https://example.org/docs/guide">The guide</a>
        <a href="https://example.org/blog/post">Our blog</a>
      `,
    });

    expect(links).toEqual([
      "https://example.org/jobs/42",
      "https://example.org/docs/guide",
    ]);
  });

  it("reads links written out in plain text, once each", () => {
    const links = extractMainLinks({
      headers,
      textPlain:
        "RSVP here: https://app.joinhandshake.com/events/1428571. Again: https://app.joinhandshake.com/events/1428571#rsvp",
    });

    expect(links).toEqual(["https://app.joinhandshake.com/events/1428571"]);
  });

  it("keeps another site's login page; only the sender's own is skipped", () => {
    expect(
      extractMainLinks({
        headers,
        textPlain: "https://partner.example.org/login/sso-guide",
      }),
    ).toEqual(["https://partner.example.org/login/sso-guide"]);
  });
});
