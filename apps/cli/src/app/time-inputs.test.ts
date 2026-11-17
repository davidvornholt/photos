import { describe, expect, it } from 'bun:test';
import { DateTime, Effect } from 'effect';
import { type Bound, parseTakenAt, parseTime } from './time-inputs.ts';

const parse = (value: string, bound: Bound = 'start', zone = 'Europe/Berlin') =>
  Effect.runPromise(
    parseTime('from', value, bound).pipe(
      Effect.provide(DateTime.layerCurrentZoneNamed(zone)),
      Effect.result,
    ),
  );

const instant = async (
  value: string,
  bound: Bound = 'start',
  zone?: string,
) => {
  const result = await parse(value, bound, zone);
  if (result._tag === 'Failure') {
    throw new Error(result.failure.message);
  }
  return result.success;
};

describe('parseTime', () => {
  it.each([
    ['2026-11-14', 'start', '2026-11-13T23:00:00.000Z'],
    ['2026-11-14', 'end', '2026-11-14T22:59:59.999Z'],
    ['2026-07-14', 'start', '2026-07-13T22:00:00.000Z'],
    ['2026-11-14T10:30', 'end', '2026-11-14T09:30:00.000Z'],
    ['2026-11-14 10:30:15', 'start', '2026-11-14T09:30:15.000Z'],
    ['2026-03-29', 'end', '2026-03-29T21:59:59.999Z'],
    ['2026-11-14T10:30:00Z', 'start', '2026-11-14T10:30:00.000Z'],
    ['2026-11-14T10:30:00-05:00', 'start', '2026-11-14T15:30:00.000Z'],
  ] as const)('reads %s as the %s %s', async (value, bound, expected) => {
    expect(await instant(value, bound)).toBe(expected);
  });

  it('reads a day in the time zone of the machine', async () => {
    expect(await instant('2026-11-14', 'start', 'America/New_York')).toBe(
      '2026-11-14T05:00:00.000Z',
    );
  });

  it('reads an age as that long before now', async () => {
    const before = Date.now();
    const parsed = Date.parse(await instant('3d'));
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect(parsed).toBeGreaterThanOrEqual(before - threeDays - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() - threeDays);
  });

  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-11-14T24:00',
    '2026-11-14T10:60',
    'yesterday',
    '3 days',
    '',
  ])('refuses %j', async (value) => {
    const result = await parse(value);
    expect(result._tag).toBe('Failure');
  });
});

// Berlin is an hour ahead of UTC in winter and two in summer.
const berlinOffset = /[+]0[12]:00$/u;

describe('parseTakenAt', () => {
  const takenAt = async (value: string) => {
    const result = await Effect.runPromise(
      parseTakenAt('taken-at', value).pipe(
        Effect.provide(DateTime.layerCurrentZoneNamed('Europe/Berlin')),
        Effect.result,
      ),
    );
    if (result._tag === 'Failure') {
      throw new Error(result.failure.message);
    }
    return result.success;
  };

  it.each([
    ['2024-11-01', '2024-11-01T00:00:00.000+01:00'],
    ['2024-07-01T12:00', '2024-07-01T12:00:00.000+02:00'],
    ['2024-11-01T12:00:00-05:00', '2024-11-01T12:00:00.000-05:00'],
    ['2024-11-01T12:00+0530', '2024-11-01T12:00:00.000+05:30'],
    ['2024-11-01T12:00:00Z', '2024-11-01T12:00:00.000Z'],
  ])('keeps the offset of %s as %s', async (value, expected) => {
    expect(await takenAt(value)).toBe(expected);
  });

  it('reads an age in the time zone of the machine', async () => {
    expect(await takenAt('3d')).toMatch(berlinOffset);
  });
});
