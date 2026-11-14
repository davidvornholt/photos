import { Effect, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import {
  MemoryCountSchema,
  memoryTypes,
  validDay,
} from '../features/memories/memories.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  bounded,
  choice,
  flag,
  idArgument,
  once,
  optionalInt,
  optionalString,
  pageSize,
  validId,
} from './command-inputs.ts';
import {
  getMemory,
  MemoryWithAssetsSchema,
  memoryAndAssets,
  memorySummary,
} from './memory-assets.ts';
import { add, create, remove, update } from './memory-change-commands.ts';
import { runImmich } from './root.ts';

const memoryPageDefault = 50;

const list = Command.make(
  'list',
  {
    for: optionalString(
      'for',
      'Only memories Immich shows on this day, YYYY-MM-DD',
    ),
    saved: choice(
      'saved',
      'Only saved memories, or with --no-saved only the rest',
    ),
    type: once(
      Flag.Literals('type', memoryTypes).pipe(
        Flag.withDescription('Only on_this_day or only birthday memories'),
      ),
    ),
    oldestFirst: flag('oldest-first', 'Oldest first instead of newest first'),
    limit: optionalInt(
      'limit',
      `How many memories (default ${memoryPageDefault})`,
    ),
    page: optionalInt('page', 'Which page, counting from 1 (default 1)'),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const filters = {
          for: Option.isSome(flags.for)
            ? yield* validDay('for', flags.for.value)
            : undefined,
          isSaved: Option.getOrUndefined(Option.map(flags.saved, String)),
          type: Option.getOrUndefined(flags.type),
        };
        return {
          filters,
          size: yield* pageSize(flags.limit, memoryPageDefault),
          page: yield* bounded('page', flags.page, {
            fallback: 1,
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          order: flags.oldestFirst ? 'asc' : 'desc',
        };
      }),
      ({ filters, size, page, order }) =>
        Effect.gen(function* () {
          const [memories, count] = yield* Effect.all(
            [
              requestJson(
                {
                  method: 'GET',
                  path: '/memories',
                  query: {
                    ...filters,
                    order,
                    size: String(size),
                    page: String(page),
                  },
                },
                Schema.Array(MemoryWithAssetsSchema),
              ),
              requestJson(
                { method: 'GET', path: '/memories/statistics', query: filters },
                MemoryCountSchema,
              ),
            ],
            { concurrency: 'unbounded' },
          );
          return {
            total: count.total,
            page,
            nextPage: page * size < count.total ? page + 1 : null,
            memories: memories.map(memorySummary),
          };
        }),
    ),
).pipe(
  Command.withDescription(
    'List memories, the photos from earlier years Immich shows above the timeline, newest first',
  ),
);

const show = Command.make(
  'show',
  { id: idArgument('memory', 'Memory id') },
  ({ id }) =>
    runImmich(validId(id), (valid) =>
      getMemory(valid).pipe(Effect.map(memoryAndAssets)),
    ),
).pipe(Command.withDescription('Show a memory and its photos'));

const deleteMemory = Command.make(
  'delete',
  { id: idArgument('memory', 'Memory id') },
  ({ id }) =>
    runImmich(validId(id), (valid) =>
      Effect.gen(function* () {
        const memory = yield* getMemory(valid);
        yield* requestNothing({ method: 'DELETE', path: `/memories/${valid}` });
        const { date } = memorySummary(memory);
        return {
          deleted: memorySummary(memory),
          assetIds: memory.assets.map((asset) => asset.id),
          note: `The photos stay in the library. To make the memory again, run \`photos memories create\` with these asset ids and --date ${date.slice(0, 'YYYY-MM-DD'.length)}.`,
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Delete a memory. Its photos stay in the library; the output lists them, so the memory can be made again.',
  ),
);

export const memories = Command.make('memories').pipe(
  Command.withDescription(
    'List, look at, make, change and delete memories, the photos from earlier years Immich shows above the timeline',
  ),
  Command.withSubcommands([
    list,
    show,
    create,
    update,
    add,
    remove,
    deleteMemory,
  ]),
);
