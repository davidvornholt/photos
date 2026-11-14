import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { DuplicatesSchema, summarize } from '../features/assets/assets.ts';
import { maxPage } from '../features/assets/library.ts';
import { requestJson } from '../shared/immich.ts';
import { optionalInt, pageSize } from './command-inputs.ts';
import { runImmich } from './root.ts';

const duplicatesDefault = 20;

export const duplicates = Command.make(
  'duplicates',
  {
    limit: optionalInt(
      'limit',
      `How many groups (default ${duplicatesDefault}, at most ${maxPage})`,
    ),
  },
  ({ limit }) =>
    runImmich(pageSize(limit, duplicatesDefault), (chosen) =>
      requestJson(
        { method: 'GET', path: '/duplicates' },
        DuplicatesSchema,
      ).pipe(
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
