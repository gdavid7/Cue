import { describe, expect, it } from "vitest";
import {
  getCommitThreshold,
  getReleaseVelocity,
  getSwipeOffset,
  getSwipeTravel,
  isArmed,
  resolveAxis,
  resolveRelease,
  springAt,
} from "@/app/(app)/[emailAccountId]/mail/row-swipe";

const WIDTH = 390;
const BOTH = { archive: true, toggleRead: true };
const READ_ONLY = { archive: false, toggleRead: true };
const THRESHOLD = getCommitThreshold(WIDTH);

describe("resolveAxis", () => {
  it("waits out a tap's jitter before picking an axis", () => {
    expect(resolveAxis(6, 4)).toBe("pending");
  });

  it("leaves a vertical or slanted drag to the scroll", () => {
    expect(resolveAxis(3, 30)).toBe("vertical");
    // 45 degrees is a scroll as much as a swipe; scrolling wins.
    expect(resolveAxis(20, 20)).toBe("vertical");
  });

  it("takes a clearly sideways drag", () => {
    expect(resolveAxis(-24, 6)).toBe("horizontal");
    expect(resolveAxis(18, 2)).toBe("horizontal");
  });
});

describe("getCommitThreshold", () => {
  it("scales with the row but stays reachable on any screen", () => {
    expect(getCommitThreshold(390)).toBe(117);
    expect(getCommitThreshold(120)).toBe(56);
    expect(getCommitThreshold(1200)).toBe(160);
  });
});

describe("getSwipeOffset", () => {
  it("follows the finger 1:1 up to the commit point", () => {
    expect(getSwipeOffset({ travel: -80, width: WIDTH, enabled: BOTH })).toBe(
      -80,
    );
    expect(
      getSwipeOffset({ travel: THRESHOLD, width: WIDTH, enabled: BOTH }),
    ).toBe(THRESHOLD);
  });

  it("resists past the commit point, more the further it goes", () => {
    const near = getSwipeOffset({
      travel: THRESHOLD + 40,
      width: WIDTH,
      enabled: BOTH,
    });
    const far = getSwipeOffset({
      travel: THRESHOLD + 240,
      width: WIDTH,
      enabled: BOTH,
    });
    expect(near).toBeGreaterThan(THRESHOLD);
    expect(near - THRESHOLD).toBeLessThan(40);
    expect(far - near).toBeLessThan(200);
    // Never past the row itself.
    expect(far).toBeLessThan(THRESHOLD + WIDTH);
  });

  it("resists from the start in a direction that does nothing", () => {
    const offset = getSwipeOffset({
      travel: -100,
      width: WIDTH,
      enabled: READ_ONLY,
    });
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-100);
    expect(isArmed({ offset: -WIDTH, width: WIDTH, enabled: READ_ONLY })).toBe(
      false,
    );
  });

  it("maps back to the finger travel, so a grabbed row stays put", () => {
    for (const travel of [-300, -90, 40, 200]) {
      for (const enabled of [BOTH, READ_ONLY]) {
        const offset = getSwipeOffset({ travel, width: WIDTH, enabled });
        expect(getSwipeTravel({ offset, width: WIDTH, enabled })).toBeCloseTo(
          travel,
          6,
        );
      }
    }
  });
});

describe("resolveRelease", () => {
  it("commits a slow release past the threshold, on its own side", () => {
    expect(
      resolveRelease({
        offset: -(THRESHOLD + 5),
        velocity: 0,
        width: WIDTH,
        enabled: BOTH,
      }),
    ).toBe("archive");
    expect(
      resolveRelease({
        offset: THRESHOLD + 5,
        velocity: 0,
        width: WIDTH,
        enabled: BOTH,
      }),
    ).toBe("toggleRead");
  });

  it("springs back from a slow release short of the threshold", () => {
    expect(
      resolveRelease({
        offset: -(THRESHOLD - 20),
        velocity: 0,
        width: WIDTH,
        enabled: BOTH,
      }),
    ).toBeNull();
  });

  it("commits a quick flick before the threshold", () => {
    expect(
      resolveRelease({
        offset: -50,
        velocity: -1200,
        width: WIDTH,
        enabled: BOTH,
      }),
    ).toBe("archive");
  });

  it("cancels when the finger pulls back before letting go", () => {
    expect(
      resolveRelease({
        offset: -(THRESHOLD + 10),
        velocity: 900,
        width: WIDTH,
        enabled: BOTH,
      }),
    ).toBeNull();
  });

  it("never commits a direction that does nothing", () => {
    expect(
      resolveRelease({
        offset: -WIDTH,
        velocity: -3000,
        width: WIDTH,
        enabled: READ_ONLY,
      }),
    ).toBeNull();
  });
});

describe("getReleaseVelocity", () => {
  it("measures the last stretch of the drag, not the whole of it", () => {
    const samples = [
      { x: 0, t: 0 },
      { x: -10, t: 400 },
      { x: -20, t: 450 },
      { x: -60, t: 500 },
    ];
    expect(getReleaseVelocity(samples)).toBe(-500);
  });

  it("is still for a single sample", () => {
    expect(getReleaseVelocity([{ x: -40, t: 10 }])).toBe(0);
  });
});

describe("springAt", () => {
  it("starts where the row is, at the finger's speed", () => {
    const start = springAt({
      from: -120,
      to: 0,
      velocity: 600,
      response: 0.35,
      elapsed: 0,
    });
    expect(start.value).toBe(-120);
    expect(start.velocity).toBeCloseTo(600, 6);
  });

  it("settles without overshooting", () => {
    let previous = -120;
    for (let t = 0.01; t < 1; t += 0.01) {
      const { value } = springAt({
        from: -120,
        to: 0,
        velocity: 0,
        response: 0.35,
        elapsed: t,
      });
      expect(value).toBeLessThanOrEqual(0);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(Math.abs(previous)).toBeLessThan(0.5);
  });
});
