import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import {
  Data,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from 'effect';
import { InvalidInput } from '../../shared/errors/errors.ts';
import { requestJson } from '../../shared/immich.ts';

/** A file on this machine, checked and ready to upload. */
export type LocalFile = {
  readonly path: string;
  readonly name: string;
  /** When the file last changed, which Immich falls back on when the photo carries no date. */
  readonly modifiedAt: string;
  /** SHA-1 in hex, which Immich compares to spot a file it already has. */
  readonly checksum: string;
  /** An XMP file next to it, which Immich reads like the photo's own metadata. */
  readonly sidecar: string | undefined;
};

const refused = (path: string, problem: string) =>
  new InvalidInput({
    message: `${path} ${problem}. Nothing was uploaded.`,
  });

const sha1 = (path: string, shown: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = yield* fs.stream(path).pipe(
      Stream.runFold(
        () => createHash('sha1'),
        (sum, chunk) => sum.update(chunk),
      ),
      Effect.mapError(() => refused(shown, 'cannot be read')),
    );
    return hash.digest('hex');
  });

/**
 * The sidecar Immich's own CLI uploads with a file: `photo.jpg.xmp`, else
 * `photo.xmp`.
 */
const findSidecar = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dir, name } = path.parse(file);
    const candidates = [`${file}.xmp`, path.join(dir, `${name}.xmp`)].filter(
      // A sidecar is never the file itself, as `photo.xmp` would be.
      (candidate) => candidate !== file,
    );
    for (const candidate of candidates) {
      const info = yield* fs
        .stat(candidate)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type === 'File') {
        return candidate;
      }
    }
  });

/**
 * Checks that a path names a file this user can read and gathers what the
 * upload sends with it. Reading it whole for the checksum proves it can be
 * read before anything goes to Immich.
 */
export const localFile = (input: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolute = path.resolve(input);
    const info = yield* fs
      .stat(absolute)
      .pipe(Effect.mapError(() => refused(input, 'does not exist')));
    if (info.type !== 'File') {
      return yield* refused(input, 'is not a file');
    }
    const checksum = yield* sha1(absolute, input);
    const modified = Option.match(info.mtime, {
      onNone: () => DateTime.now,
      onSome: (date) => Effect.succeed(DateTime.fromDateUnsafe(date)),
    });
    return {
      path: absolute,
      name: path.basename(absolute),
      modifiedAt: DateTime.formatIso(yield* modified),
      checksum,
      sidecar: yield* findSidecar(absolute),
    } satisfies LocalFile;
  });

const UploadCheckSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      // accept or reject.
      action: Schema.String,
      // duplicate or unsupported-format.
      reason: Schema.optional(Schema.String),
      assetId: Schema.optional(Schema.String),
      isTrashed: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type UploadCheck = (typeof UploadCheckSchema.Type)['results'][number];

/**
 * Asks Immich which files it already has, by checksum alone, so a duplicate
 * is never sent. Files go by their place in the list, not their local path.
 */
export const checkFiles = (files: ReadonlyArray<LocalFile>) =>
  requestJson(
    {
      method: 'POST',
      path: '/assets/bulk-upload-check',
      body: {
        assets: files.map((file, index) => ({
          id: String(index),
          checksum: file.checksum,
        })),
      },
    },
    UploadCheckSchema,
  ).pipe(
    Effect.map(({ results }) =>
      files.map((_, index) =>
        results.find((result) => result.id === String(index)),
      ),
    ),
  );

const UploadedSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(['created', 'duplicate']),
});

/** A file that was fine when checked but cannot be read now. */
class Unreadable extends Data.TaggedError('Unreadable')<{
  readonly reason: string;
}> {}

const blobOf = (path: string) =>
  Effect.tryPromise({
    try: () => openAsBlob(path),
    catch: () => new Unreadable({ reason: 'it can no longer be read' }),
  });

/**
 * Uploads one file, with its sidecar, keeping its date. A file Immich refuses,
 * or one that went away since it was checked, fails alone; the others go on.
 */
export const uploadFile = (file: LocalFile) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const form = new FormData();
    form.append('fileCreatedAt', file.modifiedAt);
    form.append('fileModifiedAt', file.modifiedAt);
    form.append('assetData', yield* blobOf(file.path), file.name);
    if (file.sidecar !== undefined) {
      form.append(
        'sidecarData',
        yield* blobOf(file.sidecar),
        path.basename(file.sidecar),
      );
    }
    const uploaded = yield* requestJson(
      { method: 'POST', path: '/assets', form },
      UploadedSchema,
    );
    return { status: uploaded.status, assetId: uploaded.id } as const;
  }).pipe(
    Effect.catchTag('Unreadable', ({ reason }) =>
      Effect.succeed({ status: 'failed', reason } as const),
    ),
    Effect.catchTag('ImmichRejected', ({ message }) =>
      Effect.succeed({ status: 'failed', reason: message } as const),
    ),
  );
