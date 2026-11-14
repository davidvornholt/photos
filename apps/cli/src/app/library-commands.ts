import { Effect, Option, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { AlbumCountsSchema } from '../features/albums/albums.ts';
import {
  CurrentUserSchema,
  ServerUsersSchema,
} from '../features/albums/sharing.ts';
import { AssetSchema, summarize } from '../features/assets/assets.ts';
import {
  AssetCountsSchema,
  FolderPathsSchema,
  maxPage,
  PeopleCountsSchema,
} from '../features/assets/library.ts';
import { MemoryCountSchema } from '../features/memories/memories.ts';
import { requestJson } from '../shared/immich.ts';
import {
  fail,
  optionalInt,
  optionalString,
  pageSize,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const folderPageDefault = 100;

const trailingSlashes = /\/+$/u;

/** Photos, videos and everything together that match a filter. */
const assetCounts = (query: Readonly<Record<string, string>> = {}) =>
  requestJson(
    { method: 'GET', path: '/assets/statistics', query },
    AssetCountsSchema,
  ).pipe(
    Effect.map(({ images, videos, total }) => ({
      photos: images,
      videos,
      total,
    })),
  );

export const stats = Command.make('stats', {}, () =>
  runImmich(Effect.void, () =>
    Effect.all(
      {
        library: assetCounts(),
        favorites: assetCounts({ isFavorite: 'true' }),
        archived: assetCounts({ visibility: 'archive' }),
        trash: assetCounts({ isTrashed: 'true' }),
        albums: requestJson(
          { method: 'GET', path: '/albums/statistics' },
          AlbumCountsSchema,
        ),
        people: requestJson(
          { method: 'GET', path: '/people', query: { size: '1' } },
          PeopleCountsSchema,
        ).pipe(Effect.map(({ total, hidden }) => ({ total, hidden }))),
        memories: requestJson(
          { method: 'GET', path: '/memories/statistics' },
          MemoryCountSchema,
        ).pipe(Effect.map(({ total }) => total)),
      },
      { concurrency: 'unbounded' },
    ),
  ),
).pipe(
  Command.withDescription(
    'Count what this account has. library is the timeline and the archive, without the trash; favorites and archived are parts of it. albums counts those it owns, those shared by or with it, and its own that nobody else sees. people counts the people Immich recognized, hidden ones included.',
  ),
);

const listFolders = Command.make(
  'list',
  { path: optionalString('path', 'Only folders whose path contains this') },
  ({ path }) =>
    runImmich(Effect.succeed(path), (chosen) =>
      requestJson(
        { method: 'GET', path: '/view/folder/unique-paths' },
        FolderPathsSchema,
      ).pipe(
        Effect.map((paths) =>
          Option.match(chosen, {
            onNone: () => paths,
            onSome: (text) =>
              paths.filter((folder) =>
                folder.toLowerCase().includes(text.trim().toLowerCase()),
              ),
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "List the folders on the server that hold this account's photos, as Immich stores them. Archived photos are left out.",
  ),
);

const showFolder = Command.make(
  'show',
  {
    path: Argument.String('path').pipe(
      Argument.withDescription('A folder as `photos folders list` prints it'),
    ),
    limit: optionalInt(
      'limit',
      `How many photos (default ${folderPageDefault}, at most ${maxPage})`,
    ),
  },
  ({ path, limit }) =>
    runImmich(
      Effect.gen(function* () {
        const folder = path.trim().replace(trailingSlashes, '');
        if (folder === '') {
          return yield* fail('Name a folder.');
        }
        return { folder, limit: yield* pageSize(limit, folderPageDefault) };
      }),
      ({ folder, limit: chosen }) =>
        requestJson(
          { method: 'GET', path: '/view/folder', query: { path: folder } },
          Schema.Array(AssetSchema),
        ).pipe(
          Effect.map((assets) => ({
            path: folder,
            count: assets.length,
            assets: assets.slice(0, chosen).map(summarize),
          })),
        ),
    ),
).pipe(
  Command.withDescription(
    'Show the photos stored directly in one folder, not in the folders inside it, by file name. Archived photos are left out.',
  ),
);

export const folders = Command.make('folders').pipe(
  Command.withDescription(
    'Browse the photos by the folders the server stores them in',
  ),
  Command.withSubcommands([listFolders, showFolder]),
);

export const users = Command.make('users', {}, () =>
  runImmich(Effect.void, () =>
    Effect.all(
      [
        requestJson({ method: 'GET', path: '/users' }, ServerUsersSchema),
        requestJson({ method: 'GET', path: '/users/me' }, CurrentUserSchema),
      ],
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map(([all, me]) =>
        all.map(({ id, name, email }) => ({
          id,
          name,
          email,
          isThisAccount: id === me.id,
        })),
      ),
    ),
  ),
).pipe(
  Command.withDescription(
    "List the accounts on the server, the ones albums can be shared with. Unless Immich's admin lets users see each other, an account that is not an admin sees only itself.",
  ),
);
