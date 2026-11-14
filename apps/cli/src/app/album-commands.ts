import { Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import {
  AlbumListSchema,
  AlbumSchema,
  getAlbum,
  matchesName,
  summarizeAlbum,
} from '../features/albums/albums.ts';
import { AssetPageSchema } from '../features/assets/assets.ts';
import { maxPage, searchAssets } from '../features/assets/library.ts';
import { searchRequest } from '../features/assets/search.ts';
import { BulkResultSchema, splitResults } from '../shared/bulk.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import { share, unshare } from './album-share-commands.ts';
import {
  fail,
  idArgument,
  idsArgument,
  optionalInt,
  optionalString,
  pageSize,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const albumPageDefault = 100;

const albumName = (value: string) => {
  const name = value.trim();
  return name === '' ? fail('An album needs a name.') : Effect.succeed(name);
};

const list = Command.make(
  'list',
  { name: optionalString('name', 'Only albums whose name contains this') },
  ({ name }) =>
    runImmich(Effect.succeed(name), (chosen) =>
      requestJson({ method: 'GET', path: '/albums' }, AlbumListSchema).pipe(
        Effect.map((all) =>
          all
            .filter((album) =>
              Option.match(chosen, {
                onNone: () => true,
                onSome: (text) => matchesName(album, text),
              }),
            )
            .map(summarizeAlbum),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    'List the albums, their own and those shared with this account',
  ),
);

const show = Command.make(
  'show',
  {
    id: idArgument('album', 'Album id'),
    limit: optionalInt(
      'limit',
      `How many photos (default ${albumPageDefault}, at most ${maxPage})`,
    ),
    cursor: optionalString('cursor', 'The nextCursor of the previous page'),
  },
  ({ id, limit, cursor }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          id: yield* validId(id),
          limit: yield* pageSize(limit, albumPageDefault),
          cursor: Option.getOrUndefined(cursor),
        };
      }),
      (input) =>
        Effect.gen(function* () {
          const album = yield* getAlbum(input.id);
          const page = yield* searchAssets({
            albumId: input.id,
            limit: input.limit,
            cursor: input.cursor,
            oldestFirst: album.order === 'asc',
          });
          return { album: summarizeAlbum(album), ...page };
        }),
    ),
).pipe(
  Command.withDescription(
    'Show an album and its photos, in pages, in the order the album sorts them',
  ),
);

const create = Command.make(
  'create',
  {
    name: Argument.String('name').pipe(Argument.withDescription('Album name')),
    description: optionalString('description', 'What the album is about'),
    assets: Argument.String('asset').pipe(
      Argument.withDescription('Asset ids to put in it'),
      Argument.variadic(),
    ),
  },
  ({ name, description, assets }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          albumName: yield* albumName(name),
          description: Option.getOrUndefined(description)?.trim(),
          assetIds: yield* validIds(assets),
        };
      }),
      (body) =>
        requestJson(
          { method: 'POST', path: '/albums', body },
          AlbumSchema,
        ).pipe(Effect.map(summarizeAlbum)),
    ),
).pipe(Command.withDescription('Create an album, with photos in it or empty'));

const update = Command.make(
  'update',
  {
    id: idArgument('album', 'Album id'),
    name: optionalString('name', 'New name'),
    description: optionalString(
      'description',
      'New description; an empty one clears it',
    ),
    cover: optionalString(
      'cover',
      'Asset id of the photo to show as the cover',
    ),
  },
  ({ id, name, description, cover }) =>
    runImmich(
      Effect.gen(function* () {
        const changes = {
          ...(Option.isSome(name)
            ? { albumName: yield* albumName(name.value) }
            : {}),
          ...(Option.isSome(description)
            ? { description: description.value.trim() }
            : {}),
          ...(Option.isSome(cover)
            ? { albumThumbnailAssetId: yield* validId(cover.value) }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --name, --description or --cover.',
          );
        }
        return { id: yield* validId(id), changes };
      }),
      ({ id: valid, changes }) =>
        requestJson(
          { method: 'PATCH', path: `/albums/${valid}`, body: changes },
          AlbumSchema,
        ).pipe(Effect.map(summarizeAlbum)),
    ),
).pipe(
  Command.withDescription('Rename an album or change its description or cover'),
);

const albumAndAssets = (album: string, assets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return { album: yield* validId(album), ids: yield* validIds(assets) };
  });

const add = Command.make(
  'add',
  {
    album: idArgument('album', 'Album id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ album, assets }) =>
    runImmich(albumAndAssets(album, assets), ({ album: id, ids }) =>
      Effect.gen(function* () {
        const results = yield* requestJson(
          { method: 'PUT', path: `/albums/${id}/assets`, body: { ids } },
          BulkResultSchema,
        );
        const { changed, unchanged } = splitResults(results);
        const now = yield* getAlbum(id);
        return { album: summarizeAlbum(now), added: changed, unchanged };
      }),
    ),
).pipe(
  Command.withDescription(
    'Put photos in an album. Photos already in it are listed as unchanged.',
  ),
);

const remove = Command.make(
  'remove',
  {
    album: idArgument('album', 'Album id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ album, assets }) =>
    runImmich(albumAndAssets(album, assets), ({ album: id, ids }) =>
      Effect.gen(function* () {
        const results = yield* requestJson(
          { method: 'DELETE', path: `/albums/${id}/assets`, body: { ids } },
          BulkResultSchema,
        );
        const { changed, unchanged } = splitResults(results);
        const now = yield* getAlbum(id);
        return { album: summarizeAlbum(now), removed: changed, unchanged };
      }),
    ),
).pipe(
  Command.withDescription(
    'Take photos out of an album. They stay in the library.',
  ),
);

/** Every asset id in an album, page by page. */
const albumAssetIds = (albumId: string) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let cursor: string | undefined;
    do {
      const { assets } = yield* requestJson(
        searchRequest({ albumId, limit: maxPage, cursor }),
        AssetPageSchema,
      );
      ids.push(...assets.items.map(({ id }) => id));
      cursor = assets.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return ids;
  });

const deleteAlbum = Command.make(
  'delete',
  { id: idArgument('album', 'Album id') },
  ({ id }) =>
    runImmich(validId(id), (valid) =>
      Effect.gen(function* () {
        const album = yield* getAlbum(valid);
        const assetIds = yield* albumAssetIds(valid);
        yield* requestNothing({ method: 'DELETE', path: `/albums/${valid}` });
        return {
          deleted: summarizeAlbum(album),
          assetIds,
          note: 'The photos stay in the library. To bring the album back, run `photos albums create` with its name and these asset ids.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Delete an album. Its photos stay in the library; the output lists them, so the album can be made again.',
  ),
);

export const albums = Command.make('albums').pipe(
  Command.withDescription(
    'List, look at, create, change, share and delete albums',
  ),
  Command.withSubcommands([
    list,
    show,
    create,
    update,
    add,
    remove,
    deleteAlbum,
    share,
    unshare,
  ]),
);
