import { describe, expect, it } from "vitest";
import { findPlaceholders } from "./find-placeholders";

describe("findPlaceholders", () => {
  it.each([
    ["Hi {name},", ["{name}"]],
    ["Hi {first_name}, write to {email}", ["{first_name}", "{email}"]],
    ["Dear {{ first_name }},", ["{{ first_name }}"]],
    ["Dear {{customer.name}},", ["{{customer.name}}"]],
    ["Hi [Name],", ["[Name]"]],
    ["Welcome to [COMPANY]", ["[COMPANY]"]],
    ["Hi [First Name], from [YOUR NAME]", ["[First Name]", "[YOUR NAME]"]],
    ["Meeting on <insert date>", ["<insert date>"]],
    ["Hola <nombre del cliente>", ["<nombre del cliente>"]],
    ["Total: XXX", ["XXX"]],
    ["Call us at XXXX-XXXX", ["XXXX"]],
    ["Launch date: TBD.", ["TBD"]],
    ["Hallo [Vorname],", ["[Vorname]"]],
    ["Привет, [Имя]!", ["[Имя]"]],
  ])("finds the placeholder in %j", (text, expected) => {
    expect(findPlaceholders(text)).toEqual(expected);
  });

  it("lists each placeholder once, in the order written", () => {
    expect(findPlaceholders("{name} and [Name] and {name} and TBD")).toEqual([
      "{name}",
      "[Name]",
      "TBD",
    ]);
  });

  it.each([
    "Sounds good, see you at noon.",
    "See reference [1] and [2, 3] and [sic].",
    "He said [...] and left [x] [ ] [!]",
    "Read the [docs](https://example.com/docs) first",
    "Read [Docs](https://example.com) first",
    "Alex <alex@example.com> wrote",
    "Write to <alex@example.com>",
    "Visit https://example.com/{name}/[ID]/TBD today",
    "Visit www.example.com/{name} today",
    "Mail xxx@example.com or TBD@example.com",
    'Send {"a": 1} and {a, b} and {}',
    "Set {id} in the template",
    "if (a < b && c > d) return",
    "5 < 6 and 7 > 3",
    "Lots of love, xxx",
    "Next steps tbd with Sam",
    "Use `{name}` and `[Name]` in the template",
    "Use <p> and <br> tags",
    "The 3 XXXL shirts",
    "Roman numeral [IV] and [Q3] and [A1]",
    "[Q3] plan",
  ])("does not flag %j", (text) => {
    expect(findPlaceholders(text)).toEqual([]);
  });
});
