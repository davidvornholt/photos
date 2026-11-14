import { DateTime, Effect, Option } from 'effect';
import { fail } from './command-inputs.ts';
import { parseTime } from './time-inputs.ts';

/** How long a new link works unless `--expires` says otherwise. */
export const defaultExpiry = '7d';

const agePattern = /^(?<amount>\d+)\s*(?<unit>m|h|d|w)$/u;

const units = {
  m: 'minutes',
  h: 'hours',
  d: 'days',
  w: 'weeks',
} as const;

/**
 * When a link stops working, as an ISO instant, or null for `never`. An age
 * such as `7d` counts from now; a day means its last moment, so
 * `--expires 2026-12-24` works through Christmas Eve.
 */
export const expiryTime = (value: string) =>
  Effect.gen(function* () {
    const text = value.trim().toLowerCase();
    if (text === 'never') {
      return null;
    }
    const now = yield* DateTime.now;
    const groups = agePattern.exec(text)?.groups;
    const iso =
      groups === undefined
        ? yield* parseTime('expires', value, 'end')
        : DateTime.formatIso(
            DateTime.add(now, {
              [units[groups.unit as keyof typeof units]]: Number(groups.amount),
            }),
          );
    const inFuture = Option.exists(DateTime.make(iso), (end) =>
      DateTime.isGreaterThan(end, now),
    );
    return inFuture
      ? iso
      : yield* fail(
          `--expires ${value} is not in the future. Use an age from now such as 7d, a later day or time, or never.`,
        );
  });

/** A text flag where an empty value clears the field. */
export const clearable = (value: string) => {
  const text = value.trim();
  return text === '' ? null : text;
};

/** A link password: kept as typed, and never empty. */
export const linkPassword = (value: string) =>
  value === ''
    ? fail('--password needs a value. To remove it, use --remove-password.')
    : Effect.succeed(value);
