import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { immichLayer } from '../shared/immich.ts';
import { emit } from './output.ts';

export const root = Command.make('photos').pipe(
  Command.withDescription(
    'Find, look at, download and tidy the photos in an Immich library through its API. Prints JSON. Deletes only into the trash, where Immich keeps photos until they expire.',
  ),
);

// Checks a command's input, then runs its requests with this machine's API key
// and prints the result. The key is read only after the input passes, so a
// mistake in the input is reported as one even when no key is stored.
export const runImmich = <I, A, E1, E2, R1, R2>(
  input: Effect.Effect<I, E1, R1>,
  request: (input: I) => Effect.Effect<A, E2, R2>,
) =>
  Effect.gen(function* () {
    const valid = yield* input;
    const data = yield* request(valid).pipe(Effect.provide(immichLayer));
    yield* emit(data);
  });
