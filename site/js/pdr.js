// Pedestrian dead reckoning helpers shared by the walking survey: step detection from the
// accelerometer and heading from the gyroscope-based orientation. Pure, no DOM.

/**
 * Steps from acceleration (incl. gravity): low-passed magnitude, a step is a peak above a slow
 * baseline followed by a drop below it, at most one every 300 ms. Orientation independent.
 */
export class StepDetector {
  constructor() {
    this.lp = 9.8;
    this.base = 9.8;
    this.armed = false;
    this.last = -Infinity;
  }

  /** Feed one sample (t in ms); true when it completes a step. */
  feed(t, ax, ay, az) {
    const mag = Math.hypot(ax, ay, az);
    this.lp = this.lp * 0.8 + mag * 0.2;
    this.base = this.base * 0.98 + this.lp * 0.02;
    if (!this.armed && this.lp > this.base + 1.2) this.armed = true;
    if (this.armed && this.lp < this.base) {
      this.armed = false;
      if (t - this.last > 300) {
        this.last = t;
        return true;
      }
    }
    return false;
  }
}

/**
 * Heading (degrees, clockwise) from a deviceorientation alpha. On iPhone alpha comes from the
 * gyroscope and is relative to where the phone pointed when sensing started (not magnetic north),
 * which is what we want indoors, where steel and wiring throw compasses off.
 */
export const headingFromAlpha = (alpha) => (360 - alpha + 360) % 360;

/** Typical walking step length (metres) for a body height in cm. */
export const stepLengthFor = (heightCm) => Math.round(heightCm * 0.00413 * 100) / 100;

/** Signed smallest difference a − b of two angles in degrees, in (−180, 180]. */
export const angleDiff = (a, b) => {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
};

/** Circular mean of angles in degrees. */
export function meanAngle(list) {
  let s = 0, c = 0;
  for (const a of list) { s += Math.sin((a * Math.PI) / 180); c += Math.cos((a * Math.PI) / 180); }
  return (Math.atan2(s, c) * 180) / Math.PI;
}
