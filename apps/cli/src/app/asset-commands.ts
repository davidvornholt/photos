import { Effect, FileSystem, Option, Path } from 'effect';
import { Command, Flag } from 'effect/cli';
import { AlbumListSchema } from '../features/albums/albums.ts';
import { describeAsset, OcrSchema } from '../features/assets/assets.ts';
import {
  checkFree,
  originalNames,
  previewSizes,
  saveOriginal,
  savePreview,
} from '../features/assets/files.ts';
import {
  browsable,
  getAsset,
  getAssets,
  maxPage,
  searchAssets,
} from '../features/assets/library.ts';
import type { AssetQuery } from '../features/assets/search.ts';
import { FileNotSaved, InvalidInput } from '../shared/errors/errors.ts';
import { requestJson } from '../shared/immich.ts';
import {
  choice,
  fail,
  flag,
  idsArgument,
  once,
  optionalInt,
  optionalString,
  pageSize,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';
import { optionalTime } from './time-inputs.ts';

const recentDefault = 20;
const searchDefault = 50;
// Enough to look at a handful of photos quickly without crowding the server.
const lookupConcurrency = 4;

const optionalText = (value: Option.Option<string>) =>
  Option.getOrUndefined(
    Option.filter(
      Option.map(value, (text) => text.trim()),
      (text) => text !== '',
    ),
  );

/** A flag that may be given several times, each with an id. */
const repeatedIds = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));

const timeHelp =
  'an age such as 30m, 2h, 3d or 1w; a day as YYYY-MM-DD; or a time';

export const recent = Command.make(
  'recent',
  {
    limit: optionalInt(
      'limit',
      `How many photos (default ${recentDefault}, at most ${maxPage})`,
    ),
    since: optionalString('since', `Only photos taken since then: ${timeHelp}`),
  },
  ({ limit, since }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          limit: yield* pageSize(limit, recentDefault),
          takenFrom: yield* optionalTime('since', since, 'start'),
        };
      }),
      searchAssets,
    ),
).pipe(
  Command.withDescription(
    'List the newest photos and videos, newest taken first, such as the ones just taken on the phone',
  ),
);

export const search = Command.make(
  'search',
  {
    query: optionalString(
      'query',
      'What the photo shows, in words (smart search), such as "receipt" or "dog on a beach". Ranked by likeness, one page only.',
    ),
    ocr: optionalString('ocr', 'Text visible in the photo, as Immich read it'),
    fileName: optionalString('file-name', 'Part of the original file name'),
    description: optionalString('description', 'Part of the description'),
    from: optionalString('from', `Taken at or after: ${timeHelp}`),
    to: optionalString('to', `Taken at or before: ${timeHelp}`),
    uploadedFrom: optionalString(
      'uploaded-from',
      `Uploaded at or after: ${timeHelp}`,
    ),
    uploadedTo: optionalString(
      'uploaded-to',
      `Uploaded at or before: ${timeHelp}`,
    ),
    type: once(
      Flag.Literals('type', ['image', 'video']).pipe(
        Flag.withDescription('Only photos (image) or only videos (video)'),
      ),
    ),
    album: optionalString('album', 'Only what is in this album (album id)'),
    withoutAlbum: flag('without-album', 'Only what is in no album'),
    person: repeatedIds(
      'person',
      'Only photos that show this person (person id from `photos people list`). Repeat it for photos that show all of them.',
    ),
    tag: repeatedIds(
      'tag',
      'Only photos with this tag or a tag below it (tag id). Repeat it for photos that have all of them.',
    ),
    favorite: choice(
      'favorite',
      'Only favorites, or with --no-favorite only the rest',
    ),
    archived: choice(
      'archived',
      'Only archived photos, or with --no-archived only the timeline. Both by default.',
    ),
    trashed: flag('trashed', 'Search the trash instead of the library'),
    oldestFirst: flag('oldest-first', 'Oldest taken first instead of newest'),
    limit: optionalInt(
      'limit',
      `How many results (default ${searchDefault}, at most ${maxPage})`,
    ),
    cursor: optionalString('cursor', 'The nextCursor of the previous page'),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const query: AssetQuery = {
          query: optionalText(flags.query),
          ocr: optionalText(flags.ocr),
          fileName: optionalText(flags.fileName),
          description: optionalText(flags.description),
          takenFrom: yield* optionalTime('from', flags.from, 'start'),
          takenTo: yield* optionalTime('to', flags.to, 'end'),
          uploadedFrom: yield* optionalTime(
            'uploaded-from',
            flags.uploadedFrom,
            'start',
          ),
          uploadedTo: yield* optionalTime(
            'uploaded-to',
            flags.uploadedTo,
            'end',
          ),
          type: Option.getOrUndefined(
            Option.map(flags.type, (type) =>
              type === 'image' ? ('IMAGE' as const) : ('VIDEO' as const),
            ),
          ),
          albumId: Option.isSome(flags.album)
            ? yield* validId(flags.album.value)
            : undefined,
          withoutAlbum: flags.withoutAlbum,
          personIds: yield* validIds(flags.person),
          tagIds: yield* validIds(flags.tag),
          favorite: Option.getOrUndefined(flags.favorite),
          archived: Option.getOrUndefined(flags.archived),
          trashed: flags.trashed,
          oldestFirst: flags.oldestFirst,
          limit: yield* pageSize(flags.limit, searchDefault),
          cursor: optionalText(flags.cursor),
        };
        if (query.query !== undefined && query.cursor !== undefined) {
          return yield* fail(
            'A --query search ranks by likeness and has no further pages. Raise --limit instead of passing --cursor.',
          );
        }
        if (query.query !== undefined && query.oldestFirst === true) {
          return yield* fail(
            'A --query search ranks by likeness, so --oldest-first does not apply.',
          );
        }
        if (query.albumId !== undefined && query.withoutAlbum === true) {
          return yield* fail('Pass --album or --without-album, not both.');
        }
        return query;
      }),
      searchAssets,
    ),
).pipe(
  Command.withDescription(
    'Search the library by what photos show, text in them, file name, description, time taken or uploaded, type, album, people, tags and flags. Without --query, newest taken first, in pages.',
  ),
);

export const show = Command.make(
  'show',
  { ids: idsArgument('id', 'Asset ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.forEach(
        valid,
        (id) =>
          Effect.gen(function* () {
            const [asset, albums, ocr] = yield* Effect.all(
              [
                getAsset(id),
                requestJson(
                  { method: 'GET', path: '/albums', query: { assetId: id } },
                  AlbumListSchema,
                ),
                requestJson(
                  { method: 'GET', path: `/assets/${id}/ocr` },
                  OcrSchema,
                ),
              ],
              { concurrency: 'unbounded' },
            );
            return describeAsset(
              asset,
              albums.map((album) => ({ id: album.id, name: album.albumName })),
              ocr.map(({ text }) => text),
            );
          }),
        { concurrency: lookupConcurrency },
      ),
    ),
).pipe(
  Command.withDescription(
    'Show everything about photos: when and where they were taken (place name, never coordinates), camera, size, rating, description, albums, the people Immich recognized in them, tags, the stack they belong to, and the text Immich read in them',
  ),
);

export const preview = Command.make(
  'preview',
  {
    ids: idsArgument('id', 'Asset ids'),
    size: once(
      Flag.Literals('size', previewSizes).pipe(
        Flag.withDescription(
          'preview (about 1440 px, the default) or thumbnail (about 250 px)',
        ),
      ),
    ),
  },
  ({ ids, size }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.forEach(
        valid,
        (id) =>
          Effect.map(
            savePreview(
              id,
              Option.getOrElse(size, () => 'preview' as const),
            ),
            (path) => ({ id, path }),
          ),
        { concurrency: lookupConcurrency },
      ),
    ),
).pipe(
  Command.withDescription(
    'Save a preview image of each photo or video to a private temporary directory and print its path, to look at it. Previews carry no camera metadata.',
  ),
);

export const download = Command.make(
  'download',
  {
    ids: idsArgument('id', 'Asset ids'),
    to: Flag.String('to').pipe(
      Flag.withDescription('An existing directory to save the originals in'),
    ),
  },
  ({ ids, to }) =>
    runImmich(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const directory = path.resolve(to);
        const info = yield* fs.stat(directory).pipe(
          Effect.mapError(
            () =>
              new InvalidInput({
                message: `--to ${to} is not a directory. Create it first.`,
              }),
          ),
        );
        if (info.type !== 'Directory') {
          return yield* new InvalidInput({
            message: `--to ${to} is not a directory.`,
          });
        }
        return { directory, ids: yield* validIds(ids) };
      }),
      ({ directory, ids: valid }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const assets = yield* getAssets(valid).pipe(
            Effect.flatMap(browsable),
          );
          const files = originalNames(assets).map((name) =>
            path.join(directory, name),
          );
          yield* checkFree(files);
          return yield* Effect.forEach(assets, (asset, index) =>
            Effect.gen(function* () {
              const file = files[index];
              if (file === undefined) {
                return yield* new FileNotSaved({
                  message: `No file name for ${asset.id}.`,
                });
              }
              const saved = yield* saveOriginal(asset.id, file);
              return {
                id: asset.id,
                fileName: asset.originalFileName,
                ...saved,
              };
            }),
          );
        }),
    ),
).pipe(
  Command.withDescription(
    'Save the original files, with all their metadata, into a directory. Never replaces a file that is already there.',
  ),
);
