import { Effect, Option, Schema } from 'effect';
import { Command } from 'effect/cli';
import { AssetSchema, summarize } from '../features/assets/assets.ts';
import {
  AssetStackSchema,
  describeStack,
  listedStack,
  stackSchema,
} from '../features/stacks/stacks.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  fail,
  idArgument,
  idsArgument,
  optionalString,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const StackSchema = stackSchema(AssetSchema);
type Stack = typeof StackSchema.Type;
const StackListSchema = Schema.Array(StackSchema);

// Enough to look up a handful of stacks quickly without crowding the server.
const lookupConcurrency = 4;
const minStackSize = 2;

const getStack = (id: string) =>
  requestJson({ method: 'GET', path: `/stacks/${id}` }, StackSchema);

const listed = (stack: Stack) => listedStack(stack, summarize);
const described = (stack: Stack) => describeStack(stack, summarize);

/** The stack a photo is in, among all its photos and not only the primary one. */
const stackOf = (assetId: string) =>
  Effect.gen(function* () {
    const { stack } = yield* requestJson(
      { method: 'GET', path: `/assets/${assetId}` },
      AssetStackSchema,
    );
    return stack === undefined || stack === null
      ? []
      : [yield* getStack(stack.id)];
  });

const list = Command.make(
  'list',
  {
    asset: optionalString(
      'asset',
      'Only the stack this photo is in, whether it is the primary one or not',
    ),
  },
  ({ asset }) =>
    runImmich(
      Option.match(asset, {
        onNone: () => Effect.succeed(undefined),
        onSome: validId,
      }),
      (assetId) =>
        (assetId === undefined
          ? requestJson({ method: 'GET', path: '/stacks' }, StackListSchema)
          : stackOf(assetId)
        ).pipe(Effect.map((found) => found.map(listed))),
    ),
).pipe(
  Command.withDescription(
    'List the stacks, each with its primary photo, the one the timeline shows, and the ids of all its photos, primary first',
  ),
);

const show = Command.make(
  'show',
  { stack: idArgument('stack', 'Stack id') },
  ({ stack }) =>
    runImmich(validId(stack), (id) => getStack(id).pipe(Effect.map(described))),
).pipe(
  Command.withDescription(
    'Show a stack with all its photos, the primary one first. Photos in the trash are left out.',
  ),
);

const create = Command.make(
  'create',
  {
    assets: idsArgument(
      'asset',
      'Asset ids, the one to be the primary photo first',
    ),
  },
  ({ assets }) =>
    runImmich(
      validIds(assets).pipe(
        Effect.flatMap((ids) =>
          ids.length < minStackSize
            ? fail('A stack needs at least two different photos.')
            : Effect.succeed(ids),
        ),
      ),
      (assetIds) =>
        requestJson(
          { method: 'POST', path: '/stacks', body: { assetIds } },
          StackSchema,
        ).pipe(Effect.map(described)),
    ),
).pipe(
  Command.withDescription(
    'Stack photos, such as a burst or a RAW file and its JPEG, so the timeline shows only the first one given, the primary photo. A photo in another stack moves to the new one; when it was the primary photo there, its whole stack joins.',
  ),
);

const update = Command.make(
  'update',
  {
    stack: idArgument('stack', 'Stack id'),
    primary: optionalString(
      'primary',
      'Asset id of the photo in the stack to make the primary one',
    ),
  },
  ({ stack, primary }) =>
    runImmich(
      Effect.gen(function* () {
        if (Option.isNone(primary)) {
          return yield* fail('Nothing to change. Pass --primary.');
        }
        return {
          id: yield* validId(stack),
          primaryAssetId: yield* validId(primary.value),
        };
      }),
      ({ id, primaryAssetId }) =>
        requestJson(
          { method: 'PUT', path: `/stacks/${id}`, body: { primaryAssetId } },
          StackSchema,
        ).pipe(Effect.map(described)),
    ),
).pipe(
  Command.withDescription(
    'Make another photo in a stack the primary one, the one the timeline shows',
  ),
);

/** Takes one photo out of a stack, or says why Immich would not. */
const takeOut = (stack: Stack, assetId: string) =>
  assetId === stack.primaryAssetId
    ? Effect.succeed({
        id: assetId,
        reason:
          'It is the primary photo. Make another one primary with `photos stacks update` first, or delete the stack.',
      })
    : requestNothing({
        method: 'DELETE',
        path: `/stacks/${stack.id}/assets/${assetId}`,
      }).pipe(
        Effect.as(undefined),
        Effect.catchTag('ImmichRejected', (error) =>
          Effect.succeed({ id: assetId, reason: error.message }),
        ),
      );

const remove = Command.make(
  'remove',
  {
    stack: idArgument('stack', 'Stack id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ stack, assets }) =>
    runImmich(
      Effect.gen(function* () {
        return { id: yield* validId(stack), ids: yield* validIds(assets) };
      }),
      ({ id, ids }) =>
        Effect.gen(function* () {
          const before = yield* getStack(id);
          const outcomes = yield* Effect.forEach(ids, (assetId) =>
            takeOut(before, assetId),
          );
          const unchanged = outcomes.filter((outcome) => outcome !== undefined);
          const removed = ids.filter(
            (assetId) => !unchanged.some((outcome) => outcome.id === assetId),
          );
          const now = yield* getStack(id);
          return { stack: described(now), removed, unchanged };
        }),
    ),
).pipe(
  Command.withDescription(
    'Take photos out of a stack. They stay in the library and show on the timeline again. The primary photo cannot be taken out.',
  ),
);

const deleteStacks = Command.make(
  'delete',
  { stackIds: idsArgument('stack', 'Stack ids') },
  ({ stackIds }) =>
    runImmich(validIds(stackIds), (ids) =>
      Effect.gen(function* () {
        const found = yield* Effect.forEach(ids, getStack, {
          concurrency: lookupConcurrency,
        });
        yield* requestNothing({
          method: 'DELETE',
          path: '/stacks',
          body: { ids },
        });
        return {
          deleted: found.map((stack) => {
            const { id, primaryAssetId, assetIds } = listed(stack);
            return { id, primaryAssetId, assetIds };
          }),
          note: "The photos stay in the library, no longer stacked. To stack them again, run `photos stacks create` with a stack's asset ids, primary first.",
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Unstack: delete stacks. Their photos stay in the library and show on the timeline again; the output lists them, so the stacks can be made again.',
  ),
);

export const stacks = Command.make('stacks').pipe(
  Command.withDescription(
    'List, look at, create, change and delete stacks: groups of photos, such as a burst, that the timeline shows as one, the primary photo',
  ),
  Command.withSubcommands([list, show, create, update, remove, deleteStacks]),
);
