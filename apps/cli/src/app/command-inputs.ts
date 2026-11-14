import { Effect, Option } from 'effect';
import { Argument, Flag } from 'effect/cli';
import { maxPage } from '../features/assets/library.ts';
import { InvalidInput } from '../shared/errors/errors.ts';

// Like `Flag.optional`, but a repeated flag is an error: the parser would keep
// the first value, so `--album a --album b` would silently mean the first one.
export const once = <A>(self: Flag.Flag<A>): Flag.Flag<Option.Option<A>> =>
  self.pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
  );

export const optionalString = (name: string, description: string) =>
  once(Flag.String(name).pipe(Flag.withDescription(description)));

/** A switch that is off unless given. */
export const flag = (name: string, description: string) =>
  once(Flag.Boolean(name).pipe(Flag.withDescription(description))).pipe(
    Flag.map(Option.getOrElse(() => false)),
  );

/** A yes-or-no choice that may be left open: `--name` or `--no-name`. */
export const choice = (name: string, description: string) =>
  once(Flag.Boolean(name).pipe(Flag.withDescription(description)));

export const fail = (message: string) =>
  Effect.fail(new InvalidInput({ message }));

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * An Immich id. It goes into request paths, so anything but a UUID is
 * refused here rather than sent.
 */
export const validId = (value: string) => {
  const id = value.trim().toLowerCase();
  return uuidPattern.test(id)
    ? Effect.succeed(id)
    : fail(
        `${value} is not an Immich id. Ids look like 5f0c1e9a-3b7d-4c2e-9a41-0d6b8f2e7c13.`,
      );
};

/** Several ids, each once, in the order given. */
export const validIds = (values: ReadonlyArray<string>) =>
  Effect.forEach(values, validId).pipe(Effect.map((ids) => [...new Set(ids)]));

export const idsArgument = (name: string, description: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(description),
    Argument.variadic({ min: 1 }),
  );

export const idArgument = (name: string, description: string) =>
  Argument.String(name).pipe(Argument.withDescription(description));

export const optionalInt = (name: string, description: string) =>
  once(Flag.Int(name).pipe(Flag.withDescription(description)));

/** A whole number within bounds, or the default when the flag is absent. */
export const bounded = (
  name: string,
  value: Option.Option<number>,
  range: {
    readonly fallback: number;
    readonly min: number;
    readonly max: number;
  },
) => {
  const chosen = Option.getOrElse(value, () => range.fallback);
  return chosen >= range.min && chosen <= range.max
    ? Effect.succeed(chosen)
    : fail(`--${name} must be between ${range.min} and ${range.max}.`);
};

/** How many results one page of a list holds: `--limit`. */
export const pageSize = (value: Option.Option<number>, fallback: number) =>
  bounded('limit', value, { fallback, min: 1, max: maxPage });
