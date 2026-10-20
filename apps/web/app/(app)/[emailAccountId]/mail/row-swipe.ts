/**
 * The physics of swiping a mail row on touch: which axis a drag belongs to,
 * how far the row follows the finger, and whether a release commits.
 * Kept free of the DOM so the feel can be tested and tuned in one place.
 */

/** Finger left archives, finger right toggles read, as in Gmail's mobile apps. */
export type RowSwipeAction = "archive" | "toggleRead";

export type RowSwipeAxis = "pending" | "horizontal" | "vertical";

/** Movement before a drag picks an axis, so a tap's jitter does nothing. */
export const AXIS_LOCK_SLOP_PX = 10;
/** Horizontal must clearly dominate, so a slanted scroll stays a scroll. */
const HORIZONTAL_LOCK_RATIO = 1.2;
/** iOS Safari's back gesture starts at the screen edge; leave it alone. */
export const EDGE_GUARD_PX = 16;
const MIN_COMMIT_PX = 56;
const MAX_COMMIT_PX = 160;
const COMMIT_FRACTION = 0.3;
/** Apple's rubber-band constant. */
const RUBBER_BAND = 0.55;
/** The snappier of Apple's two deceleration rates, so a flick throws less far. */
const DECELERATION_RATE = 0.99;
/** Only the last stretch of a drag says how fast it was moving at release. */
const VELOCITY_WINDOW_MS = 100;

export function resolveAxis(dx: number, dy: number): RowSwipeAxis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < AXIS_LOCK_SLOP_PX) return "pending";
  return ax > ay * HORIZONTAL_LOCK_RATIO ? "horizontal" : "vertical";
}

export function getCommitThreshold(width: number) {
  return Math.min(
    MAX_COMMIT_PX,
    Math.max(MIN_COMMIT_PX, width * COMMIT_FRACTION),
  );
}

export function getSwipeAction(offset: number): RowSwipeAction | null {
  if (offset < 0) return "archive";
  if (offset > 0) return "toggleRead";
  return null;
}

/**
 * Where the row sits for a finger `travel` px from rest: 1:1 up to the commit
 * threshold, then resisting progressively. A direction that does nothing
 * resists from the start, so it reads as "nothing here" rather than frozen.
 */
export function getSwipeOffset({
  travel,
  width,
  enabled,
}: {
  travel: number;
  width: number;
  enabled: Record<RowSwipeAction, boolean>;
}) {
  const action = getSwipeAction(travel);
  if (!action) return 0;
  const sign = Math.sign(travel);
  const distance = Math.abs(travel);
  if (!enabled[action]) return sign * rubberBand(distance, width);
  const threshold = getCommitThreshold(width);
  if (distance <= threshold) return travel;
  return sign * (threshold + rubberBand(distance - threshold, width));
}

/**
 * The finger travel that puts the row at `offset`: the inverse of
 * `getSwipeOffset`, so a row grabbed mid-flight keeps its place under the finger.
 */
export function getSwipeTravel({
  offset,
  width,
  enabled,
}: {
  offset: number;
  width: number;
  enabled: Record<RowSwipeAction, boolean>;
}) {
  const action = getSwipeAction(offset);
  if (!action) return 0;
  const sign = Math.sign(offset);
  const distance = Math.abs(offset);
  if (!enabled[action]) return sign * unRubberBand(distance, width);
  const threshold = getCommitThreshold(width);
  if (distance <= threshold) return offset;
  return sign * (threshold + unRubberBand(distance - threshold, width));
}

export function isArmed({
  offset,
  width,
  enabled,
}: {
  offset: number;
  width: number;
  enabled: Record<RowSwipeAction, boolean>;
}) {
  const action = getSwipeAction(offset);
  return (
    !!action && enabled[action] && Math.abs(offset) >= getCommitThreshold(width)
  );
}

/**
 * Commits when the release, projected forward by its momentum, lands past the
 * threshold on the side the row was pulled to. A quick flick commits early;
 * pulling back before letting go cancels.
 */
export function resolveRelease({
  offset,
  velocity,
  width,
  enabled,
}: {
  offset: number;
  /** px/s, positive to the right. */
  velocity: number;
  width: number;
  enabled: Record<RowSwipeAction, boolean>;
}): RowSwipeAction | null {
  const action = getSwipeAction(offset);
  if (!action || !enabled[action]) return null;
  const projected = offset + project(velocity);
  if (Math.sign(projected) !== Math.sign(offset)) return null;
  return Math.abs(projected) >= getCommitThreshold(width) ? action : null;
}

export type VelocitySample = { x: number; t: number };

/** px/s over the last stretch of the drag. */
export function getReleaseVelocity(samples: VelocitySample[]) {
  const last = samples.at(-1);
  if (!last) return 0;
  const first =
    samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0;
}

/**
 * A critically damped spring (Apple's damping 1.0), solved exactly so it can
 * start from wherever the row is, at whatever speed the finger left it.
 */
export function springAt({
  from,
  to,
  velocity,
  response,
  elapsed,
}: {
  from: number;
  to: number;
  /** px/s */
  velocity: number;
  /** seconds */
  response: number;
  /** seconds */
  elapsed: number;
}) {
  const omega = (2 * Math.PI) / response;
  const x0 = from - to;
  const b = velocity + omega * x0;
  const decay = Math.exp(-omega * elapsed);
  return {
    value: to + (x0 + b * elapsed) * decay,
    velocity: (b - omega * (x0 + b * elapsed)) * decay,
  };
}

function project(velocity: number) {
  return ((velocity / 1000) * DECELERATION_RATE) / (1 - DECELERATION_RATE);
}

function rubberBand(overshoot: number, dimension: number) {
  return (
    (overshoot * dimension * RUBBER_BAND) /
    (dimension + RUBBER_BAND * overshoot)
  );
}

function unRubberBand(offset: number, dimension: number) {
  // The band approaches `dimension` but never reaches it.
  const bounded = Math.min(offset, dimension * 0.999);
  return (bounded * dimension) / (RUBBER_BAND * (dimension - bounded));
}
