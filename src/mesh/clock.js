/**
 * Hybrid logical clock.
 *
 * Every write gets a version. When two phones change the same record, the
 * higher version wins on every phone, so they all end up agreeing without
 * talking to a server.
 *
 * Wall-clock time alone is not enough: phone clocks disagree, and two writes
 * can land in the same millisecond. A version is therefore three parts:
 *
 *   wall-clock milliseconds : counter : node id
 *
 * - the counter orders writes that share a millisecond,
 * - the node id breaks any remaining tie the same way everywhere,
 * - seeing a version from another phone pulls this clock forward, so a phone
 *   whose clock is behind still produces versions newer than what it has seen.
 *
 * Versions are fixed-width strings, so plain string comparison orders them.
 */

const MILLIS_WIDTH = 15;
const COUNTER_WIDTH = 5;

// A version further ahead of this phone's clock than this is not followed.
// Without a limit, one phone with a wildly wrong clock (or one bad record)
// would drag every phone's versions into the future, and from then on a
// change made with a correct clock would look older than what it replaces.
const MAX_AHEAD_MS = 60 * 60 * 1000;

const format = (millis, counter, nodeId) =>
  `${String(millis).padStart(MILLIS_WIDTH, '0')}:${counter.toString(36).padStart(COUNTER_WIDTH, '0')}:${nodeId}`;

const parse = (version) => {
  const [millis, counter] = String(version).split(':');
  return { millis: Number(millis), counter: parseInt(counter, 36) };
};

/** The wall-clock time, in milliseconds, a version was written at. */
export const versionMillis = (version) => parse(version).millis;

/** Negative when a is older than b, positive when newer, zero when equal. */
export const compareVersions = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** The smallest version this node can write that is newer than `version`. */
export const nextAfter = (version, nodeId) => {
  const { millis, counter } = parse(version);
  return format(millis, counter + 1, nodeId);
};

export class HybridClock {
  constructor(nodeId, now = () => Date.now()) {
    this.nodeId = nodeId;
    this.now = now;
    this.millis = 0;
    this.counter = 0;
  }

  /** A new version for a local write, newer than anything issued or seen. */
  tick() {
    const wall = this.now();
    if (wall > this.millis) {
      this.millis = wall;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return format(this.millis, this.counter, this.nodeId);
  }

  /** Called for every version received from another phone. */
  observe(version) {
    const remote = parse(version);
    const wall = this.now();
    if (!Number.isFinite(remote.millis) || remote.millis > wall + MAX_AHEAD_MS) return;
    const millis = Math.max(wall, this.millis, remote.millis);
    if (millis === this.millis && millis === remote.millis) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (millis === this.millis) {
      this.counter += 1;
    } else if (millis === remote.millis) {
      this.counter = remote.counter + 1;
    } else {
      this.counter = 0;
    }
    this.millis = millis;
  }
}
