import { describe, expect, it } from "vitest";
import { coarseLocation } from "@/utils/weather/coarse-location";

describe("coarseLocation", () => {
  it("rounds a precise fix to about 10 km, and adds no label of its own", () => {
    expect(
      coarseLocation({ latitude: 37.774_929, longitude: -122.419_416 }),
    ).toEqual({ latitude: 37.8, longitude: -122.4 });
  });

  it("keeps the city the user typed", () => {
    expect(
      coarseLocation({
        latitude: 38.716_67,
        longitude: -9.133_33,
        label: "Lisbon",
      }),
    ).toEqual({ latitude: 38.7, longitude: -9.1, label: "Lisbon" });
  });
});
