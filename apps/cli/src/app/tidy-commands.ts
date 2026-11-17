import { Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import {
  FeaturesSchema,
  ServerConfigSchema,
} from '../features/account/account.ts';
import { CountSchema, summarize } from '../features/assets/assets.ts';
import { browsable, getAssets } from '../features/assets/library.ts';
import { TrashDisabled } from '../shared/errors/errors.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  bounded,
  choice,
  fail,
  idsArgument,
  optionalInt,
  optionalString,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';
import { parseTakenAt } from './time-inputs.ts';

const maxRating = 5;

// Immich applies a new time taken in the background, usually within seconds,
// so update looks again for up to about 15 seconds before printing.
const takenAtChecks = 30;
const takenAtCheckInterval = '500 millis';
// Immich may store the time to the second only.
const takenAtTolerance = 1000;

/**
 * The photos as they are now; with a new time taken, once Immich shows it on
 * all of them or the checks run out.
 */
const changedAssets = (ids: ReadonlyArray<string>, takenAt?: string) =>
  Effect.gen(function* () {
    const wanted = takenAt === undefined ? undefined : Date.parse(takenAt);
    for (let check = 1; ; check += 1) {
      const assets = yield* getAssets(ids);
      const settled =
        wanted === undefined ||
        assets.every(
          (asset) =>
            Math.abs(Date.parse(asset.fileCreatedAt) - wanted) <
            takenAtTolerance,
        );
      if (settled || check === takenAtChecks) {
        return assets;
      }
      yield* Effect.sleep(takenAtCheckInterval);
    }
  });

/**
 * Immich's trash settings, or a failure while the trash is off: then Immich
 * deletes for good what it is asked to delete, and photos never deletes for
 * good. Every command that moves photos to the trash checks this first.
 */
export const requireTrash = Effect.gen(function* () {
  const [features, config] = yield* Effect.all(
    [
      requestJson({ method: 'GET', path: '/server/features' }, FeaturesSchema),
      requestJson(
        { method: 'GET', path: '/server/config' },
        ServerConfigSchema,
      ),
    ],
    { concurrency: 'unbounded' },
  );
  if (!features.trash) {
    return yield* new TrashDisabled({
      message:
        "Immich's trash is turned off, so deleting would remove the photos for good. photos only moves photos to the trash; turn the trash back on in Immich's settings first.",
    });
  }
  return { trashDays: config.trashDays };
});

export const trash = Command.make(
  'trash',
  { ids: idsArgument('id', 'Asset ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.gen(function* () {
        const { trashDays } = yield* requireTrash;
        const assets = yield* getAssets(valid).pipe(Effect.flatMap(browsable));
        const toTrash = assets.filter((asset) => !asset.isTrashed);
        if (toTrash.length > 0) {
          yield* requestNothing({
            method: 'DELETE',
            path: '/assets',
            body: { ids: toTrash.map(({ id }) => id), force: false },
          });
        }
        return {
          trashed: toTrash.map((asset) =>
            summarize({ ...asset, isTrashed: true }),
          ),
          alreadyInTrash: assets
            .filter((asset) => asset.isTrashed)
            .map(({ id }) => id),
          trashDays,
          restoreWith: `photos restore ${valid.join(' ')}`,
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Move photos to the trash, where Immich keeps them for trashDays days before it deletes them. Never deletes for good. Prints what moved and how to restore it.',
  ),
);

export const restore = Command.make(
  'restore',
  { ids: idsArgument('id', 'Asset ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.gen(function* () {
        const assets = yield* getAssets(valid);
        const inTrash = assets.filter((asset) => asset.isTrashed);
        if (inTrash.length > 0) {
          yield* requestJson(
            {
              method: 'POST',
              path: '/trash/restore/assets',
              body: { ids: inTrash.map(({ id }) => id) },
            },
            CountSchema,
          );
        }
        const restored = yield* getAssets(inTrash.map(({ id }) => id));
        return {
          restored: restored.map(summarize),
          notInTrash: assets
            .filter((asset) => !asset.isTrashed)
            .map(({ id }) => id),
        };
      }),
    ),
).pipe(Command.withDescription('Bring photos back from the trash'));

export const update = Command.make(
  'update',
  {
    ids: idsArgument('id', 'Asset ids'),
    favorite: choice(
      'favorite',
      'Mark as favorite, or --no-favorite to unmark',
    ),
    archived: choice(
      'archived',
      'Move to the archive, or --no-archived back to the timeline',
    ),
    description: optionalString(
      'description',
      'Set the description; an empty one clears it',
    ),
    rating: optionalInt(
      'rating',
      `Set the star rating, 1 to ${maxRating}; 0 clears it`,
    ),
    takenAt: optionalString(
      'taken-at',
      "Set when the photo was taken: a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MM in this machine's time zone, or an ISO time with an offset",
    ),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const ids = yield* validIds(flags.ids);
        const rating = Option.isSome(flags.rating)
          ? yield* bounded('rating', flags.rating, {
              fallback: 0,
              min: 0,
              max: maxRating,
            })
          : undefined;
        const takenAt = Option.isSome(flags.takenAt)
          ? yield* parseTakenAt('taken-at', flags.takenAt.value)
          : undefined;
        const changes = {
          ...Option.match(flags.favorite, {
            onNone: () => ({}),
            onSome: (isFavorite) => ({ isFavorite }),
          }),
          ...Option.match(flags.archived, {
            onNone: () => ({}),
            onSome: (archived) => ({
              visibility: archived ? 'archive' : 'timeline',
            }),
          }),
          ...Option.match(flags.description, {
            onNone: () => ({}),
            onSome: (description) => ({ description: description.trim() }),
          }),
          ...(rating === undefined
            ? {}
            : { rating: rating === 0 ? null : rating }),
          ...(takenAt === undefined ? {} : { dateTimeOriginal: takenAt }),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --favorite, --archived, --description, --rating or --taken-at, or the --no- forms of the first two.',
          );
        }
        return { ids, changes };
      }),
      ({ ids, changes }) =>
        Effect.gen(function* () {
          yield* getAssets(ids).pipe(Effect.flatMap(browsable));
          yield* requestNothing({
            method: 'PUT',
            path: '/assets',
            body: { ids, ...changes },
          });
          const updated = yield* changedAssets(ids, changes.dateTimeOriginal);
          return updated.map(summarize);
        }),
    ),
).pipe(
  Command.withDescription(
    'Change the favorite mark, archive, description, rating or time taken of photos. Prints them as they are now.',
  ),
);
