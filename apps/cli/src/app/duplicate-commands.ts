import { Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import { DuplicatesSchema, summarize } from '../features/assets/assets.ts';
import { browsable, getAssets, maxPage } from '../features/assets/library.ts';
import { BulkResultSchema } from '../shared/bulk.ts';
import { ImmichRejected } from '../shared/errors/errors.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  fail,
  idArgument,
  idsArgument,
  optionalInt,
  pageSize,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';
import { requireTrash } from './tidy-commands.ts';

const duplicatesDefault = 20;
// Immich answers a resolve with 200 and reports each group's failure inside.
const resolvedStatus = 200;

const getGroups = requestJson(
  { method: 'GET', path: '/duplicates' },
  DuplicatesSchema,
);

/** The groups with these ids, or a failure naming the ids that are none. */
const findGroups = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const groups = yield* getGroups;
    const unknown = ids.filter(
      (id) => !groups.some((group) => group.duplicateId === id),
    );
    if (unknown.length > 0) {
      return yield* fail(
        `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a group of duplicates. \`photos duplicates list\` shows the groups.`,
      );
    }
    return ids.flatMap((id) =>
      groups.filter((group) => group.duplicateId === id),
    );
  });

const list = Command.make(
  'list',
  {
    limit: optionalInt(
      'limit',
      `How many groups (default ${duplicatesDefault}, at most ${maxPage})`,
    ),
  },
  ({ limit }) =>
    runImmich(pageSize(limit, duplicatesDefault), (chosen) =>
      getGroups.pipe(
        Effect.map((groups) => ({
          groups: groups.length,
          duplicates: groups.slice(0, chosen).map((group) => ({
            duplicateId: group.duplicateId,
            keep: group.suggestedKeepAssetIds,
            assets: group.assets.map(summarize),
          })),
        })),
      ),
    ),
).pipe(
  Command.withDescription(
    'List groups of photos Immich found to look alike, with the ones it suggests keeping',
  ),
);

/** The photos of a group, once every photo to keep is found among them. */
const groupAssets = (duplicateId: string, keep: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [group] = yield* findGroups([duplicateId]);
    const assets = group?.assets ?? [];
    const strangers = keep.filter(
      (keepId) => !assets.some((asset) => asset.id === keepId),
    );
    if (strangers.length > 0) {
      return yield* fail(
        `${strangers.join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not in duplicate group ${duplicateId}. Its photos are ${assets.map((asset) => asset.id).join(', ')}.`,
      );
    }
    return assets;
  });

const resolve = Command.make(
  'resolve',
  {
    id: idArgument('duplicate', 'Duplicate group id (its duplicateId)'),
    keep: Flag.String('keep').pipe(
      Flag.withDescription(
        'Asset id of a photo in the group to keep; repeat the flag to keep several',
      ),
      Flag.atLeast(1),
    ),
  },
  ({ id, keep }) =>
    runImmich(
      Effect.gen(function* () {
        return { id: yield* validId(id), keep: yield* validIds(keep) };
      }),
      (input) =>
        Effect.gen(function* () {
          const { trashDays } = yield* requireTrash;
          const assets = yield* groupAssets(input.id, input.keep);
          const toTrash = yield* browsable(
            assets.filter((asset) => !input.keep.includes(asset.id)),
          );
          const [result] = yield* requestJson(
            {
              method: 'POST',
              path: '/duplicates/resolve',
              body: {
                groups: [
                  {
                    duplicateId: input.id,
                    keepAssetIds: input.keep,
                    trashAssetIds: toTrash.map((asset) => asset.id),
                  },
                ],
              },
            },
            BulkResultSchema,
          );
          if (result !== undefined && !result.success) {
            return yield* new ImmichRejected({
              status: resolvedStatus,
              message: `Immich did not resolve ${input.id}: ${result.errorMessage ?? result.error ?? 'no reason given'}.`,
            });
          }
          const kept = yield* getAssets(input.keep);
          return {
            kept: kept.map(summarize),
            trashed: toTrash.map((asset) =>
              summarize({ ...asset, isTrashed: true }),
            ),
            trashDays,
            restoreWith:
              toTrash.length === 0
                ? null
                : `photos restore ${toTrash.map((asset) => asset.id).join(' ')}`,
          };
        }),
    ),
).pipe(
  Command.withDescription(
    "Settle a group of duplicates: keep the photos given with --keep and move the rest of the group to the trash, where Immich keeps them for trashDays days. Refused while Immich's trash is off. When exactly one photo is kept, Immich first gives it what the others had: their albums and tags, the favorite mark if any had it, the locked folder or the archive if any was there (the locked folder first), the highest rating, every line of their descriptions, and their location if they all agree on one. The taken date is not merged.",
  ),
);

const dismiss = Command.make(
  'dismiss',
  { ids: idsArgument('duplicate', 'Duplicate group ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.gen(function* () {
        const groups = yield* findGroups(valid);
        yield* requestNothing({
          method: 'DELETE',
          path: '/duplicates',
          body: { ids: valid },
        });
        return {
          dismissed: groups.map((group) => ({
            duplicateId: group.duplicateId,
            assetIds: group.assets.map((asset) => asset.id),
          })),
          note: 'Every photo stays where it was. Immich no longer lists these groups as duplicates.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Tell Immich that groups are not duplicates after all. Keeps every photo and changes nothing about them.',
  ),
);

export const duplicates = Command.make('duplicates').pipe(
  Command.withDescription(
    'Find photos Immich thinks are duplicates, and keep the best of each group or dismiss the group',
  ),
  Command.withSubcommands([list, resolve, dismiss]),
);
