import { DateTime, Effect, Option } from 'effect';
import { InvalidInput } from '../shared/errors/errors.ts';

const relativePattern = /^(?<amount>\d+)\s*(?<unit>m|h|d|w)$/u;
const wallClockPattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/u;
const instantPattern =
  /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/iu;

const units = {
  m: 'minutes',
  h: 'hours',
  d: 'days',
  w: 'weeks',
} as const;

const lastHour = 23;
const lastMinute = 59;
const lastSecond = 59;

/** Which end of a range a time marks; a bare day spans the whole day. */
export type Bound = 'start' | 'end';

const invalid = (flag: string, value: string) =>
  new InvalidInput({
    message: `--${flag} ${value} is not a time. Use an age such as 30m, 2h, 3d or 1w, a day as YYYY-MM-DD, a local time as YYYY-MM-DDTHH:MM, or an ISO time with an offset.`,
  });

/** An age before now, such as `3d`, or nothing if the text is not one. */
const ago = (text: string) =>
  Effect.gen(function* () {
    const groups = relativePattern.exec(text)?.groups;
    if (groups === undefined) {
      return Option.none<DateTime.DateTime>();
    }
    const unit = units[groups.unit as keyof typeof units];
    const now = yield* DateTime.nowInCurrentZone;
    return Option.some<DateTime.DateTime>(
      DateTime.subtract(now, { [unit]: Number(groups.amount) }),
    );
  });

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly hasTime: boolean;
};

const wallClockParts = (text: string): Option.Option<WallClock> => {
  const groups = wallClockPattern.exec(text)?.groups;
  if (groups === undefined) {
    return Option.none();
  }
  const parts = {
    year: Number(groups.year),
    month: Number(groups.month),
    day: Number(groups.day),
    hour: Number(groups.hour ?? 0),
    minute: Number(groups.minute ?? 0),
    second: Number(groups.second ?? 0),
    hasTime: groups.hour !== undefined,
  };
  return parts.hour > lastHour ||
    parts.minute > lastMinute ||
    parts.second > lastSecond
    ? Option.none()
    : Option.some(parts);
};

/** A day or wall-clock time in this machine's time zone. */
const local = (parts: WallClock, bound: Bound) =>
  Effect.gen(function* () {
    const zone = yield* DateTime.CurrentTimeZone;
    const { hasTime, ...clock } = parts;
    const zoned = DateTime.makeZoned(clock, {
      timeZone: zone,
      adjustForTimeZone: true,
    });
    // A date such as February 31 rolls over instead of failing.
    const exists = Option.exists(zoned, (time) => {
      const made = DateTime.toParts(time);
      return made.day === parts.day && made.month === parts.month;
    });
    if (!exists || Option.isNone(zoned)) {
      return Option.none<DateTime.DateTime>();
    }
    const wholeDay = !hasTime && bound === 'end';
    return Option.some<DateTime.DateTime>(
      wholeDay
        ? DateTime.subtract(DateTime.add(zoned.value, { days: 1 }), {
            milliseconds: 1,
          })
        : zoned.value,
    );
  });

/**
 * The moment a person means by a time: an age before now, a day or a
 * wall-clock time in this machine's time zone, or an instant, which keeps the
 * offset it was given with. As the end of a range, a bare day means its last
 * moment, so `--to 2026-11-14` includes that whole day.
 */
const readTime = (flag: string, value: string, bound: Bound) =>
  Effect.gen(function* () {
    const text = value.trim();
    const relative = yield* ago(text);
    if (Option.isSome(relative)) {
      return relative.value;
    }
    const parsed = instantPattern.test(text)
      ? Option.orElse(
          DateTime.makeZonedFromString(text),
          // makeZonedFromString refuses Z, which is UTC.
          (): Option.Option<DateTime.DateTime> => DateTime.make(text),
        )
      : yield* Option.match(wallClockParts(text), {
          onNone: () => Effect.succeedNone,
          onSome: (parts) => local(parts, bound),
        });
    if (Option.isNone(parsed)) {
      return yield* invalid(flag, value);
    }
    return parsed.value;
  });

/** The ISO instant in UTC a person means by a time, as described at `readTime`. */
export const parseTime = (flag: string, value: string, bound: Bound) =>
  Effect.map(readTime(flag, value, bound), DateTime.formatIso);

/**
 * When a photo was taken, as an ISO time with its offset. Immich shows a photo
 * at the wall-clock time of the offset it is given, so a photo set to noon in
 * Berlin as a UTC instant would show at 11:00. A bare day means its start.
 */
export const parseTakenAt = (flag: string, value: string) =>
  Effect.map(readTime(flag, value, 'start'), DateTime.formatIsoOffset);

/** Parses an optional time flag. */
export const optionalTime = (
  flag: string,
  value: Option.Option<string>,
  bound: Bound,
) =>
  Option.match(value, {
    onNone: () => Effect.succeed(undefined),
    onSome: (text) => parseTime(flag, text, bound),
  });
