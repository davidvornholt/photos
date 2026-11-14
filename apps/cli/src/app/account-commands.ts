import { Effect, Layer, Option, Redacted, Stdio, Stream } from 'effect';
import { Command, Prompt } from 'effect/cli';
import {
  ApiKeySchema,
  FeaturesSchema,
  missingPermissions,
  ServerConfigSchema,
  UserSchema,
  VersionSchema,
} from '../features/account/account.ts';
import { removePreviews } from '../features/assets/files.ts';
import {
  forgetCredentials,
  readCredentials,
  saveCredentials,
} from '../shared/credentials.ts';
import { NotSignedIn } from '../shared/errors/errors.ts';
import {
  httpLayer,
  Immich,
  immichLayer,
  makeImmich,
  requestJson,
} from '../shared/immich.ts';
import { exampleServer, serverOrigin } from '../shared/server.ts';
import { fail, optionalString } from './command-inputs.ts';
import { emit } from './output.ts';

// An API key is one word; anything with spaces is a paste gone wrong.
const whitespace = /\s/u;

/** Who the key belongs to, what it may do, and what the server offers. */
const account = Effect.gen(function* () {
  const { server } = yield* Immich;
  const [key, version, features, config] = yield* Effect.all(
    [
      requestJson({ method: 'GET', path: '/api-keys/me' }, ApiKeySchema),
      requestJson({ method: 'GET', path: '/server/version' }, VersionSchema),
      requestJson({ method: 'GET', path: '/server/features' }, FeaturesSchema),
      requestJson(
        { method: 'GET', path: '/server/config' },
        ServerConfigSchema,
      ),
    ],
    { concurrency: 'unbounded' },
  );
  const user = yield* requestJson(
    { method: 'GET', path: '/users/me' },
    UserSchema,
  ).pipe(
    Effect.map(({ name }) => name),
    Effect.catchTag('MissingPermission', () => Effect.succeed(null)),
  );
  return {
    signedIn: true,
    server,
    user,
    apiKey: key.name,
    missingPermissions: missingPermissions(key),
    immich: {
      version: `${version.major}.${version.minor}.${version.patch}`,
      smartSearch: features.smartSearch,
      ocr: features.ocr,
      duplicateDetection: features.duplicateDetection,
      trash: features.trash,
      trashDays: config.trashDays,
    },
  };
});

const noKey = () =>
  fail(
    'No API key arrived. Paste it when asked, or pipe it in: photos login --server <address> < key-file',
  );

/**
 * The key, typed hidden at a terminal or piped in, so it never appears in
 * the shell history or the process list.
 */
const readKey = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    const key = yield* Prompt.run(
      Prompt.Hidden({ message: 'Immich API key' }),
    ).pipe(Effect.catchTag('QuitError', noKey));
    return Redacted.value(key).trim();
  }
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.map((text) => text.trim()),
    Effect.catchTag('PlatformError', noKey),
  );
});

export const login = Command.make(
  'login',
  {
    server: optionalString(
      'server',
      `The address of your Immich server, such as ${exampleServer}. Defaults to the one this machine used before.`,
    ),
  },
  ({ server }) =>
    Effect.gen(function* () {
      const stored = yield* readCredentials;
      const chosen = Option.orElse(server, () =>
        Option.map(stored, (previous) => previous.server),
      );
      if (Option.isNone(chosen)) {
        return yield* fail(
          `Pass --server with the address of your Immich server, such as ${exampleServer}.`,
        );
      }
      const origin = yield* serverOrigin(chosen.value);
      const apiKey = yield* readKey;
      if (apiKey === '') {
        return yield* noKey();
      }
      if (whitespace.test(apiKey)) {
        return yield* fail(
          'That is not an API key: it contains spaces or line breaks. Paste only the key.',
        );
      }
      const credentials = { server: origin, apiKey };
      // Checked before it is saved, so a typo never replaces a working key.
      const checked = yield* account.pipe(
        Effect.provide(
          Layer.effect(Immich, makeImmich(credentials)).pipe(
            Layer.provide(httpLayer),
          ),
        ),
        Effect.catchTag('NotSignedIn', () =>
          Effect.fail(
            new NotSignedIn({
              message: `${origin} does not accept this API key. Check that the whole key was pasted, or create a new one in Immich under Account Settings > API Keys. The key stored before, if any, is unchanged.`,
            }),
          ),
        ),
      );
      yield* saveCredentials(credentials);
      yield* emit(checked);
    }),
).pipe(
  Command.withDescription(
    'Store an Immich API key for this machine after checking it with the server. Reads the key hidden from the terminal, or from stdin. Create the key in Immich under Account Settings > API Keys.',
  ),
);

export const logout = Command.make('logout', {}, () =>
  Effect.gen(function* () {
    const removed = yield* forgetCredentials;
    const removedPreviews = yield* removePreviews;
    yield* emit({
      signedIn: false,
      removedKey: removed,
      removedPreviews,
      note: 'The key itself keeps working until you delete it in Immich under Account Settings > API Keys.',
    });
  }),
).pipe(
  Command.withDescription(
    'Remove the API key and the saved previews from this machine',
  ),
);

export const status = Command.make('status', {}, () =>
  Effect.gen(function* () {
    const stored = yield* readCredentials;
    if (Option.isNone(stored)) {
      yield* emit({ signedIn: false, server: null });
      return;
    }
    const result = yield* account.pipe(
      Effect.provide(immichLayer),
      Effect.catchTag('NotSignedIn', (error) =>
        Effect.succeed({
          signedIn: false,
          server: stored.value.server,
          problem: error.message,
        }),
      ),
    );
    yield* emit(result);
  }),
).pipe(
  Command.withDescription(
    'Show the server, whose key this is, the permissions it lacks, and what the server offers: smart search, OCR, duplicate detection, and how long the trash keeps photos',
  ),
);
