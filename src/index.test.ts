/**
 * Tests for the time substrate (`./time.ts`).
 *
 * These are deliberately NOT "call the function, paste what it returned" tests — that pattern locks a
 * defect in as a specification (docs/ops/ENGINEERING_LESSONS.md). Every assertion here is anchored to
 * something that is not this code:
 *
 *  • CLOSED FORMS. 48 samples at 48 kHz is one millisecond by the definition of a hertz; N such packets
 *    span exactly N ms. NTSC's frame period is 1001/30000 s by SMPTE. Those are the expected values, and
 *    the implementation is scored against them.
 *  • MUST-FAIL CONTROLS. Several tests assert that the OBVIOUS WRONG IMPLEMENTATION fails the same
 *    check the real one passes — float-seconds accumulation drifts, averaging round trips is biased by
 *    queueing, `nearest` reads the future where `at-or-before` cannot. A guard whose blind spot is
 *    untested is a green tick that means "not examined".
 *  • ADVERSARIAL INPUTS. Non-representable conversions, negative round trips, clock-epoch changes,
 *    empty source sets — each must throw with a named cause rather than return a plausible number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TB_MICROS,
  TB_MILLIS,
  TB_SECONDS,
  audioTimebase,
  videoTimebase,
  normalizeTimebase,
  timebaseEquals,
  formatTimebase,
  rescale,
  rescaleExact,
  rescaleWithResidual,
  compareTicks,
  assertExtent,
  extentEnd,
  isPointSample,
  rescaleExtent,
  extentIntersect,
  extentHull,
  clockKey,
  sameClock,
  assertSameClock,
  IncomparableClocksError,
  MissingSyncError,
  threadClock,
  embodimentClock,
  documentClock,
  timed,
  compareTimed,
  sortTimed,
  checkDense,
  missingTicks,
  estimateSync,
  invertSync,
  composeSync,
  syncAt,
  SyncTable,
  mapTicks,
  mapTimed,
  watermark,
  isComplete,
  joinAt,
  beatsToSeconds,
  secondsToBeats,
  beatsToTicks,
  assertTempoMap,
  SYNC_MIN_SKEW_SAMPLES,
  SYNC_MAX_AGE_MICROS,
  StaleSyncError,
  type Sync,
  type SyncSample,
  validityAt,
  validUntil,
  type Validity,
} from "./index.js";

const AUDIO_48K = audioTimebase(48_000);
const NTSC = videoTimebase(30_000, 1001);
const PAL = videoTimebase(25);

// ─── Timebase ────────────────────────────────────────────────────────────────

test("a timebase reduces to lowest terms, so equal units compare equal", () => {
  assert.deepEqual(normalizeTimebase({ num: 2, den: 60 }), { num: 1, den: 30 });
  assert.ok(timebaseEquals({ num: 2, den: 60 }, { num: 1, den: 30 }));
  assert.ok(timebaseEquals({ num: 1001, den: 30_000 }, { num: 2002, den: 60_000 }));
});

test("NTSC is the exact SMPTE rational, not a rounding of 29.97", () => {
  // SMPTE 30000/1001 fps ⇒ a frame period of 1001/30000 s. Anchored to the standard, not to our output.
  assert.deepEqual(NTSC, { num: 1001, den: 30_000 });
  assert.equal(formatTimebase(NTSC), "1001/30000");
  // A whole second of NTSC video is 30000/1001 frames — not an integer, which is the point.
  assert.notEqual((1 * 30_000) % 1001, 0);
});

test("a non-positive or fractional timebase term is refused, not coerced", () => {
  assert.throws(() => normalizeTimebase({ num: 0, den: 30 }), /positive safe integer/);
  assert.throws(() => normalizeTimebase({ num: 1, den: -30 }), /positive safe integer/);
  assert.throws(() => normalizeTimebase({ num: 1.5, den: 30 }), /positive safe integer/);
});

// ─── Rescale: exactness and the drift control ────────────────────────────────

test("48 samples at 48 kHz is exactly one millisecond (closed form, by the definition of a hertz)", () => {
  assert.equal(rescaleExact(48, AUDIO_48K, TB_MILLIS), 1);
  assert.equal(rescaleExact(48, AUDIO_48K, TB_MICROS), 1_000);
  assert.equal(rescaleExact(48_000, AUDIO_48K, TB_SECONDS), 1);
});

test("integer sample counting never drifts; float-seconds accumulation drifts without bound (MUST-FAIL CONTROL)", () => {
  const SAMPLES = 48;
  // Ground truth from the closed form: N packets of 48 samples at 48 kHz span exactly N ms = N·1000 µs.
  // The claim under test is not "the error is small" — it is that ONE path has no error at ANY N while
  // the other's error grows with N. So both are measured at three magnitudes.
  const errors: number[] = [];
  for (const packets of [100_000, 1_000_000, 10_000_000]) {
    const expectedMicros = packets * 1_000;

    // The implementation: count in samples, convert once. Exact at every magnitude.
    assert.equal(
      rescaleExact(packets * SAMPLES, AUDIO_48K, TB_MICROS),
      expectedMicros,
      `exact rational rescale must land on the closed form at ${packets} packets`,
    );

    // The control: the obvious wrong implementation — accumulate float seconds per packet. 48/48000 is
    // not representable in IEEE754, so this can never be exact, and its error compounds. If it ever
    // stops missing, this control has stopped controlling and the assertion below says so.
    let driftSeconds = 0;
    for (let i = 0; i < packets; i++) driftSeconds += SAMPLES / 48_000;
    assert.notEqual(
      driftSeconds,
      packets / 1_000,
      "float accumulation is supposed to miss the closed form",
    );
    errors.push(Math.abs(driftSeconds * 1e6 - expectedMicros));
  }
  assert.ok(
    errors[0]! < errors[1]! && errors[1]! < errors[2]!,
    `float error must grow with N (got ${errors})`,
  );
  // At ten million packets — under three hours of audio — the float accumulator has slipped past a whole
  // microsecond, while the integer path above was exact at that same point.
  assert.ok(errors[2]! > 1, `expected >1 µs of accumulated float error, got ${errors[2]}`);
});

test('a conversion that cannot be exact is refused under "exact" and reports its residual otherwise', () => {
  // One 48 kHz sample is 20.8333… µs — no integer number of microseconds.
  assert.throws(() => rescaleExact(1, AUDIO_48K, TB_MICROS), /not representable/);
  const nearest = rescaleWithResidual(1, AUDIO_48K, TB_MICROS, "nearest");
  assert.equal(nearest.value, 21);
  assert.ok(Math.abs(nearest.residual + 1 / 6) < 1e-12, "20.8333… − 21 = −1/6 tick");
  assert.equal(rescale(1, AUDIO_48K, TB_MICROS, "floor"), 20);
  assert.equal(rescale(1, AUDIO_48K, TB_MICROS, "ceil"), 21);
});

test("rescale stays exact where the intermediate product exceeds the safe-integer range", () => {
  // 3·2^40 samples → µs. The intermediate `count · 1e6` is ~3.3e18, well past 2^53, so an implementation
  // that multiplied in doubles before dividing would already have left exact arithmetic by the time it
  // divided. Ground truth is derived independently here, by bigint division written out inline rather
  // than by calling anything in the module under test.
  const count = 3 * 2 ** 40;
  assert.ok(
    !Number.isSafeInteger(count * 1_000_000),
    "the intermediate must actually overflow, or this proves nothing",
  );
  assert.equal(
    (BigInt(count) * 1_000_000n) % 48_000n,
    0n,
    "count chosen so the exact answer is an integer",
  );
  const groundTruth = Number((BigInt(count) * 1_000_000n) / 48_000n);
  assert.equal(rescaleExact(count, AUDIO_48K, TB_MICROS), groundTruth);
});

test("a count past the safe-integer range is refused rather than silently rounded", () => {
  assert.throws(() => rescale(2 ** 52, TB_SECONDS, TB_MICROS, "nearest"), /safe integer range/);
});

test("compareTicks orders across timebases exactly", () => {
  // One NTSC frame (1001/30000 s ≈ 33.3667 ms) against 33 ms and 34 ms.
  assert.equal(compareTicks(1, NTSC, 33, TB_MILLIS), 1);
  assert.equal(compareTicks(1, NTSC, 34, TB_MILLIS), -1);
  // 1 second, said three ways.
  assert.equal(compareTicks(48_000, AUDIO_48K, 1, TB_SECONDS), 0);
  assert.equal(compareTicks(25, PAL, 1_000, TB_MILLIS), 0);
  // 30000 NTSC frames is exactly 1001 seconds.
  assert.equal(compareTicks(30_000, NTSC, 1_001, TB_SECONDS), 0);
});

// ─── Extent ──────────────────────────────────────────────────────────────────

test("an extent is half-open, and a zero-duration extent is a point sample that contains nothing", () => {
  const point = { start: 100, duration: 0 };
  assert.ok(isPointSample(point));
  assert.equal(extentEnd(point), 100);
  assert.equal(
    extentIntersect(point, { start: 0, duration: 1_000 }),
    null,
    "an empty interval overlaps nothing",
  );
  // Adjacent extents tile without overlapping — the property concatenation depends on.
  assert.equal(extentIntersect({ start: 0, duration: 48 }, { start: 48, duration: 48 }), null);
});

test("a negative duration is refused; it means an end was computed before a start", () => {
  assert.throws(() => assertExtent({ start: 0, duration: -1 }), /non-negative/);
  assert.throws(() => assertExtent({ start: 1.5, duration: 1 }), /safe integer/);
});

test("rescaling an extent never loses material (start floors, end ceils)", () => {
  // 1 sample at 48 kHz spans [20.83, 41.67) µs — it must survive as [20, 42), never [21, 21).
  const e = rescaleExtent({ start: 1, duration: 1 }, AUDIO_48K, TB_MICROS);
  assert.equal(e.start, 20);
  assert.equal(extentEnd(e), 42);
  assert.ok(e.duration >= 1, "a real sample must never rescale to nothing");
});

test("extentHull covers every input", () => {
  assert.deepEqual(
    extentHull([
      { start: 10, duration: 5 },
      { start: 2, duration: 3 },
      { start: 20, duration: 0 },
    ]),
    {
      start: 2,
      duration: 18,
    },
  );
  assert.equal(extentHull([]), null);
});

// ─── Clock identity — the load-bearing rule ──────────────────────────────────

test("two clocks are the same iff BOTH owner and epoch match", () => {
  const a = embodimentClock("cam1", "boot-1");
  const b = embodimentClock("cam1", "boot-1");
  const reconnected = embodimentClock("cam1", "boot-2");
  assert.ok(sameClock(a, b));
  assert.ok(!sameClock(a, reconnected), "a reconnect is a NEW clock that reuses an old name");
  assert.equal(clockKey(a), "embodiment:cam1@boot-1");
});

test("comparing across clocks throws, and says WHY — including the same-owner/new-epoch case", () => {
  const a = embodimentClock("cam1", "boot-1");
  const b = embodimentClock("cam1", "boot-2");
  assert.throws(() => assertSameClock(a, b, "test"), IncomparableClocksError);
  assert.throws(() => assertSameClock(a, b, "test"), /different EPOCH/);
  const other = embodimentClock("mic1", "boot-1");
  assert.throws(() => assertSameClock(a, other, "test"), /not comparable without a measured Sync/);
});

test("compareTimed refuses an ordering across clocks", () => {
  const x = timed(embodimentClock("a", "e"), TB_MICROS, { start: 0, duration: 1 }, null);
  const y = timed(embodimentClock("b", "e"), TB_MICROS, { start: 0, duration: 1 }, null);
  assert.throws(() => compareTimed(x, y), IncomparableClocksError);
});

test("timeline order is TOTAL — rewiring the input order cannot change the result", () => {
  const c = documentClock("doc1");
  const mk = (id: string, start: number, duration: number) =>
    timed(c, TB_MILLIS, { start, duration }, { id });
  const values = [mk("c", 100, 10), mk("a", 0, 50), mk("b", 0, 50), mk("d", 100, 5)];
  const key = (v: { payload: unknown }) => (v.payload as { id: string }).id;
  const forward = sortTimed(values, key as never).map(key);
  const reversed = sortTimed([...values].reverse(), key as never).map(key);
  assert.deepEqual(forward, reversed, "a stable-by-input-order sort would differ here");
  // Ground truth by hand: (0,50,a) (0,50,b) (100,5,d) (100,10,c) — start, then duration, then id.
  assert.deepEqual(forward, ["a", "b", "d", "c"]);
});

// ─── Density — the dropped-packet detector ───────────────────────────────────

test("a dense train tiles exactly; a dropped packet is reported as a gap with its size", () => {
  const c = embodimentClock("mic", "e");
  const packet = (i: number) => timed(c, AUDIO_48K, { start: i * 48, duration: 48 }, i);
  const sound = [packet(0), packet(1), packet(2), packet(3)];
  assert.deepEqual(checkDense(sound), []);
  assert.equal(missingTicks(sound), 0);

  const dropped = [packet(0), packet(1), packet(3)]; // packet 2 never arrived
  const breaks = checkDense(dropped);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.kind, "gap");
  assert.equal(breaks[0]!.expected, 96);
  assert.equal(breaks[0]!.actual, 144);
  assert.equal(missingTicks(dropped), 48, "exactly one packet — 48 samples = 1 ms — is missing");
});

test("two values claiming the same ticks are reported as an overlap, not silently summed", () => {
  const c = embodimentClock("mic", "e");
  const train = [
    timed(c, AUDIO_48K, { start: 0, duration: 48 }, 0),
    timed(c, AUDIO_48K, { start: 24, duration: 48 }, 1),
  ];
  const breaks = checkDense(train);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.kind, "overlap");
});

// ─── Sync — the measured correspondence ──────────────────────────────────────

/** Simulate one round trip: the asking clock runs `offset` behind, with the given path delays. */
function roundTrip(clockAt: number, offset: number, up: number, down: number): SyncSample {
  const t1 = clockAt;
  const t2 = clockAt + up + offset;
  const t3 = t2;
  const t4 = t3 - offset + down;
  return { t1, t2, t3, t4 };
}

test("estimateSync recovers a known offset exactly from a symmetric round trip", () => {
  const OFFSET = 12_345;
  const s = estimateSync("a@1", "b@1", TB_MICROS, [roundTrip(1_000, OFFSET, 500, 500)]);
  assert.equal(s.offset, OFFSET);
  assert.equal(s.uncertainty, 500, "half of a 1000-tick round trip bounds the asymmetry");
});

test("the MINIMUM-DELAY filter beats averaging under queueing (MUST-FAIL CONTROL)", () => {
  const OFFSET = 10_000;
  // One clean exchange and several one-way-queued ones. Queueing on the upstream leg biases each
  // sample's offset UPWARD by half its excess delay — averaging folds every bias in; the minimum filter
  // discards them.
  const samples: SyncSample[] = [
    roundTrip(0, OFFSET, 200, 200),
    roundTrip(1_000, OFFSET, 9_000, 200),
    roundTrip(2_000, OFFSET, 12_000, 200),
    roundTrip(3_000, OFFSET, 20_000, 200),
  ];
  const fused = estimateSync("a@1", "b@1", TB_MICROS, samples);
  assert.equal(fused.offset, OFFSET, "the least-delayed exchange is the least contaminated one");

  // The control: the naive mean of every sample's offset. It must be visibly biased, or this test is
  // asserting nothing about the filter.
  const mean =
    samples.reduce((acc, s) => acc + (s.t2 - s.t1 + (s.t3 - s.t4)) / 2, 0) / samples.length;
  assert.ok(
    Math.abs(mean - OFFSET) > 1_000,
    `averaging is supposed to be biased under queueing (got ${mean} vs ${OFFSET})`,
  );
});

test("a negative round-trip delay invalidates the exchange instead of producing a confident number", () => {
  const bad: SyncSample = { t1: 1_000, t2: 0, t3: 5_000, t4: 1_100 }; // t3-t2 exceeds t4-t1
  assert.throws(() => estimateSync("a@1", "b@1", TB_MICROS, [bad]), /negative round-trip delay/);
});

test("no round trips means no correspondence — never a default of zero", () => {
  assert.throws(() => estimateSync("a@1", "b@1", TB_MICROS, []), /no round trips/);
});

test("skew is fitted only once enough round trips span real time; below that the rate is not claimed", () => {
  const DRIFT_PPM = 40;
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const at = i * 1_000_000; // one second apart
      const offset = 5_000 + Math.round((at * DRIFT_PPM) / 1e6);
      return roundTrip(at, offset, 100, 100);
    });
  const few = estimateSync("a@1", "b@1", TB_MICROS, mk(SYNC_MIN_SKEW_SAMPLES - 1));
  assert.equal(few.skewPpm, 0, "a rate fitted from too few points is a fit to noise");
  const many = estimateSync("a@1", "b@1", TB_MICROS, mk(SYNC_MIN_SKEW_SAMPLES + 4));
  assert.ok(
    Math.abs(many.skewPpm - DRIFT_PPM) < 1,
    `fitted skew ${many.skewPpm} should recover ${DRIFT_PPM} ppm`,
  );
});

test("a stale correspondence widens rather than staying confident", () => {
  const s = estimateSync("a@1", "b@1", TB_MICROS, [roundTrip(0, 1_000, 100, 100)]);
  const fresh = syncAt(s, s.measuredAt);
  const hourOld = syncAt(s, s.measuredAt + 3_600 * 1_000_000);
  assert.equal(fresh.uncertainty, s.uncertainty);
  assert.ok(hourOld.uncertainty > s.uncertainty * 10, "an hour of unmodelled drift is not free");
  // Ground truth: one unfitted hour at 50 ppm is 180 ms of possible drift.
  assert.ok(
    hourOld.uncertainty >= 180_000,
    `expected ≥180000 µs of widening, got ${hourOld.uncertainty}`,
  );
});

test("inverting a correspondence round-trips its offset and preserves its doubt", () => {
  const s = estimateSync("a@1", "b@1", TB_MICROS, [roundTrip(0, 7_777, 300, 300)]);
  const back = invertSync(invertSync(s));
  assert.equal(back.offset, s.offset);
  assert.equal(invertSync(s).offset, -s.offset);
  assert.equal(invertSync(s).uncertainty, s.uncertainty);
});

test("composing two hops ADDS their uncertainties", () => {
  const ab = estimateSync("a@1", "hub@1", TB_MICROS, [roundTrip(0, 100, 400, 400)]);
  const bc = estimateSync("hub@1", "c@1", TB_MICROS, [roundTrip(0, 200, 600, 600)]);
  const ac = composeSync(ab, bc);
  assert.equal(ac.offset, 300);
  assert.equal(ac.uncertainty, ab.uncertainty + bc.uncertainty);
  assert.throws(() => composeSync(ab, ab), /middle clocks differ/);
});

// ─── Mapping between clocks ──────────────────────────────────────────────────

test("INTRA-EMBODIMENT alignment is exact and costs no sync at all", () => {
  const host = embodimentClock("laptop", "boot-1");
  const table = new SyncTable("thread:t@e");
  // A mic sample and a camera frame stamped off the SAME host clock never enter the estimated path.
  const mic = mapTicks(48_000, host, AUDIO_48K, host, TB_MICROS, table, { context: "mic" });
  const cam = mapTicks(30, host, videoTimebase(30), host, TB_MICROS, table, { context: "cam" });
  assert.equal(mic.uncertainty, 0);
  assert.equal(cam.uncertainty, 0);
  assert.equal(mic.count, 1_000_000);
  assert.equal(
    cam.count,
    1_000_000,
    "one second of audio and one second of video land on the same tick",
  );
});

test("a cross-embodiment mapping with no measured correspondence throws instead of guessing", () => {
  const phone = embodimentClock("phone", "e");
  const hub = threadClock("t", "e");
  const table = new SyncTable(clockKey(hub));
  assert.throws(() => mapTicks(0, phone, TB_MICROS, hub, TB_MICROS, table), MissingSyncError);
  assert.throws(
    () => mapTicks(0, phone, TB_MICROS, hub, TB_MICROS, table),
    /has never been measured|no correspondence/,
  );
});

test("a cross-embodiment mapping resolves through the hub and carries both hops' doubt", () => {
  const hub = threadClock("t", "e");
  const phone = embodimentClock("phone", "e");
  const vm = embodimentClock("vm", "e");
  const table = new SyncTable(clockKey(hub), [
    estimateSync(clockKey(phone), clockKey(hub), TB_MICROS, [roundTrip(0, 1_000, 400, 400)]),
    estimateSync(clockKey(hub), clockKey(vm), TB_MICROS, [roundTrip(0, -250, 600, 600)]),
  ]);
  const direct = mapTicks(0, phone, TB_MICROS, hub, TB_MICROS, table, { nowTicks: 0 });
  assert.equal(direct.count, 1_000);
  const twoHop = mapTicks(0, phone, TB_MICROS, vm, TB_MICROS, table, { nowTicks: 0 });
  assert.equal(twoHop.count, 750, "1000 forward then 250 back");
  assert.ok(
    twoHop.uncertainty >= direct.uncertainty,
    "two hops can never be more certain than one",
  );
});

test("mapping a Timed keeps its material: start floors, end ceils", () => {
  const hub = threadClock("t", "e");
  const mic = embodimentClock("mic", "e");
  const table = new SyncTable(clockKey(hub), [
    estimateSync(clockKey(mic), clockKey(hub), TB_MICROS, [roundTrip(0, 0, 2, 2)]),
  ]);
  const one = timed(mic, AUDIO_48K, { start: 1, duration: 1 }, "s");
  const { value } = mapTimed(one, hub, TB_MICROS, table, { nowTicks: 0 });
  assert.ok(value.duration >= 1, "a real sample must not map to nothing");
  assert.equal(value.clock.id, "thread:t");
});

// ─── Watermark ───────────────────────────────────────────────────────────────

test("the watermark is the minimum frontier MINUS its doubt, and it names the laggard", () => {
  const hub = threadClock("t", "e");
  const cam = embodimentClock("cam", "e");
  const mic = embodimentClock("mic", "e");
  const table = new SyncTable(clockKey(hub), [
    estimateSync(clockKey(cam), clockKey(hub), TB_MICROS, [roundTrip(0, 0, 100, 100)]),
    estimateSync(clockKey(mic), clockKey(hub), TB_MICROS, [roundTrip(0, 0, 100, 100)]),
  ]);
  const mark = watermark(
    [
      { id: "cam|video", clock: cam, timebase: TB_MICROS, latestEnd: 5_000_000 },
      { id: "mic|audio", clock: mic, timebase: TB_MICROS, latestEnd: 3_000_000 },
    ],
    hub,
    TB_MICROS,
    table,
    { nowTicks: 5_000_000 },
  );
  assert.equal(mark.laggard, "mic|audio");
  assert.ok(
    mark.at < 3_000_000,
    "the frontier must sit BELOW the laggard's end by its uncertainty",
  );
  assert.ok(mark.at > 2_999_000, "and not arbitrarily far below it");
});

test("the watermark of zero sources is undefined, not zero", () => {
  const hub = threadClock("t", "e");
  assert.throws(() => watermark([], hub, TB_MICROS, new SyncTable(clockKey(hub))), /zero sources/);
});

test("isComplete gates on the frontier", () => {
  const hub = threadClock("t", "e");
  const mark = watermark(
    [{ id: "s", clock: hub, timebase: TB_MICROS, latestEnd: 1_000 }],
    hub,
    TB_MICROS,
    new SyncTable(clockKey(hub)),
  );
  assert.ok(isComplete(timed(hub, TB_MICROS, { start: 0, duration: 500 }, null), mark));
  assert.ok(!isComplete(timed(hub, TB_MICROS, { start: 900, duration: 500 }, null), mark));
});

// ─── Joining ─────────────────────────────────────────────────────────────────

test("at-or-before never reads the future; nearest can (MUST-FAIL CONTROL)", () => {
  const c = documentClock("surface");
  const track = [
    timed(c, TB_MILLIS, { start: 0, duration: 0 }, "past"),
    timed(c, TB_MILLIS, { start: 100, duration: 0 }, "future"),
  ];
  const before = joinAt(track, 99, TB_MILLIS, c, "at-or-before", 1_000);
  assert.equal(before[0]!.payload, "past");
  // The control: `nearest` at the same instant picks the value that had not happened yet. Both policies
  // are legitimate; conflating them is what makes a deixis join read the wrong element.
  const nearest = joinAt(track, 99, TB_MILLIS, c, "nearest", 1_000);
  assert.equal(nearest[0]!.payload, "future", "nearest is supposed to be able to read forward");
});

test("a join must state its window; an unbounded one is refused", () => {
  const c = documentClock("s");
  assert.throws(() => joinAt([], 0, TB_MILLIS, c, "nearest", -1), /non-negative window/);
});

test("a value outside the window does not match at all", () => {
  const c = documentClock("s");
  const track = [timed(c, TB_MILLIS, { start: 0, duration: 0 }, "old")];
  assert.deepEqual(joinAt(track, 10_000, TB_MILLIS, c, "at-or-before", 1_500), []);
  assert.equal(joinAt(track, 1_000, TB_MILLIS, c, "at-or-before", 1_500).length, 1);
});

test("within returns the whole span of matches in time order", () => {
  const c = documentClock("s");
  const track = [
    timed(c, TB_MILLIS, { start: 900, duration: 0 }, "we"),
    timed(c, TB_MILLIS, { start: 1_000, duration: 0 }, "need"),
    timed(c, TB_MILLIS, { start: 9_000, duration: 0 }, "later"),
  ];
  assert.deepEqual(
    joinAt(track, 950, TB_MILLIS, c, "within", 500).map((v) => v.payload),
    ["we", "need"],
  );
});

// ─── Tempo ───────────────────────────────────────────────────────────────────

test("beats convert through a tempo map, and the conversion round-trips", () => {
  const map = [{ atBeat: 0, bpm: 120 }];
  // 120 bpm ⇒ one beat is half a second, by definition.
  assert.equal(beatsToSeconds(4, map), 2);
  assert.equal(secondsToBeats(2, map), 4);
  assert.equal(beatsToTicks(4, { num: 1, den: 1 }, map, TB_MICROS, "exact"), 2_000_000);
});

test("a tempo CHANGE is integrated piecewise, not applied retroactively", () => {
  const map = [
    { atBeat: 0, bpm: 120 }, // 0.5 s per beat
    { atBeat: 8, bpm: 60 }, // 1.0 s per beat
  ];
  // Hand-computed ground truth: 8 beats at 120 (4 s) then 4 beats at 60 (4 s) = 8 s.
  assert.equal(beatsToSeconds(12, map), 8);
  assert.ok(Math.abs(secondsToBeats(8, map) - 12) < 1e-9);
});

test("a musical clock without a tempo map is refused — no invented default tempo", () => {
  assert.throws(() => assertTempoMap([]), /at least one entry/);
  assert.throws(() => assertTempoMap([{ atBeat: 4, bpm: 120 }]), /at or before beat 0/);
  assert.throws(() => assertTempoMap([{ atBeat: 0, bpm: 0 }]), /positive, finite tempo/);
  assert.throws(
    () =>
      assertTempoMap([
        { atBeat: 4, bpm: 120 },
        { atBeat: 0, bpm: 60 },
      ]),
    /not sorted/,
  );
});

// ─── Skew, applied ───────────────────────────────────────────────────────────

test("SKEW CORRECTS DRIFT SINCE THE MEASUREMENT, not the absolute count (MUST-FAIL CONTROL)", () => {
  // A peer whose clock gains 100 ppm, measured at t=0, read again 100 s later — inside the staleness
  // ceiling, because past it there is no correspondence to apply skew to at all. Ground truth: after
  // 100 s the peer has gained 100e6 µs × 100e-6 = 10_000 µs = 10 ms.
  const PPM = 100;
  const HOUR = 100_000_000; // µs since the measurement (within SYNC_MAX_AGE_MICROS)
  const sync: Sync = {
    from: "peer@1",
    to: "hub@1",
    timebase: TB_MICROS,
    offset: 0,
    skewPpm: PPM,
    uncertainty: 10,
    measuredAt: 0,
    samples: SYNC_MIN_SKEW_SAMPLES,
  };
  const table = new SyncTable("hub@1", [sync]);
  const peer = { id: "peer", domain: "monotonic", epoch: "1" } as const;
  const hub = { id: "hub", domain: "wall", epoch: "1" } as const;

  const atMeasurement = mapTicks(0, peer, TB_MICROS, hub, TB_MICROS, table, { nowTicks: 0 });
  assert.equal(atMeasurement.count, 0, "at the measurement instant the correction is exactly zero");

  const later = mapTicks(HOUR, peer, TB_MICROS, hub, TB_MICROS, table, { nowTicks: HOUR });
  assert.equal(later.count, HOUR + Math.round((HOUR * PPM) / 1e6), "100 s of 100 ppm is 10 ms");

  // THE CONTROL: the obvious wrong implementation — skew × the ABSOLUTE count. Identical here (because
  // measuredAt is 0), and catastrophically different for a clock whose origin is the epoch, which is
  // what a `wall` reading is. 1.7e15 µs × 100 ppm is ~47 hours of "correction".
  const EPOCH_US = 1_700_000_000_000_000;
  const epochSync: Sync = { ...sync, measuredAt: EPOCH_US };
  const epochTable = new SyncTable("hub@1", [epochSync]);
  const mappedNow = mapTicks(EPOCH_US, peer, TB_MICROS, hub, TB_MICROS, epochTable, {
    nowTicks: EPOCH_US,
  });
  assert.equal(
    mappedNow.count,
    EPOCH_US,
    "a reading AT the measurement maps to itself, at any magnitude",
  );
  const naive = EPOCH_US + (EPOCH_US * PPM) / 1e6;
  assert.ok(
    Math.abs(naive - EPOCH_US) > 1e11,
    `multiplying the absolute count is supposed to be catastrophic (${(naive - EPOCH_US) / 3.6e9} hours)`,
  );
});

test("a NEGATIVE skew (a slow peer) is corrected in the other direction", () => {
  const sync: Sync = {
    from: "peer@1",
    to: "hub@1",
    timebase: TB_MICROS,
    offset: 0,
    skewPpm: -50,
    uncertainty: 10,
    measuredAt: 1_000_000,
    samples: SYNC_MIN_SKEW_SAMPLES,
  };
  const table = new SyncTable("hub@1", [sync]);
  const peer = { id: "peer", domain: "monotonic", epoch: "1" } as const;
  const hub = { id: "hub", domain: "wall", epoch: "1" } as const;
  // 10 s past the measurement, a −50 ppm peer has LOST 500 µs.
  const t = 11_000_000;
  const m = mapTicks(t, peer, TB_MICROS, hub, TB_MICROS, table, { nowTicks: t });
  assert.equal(m.count, t - Math.round((10_000_000 * 50) / 1e6));
});

test("A STALE CORRESPONDENCE IS ABSENT, NOT WIDE — the ceiling that keeps the drift priors harmless", () => {
  // The drift constants only ever apply to a sync's AGE. The hub re-measures every 30 s, so a live sync
  // is worth at most ~1.5 ms of widening at the unfitted rate — noise against a 1.5 SECOND deixis
  // window. Past the ceiling the estimate stops being an estimate, which is what stops those constants
  // from ever being load-bearing (and therefore from being a calibration debt).
  const peer = { id: "peer", domain: "monotonic", epoch: "1" } as const;
  const hub = { id: "hub", domain: "wall", epoch: "1" } as const;
  const sync: Sync = {
    from: clockKey(peer),
    to: clockKey(hub),
    timebase: TB_MICROS,
    offset: 0,
    skewPpm: 0,
    uncertainty: 100,
    measuredAt: 0,
    samples: 4,
  };
  const table = new SyncTable(clockKey(hub), [sync]);

  // Just inside the ceiling: a normal answer, with a bounded widening.
  const fresh = mapTicks(0, peer, TB_MICROS, hub, TB_MICROS, table, {
    nowTicks: SYNC_MAX_AGE_MICROS - 1,
  });
  assert.equal(fresh.count, 0);
  assert.ok(
    fresh.uncertainty < 10_000,
    `the widening inside the ceiling must stay small (got ${fresh.uncertainty} µs)`,
  );

  // Just past it: refused, by name, rather than answered with a large error bar nobody reads.
  assert.throws(
    () =>
      mapTicks(0, peer, TB_MICROS, hub, TB_MICROS, table, { nowTicks: SYNC_MAX_AGE_MICROS + 1 }),
    StaleSyncError,
  );

  // At the cadence the hub actually runs (30 s), the unfitted prior is worth ~1.5 ms — the number that
  // makes "re-fit these constants" unnecessary for every consumer this system has.
  const oneInterval = mapTicks(0, peer, TB_MICROS, hub, TB_MICROS, table, { nowTicks: 30_000_000 });
  assert.ok(
    oneInterval.uncertainty - sync.uncertainty <= 1_600,
    `one sync interval of unfitted drift should be ~1.5 ms, got ${oneInterval.uncertainty - sync.uncertainty} µs`,
  );
});

// ─── Validity — the one staleness rule ───────────────────────────────────────

test("a validity's producer end beats a consumer's refresh interval, and the boundary is half-open", () => {
  // ANCHORED ON THE HALF-OPEN CONVENTION this package states for `Extent` and applies everywhere:
  // `[from, until)`. At the instant it lapses the fact does NOT stand — one tick earlier it does.
  // Written as a boundary pair rather than as "call it and paste what came back".
  assert.equal(validityAt({ from: 0, until: 2_000 }, 1_999), "fresh");
  assert.equal(validityAt({ from: 0, until: 2_000 }, 2_000), "stale");
  assert.equal(validityAt({ from: 0, until: 2_000 }, 2_001), "stale");

  // THE PRECEDENCE: the producer's promise wins over the consumer's refresh interval, in BOTH
  // directions, which is the half a one-sided test would miss. A forecast valid until 06:00Z is
  // fresh at 05:59 even if the consumer refreshes every minute; an expired one is stale even if the
  // consumer would have let it stand for a decade.
  assert.equal(validityAt({ from: 0, until: 10_000, ttl: 1 }, 9_999), "fresh");
  assert.equal(validityAt({ from: 0, until: 1, ttl: 10_000_000 }, 5_000), "stale");
});

test("nothing promised is `unknown`, and `unknown` is neither of the other two", () => {
  // The failure this exists to prevent, stated in `packages/domain/core/src/supplier.ts` and in geo-core's
  // header: "we could not check" and "there are 40 in stock" must never render the same. A fact with
  // no producer end and no consumer interval is one nobody made a promise about.
  assert.equal(validityAt({ from: 0 }, 0), "unknown");
  assert.equal(validityAt({ from: 0 }, 9_999_999), "unknown");
  // …and it is not reachable by the ttl path either: a ttl of ZERO is a promise (of nothing), not
  // an absence. `0` and `undefined` are different facts and `v.ttl === undefined` is the test.
  assert.equal(validityAt({ from: 0, ttl: 0 }, 0), "stale");
});

test("validUntil is the one place a refresh interval becomes an instant", () => {
  // The claim being pinned: a consumer that PRINTS an expiry and one that TESTS it cannot disagree,
  // because the test is `now < validUntil(v)` by construction. Asserted as that identity over a
  // matrix rather than as three hand-picked returns.
  const cases: Validity[] = [
    { from: 1_000, until: 4_000 },
    { from: 1_000, ttl: 3_000 },
    { from: 1_000, until: 4_000, ttl: 99 },
    { from: 1_000 },
  ];
  for (const v of cases) {
    const end = validUntil(v);
    for (const now of [0, 999, 1_000, 3_999, 4_000, 4_001]) {
      const expected = end === null ? "unknown" : now < end ? "fresh" : "stale";
      assert.equal(validityAt(v, now), expected, `${JSON.stringify(v)} at ${now}`);
    }
  }
  assert.equal(validUntil({ from: 1_000 }), null);
});
