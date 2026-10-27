/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { isTrackingImage } from "./tracking-images";

describe("isTrackingImage", () => {
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
    [
      "a 1px height with no width",
      '<img src="https://e.example.com/p" height="1">',
    ],
    ["zero height only", '<img src="https://e.example.com/p" height="0">'],
    [
      "a 1px width with no height",
      '<img src="https://e.example.com/p" width="1">',
    ],
    [
      "a hidden 1x1",
      '<img src="https://e.example.com/p" width="1" height="1" style="display:none">',
    ],
    [
      "protocol-relative 1x1",
      '<img src="//e.example.com/p" width="1" height="1">',
    ],
    [
      "a 1x1 with only a srcset",
      '<img srcset="https://t.example.com/o.gif 1x" width="1" height="1">',
    ],
    [
      "Mailchimp open path",
      '<img src="https://acme.us1.list-manage.com/track/open.php?u=1&amp;id=2">',
    ],
    [
      "Mandrill open path",
      '<img src="https://mandrillapp.com/track/open.php?u=1">',
    ],
    [
      "SendGrid open path",
      '<img src="https://u123.ct.sendgrid.net/wf/open?upn=x">',
    ],
    [
      "Salesforce Marketing Cloud open path",
      '<img src="https://cl.s7.exct.net/open.aspx?ffcb10-x">',
    ],
    [
      "Amazon SES open host",
      '<img src="https://abc.r.us-east-1.awstrack.me/I0/0100/xyz/1" alt="">',
    ],
    ["Mailtrack host", '<img src="https://mailtrack.io/trace/mail/abc.png">'],
  ])("flags %s", (_name, tag) => {
    expect(isTracker(tag)).toBe(true);
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
      "a 600x1 divider sized by inline style",
      '<img src="https://e.example.com/line.gif" style="width:600px;height:1px">',
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
      "a hidden mobile-only hero with no size",
      '<img src="https://cdn.example/hero-mobile.jpg" class="show-mobile" style="display:none;mso-hide:all">',
    ],
    [
      "an invisible image with no size",
      '<img src="https://e.example.com/p" style="visibility:hidden;opacity:0" hidden>',
    ],
    [
      "a sized image on a tracking-like path of another host",
      '<img src="https://shop.example/track/open" width="300" height="200">',
    ],
    [
      "an unsized image on a tracking-like path of another host",
      '<img src="https://shop.example/wf/open">',
    ],
    [
      "a sized image on a platform's open path",
      '<img src="https://acme.us1.list-manage.com/track/open.php?u=1" width="300" height="200">',
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
      "a sized image with only a srcset",
      '<img srcset="https://e.example.com/a.jpg 1x, https://e.example.com/b.jpg 2x" width="300">',
    ],
    [
      "a 1px max-width that does not set the size",
      '<img src="https://e.example.com/p.png" style="max-width:1px">',
    ],
  ])("keeps %s", (_name, tag) => {
    expect(isTracker(tag)).toBe(false);
  });
});

function isTracker(tag: string) {
  const template = document.createElement("template");
  template.innerHTML = tag;
  const image = template.content.querySelector("img");
  if (!image) throw new Error(`No image in ${tag}`);
  return isTrackingImage((name) => image.getAttribute(name));
}
