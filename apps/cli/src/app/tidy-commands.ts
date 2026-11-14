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

const maxRating = 5;

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
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --favorite, --archived, --description or --rating, or their --no- forms.',
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
          const updated = yield* getAssets(ids);
          return updated.map(summarize);
        }),
    ),
).pipe(
  Command.withDescription(
    'Change the favorite mark, archive, description or rating of photos. Prints them as they are now.',
  ),
);
