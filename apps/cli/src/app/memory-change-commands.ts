import { DateTime, Effect, Option } from 'effect';
import { Command } from 'effect/cli';
import { takenAt } from '../features/assets/assets.ts';
import { getAssets } from '../features/assets/library.ts';
import {
  memoryAt,
  unsavedMemoryDays,
  validDay,
  yearOf,
} from '../features/memories/memories.ts';
import { BulkResultSchema, splitResults } from '../shared/bulk.ts';
import { requestJson } from '../shared/immich.ts';
import {
  choice,
  fail,
  flag,
  idArgument,
  idsArgument,
  optionalString,
  validId,
  validIds,
} from './command-inputs.ts';
import {
  getMemory,
  MemoryWithAssetsSchema,
  memorySummary,
  onTimeline,
} from './memory-assets.ts';
import { runImmich } from './root.ts';
import { optionalTime } from './time-inputs.ts';

const timeHelp =
  'a day as YYYY-MM-DD, a local time as YYYY-MM-DDTHH:MM, or a time with an offset';

const unsavedNote = `Immich deletes a memory that is not saved ${unsavedMemoryDays} days after it was made. \`photos memories update <memory> --saved\` keeps it.`;

const dayLength = 'YYYY-MM-DD'.length;

/** The day the earliest of the photos was taken, where it was taken. */
const earliestDay = (taken: ReadonlyArray<string>) =>
  taken
    .map((time) => time.slice(0, dayLength))
    .reduce<string | undefined>(
      (earliest, day) =>
        earliest === undefined || day < earliest ? day : earliest,
      undefined,
    );

export const create = Command.make(
  'create',
  {
    assets: idsArgument('asset', 'Asset ids of the photos in it'),
    date: optionalString(
      'date',
      'The day it remembers, YYYY-MM-DD (default: the day the earliest photo was taken). Immich titles it with the years since.',
    ),
    showFrom: optionalString('show-from', `Show it from then on: ${timeHelp}`),
    showUntil: optionalString('show-until', `Show it until then: ${timeHelp}`),
    saved: flag(
      'saved',
      `Save it, so that Immich keeps it past ${unsavedMemoryDays} days`,
    ),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const showAt = yield* optionalTime(
          'show-from',
          flags.showFrom,
          'start',
        );
        const hideAt = yield* optionalTime(
          'show-until',
          flags.showUntil,
          'end',
        );
        if (showAt !== undefined && hideAt !== undefined && showAt > hideAt) {
          return yield* fail('--show-from must come before --show-until.');
        }
        return {
          ids: yield* validIds(flags.assets),
          day: Option.isSome(flags.date)
            ? yield* validDay('date', flags.date.value)
            : undefined,
          showAt,
          hideAt,
          isSaved: flags.saved,
        };
      }),
      ({ ids, day, ...rest }) =>
        Effect.gen(function* () {
          const assets = yield* getAssets(ids).pipe(Effect.flatMap(onTimeline));
          const chosen = day ?? earliestDay(assets.map(takenAt));
          if (chosen === undefined) {
            return yield* fail('A memory needs photos.');
          }
          const memory = yield* requestJson(
            {
              method: 'POST',
              path: '/memories',
              body: {
                type: 'on_this_day',
                data: { year: yearOf(chosen) },
                memoryAt: memoryAt(chosen),
                assetIds: ids,
                ...rest,
              },
            },
            MemoryWithAssetsSchema,
          );
          return {
            ...memorySummary(memory),
            ...(memory.isSaved ? {} : { note: unsavedNote }),
          };
        }),
    ),
).pipe(
  Command.withDescription(
    'Make a memory of photos, the kind Immich shows above the timeline as "N years ago". Without --show-from and --show-until, Immich shows it every day.',
  ),
);

export const update = Command.make(
  'update',
  {
    id: idArgument('memory', 'Memory id'),
    saved: choice(
      'saved',
      `Save it, so that Immich keeps it past ${unsavedMemoryDays} days, or --no-saved to let it go`,
    ),
    seen: flag('seen', 'Mark it as seen now'),
    date: optionalString(
      'date',
      'Move it to another day, YYYY-MM-DD; the year Immich titles it with stays',
    ),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const changes = {
          ...Option.match(flags.saved, {
            onNone: () => ({}),
            onSome: (isSaved) => ({ isSaved }),
          }),
          ...(flags.seen
            ? { seenAt: DateTime.formatIso(yield* DateTime.now) }
            : {}),
          ...(Option.isSome(flags.date)
            ? { memoryAt: memoryAt(yield* validDay('date', flags.date.value)) }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --saved, --no-saved, --seen or --date.',
          );
        }
        return { id: yield* validId(flags.id), changes };
      }),
      ({ id, changes }) =>
        requestJson(
          { method: 'PUT', path: `/memories/${id}`, body: changes },
          MemoryWithAssetsSchema,
        ).pipe(Effect.map(memorySummary)),
    ),
).pipe(
  Command.withDescription(
    'Save a memory, mark it as seen, or move it to another day. Prints it as it is now.',
  ),
);

const memoryAndAssetIds = (memory: string, assets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return { id: yield* validId(memory), ids: yield* validIds(assets) };
  });

export const add = Command.make(
  'add',
  {
    memory: idArgument('memory', 'Memory id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ memory, assets }) =>
    runImmich(memoryAndAssetIds(memory, assets), ({ id, ids }) =>
      Effect.gen(function* () {
        yield* getAssets(ids).pipe(Effect.flatMap(onTimeline));
        const results = yield* requestJson(
          { method: 'PUT', path: `/memories/${id}/assets`, body: { ids } },
          BulkResultSchema,
        );
        const { changed, unchanged } = splitResults(results);
        const now = yield* getMemory(id);
        return { memory: memorySummary(now), added: changed, unchanged };
      }),
    ),
).pipe(
  Command.withDescription(
    'Put photos in a memory. Photos already in it are listed as unchanged.',
  ),
);

export const remove = Command.make(
  'remove',
  {
    memory: idArgument('memory', 'Memory id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ memory, assets }) =>
    runImmich(memoryAndAssetIds(memory, assets), ({ id, ids }) =>
      Effect.gen(function* () {
        const results = yield* requestJson(
          { method: 'DELETE', path: `/memories/${id}/assets`, body: { ids } },
          BulkResultSchema,
        );
        const { changed, unchanged } = splitResults(results);
        const now = yield* getMemory(id);
        return { memory: memorySummary(now), removed: changed, unchanged };
      }),
    ),
).pipe(
  Command.withDescription(
    'Take photos out of a memory. They stay in the library.',
  ),
);
