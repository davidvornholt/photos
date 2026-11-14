import { Effect, Option, Path } from 'effect';
import { Argument, Command } from 'effect/cli';
import {
  AlbumListSchema,
  getAlbum,
  summarizeAlbum,
} from '../features/albums/albums.ts';
import { summarize } from '../features/assets/assets.ts';
import { browsable, getAsset, getAssets } from '../features/assets/library.ts';
import {
  checkFiles,
  type LocalFile,
  localFile,
  type UploadCheck,
  uploadFile,
} from '../features/upload/upload.ts';
import { BulkResultSchema, splitResults } from '../shared/bulk.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  choice,
  fail,
  idArgument,
  optionalString,
  validId,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

/** A file as the caller named it, with what was found out about it. */
type Named = { readonly given: string; readonly file: LocalFile };

/** The files named, each checked and each once, however it was spelled. */
const localFiles = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const seen = new Set<string>();
    const unique = paths.filter((given) => {
      const absolute = path.resolve(given);
      const fresh = !seen.has(absolute);
      seen.add(absolute);
      return fresh;
    });
    return yield* Effect.forEach(unique, (given) =>
      Effect.map(localFile(given), (file): Named => ({ given, file })),
    );
  });

/** What happened to one file. */
type Outcome =
  | {
      readonly file: string;
      readonly status: 'created';
      readonly assetId: string;
    }
  | {
      readonly file: string;
      readonly status: 'duplicate';
      readonly assetId: string;
      readonly trashed: boolean;
    }
  | {
      readonly file: string;
      readonly status: 'failed';
      readonly reason: string;
    };

const refusal = (reason: string | undefined) =>
  reason === 'unsupported-format'
    ? 'Immich does not take files of this kind'
    : `Immich refused it (${reason ?? 'no reason given'})`;

/**
 * Uploads a file unless the check found it in the library already. A file
 * named twice under different names goes up once; the second upload finds
 * the first and is listed as a duplicate of it.
 */
const sendFile = ({ given, file }: Named, check: UploadCheck | undefined) => {
  if (check?.action === 'reject' && check.reason !== 'duplicate') {
    return Effect.succeed<Outcome>({
      file: given,
      status: 'failed',
      reason: refusal(check.reason),
    });
  }
  if (check?.action === 'reject' && check.assetId !== undefined) {
    return Effect.succeed<Outcome>({
      file: given,
      status: 'duplicate',
      assetId: check.assetId,
      trashed: check.isTrashed ?? false,
    });
  }
  return Effect.map(uploadFile(file), (result): Outcome => {
    if (result.status === 'failed') {
      return { file: given, status: 'failed', reason: result.reason };
    }
    return result.status === 'created'
      ? { file: given, status: 'created', assetId: result.assetId }
      : {
          file: given,
          status: 'duplicate',
          assetId: result.assetId,
          trashed: false,
        };
  });
};

/** The photos to put in the album: all that arrived, but none in the trash. */
const inLibrary = (outcomes: ReadonlyArray<Outcome>) =>
  outcomes.flatMap((result) =>
    result.status === 'created' ||
    (result.status === 'duplicate' && !result.trashed)
      ? [result.assetId]
      : [],
  );

const addToAlbum = (albumId: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { changed, unchanged } =
      ids.length === 0
        ? { changed: [], unchanged: [] }
        : splitResults(
            yield* requestJson(
              {
                method: 'PUT',
                path: `/albums/${albumId}/assets`,
                body: { ids },
              },
              BulkResultSchema,
            ),
          );
    return {
      album: summarizeAlbum(yield* getAlbum(albumId)),
      added: changed,
      unchanged,
    };
  });

export const upload = Command.make(
  'upload',
  {
    files: Argument.String('file').pipe(
      Argument.withDescription('Photos or videos on this machine'),
      Argument.variadic({ min: 1 }),
    ),
    album: optionalString('album', 'Also put them in this album (album id)'),
  },
  ({ files, album }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          albumId: Option.isSome(album)
            ? yield* validId(album.value)
            : undefined,
          named: yield* localFiles(files),
        };
      }),
      ({ albumId, named }) =>
        Effect.gen(function* () {
          // A wrong album id is caught before anything is sent.
          if (albumId !== undefined) {
            yield* getAlbum(albumId);
          }
          const checks = yield* checkFiles(named.map(({ file }) => file));
          const outcomes = yield* Effect.forEach(named, (one, index) =>
            sendFile(one, checks[index]),
          );
          const trashed = outcomes.some(
            (result) => result.status === 'duplicate' && result.trashed,
          );
          return {
            files: outcomes,
            ...(albumId === undefined
              ? {}
              : { album: yield* addToAlbum(albumId, inLibrary(outcomes)) }),
            note: [
              'Immich reads the date, place and camera of new files in the background, so they can take a minute to show.',
              'A duplicate is a file Immich already had; it was not sent again.',
              ...(trashed
                ? [
                    'Some duplicates are in the trash: `photos restore <id>` brings them back, and they were not put in the album.',
                  ]
                : []),
            ].join(' '),
          };
        }),
    ),
).pipe(
  Command.withDescription(
    "Upload photos or videos from this machine to the library, with an XMP sidecar next to a file if there is one. Each file keeps its date. Files Immich already has are not sent again and are listed as duplicates with their asset id, so running it twice is safe. Paths that aren't readable files are refused before anything is sent.",
  ),
);

/** What `photos copy-info` can carry over, with the flag that skips it. */
const parts = [
  { key: 'albums', flag: 'albums', help: 'the albums it is in' },
  { key: 'favorite', flag: 'favorite', help: 'whether it is a favorite' },
  {
    key: 'sharedLinks',
    flag: 'shared-links',
    help: 'the shared links that share it, so people who have them see the target too',
  },
  { key: 'stack', flag: 'stack', help: 'its stack' },
  {
    key: 'sidecar',
    flag: 'sidecar',
    help: 'its XMP sidecar, which holds edits made in Immich such as the date, description and rating',
  },
] as const;

const partFlag = (part: (typeof parts)[number]) =>
  choice(
    part.flag,
    `Copy ${part.help} (default), or skip it with --no-${part.flag}`,
  );

export const copyInfo = Command.make(
  'copy-info',
  {
    source: idArgument('source', 'The asset to copy from'),
    target: idArgument('target', 'The asset to copy to'),
    albums: partFlag(parts[0]),
    favorite: partFlag(parts[1]),
    sharedLinks: partFlag(parts[2]),
    stack: partFlag(parts[3]),
    sidecar: partFlag(parts[4]),
  },
  (options) =>
    runImmich(
      Effect.gen(function* () {
        const sourceId = yield* validId(options.source);
        const targetId = yield* validId(options.target);
        if (sourceId === targetId) {
          return yield* fail('The source and the target are the same asset.');
        }
        const choices = Object.fromEntries(
          parts.map(({ key }) => [
            key,
            Option.getOrElse(options[key], () => true),
          ]),
        ) as Record<(typeof parts)[number]['key'], boolean>;
        if (!Object.values(choices).some(Boolean)) {
          return yield* fail(
            'Everything is skipped, so there is nothing to copy.',
          );
        }
        return { sourceId, targetId, choices };
      }),
      ({ sourceId, targetId, choices }) =>
        Effect.gen(function* () {
          yield* browsable(yield* getAssets([sourceId, targetId]));
          yield* requestNothing({
            method: 'PUT',
            path: '/assets/copy',
            body: { sourceId, targetId, ...choices },
          });
          const target = yield* getAsset(targetId);
          const albums = yield* requestJson(
            { method: 'GET', path: '/albums', query: { assetId: targetId } },
            AlbumListSchema,
          );
          return {
            source: sourceId,
            target: {
              ...summarize(target),
              albums: albums.map(({ id, albumName }) => ({
                id,
                name: albumName,
              })),
              stackId: target.stack?.id ?? null,
            },
            copied: parts
              .filter(({ key }) => choices[key])
              .map(({ key }) => key),
            note: 'The source is unchanged. If the target replaces it, move the source to the trash with `photos trash`.',
          };
        }),
    ),
).pipe(
  Command.withDescription(
    "Copy what belongs to one photo onto another, such as a better copy of it: its albums, favorite, shared links, stack and sidecar. The target's favorite is overwritten, and it joins the source's stack. Nothing is copied that a --no- flag skips. The source stays as it is.",
  ),
);
