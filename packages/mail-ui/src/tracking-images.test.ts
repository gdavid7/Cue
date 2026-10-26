import { describe, expect, it } from "vitest";
import { stripTrackingImages } from "./tracking-images";

describe("stripTrackingImages", () => {
  it.each([
    [
      "1x1 attributes",
      '<img src="https://news.example.com/o/abc" width="1" height="1" alt="">',
    ],
    ["unquoted 1x1", "<img src=https://e.example.com/p.gif width=1 height=1>"],
    [
      "0x0 attributes",
      '<img src="https://e.example.com/p" width="0" height="0">',
    ],
    [
      "1px inline style",
      '<img src="https://e.example.com/p" style="width:1px;height:1px;border:0">',
    ],
    [
      "style overrides larger attributes",
      '<img src="https://e.example.com/p" width="600" style="width:1px!important;height:1px">',
    ],
    ["zero height only", '<img src="https://e.example.com/p" height="0">'],
    [
      "display none without a size",
      '<img src="https://e.example.com/p" style="display: none">',
    ],
    [
      "visibility hidden",
      '<img src="https://e.example.com/p" style="visibility:hidden">',
    ],
    ["opacity zero", '<img src="https://e.example.com/p" style="opacity:0">'],
    ["hidden attribute", '<img src="https://e.example.com/p" hidden>'],
    [
      "protocol-relative 1x1",
      '<img src="//e.example.com/p" width="1" height="1">',
    ],
    [
      "Mailchimp open path",
      '<img src="https://acme.us1.list-manage.com/track/open.php?u=1&amp;id=2">',
    ],
    [
      "SendGrid open path",
      '<img src="https://u123.ct.example.com/wf/open?upn=x">',
    ],
    [
      "Amazon SES open host",
      '<img src="https://abc.r.us-east-1.awstrack.me/I0/0100/xyz/1" alt="">',
    ],
    ["Mailtrack host", '<img src="https://mailtrack.io/trace/mail/abc.png">'],
    [
      "Salesforce Marketing Cloud open path",
      '<img src="https://cl.s7.exct.net/open.aspx?ffcb10-x" width="0">',
    ],
    [
      "quoted > inside another attribute",
      '<img alt="a > b" src="https://e.example.com/p" width="1" height="1">',
    ],
  ])("removes %s", (_name, tag) => {
    const result = stripTrackingImages(`<p>Hi</p>${tag}<p>Bye</p>`);
    expect(result).toEqual({ html: "<p>Hi</p><p>Bye</p>", hiddenCount: 1 });
  });

  it.each([
    [
      "a visible 16px icon",
      '<img src="https://e.example.com/i.png" width="16" height="16">',
    ],
    ["an image with no size", '<img src="https://e.example.com/photo.jpg">'],
    [
      "a full-width 1px divider",
      '<img src="https://e.example.com/line.gif" width="100%" height="1">',
    ],
    [
      "a 600x1 divider",
      '<img src="https://e.example.com/line.gif" width="600" height="1">',
    ],
    [
      "a 1x20 spacer",
      '<img src="https://e.example.com/s.gif" width="1" height="20">',
    ],
    [
      "a hidden mobile-only hero with a real size",
      '<img src="https://e.example.com/hero-m.jpg" width="600" style="display:none;max-height:0">',
    ],
    [
      "an inline cid image",
      '<img src="cid:logo@example" width="1" height="1">',
    ],
    [
      "a data URI",
      '<img src="data:image/gif;base64,R0lGOD" width="1" height="1">',
    ],
    ["an image with no src", '<img width="1" height="1">'],
    [
      "a 1px max-width that does not set the size",
      '<img src="https://e.example.com/p.png" style="max-width:1px">',
    ],
  ])("keeps %s", (_name, tag) => {
    const html = `<p>Hi</p>${tag}`;
    expect(stripTrackingImages(html)).toEqual({ html, hiddenCount: 0 });
  });

  it("counts every tracker in a message", () => {
    const html = [
      '<img src="https://e.example.com/logo.png" width="120" height="40">',
      '<img src="https://e.example.com/a" width="1" height="1">',
      '<img src="https://mailtrack.io/trace/mail/x.png">',
    ].join("");
    expect(stripTrackingImages(html)).toEqual({
      html: '<img src="https://e.example.com/logo.png" width="120" height="40">',
      hiddenCount: 2,
    });
  });

  it("returns empty html unchanged", () => {
    expect(stripTrackingImages("")).toEqual({ html: "", hiddenCount: 0 });
  });
});
