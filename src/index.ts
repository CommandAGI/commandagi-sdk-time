/**
 * TIME — the one common reference every signal in CommandAGI is oriented against.
 *
 * ── The defect this exists to remove ──────────────────────────────────────────────────────────────
 *
 * Before this module the platform carried TEN incompatible notions of "when", and the two that mattered
 * most were "none": the host→DO `frame` and `data` messages carried no capture time at all, so the only
 * timestamp a sample ever received was `Date.now()` in the Durable Object *at the moment the WebSocket
 * message arrived*. Every recorded stream's timeline was therefore network-jitter-shaped, and two
 * channels captured in the same instant on the same laptop landed at different times if they arrived in
 * different messages. Aligning a microphone to a camera was not merely unimplemented; it was impossible.
 *
 * Worse than impossible was the part that silently *worked*: the deixis resolver
 * (`./interaction.ts`) joined a browser's `Date.now()` against a producer's unstated clock inside a
 * ±1500 ms window and returned an answer with no error and no caveat. A viewer whose wall clock was
 * three seconds off resolved "make it more like THIS" to whatever had been under the cursor three
 * seconds earlier, confidently. A system with no concept of time does not fail loudly; it answers the
 * wrong question.
 *
 * ── The model ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Four ideas, and this file names all four:
 *
 * 1. **A time is an INTEGER COUNT in a declared RATIONAL TIMEBASE** ({@link Timebase}). Not a float of
 *    seconds. 48 samples at 48 kHz is exactly one millisecond, and one sample is 20.8333… µs — a number
 *    with no finite decimal expansion, so any float-seconds or integer-µs representation of a sample
 *    index accumulates error without bound. Counting in the signal's own units cannot drift, ever, and
 *    conversion between units is exact rational arithmetic ({@link rescale}) with a DECLARED rounding
 *    at the one boundary that needs it. This is the same choice FFmpeg (`AVRational` / `av_rescale_q`),
 *    MPEG, and WebCodecs made, for the same reason.
 *
 * 2. **Every media value is a HALF-OPEN INTERVAL** ({@link Extent}) `[start, start+duration)`, in ticks
 *    of its timebase. A microphone packet of 48 samples is `{start: <sample index>, duration: 48}` at
 *    `1/48000`. A two-frame NTSC video packet is `duration: 2` at `1001/30000`. A screen grab is
 *    `duration: 0` — a genuine point sample, the honest statement "I know *when* this was, I do not
 *    claim it *lasted*". Zero-duration is not a special case and not a nullable field: it is the empty
 *    interval, and "this frame is the best evidence until the next one" is a *decision* about hold
 *    semantics that belongs on a node (`hold`), written down, not implied by an absent field.
 *
 * 3. **A time is meaningless without saying WHOSE CLOCK** ({@link ClockRef}). Two values are directly
 *    comparable **iff their clock `id` and `epoch` are equal**; anything else requires an explicit,
 *    MEASURED, UNCERTAIN correspondence ({@link Sync}). This is the rule the whole module enforces, and
 *    every function here that could quietly compare across clocks instead throws
 *    ({@link IncomparableClocksError}). The vocabulary is generalized from the ONE place the platform
 *    already got this right — the robot pose contract in `docs/platform/SERVERLESS_OS.md`
 *    (`{sourceDomain, epoch, monotonicTime, frameSequence}`), which exists precisely because a stale or
 *    replayed frame must never reach an actuator.
 *
 * 4. **The common reference point is the THREAD CLOCK.** Not global NTP. Every peer — every host, every
 *    browser — already holds a WebSocket to its thread's AgentThread Durable Object, so each measures
 *    its own offset to that one hub over the socket it already has ({@link estimateSync}, the classic
 *    four-timestamp exchange with a minimum-delay filter). Cross-embodiment alignment is therefore always
 *    explicit and always carries an uncertainty; INTRA-embodiment alignment needs no sync at all, because a
 *    host stamps its own microphone and its own camera off one clock and those values share a clock id.
 *    That asymmetry is deliberate and is the honest one: the alignment that has to be tight (a mic to
 *    the camera beside it) is exact, and the alignment that cannot be tight (two machines across the
 *    internet) says so in a number.
 *
 * ── What lives here and what does not ─────────────────────────────────────────────────────────────
 *
 * This file imports NOTHING. It is pure integer/rational arithmetic and the type vocabulary, so it can
 * be carried into a Cloudflare Worker, a React Native bundle, an Electron main process, and a vendored
 * eval container alike without dragging a dependency behind it. The zod wire schemas that validate a
 * stamp arriving off a socket are in `./clock.ts`; the op-graph port types and the
 * `reclock`/`align`/`hold`/`resample` node definitions built on this are in
 * `@commandagi/document/time`.
 *
 * See `docs/platform/TIME.md`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Exact rational arithmetic — the private floor everything else stands on
// ─────────────────────────────────────────────────────────────────────────────

/** `Number.MAX_SAFE_INTEGER` as a bigint — the boundary past which a count stops being a count. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Greatest common divisor of two non-negative integers (Euclid). */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Floor division for bigints with a POSITIVE divisor (JS `/` truncates toward zero; we need floor). */
function floorDivBig(p: bigint, q: bigint): bigint {
  const d = p / q;
  return p % q !== 0n && p < 0n ? d - 1n : d;
}

/**
 * A bigint back to a `number`, refusing rather than silently losing precision.
 *
 * Every count in this module is an integer a consumer will do arithmetic on. A count that has left the
 * safe-integer range is not a large number, it is a WRONG number — the next addition will land on the
 * wrong tick and nothing downstream can tell. So this is a throw, named with the quantity that
 * overflowed, and never a clamp.
 */
function exactNumber(v: bigint, what: string): number {
  if (v > MAX_SAFE || v < -MAX_SAFE) {
    throw new RangeError(
      `time: ${what} = ${v} exceeds the safe integer range (±${Number.MAX_SAFE_INTEGER}). ` +
        `A count past this point cannot be added to without landing on the wrong tick. Use a coarser ` +
        `timebase (µs spans ~285 years from the epoch; ns spans only ~104 days).`,
    );
  }
  return Number(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timebase — the unit a count is counted in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The duration of ONE TICK, as an exact rational number of seconds: `num / den`.
 *
 * A value's time is `count * num / den` seconds. Both fields are positive integers, so every timebase
 * this system can express is exactly representable and every conversion between two of them is a
 * rational operation with a computable remainder — which is what lets {@link rescale} report, rather
 * than absorb, the cases where a conversion is not exact.
 *
 * The convention is FFmpeg's and it inverts the intuition once: a 30 fps video timebase is
 * `{num: 1, den: 30}` (a tick is 1/30 s, and `count` is a frame index), while 48 kHz audio is
 * `{num: 1, den: 48000}` (a tick is one sample). NTSC's 29.97 fps is `{num: 1001, den: 30000}` — exact,
 * where `29.97` as a float never is.
 */
export interface Timebase {
  /** Seconds per tick, numerator. A positive, finite, safe integer. */
  num: number;
  /** Seconds per tick, denominator. A positive, finite, safe integer. */
  den: number;
}

/** Nanosecond ticks. Precise, but only ~104 days of counts fit in a safe integer — see {@link TB_MICROS}. */
export const TB_NANOS: Timebase = { num: 1, den: 1_000_000_000 };

/**
 * MICROSECOND ticks — **the canonical timebase of a thread clock**, and the default any platform-plane
 * time is expressed in unless a source declares its own.
 *
 * Chosen over nanoseconds on a single measured constraint: an epoch count in ns overflows the safe
 * integer range after 104 days, so a wall-clock stamp in ns is already wrong today, whereas µs spans
 * ~285 years. Chosen over milliseconds because a millisecond is coarser than a video frame and coarser
 * than the sync uncertainty we can actually achieve, so it would quantize away real information.
 *
 * It is deliberately NOT exact for audio (a 48 kHz sample is 20.8333… µs). That is correct: audio keeps
 * its own `1/48000` timebase all the way through the graph and is rescaled only where it genuinely
 * meets another clock, at which point the rounding is declared and its residual is reported.
 */
export const TB_MICROS: Timebase = { num: 1, den: 1_000_000 };

/** Millisecond ticks — what `Date.now()` speaks, and therefore what every legacy stamp arrives in. */
export const TB_MILLIS: Timebase = { num: 1, den: 1_000 };

/** Second ticks. */
export const TB_SECONDS: Timebase = { num: 1, den: 1 };

/** The audio timebase for a sample rate: one tick is one SAMPLE, so a sample index never drifts. */
export function audioTimebase(sampleRate: number): Timebase {
  return normalizeTimebase({ num: 1, den: sampleRate });
}

/**
 * The video timebase for a frame rate given as a rational (`30000/1001` for NTSC, `25/1` for PAL): one
 * tick is one FRAME. Passing the fps as a single float is deliberately not supported — `29.97` is not a
 * frame rate, it is a rounding of one, and a document that stores it can never round-trip.
 */
export function videoTimebase(fpsNum: number, fpsDen = 1): Timebase {
  return normalizeTimebase({ num: fpsDen, den: fpsNum });
}

/**
 * Validate a timebase and reduce it to lowest terms.
 *
 * Reduction matters beyond tidiness: {@link timebaseEquals} is how the fast paths decide a conversion is
 * a no-op, and `{2,60}` and `{1,30}` are the same unit. Reducing at construction means that test is a
 * pair of integer comparisons rather than a cross-multiplication on every value.
 */
export function normalizeTimebase(tb: Timebase): Timebase {
  const { num, den } = tb;
  for (const [k, v] of [
    ["num", num],
    ["den", den],
  ] as const) {
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new TypeError(
        `time: timebase.${k} must be a positive safe integer (got ${v}). A timebase is an exact ` +
          `rational number of seconds per tick; a fractional or non-positive term has no meaning.`,
      );
    }
  }
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

/** Are two timebases the SAME UNIT? Compares reduced terms, so `{2,60}` equals `{1,30}`. */
export function timebaseEquals(a: Timebase, b: Timebase): boolean {
  const x = normalizeTimebase(a);
  const y = normalizeTimebase(b);
  return x.num === y.num && x.den === y.den;
}

/** A timebase as seconds per tick, for display and for lossy interop with float-seconds APIs only. */
export function timebaseSeconds(tb: Timebase): number {
  const t = normalizeTimebase(tb);
  return t.num / t.den;
}

/** `"1/48000"` — the stable, human-readable form used in error messages and debug output. */
export function formatTimebase(tb: Timebase): string {
  const t = normalizeTimebase(tb);
  return `${t.num}/${t.den}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rescale — the ONE place a count changes units, with the rounding stated
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to do when a count does not land exactly on a tick of the target timebase.
 *
 * There is no default. A conversion that rounds is a decision about which direction the error goes, and
 * the direction matters differently for a clip's start (`floor` keeps material) than for its end
 * (`ceil` keeps material) than for a sample position (`nearest`). `"exact"` is the strictest and the
 * right choice wherever a rounding would be a bug rather than a compromise — it throws instead.
 */
export type Rounding = "floor" | "ceil" | "nearest" | "exact";

/** A rescale result that carries what the rounding cost, in fractional ticks of the TARGET timebase. */
export interface RescaleResult {
  /** The rounded count in the target timebase. */
  value: number;
  /**
   * The signed residual `exact - value`, in fractional target ticks, in `(-1, 1)`. Exactly `0` when the
   * conversion was exact. Carried rather than discarded because it is the term that must be added to an
   * uncertainty budget whenever a chain of conversions is composed.
   */
  residual: number;
}

/**
 * Convert `count` from one timebase to another, EXACTLY where possible, with `rounding` applied only
 * where it is not — and report the residual either way.
 *
 * The arithmetic is `count * from.num * to.den / (from.den * to.num)`, carried out in bigints so that
 * neither the multiply nor the divide can lose a bit before the declared rounding is applied. This is
 * the single conversion primitive in the system; every clip placement, every clock mapping, and every
 * resample boundary goes through it, so a rounding rule stated here is a rounding rule stated once.
 */
export function rescaleWithResidual(
  count: number,
  from: Timebase,
  to: Timebase,
  rounding: Rounding,
): RescaleResult {
  if (!Number.isSafeInteger(count)) {
    throw new TypeError(
      `time: count must be a safe integer (got ${count}). A tick count is not a float.`,
    );
  }
  const f = normalizeTimebase(from);
  const t = normalizeTimebase(to);
  if (f.num === t.num && f.den === t.den) return { value: count, residual: 0 };

  const p = BigInt(count) * BigInt(f.num) * BigInt(t.den);
  const q = BigInt(f.den) * BigInt(t.num); // > 0, both terms positive
  const r = p % q;
  if (r === 0n) return { value: exactNumber(p / q, "rescaled count"), residual: 0 };

  if (rounding === "exact") {
    throw new RangeError(
      `time: ${count} ticks at ${formatTimebase(f)} is not representable at ${formatTimebase(t)} ` +
        `(${p}/${q} is not an integer), and the rounding policy is "exact". Either keep the value in its ` +
        `own timebase or state a rounding.`,
    );
  }

  const fl = floorDivBig(p, q);
  let v: bigint;
  switch (rounding) {
    case "floor":
      v = fl;
      break;
    case "ceil":
      v = fl + 1n; // r !== 0, so ceil is strictly one above floor
      break;
    case "nearest":
      // Halves go up (toward +infinity) — stated, so a boundary sample lands the same way every time.
      v = floorDivBig(2n * p + q, 2n * q);
      break;
  }
  const value = exactNumber(v, "rescaled count");
  // residual = (p/q) - value, computed as a single division of the leftover so it stays exact to a double.
  const residual = Number(p - v * q) / Number(q);
  return { value, residual };
}

/** {@link rescaleWithResidual}, discarding the residual — for the many call sites that only want the count. */
export function rescale(count: number, from: Timebase, to: Timebase, rounding: Rounding): number {
  return rescaleWithResidual(count, from, to, rounding).value;
}

/** {@link rescale} with `"exact"` — throws rather than round. The right default inside one modality. */
export function rescaleExact(count: number, from: Timebase, to: Timebase): number {
  return rescaleWithResidual(count, from, to, "exact").value;
}

/**
 * Order two counts given in DIFFERENT timebases, without converting either.
 *
 * Cross-multiplication in bigints, so the comparison is exact even where no common timebase would
 * represent both values. Returns the usual `-1 | 0 | 1`. This is what a sort over mixed-rate values
 * uses, and it is the reason a timeline holding 48 kHz audio beside 29.97 fps video has one total order
 * rather than two approximate ones.
 */
export function compareTicks(
  aCount: number,
  aTb: Timebase,
  bCount: number,
  bTb: Timebase,
): -1 | 0 | 1 {
  const a = normalizeTimebase(aTb);
  const b = normalizeTimebase(bTb);
  // a*an/ad  vs  b*bn/bd   ⇔   a*an*bd  vs  b*bn*ad     (all denominators positive)
  const lhs = BigInt(aCount) * BigInt(a.num) * BigInt(b.den);
  const rhs = BigInt(bCount) * BigInt(b.num) * BigInt(a.den);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extent — a half-open interval of ticks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `[start, start + duration)` in ticks of some timebase — the extent of ONE media value.
 *
 * Half-open because that is the only convention under which adjacent intervals tile a line without
 * either overlapping by a tick or leaving a hole between them, which is exactly the property
 * {@link checkDense} tests for and exactly the property a concatenation depends on.
 *
 * `duration: 0` is the POINT SAMPLE and it is a first-class citizen, not a degenerate case: a 1 fps
 * screen grab, a mouse `mark`, a structure snapshot, and a transcript word onset are all genuinely
 * instants that the system knows the time of and must not pretend to know the extent of.
 */
export interface Extent {
  /** Inclusive start, in ticks. May be negative (a clock's epoch is not necessarily its origin). */
  start: number;
  /** Exclusive length, in ticks. `>= 0`; `0` is a point sample. */
  duration: number;
}

/** Validate an extent, naming what is wrong. Called at every boundary a foreign extent enters through. */
export function assertExtent(e: Extent, what = "extent"): Extent {
  if (!Number.isSafeInteger(e.start)) {
    throw new TypeError(`time: ${what}.start must be a safe integer (got ${e.start}).`);
  }
  if (!Number.isSafeInteger(e.duration) || e.duration < 0) {
    throw new TypeError(
      `time: ${what}.duration must be a non-negative safe integer (got ${e.duration}). A negative extent ` +
        `is not a value that ran backwards; it is a value whose end was computed before its start.`,
    );
  }
  return e;
}

/** The exclusive end tick of an extent. */
export function extentEnd(e: Extent): number {
  return e.start + e.duration;
}

/** Is this extent a POINT SAMPLE (zero length)? See the note on {@link Extent}. */
export function isPointSample(e: Extent): boolean {
  return e.duration === 0;
}

/** Convert an extent from one timebase to another. Start rounds DOWN and end rounds UP, so material is
 *  never lost at a boundary — the only rounding pair that is safe for a value that will be rendered. */
export function rescaleExtent(e: Extent, from: Timebase, to: Timebase): Extent {
  assertExtent(e);
  const start = rescale(e.start, from, to, "floor");
  const end = rescale(extentEnd(e), from, to, "ceil");
  return { start, duration: Math.max(0, end - start) };
}

/** Does `e` contain tick `t` (half-open)? A point sample contains nothing — including its own start. */
export function extentContains(e: Extent, t: number): boolean {
  return t >= e.start && t < extentEnd(e);
}

/** The overlap of two extents in the SAME timebase, or `null` when they do not overlap. */
export function extentIntersect(a: Extent, b: Extent): Extent | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(extentEnd(a), extentEnd(b));
  return end > start ? { start, duration: end - start } : null;
}

/** Do two extents in the same timebase overlap by at least one tick? */
export function extentsOverlap(a: Extent, b: Extent): boolean {
  return extentIntersect(a, b) !== null;
}

/** The smallest extent covering every input, in a shared timebase. `null` for an empty list. */
export function extentHull(extents: readonly Extent[]): Extent | null {
  if (extents.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of extents) {
    lo = Math.min(lo, e.start);
    hi = Math.max(hi, extentEnd(e));
  }
  return { start: lo, duration: hi - lo };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validity — how long a derived fact stands before it must be re-derived
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **HOW LONG A DERIVED FACT STANDS BEFORE IT MUST BE RE-DERIVED — ONE CONCEPT, EVERY DOMAIN.**
 *
 * A quote's EXPIRY and a materialization's REFRESH INTERVAL are the same object, and
 * `notes/decisions/2026-09-02-the-earth-document-materializes-lazily-and-the-matrix-is-reseedable.md`
 * is where that was first written down: *"a quote is a frozen offer with an expiry"* sits opposite
 * *"a materialized patch is frozen upstream data with a refresh interval"*, and the note's own
 * conclusion is that **"if they are built twice they will disagree about staleness."**
 *
 * They HAD been built twice when this was written, and byte-identically: `catalogFreshness`
 * (`packages/domain/core/src/supplier.ts`) and `observationFreshness` (`packages/domain/geo-core/src/source.ts`),
 * the second carrying a header saying it is *"deliberately the same shape and the same argument
 * order"* as the first *"so the two cannot drift into disagreeing about what staleness means"*. A
 * comment is not a mechanism. Both call this now, and a quote's expiry is the same value.
 *
 * ## The precedence, which is the whole content of the rule
 *
 * An observation's own `until` WINS over the consumer's `ttl`, because the PRODUCER knows something
 * the consumer's default does not — a forecast valid until 06:00Z, a berth reservation until the ship
 * sails, a distributor quote honoured for thirty days. The `ttl` is the consumer's own refresh
 * interval and applies only where the producer promised nothing.
 *
 * ## Three answers, and `unknown` is not `fresh`
 *
 * A fact with neither an `until` nor a `ttl` is UNSTATED: nobody said how long it stands, so nothing
 * can say whether it still does. Collapsing that into `fresh` is how yesterday's inventory renders as
 * today's, and collapsing it into `stale` would refuse every source that makes no promise.
 *
 * ## This is `Extent`'s vocabulary and deliberately not `Extent`'s type
 *
 * `[from, until)` is exactly a half-open {@link Extent}, and the resemblance is not a coincidence —
 * an unexpired fact is one whose instant lies inside its own validity window, which is
 * {@link extentContains}. It is a distinct type because a validity is stated in TWO ways and an
 * extent in one: a producer states an END and a consumer states a LENGTH, and which of the two is
 * present is the precedence rule above rather than a detail of construction. Reducing it to an
 * `Extent` at the door would throw away the distinction the rule is made of.
 */
export interface Validity {
  /** When the fact was derived — a wall-clock instant, epoch ms. */
  from: number;
  /** The instant the PRODUCER says it lapses. Wins over {@link Validity.ttl}. */
  until?: number;
  /** How long a CONSUMER lets it stand when the producer promised nothing — the refresh interval, ms. */
  ttl?: number;
}

/** `fresh` · `stale` · `unknown`. Three answers; see {@link Validity}. */
export type Freshness = "fresh" | "stale" | "unknown";

/**
 * DOES THIS FACT STILL STAND AT `now`? THE one staleness rule.
 *
 * `unknown` is returned when nothing was promised — never `fresh`, and never `stale`. "We could not
 * check" and "there are 40 in stock" must not render the same, and neither must "nobody said" and
 * "it expired".
 */
export function validityAt(v: Validity, now: number): Freshness {
  if (v.until !== undefined) return now < v.until ? "fresh" : "stale";
  if (v.ttl === undefined) return "unknown";
  return now < v.from + v.ttl ? "fresh" : "stale";
}

/**
 * The instant a validity lapses, or `null` when nothing was promised.
 *
 * The one place a `ttl` is turned into an instant, so a consumer that needs to PRINT an expiry and
 * one that needs to TEST it cannot compute different answers from the same validity.
 */
export function validUntil(v: Validity): number | null {
  if (v.until !== undefined) return v.until;
  if (v.ttl === undefined) return null;
  return v.from + v.ttl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock — whose time it is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What KIND of time a clock keeps. The domain does not make two clocks comparable — only `id` + `epoch`
 * does that — but it states what a mapping to another clock can be expected to mean.
 *
 * - `wall` — a `Date.now()`-style epoch clock. Steppable by NTP and by the user, so it is the only
 *   domain where a value can legitimately travel backwards; anything that must not do that uses
 *   `monotonic` and carries its correspondence separately.
 * - `monotonic` — a embodiment-local clock that only ever advances (`performance.now()`, `CLOCK_MONOTONIC`,
 *   an audio context's `currentTime`). Its origin is arbitrary, which is what `epoch` names.
 * - `media` — the internal timeline of a finished work: an asset's own zero, a document's program-out.
 *   It has no relationship to any world clock until something places it.
 * - `sim` — a simulation's authoritative step clock. It runs faster or slower than the world by design,
 *   and it resets on every fork, which is exactly what `epoch` is for.
 * - `musical` — beats. Convertible to seconds only through a tempo map, which is why a musical clock
 *   never appears without one (see {@link TempoMap}).
 */
export type ClockDomain = "wall" | "monotonic" | "media" | "sim" | "musical";

/**
 * The IDENTITY of a clock. **This is the load-bearing type in this module.**
 *
 * Two timestamps may be compared directly if and only if their `id` AND `epoch` match. That is the whole
 * rule, and every comparison helper here enforces it rather than trusting a caller to remember.
 *
 * `epoch` exists because a monotonic clock's origin is arbitrary and a simulation's clock is reset by a
 * fork: a embodiment that reconnects, a sim that resets, a browser tab that reloads has a NEW clock that
 * happens to reuse an old name. Treating those as the same clock is how a replayed frame gets accepted
 * as a live one. Generalized from the robot pose contract in `docs/platform/SERVERLESS_OS.md`, where
 * getting exactly this wrong moves a physical arm.
 */
export interface ClockRef {
  /** Stable name of the clock's owner: `embodiment:<id>`, `thread:<id>`, `doc:<id>`, `sim:<id>`, `view:<id>`. */
  id: string;
  /** What kind of time this clock keeps. */
  domain: ClockDomain;
  /** Opaque origin token. CHANGES on reset / reconnect / fork; a new epoch is a NEW, incomparable clock. */
  epoch: string;
}

/** The comparison key of a clock — `id@epoch`. Two values are directly comparable iff these are equal. */
export type ClockKey = string;

/** {@link ClockKey} for a clock ref. */
export function clockKey(c: ClockRef): ClockKey {
  return `${c.id}@${c.epoch}`;
}

/** Are these the SAME clock — same owner AND same epoch? The predicate behind every direct comparison. */
export function sameClock(a: ClockRef, b: ClockRef): boolean {
  return a.id === b.id && a.epoch === b.epoch;
}

/** Thrown wherever two times from different clocks would otherwise have been compared as if they weren't. */
export class IncomparableClocksError extends Error {
  constructor(
    readonly a: ClockRef,
    readonly b: ClockRef,
    readonly context: string,
  ) {
    super(
      `time: ${context} compared ${clockKey(a)} (${a.domain}) against ${clockKey(b)} (${b.domain}), which ` +
        `are different clocks. Times from different clocks are not comparable without a measured Sync; ` +
        `map one into the other with mapTicks() and carry the resulting uncertainty.` +
        (a.id === b.id
          ? ` NOTE: same owner, different EPOCH — the source reset or reconnected, so its old and new ` +
            `timelines share a name and nothing else.`
          : ""),
    );
    this.name = "IncomparableClocksError";
  }
}

/** Assert two clocks are the same, throwing {@link IncomparableClocksError} naming the caller if not. */
export function assertSameClock(a: ClockRef, b: ClockRef, context: string): void {
  if (!sameClock(a, b)) throw new IncomparableClocksError(a, b, context);
}

/** The canonical thread clock — the hub every peer measures itself against. Wall domain, µs ticks. */
export function threadClock(threadId: string, epoch: string): ClockRef {
  return { id: `thread:${threadId}`, domain: "wall", epoch };
}

/** A embodiment's own capture clock. Monotonic, because a host's wall clock may step under it mid-stream. */
export function embodimentClock(embodimentId: string, epoch: string): ClockRef {
  return { id: `embodiment:${embodimentId}`, domain: "monotonic", epoch };
}

/** A document's internal timeline (an asset's own zero, a composition's program-out). */
export function documentClock(docId: string, epoch = "doc"): ClockRef {
  return { id: `doc:${docId}`, domain: "media", epoch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timed — a value that knows when it is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A value plus everything needed to say WHEN it is, with nothing left implicit.
 *
 * This is the shape that travels a wire, and the reason it carries its clock and its timebase rather
 * than inheriting them from a node is the substrate's own rule: a consumer must be able to do the whole
 * arithmetic from what it received. A frame rate reachable only by walking to a distant "settings" node,
 * or a tempo map living on a master bus three hops away, is hidden information — the same defect that
 * numbered ports removed from the layer stack, in the time dimension.
 */
export interface Timed<T = unknown> extends Extent {
  /** Whose time `start`/`duration` are in. */
  clock: ClockRef;
  /** The unit `start`/`duration` are counted in. */
  timebase: Timebase;
  /** The value itself — frames, samples, text, ops. Opaque here. */
  payload: T;
}

/** Build a {@link Timed}, validating the extent and normalizing the timebase at the one construction site. */
export function timed<T>(
  clock: ClockRef,
  timebase: Timebase,
  extent: Extent,
  payload: T,
): Timed<T> {
  assertExtent(extent);
  return {
    clock,
    timebase: normalizeTimebase(timebase),
    start: extent.start,
    duration: extent.duration,
    payload,
  };
}

/** The extent of a timed value, as a bare {@link Extent}. */
export function extentOf(v: Timed): Extent {
  return { start: v.start, duration: v.duration };
}

/**
 * Order timed values in TIME, totally.
 *
 * Total, not merely correct: the tiebreak chain runs start → duration → a caller-supplied stable key, so
 * the result cannot depend on the order the values happened to arrive in. That property is what makes an
 * order-agnostic fan-in honest — a timeline whose sort has ties broken by input order still has hidden
 * information in it, it has just moved somewhere harder to see.
 *
 * Throws if the values are not all on one clock: an ordering across unsynchronized clocks is a fiction.
 */
export function compareTimed(a: Timed, b: Timed, key?: (v: Timed) => string): -1 | 0 | 1 {
  assertSameClock(a.clock, b.clock, "compareTimed");
  const byStart = compareTicks(a.start, a.timebase, b.start, b.timebase);
  if (byStart !== 0) return byStart;
  const byDur = compareTicks(a.duration, a.timebase, b.duration, b.timebase);
  if (byDur !== 0) return byDur;
  if (!key) return 0;
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Sort timed values into time order (see {@link compareTimed} on why `key` matters). Pure — returns new. */
export function sortTimed<T extends Timed>(values: readonly T[], key?: (v: Timed) => string): T[] {
  return [...values].sort((a, b) => compareTimed(a, b, key));
}

// ─────────────────────────────────────────────────────────────────────────────
// Density — whether a train of values tiles its span or merely samples it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a train of timed values COVERS its span or merely SAMPLES it.
 *
 * The distinction decides which operations are truthful, so it belongs in the port type rather than in a
 * comment: a `dense` train may be concatenated, resampled, and played, because consecutive extents tile
 * without gap or overlap; a `sparse` train may only be joined by nearest-at-or-before, because between
 * two of its values the system genuinely does not know what happened. Resampling a sparse train produces
 * numbers that look like measurements and are not.
 */
export type Density = "dense" | "sparse";

/** Where a supposedly-dense train stopped tiling — the first hole or overlap, with both sides named. */
export interface DensityBreak {
  /** Index of the value whose start did not meet the previous value's end. */
  index: number;
  /** The previous value's exclusive end tick. */
  expected: number;
  /** The tick this value actually started at. */
  actual: number;
  /** `gap` — silence the producer never sent. `overlap` — two values claiming the same ticks. */
  kind: "gap" | "overlap";
}

/**
 * Verify that a train really is dense: sorted, on one clock and one timebase, tiling without gap or
 * overlap. Returns every break, empty when the train is sound.
 *
 * **This is the dropped-packet detector the platform has never had.** A microphone that loses 20 ms
 * produces a train whose values are individually valid and whose concatenation is silently 20 ms short —
 * every later sample sits early, and by the end of a minute the audio leads the video by a visible
 * amount with nothing anywhere reporting a fault. A gap is a fact about the capture; it must survive as
 * one.
 */
export function checkDense(train: readonly Timed[]): DensityBreak[] {
  const breaks: DensityBreak[] = [];
  for (let i = 1; i < train.length; i++) {
    const prev = train[i - 1]!;
    const cur = train[i]!;
    assertSameClock(prev.clock, cur.clock, "checkDense");
    if (!timebaseEquals(prev.timebase, cur.timebase)) {
      throw new TypeError(
        `time: checkDense over a train whose timebase changes at index ${i} ` +
          `(${formatTimebase(prev.timebase)} → ${formatTimebase(cur.timebase)}). Density is a statement ` +
          `about tiling, and two units cannot tile each other without a rescale that would round.`,
      );
    }
    const expected = extentEnd(prev);
    if (cur.start !== expected) {
      breaks.push({
        index: i,
        expected,
        actual: cur.start,
        kind: cur.start > expected ? "gap" : "overlap",
      });
    }
  }
  return breaks;
}

/** Total ticks MISSING from a train that claims to be dense (0 when sound). Overlaps count as 0, not negative. */
export function missingTicks(train: readonly Timed[]): number {
  return checkDense(train).reduce((n, b) => n + Math.max(0, b.actual - b.expected), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync — the measured, uncertain correspondence between two clocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE round of the four-timestamp exchange, in a single shared timebase.
 *
 * `t1`/`t4` are read on the ASKING clock (send, receive); `t2`/`t3` on the ANSWERING clock (receive,
 * send). The four together separate the quantity we want (the offset between the clocks) from the
 * quantity that contaminates it (the round trip), which is why two timestamps are not enough and why
 * every serious clock protocol since NTP has used exactly these four.
 */
export interface SyncSample {
  /** Asking clock, at send. */
  t1: number;
  /** Answering clock, at receive. */
  t2: number;
  /** Answering clock, at send. */
  t3: number;
  /** Asking clock, at receive. */
  t4: number;
}

/**
 * A measured mapping from one clock to another, with the honesty attached.
 *
 * `to_ticks ≈ from_ticks + offset + from_ticks * skewPpm / 1e6`, all in {@link Sync.timebase} ticks, and
 * the answer is only ever claimed to within `± uncertainty`. The uncertainty is not decoration: it is
 * what {@link watermark} subtracts before declaring data fuseable, and it is what
 * `resolveDeixis` refuses on when it exceeds the join window.
 */
export interface Sync {
  /** {@link clockKey} of the source clock. */
  from: ClockKey;
  /** {@link clockKey} of the target clock. */
  to: ClockKey;
  /** The unit `offset`, `uncertainty` and `measuredAt` are expressed in. */
  timebase: Timebase;
  /** Additive offset, target minus source, in ticks. */
  offset: number;
  /** Relative rate error of the source against the target, in parts per million. `0` until fitted. */
  skewPpm: number;
  /** Half-width of the interval this offset is claimed within, in ticks. `>= 0`, and never 0 in practice. */
  uncertainty: number;
  /** When this estimate was taken, on the TARGET clock, in ticks — so its age can widen the uncertainty. */
  measuredAt: number;
  /** How many round trips the estimate fuses. One sample is a measurement; several are an estimate. */
  samples: number;
}

/**
 * Residual drift assumed for a clock pair once skew has been fitted, in ppm.
 *
 * A consumer crystal is specified to roughly ±50 ppm and a fitted linear skew removes most of that,
 * leaving temperature-driven wander. 2 ppm is the conservative residual this system budgets: it is what
 * {@link syncAt} charges per tick of estimate age, so a stale sync degrades into a wide, honest interval
 * rather than a confident wrong one. A reference prior, not a measurement — see the go-live note in
 * `docs/platform/TIME.md`.
 */
export const SYNC_RESIDUAL_DRIFT_PPM = 2;

/**
 * Assumed drift before any skew has been fitted (`samples < SYNC_MIN_SKEW_SAMPLES`), in ppm — the full
 * crystal tolerance, because nothing has yet been measured that would narrow it.
 */
export const SYNC_UNFITTED_DRIFT_PPM = 50;

/** Round trips required before a skew fit is trusted at all. Below this, `skewPpm` stays 0. */
export const SYNC_MIN_SKEW_SAMPLES = 8;

/**
 * How old a correspondence may be before it stops being one, in the sync's own ticks.
 *
 * **This is what keeps the drift constants above from ever being load-bearing**, and it is the reason
 * they are priors rather than a calibration debt. The hub re-measures every peer on a 30 s cadence, so a
 * live sync is at most that stale and the widening it earns is ~1.5 ms at the unfitted rate — noise
 * against every consumer in the system (the deixis window is 1.5 SECONDS). Past this ceiling the
 * estimate is not "wide", it is ABSENT: mapping through it throws {@link StaleSyncError} and the value
 * becomes unplaceable, exactly as it would for a peer that never synced at all.
 *
 * That is the house rule applied to itself. A quietly-degrading correspondence is a system that keeps
 * answering as its answers get worse, with no point at which anyone is told; a ceiling makes the failure
 * a moment. Five intervals, so a couple of missed pings is tolerated and a dead peer is not.
 */
export const SYNC_MAX_AGE_MICROS = 5 * 30_000 * 1_000;

/**
 * Fuse round trips into a {@link Sync}, using the MINIMUM-DELAY filter.
 *
 * The offset estimate comes from the single sample with the smallest round trip, not from an average of
 * all of them. That is deliberate and it is the one non-obvious thing in this function: network delay is
 * strictly non-negative and asymmetric, so a queued round trip biases its offset estimate by up to half
 * its excess delay, and averaging folds every queued sample's bias into the answer. The least-delayed
 * exchange is the least contaminated one, and its own delay bounds its error — which is exactly the
 * `uncertainty` this returns.
 *
 * Skew is fitted only once {@link SYNC_MIN_SKEW_SAMPLES} round trips span a real interval, by least
 * squares over the per-sample offsets against time. Below that the rate is not claimed at all
 * (`skewPpm: 0`) and {@link syncAt} charges the full unfitted drift for age instead — an honest "we do
 * not know yet" rather than a fit to noise.
 */
export function estimateSync(
  from: ClockKey,
  to: ClockKey,
  timebase: Timebase,
  samples: readonly SyncSample[],
): Sync {
  if (samples.length === 0) {
    throw new RangeError(
      `time: estimateSync(${from} → ${to}) with no round trips. There is no default correspondence ` +
        `between two clocks; an unmeasured pair must stay unmeasured so consumers refuse rather than guess.`,
    );
  }
  const tb = normalizeTimebase(timebase);
  let best = 0;
  let bestDelay = Infinity;
  const offsets: { at: number; offset: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const delay = s.t4 - s.t1 - (s.t3 - s.t2);
    const offset = (s.t2 - s.t1 + (s.t3 - s.t4)) / 2;
    offsets.push({ at: (s.t2 + s.t3) / 2, offset });
    if (delay < bestDelay) {
      bestDelay = delay;
      best = i;
    }
  }
  if (bestDelay < 0) {
    throw new RangeError(
      `time: estimateSync(${from} → ${to}) saw a negative round-trip delay (${bestDelay} ticks). Either a ` +
        `timestamp was taken out of order or one of the clocks stepped mid-exchange; both invalidate the ` +
        `whole exchange, so no correspondence is produced.`,
    );
  }
  const chosen = offsets[best]!;

  let skewPpm = 0;
  if (samples.length >= SYNC_MIN_SKEW_SAMPLES) {
    // Least squares of offset against time. A zero-variance span means every round trip landed in the
    // same instant, which measures no rate at all — leave the skew unclaimed rather than divide by ~0.
    const n = offsets.length;
    const meanT = offsets.reduce((a, o) => a + o.at, 0) / n;
    const meanO = offsets.reduce((a, o) => a + o.offset, 0) / n;
    let num = 0;
    let den = 0;
    for (const o of offsets) {
      const dt = o.at - meanT;
      num += dt * (o.offset - meanO);
      den += dt * dt;
    }
    if (den > 0) skewPpm = (num / den) * 1e6;
  }

  return {
    from,
    to,
    timebase: tb,
    offset: Math.round(chosen.offset),
    skewPpm,
    // Half the best round trip: the offset cannot be wrong by more than the asymmetry the trip allows.
    uncertainty: Math.max(1, Math.ceil(bestDelay / 2)),
    measuredAt: Math.round(chosen.at),
    samples: samples.length,
  };
}

/**
 * The correspondence AS OF a given target-clock time, with the estimate's age charged against its
 * uncertainty.
 *
 * A sync measured a minute ago is not the sync that holds now — the clocks have been drifting apart the
 * whole time. This widens the interval by the assumed drift over the elapsed age (residual drift once a
 * skew has been fitted, full crystal tolerance before), so a consumer that keeps using a stale
 * correspondence gets a progressively wider answer instead of a progressively wronger one.
 */
export function syncAt(sync: Sync, nowTicks: number): Sync {
  const ageTicks = Math.abs(nowTicks - sync.measuredAt);
  const ppm =
    sync.samples >= SYNC_MIN_SKEW_SAMPLES ? SYNC_RESIDUAL_DRIFT_PPM : SYNC_UNFITTED_DRIFT_PPM;
  const widened = sync.uncertainty + Math.ceil((ageTicks * ppm) / 1e6);
  return { ...sync, uncertainty: widened };
}

/** The inverse correspondence — `to → from`. Uncertainty is symmetric; offset and skew negate. */
export function invertSync(sync: Sync): Sync {
  return {
    from: sync.to,
    to: sync.from,
    timebase: sync.timebase,
    offset: -sync.offset,
    skewPpm: -sync.skewPpm,
    uncertainty: sync.uncertainty,
    // measuredAt was on the OLD target, which is the new source; carry it forward through the offset.
    measuredAt: sync.measuredAt - sync.offset,
    samples: sync.samples,
  };
}

/**
 * Compose two correspondences (`a: X→Y`, `b: Y→Z`) into `X→Z`.
 *
 * Uncertainties ADD, which is the point of composing explicitly rather than letting a caller chain two
 * mappings and keep only the last error term. Two hops through a hub are two measurements' worth of
 * doubt, and a system that forgets that will happily declare a phone and a VM aligned to a precision
 * neither of them was ever measured to.
 */
export function composeSync(a: Sync, b: Sync): Sync {
  if (a.to !== b.from) {
    throw new TypeError(
      `time: composeSync(${a.from}→${a.to}, ${b.from}→${b.to}) — the middle clocks differ.`,
    );
  }
  if (!timebaseEquals(a.timebase, b.timebase)) {
    throw new TypeError(
      `time: composeSync over mismatched timebases (${formatTimebase(a.timebase)} vs ` +
        `${formatTimebase(b.timebase)}). Express both correspondences in one unit before composing.`,
    );
  }
  return {
    from: a.from,
    to: b.to,
    timebase: a.timebase,
    offset: a.offset + b.offset,
    skewPpm: a.skewPpm + b.skewPpm,
    uncertainty: a.uncertainty + b.uncertainty,
    measuredAt: Math.min(a.measuredAt + b.offset, b.measuredAt),
    samples: Math.min(a.samples, b.samples),
  };
}

/**
 * A set of measured correspondences, keyed `from|to`, resolvable in both directions and through ONE hub.
 *
 * One hop is the declared limit, and the hub is the thread clock. This is not a shortest-path problem
 * dressed down: every peer measures itself against the same hub by construction, so a two-hop path
 * always exists and a three-hop path would only ever mean a peer failed to sync and someone routed
 * around the hole. Refusing it keeps that failure visible.
 */
export class SyncTable {
  private readonly syncs = new Map<string, Sync>();

  constructor(
    /** The hub every peer measures against — normally the thread clock. */
    readonly hub: ClockKey,
    initial: readonly Sync[] = [],
  ) {
    for (const s of initial) this.put(s);
  }

  private static key(from: ClockKey, to: ClockKey): string {
    return `${from}|${to}`;
  }

  /** Record (or replace) a correspondence. Its inverse is derived on read, never stored twice. */
  put(sync: Sync): void {
    this.syncs.set(SyncTable.key(sync.from, sync.to), sync);
  }

  /** Every stored correspondence, for persistence + debugging. */
  list(): Sync[] {
    return [...this.syncs.values()];
  }

  /**
   * The correspondence from one clock to another: direct, inverted, or composed through the hub.
   * `null` when no path exists — the caller decides how loudly to refuse, and every caller in this
   * codebase refuses loudly.
   */
  resolve(from: ClockKey, to: ClockKey): Sync | null {
    if (from === to) return null; // identity is not a Sync; callers short-circuit on sameClock first
    const direct = this.syncs.get(SyncTable.key(from, to));
    if (direct) return direct;
    const inverse = this.syncs.get(SyncTable.key(to, from));
    if (inverse) return invertSync(inverse);
    if (from === this.hub || to === this.hub) return null;
    const toHub =
      this.syncs.get(SyncTable.key(from, this.hub)) ??
      invertOrNull(this.syncs.get(SyncTable.key(this.hub, from)));
    const fromHub =
      this.syncs.get(SyncTable.key(this.hub, to)) ??
      invertOrNull(this.syncs.get(SyncTable.key(to, this.hub)));
    if (!toHub || !fromHub) return null;
    return composeSync(toHub, fromHub);
  }
}

function invertOrNull(s: Sync | undefined): Sync | null {
  return s ? invertSync(s) : null;
}

/** A tick count mapped onto another clock, with the doubt it arrived with. */
export interface MappedTicks {
  /** The count on the target clock. */
  count: number;
  /** The timebase `count` and `uncertainty` are in. */
  timebase: Timebase;
  /** Half-width of the interval `count` is claimed within, in `timebase` ticks. `0` only for same-clock. */
  uncertainty: number;
}

/**
 * Thrown when the only correspondence between two clocks is too old to be one.
 *
 * A sibling of {@link MissingSyncError} rather than a widened answer: past {@link SYNC_MAX_AGE_MICROS}
 * the estimate describes a relationship that has had minutes to change, and the honest report is that we
 * do not know — not a confident number with a large error bar nobody reads.
 */
export class StaleSyncError extends Error {
  constructor(
    readonly from: ClockRef,
    readonly to: ClockRef,
    readonly ageTicks: number,
    readonly context: string,
  ) {
    super(
      `time: ${context} found only a STALE correspondence from ${clockKey(from)} to ${clockKey(to)} — ` +
        `measured ${ageTicks} ticks ago, past the ${SYNC_MAX_AGE_MICROS}-tick ceiling. The peer has stopped ` +
        `answering the clock exchange, so its clock has had that long to drift somewhere unmeasured. ` +
        `Values from it are unplaceable until it syncs again.`,
    );
    this.name = "StaleSyncError";
  }
}

/** Thrown when a mapping between two clocks is required and has never been measured. */
export class MissingSyncError extends Error {
  constructor(
    readonly from: ClockRef,
    readonly to: ClockRef,
    readonly context: string,
  ) {
    super(
      `time: ${context} needs to map ${clockKey(from)} into ${clockKey(to)}, and no correspondence between ` +
        `them has been measured. A clock pair with no Sync is not "probably close" — it is unknown. Run the ` +
        `clock-sync exchange for this peer, or keep the value on its own clock.`,
    );
    this.name = "MissingSyncError";
  }
}

/**
 * Map a tick count from one clock onto another, exactly where the clocks are the same and with a
 * measured, aged, drift-widened uncertainty where they are not.
 *
 * The same-clock path costs nothing and claims zero uncertainty, which is the property that makes
 * intra-embodiment alignment exact: a host that stamps its microphone and its camera off one clock never
 * enters the estimated path at all.
 */
export function mapTicks(
  count: number,
  fromClock: ClockRef,
  fromTb: Timebase,
  toClock: ClockRef,
  toTb: Timebase,
  syncs: SyncTable,
  opts: { nowTicks?: number; context?: string; rounding?: Rounding } = {},
): MappedTicks {
  const context = opts.context ?? "mapTicks";
  const rounding = opts.rounding ?? "nearest";
  const target = normalizeTimebase(toTb);
  if (sameClock(fromClock, toClock)) {
    return { count: rescale(count, fromTb, target, rounding), timebase: target, uncertainty: 0 };
  }
  const sync = syncs.resolve(clockKey(fromClock), clockKey(toClock));
  if (!sync) throw new MissingSyncError(fromClock, toClock, context);
  // A ceiling on age, checked BEFORE the mapping rather than absorbed into its uncertainty. See
  // SYNC_MAX_AGE_MICROS: past it the estimate is absent, not merely wide.
  if (opts.nowTicks !== undefined) {
    const ageTicks = Math.abs(
      rescale(opts.nowTicks, target, sync.timebase, "nearest") - sync.measuredAt,
    );
    if (ageTicks > rescale(SYNC_MAX_AGE_MICROS, TB_MICROS, sync.timebase, "ceil")) {
      throw new StaleSyncError(fromClock, toClock, ageTicks, context);
    }
  }

  // Everything happens in the sync's own timebase, then lands in the caller's.
  const inSync = rescaleWithResidual(count, fromTb, sync.timebase, rounding);
  // SKEW APPLIES TO ELAPSED TIME SINCE THE MEASUREMENT, never to the absolute count.
  //
  // The fit measures how fast the offset CHANGES per tick of target time, so the correction is
  // `skew · (t − measuredAt)` — the drift accumulated since the estimate was taken. Multiplying the
  // absolute count instead is catastrophic and silent: an epoch-microsecond reading is ~1.7e15, so a
  // 2 ppm skew "corrects" it by 3.4e9 µs — about 57 minutes — and every value maps to a plausible,
  // wrong instant. A monotonic clock's origin is arbitrary, which makes its absolute count meaningless
  // for this purpose too.
  const approx = inSync.value + sync.offset;
  const mapped = approx + ((approx - sync.measuredAt) * sync.skewPpm) / 1e6;
  const aged = syncAt(sync, opts.nowTicks ?? Math.round(mapped));
  const out = rescaleWithResidual(Math.round(mapped), sync.timebase, target, rounding);
  const uncertainty = rescale(aged.uncertainty, sync.timebase, target, "ceil");
  return {
    count: out.value,
    timebase: target,
    // Every rounding along the way is a real, if sub-tick, contribution to the doubt.
    uncertainty: uncertainty + Math.ceil(Math.abs(inSync.residual) + Math.abs(out.residual)),
  };
}

/** Map a whole {@link Timed} onto another clock. Start and end map independently, so no material is lost. */
export function mapTimed<T>(
  value: Timed<T>,
  toClock: ClockRef,
  toTb: Timebase,
  syncs: SyncTable,
  opts: { nowTicks?: number; context?: string } = {},
): { value: Timed<T>; uncertainty: number } {
  const ctx = opts.context ?? "mapTimed";
  const s = mapTicks(value.start, value.clock, value.timebase, toClock, toTb, syncs, {
    ...opts,
    context: ctx,
    rounding: "floor",
  });
  const e = mapTicks(extentEnd(value), value.clock, value.timebase, toClock, toTb, syncs, {
    ...opts,
    context: ctx,
    rounding: "ceil",
  });
  return {
    value: {
      clock: toClock,
      timebase: s.timebase,
      start: s.count,
      duration: Math.max(0, e.count - s.count),
      payload: value.payload,
    },
    uncertainty: Math.max(s.uncertainty, e.uncertainty),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Watermark — the frontier up to which fusing realtime sources is honest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far ONE live source has been heard from — its latest known end, on its own clock.
 *
 * Realtime is not the same time. Sources arrive at different rates, over different paths, from clocks
 * that agree only to a measured tolerance, so "now" is not a thing several live streams share. What they
 * do share is a frontier: the most recent instant every one of them has already reported past. Fusing
 * below that frontier is a statement about data that exists; fusing above it is a guess dressed as a
 * measurement.
 */
export interface SourceFrontier {
  /** Which source this is (a embodiment|channel key) — carried so a stalled one can be NAMED, not just felt. */
  id: string;
  /** The source's clock. */
  clock: ClockRef;
  /** The timebase of `latestEnd`. */
  timebase: Timebase;
  /** The exclusive end of the latest value this source has delivered, in its own ticks. */
  latestEnd: number;
}

/** The fuseable frontier, plus which source is holding it back. */
export interface Watermark {
  /** The frontier tick on the target clock: every source has reported past this. */
  at: number;
  /** The timebase of `at`. */
  timebase: Timebase;
  /** The target clock `at` is on. */
  clock: ClockRef;
  /** The {@link SourceFrontier.id} that is furthest behind — the one to look at when fusion stalls. */
  laggard: string;
  /** The uncertainty charged against `at` (the laggard's mapping doubt), in `timebase` ticks. */
  uncertainty: number;
}

/**
 * **The highest common time point every live source has passed.** The answer to "how do I stitch
 * realtime sources, given realtime is not the same time".
 *
 * The minimum over sources of each one's latest end mapped onto the target clock, MINUS that mapping's
 * uncertainty — because a value is only known to have happened before the frontier if it is before the
 * frontier even under the least favourable reading of the clock correspondence. Subtracting the doubt is
 * what makes the frontier a guarantee rather than an expectation.
 *
 * Throws on an empty source set. The watermark of nothing is not zero and not "now"; it is undefined,
 * and a fusion node that quietly treated it as either would emit output built from no inputs.
 */
export function watermark(
  sources: readonly SourceFrontier[],
  toClock: ClockRef,
  toTb: Timebase,
  syncs: SyncTable,
  opts: { nowTicks?: number } = {},
): Watermark {
  if (sources.length === 0) {
    throw new RangeError(
      `time: watermark() over zero sources. The frontier of an empty set is not a time — a fusion with no ` +
        `inputs must report that it has no inputs, not emit output at tick 0.`,
    );
  }
  const timebase = normalizeTimebase(toTb);
  let at = Infinity;
  let laggard = sources[0]!.id;
  let uncertainty = 0;
  for (const s of sources) {
    const m = mapTicks(s.latestEnd, s.clock, s.timebase, toClock, timebase, syncs, {
      nowTicks: opts.nowTicks,
      context: `watermark(${s.id})`,
      rounding: "floor",
    });
    const guaranteed = m.count - m.uncertainty;
    if (guaranteed < at) {
      at = guaranteed;
      laggard = s.id;
      uncertainty = m.uncertainty;
    }
  }
  return { at, timebase, clock: toClock, laggard, uncertainty };
}

/** Is a value wholly below the frontier — i.e. is it safe to fuse yet? */
export function isComplete(value: Timed, mark: Watermark): boolean {
  assertSameClock(value.clock, mark.clock, "isComplete");
  return compareTicks(extentEnd(value), value.timebase, mark.at, mark.timebase) <= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Joining — how a sparse track is read at an instant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a track is sampled at an instant it has no value exactly at.
 *
 * - `at-or-before` — the most recent value not after the query. The only truthful reading of a SPARSE
 *   track: a structure snapshot, a cursor position, a screen grab is the last thing known to be true.
 * - `nearest` — the closest value on either side, within the window. Right for a train of measurements
 *   of a continuous quantity; wrong for anything with edges, because it reads the future.
 * - `within` — every value inside the window, unreduced. What a transcript join wants, since "what was
 *   being said around then" is a span of words rather than one.
 */
export type JoinPolicy = "at-or-before" | "nearest" | "within";

/**
 * Read a sparse track at `atTicks`, under a stated policy and a stated window.
 *
 * The window is REQUIRED. A join with no window is a join that will happily match a value from an hour
 * ago and report it as contemporaneous, which is the precise shape of the deixis defect this whole
 * module exists to remove; making the caller state how stale is too stale puts that decision where a
 * reader can see it.
 *
 * Every input must be on the query's clock — map first, and carry the mapping's uncertainty into
 * `windowTicks` yourself, because only the caller knows how much of the budget the join may spend.
 */
export function joinAt<T extends Timed>(
  track: readonly T[],
  atTicks: number,
  atTb: Timebase,
  clock: ClockRef,
  policy: JoinPolicy,
  windowTicks: number,
): T[] {
  if (!Number.isSafeInteger(windowTicks) || windowTicks < 0) {
    throw new TypeError(
      `time: joinAt needs a non-negative window (got ${windowTicks}). An unbounded join silently matches ` +
        `arbitrarily stale values and reports them as contemporaneous.`,
    );
  }
  const inWindow: { v: T; delta: number }[] = [];
  for (const v of track) {
    assertSameClock(v.clock, clock, "joinAt");
    // Distance from the query to the value's extent: 0 while inside it, else to the nearer edge.
    const startCmp = compareTicks(v.start, v.timebase, atTicks, atTb);
    const endCmp = compareTicks(extentEnd(v), v.timebase, atTicks, atTb);
    const startAt = rescale(v.start, v.timebase, atTb, "nearest");
    const endAt = rescale(extentEnd(v), v.timebase, atTb, "nearest");
    const delta =
      startCmp <= 0 && endCmp > 0 ? 0 : startCmp > 0 ? startAt - atTicks : atTicks - endAt;
    if (Math.abs(delta) <= windowTicks) inWindow.push({ v, delta });
  }
  switch (policy) {
    case "within":
      return inWindow.sort((a, b) => compareTimed(a.v, b.v)).map((x) => x.v);
    case "at-or-before": {
      const before = inWindow.filter(
        (x) => compareTicks(x.v.start, x.v.timebase, atTicks, atTb) <= 0,
      );
      if (before.length === 0) return [];
      before.sort((a, b) => compareTimed(b.v, a.v));
      return [before[0]!.v];
    }
    case "nearest": {
      if (inWindow.length === 0) return [];
      // Ties resolve to the EARLIER value: reading the past on a tie is a defensible bias, reading the
      // future on one is not.
      inWindow.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || compareTimed(a.v, b.v));
      return [inWindow[0]!.v];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tempo — the one map that makes a musical clock convertible
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tempo in force from a beat onward. A map is a sorted list of these.
 *
 * This type exists in the platform's time module, rather than on a mixer node in the music editor,
 * because a musical clock is not convertible to any other clock without it. A beat count whose tempo map
 * lives three hops away on a master bus is a value that cannot be interpreted from what arrived on the
 * wire — the exact hidden-information defect numbered ports removed from the layer stack, and the reason
 * a `musical` {@link ClockDomain} always travels with its map.
 */
export interface TempoChange {
  /** Beat this tempo takes effect at (absolute, from the musical clock's zero). */
  atBeat: number;
  /** Beats per minute from `atBeat` until the next change. Positive and finite. */
  bpm: number;
}

/** A tempo map: at least one change, sorted by `atBeat`, the first at or before beat 0. */
export type TempoMap = readonly TempoChange[];

/** Validate a tempo map, naming the first thing wrong with it. */
export function assertTempoMap(map: TempoMap): TempoMap {
  if (map.length === 0) {
    throw new TypeError(
      `time: a musical clock needs a tempo map with at least one entry. Beats are not convertible to ` +
        `seconds without one, and a default tempo would be an invented fact about someone's document.`,
    );
  }
  let prev = -Infinity;
  for (const c of map) {
    if (!Number.isFinite(c.atBeat) || c.atBeat < prev) {
      throw new TypeError(`time: tempo map is not sorted by beat (${c.atBeat} follows ${prev}).`);
    }
    if (!Number.isFinite(c.bpm) || c.bpm <= 0) {
      throw new TypeError(
        `time: tempo ${c.bpm} bpm at beat ${c.atBeat} is not a positive, finite tempo.`,
      );
    }
    prev = c.atBeat;
  }
  if (map[0]!.atBeat > 0) {
    throw new TypeError(
      `time: tempo map starts at beat ${map[0]!.atBeat}; nothing states the tempo before it. The first ` +
        `entry must be at or before beat 0.`,
    );
  }
  return map;
}

/**
 * Seconds elapsed from beat 0 to `beat`, integrating a piecewise-constant tempo map.
 *
 * Exact within each segment (a segment is a constant rate, so its contribution is a multiplication) and
 * therefore exact overall up to floating addition — which is why the conversion to a tick count is a
 * single {@link rescale} at the end rather than an accumulation per segment.
 */
export function beatsToSeconds(beat: number, map: TempoMap): number {
  assertTempoMap(map);
  if (beat <= 0) return (beat * 60) / map[0]!.bpm;
  let seconds = 0;
  let cursor = 0;
  for (let i = 0; i < map.length; i++) {
    const cur = map[i]!;
    const next = map[i + 1];
    const from = Math.max(cursor, cur.atBeat);
    const to = next ? Math.min(beat, next.atBeat) : beat;
    if (to > from) {
      seconds += ((to - from) * 60) / cur.bpm;
      cursor = to;
    }
    if (cursor >= beat) break;
  }
  return seconds;
}

/** The inverse of {@link beatsToSeconds} — which beat a given elapsed time lands on. */
export function secondsToBeats(seconds: number, map: TempoMap): number {
  assertTempoMap(map);
  if (seconds <= 0) return (seconds * map[0]!.bpm) / 60;
  let acc = 0;
  for (let i = 0; i < map.length; i++) {
    const cur = map[i]!;
    const next = map[i + 1];
    const spanBeats = next ? next.atBeat - Math.max(cur.atBeat, 0) : Infinity;
    const spanSeconds = (spanBeats * 60) / cur.bpm;
    if (seconds - acc <= spanSeconds)
      return Math.max(cur.atBeat, 0) + ((seconds - acc) * cur.bpm) / 60;
    acc += spanSeconds;
  }
  const last = map[map.length - 1]!;
  return last.atBeat + ((seconds - acc) * last.bpm) / 60;
}

/**
 * Convert a beat count in a musical timebase to ticks of a wall/media timebase, through a tempo map.
 *
 * `rounding` is required for the same reason it is required everywhere else here: beats do not land on
 * microsecond boundaries, and which way a note's onset moves when it doesn't is a decision.
 */
export function beatsToTicks(
  beats: number,
  beatTb: Timebase,
  map: TempoMap,
  to: Timebase,
  rounding: Rounding,
): number {
  const beatValue = beats * timebaseSeconds(beatTb);
  const seconds = beatsToSeconds(beatValue, map);
  const t = normalizeTimebase(to);
  const exact = (seconds * t.den) / t.num;
  switch (rounding) {
    case "floor":
      return Math.floor(exact);
    case "ceil":
      return Math.ceil(exact);
    case "nearest":
      return Math.round(exact);
    case "exact": {
      const r = Math.round(exact);
      if (Math.abs(exact - r) > 1e-9) {
        throw new RangeError(
          `time: beat ${beats} is not representable at ${formatTimebase(t)} under this tempo map ` +
            `(${exact} ticks), and the rounding policy is "exact".`,
        );
      }
      return r;
    }
  }
}
