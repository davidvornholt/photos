import { lstat } from 'node:fs/promises';
import process from 'node:process';
import { Config, Effect, FileSystem, Option, Path, Stream } from 'effect';
import { FileNotSaved } from '../../shared/errors/errors.ts';
import { Immich, type ImmichRequest } from '../../shared/immich.ts';
import type { Asset } from './assets.ts';

export const previewSizes = ['preview', 'thumbnail'] as const;
export type PreviewSize = (typeof previewSizes)[number];

const ownerOnlyDirectory = 0o700;
const ownerOnlyFile = 0o600;
const permissionDigits = 0o1000;

const notSaved = (target: string) => (error: { readonly message: string }) =>
  new FileNotSaved({ message: `Could not save ${target}: ${error.message}` });

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const entryAt = (target: string) =>
  Effect.tryPromise({ try: () => lstat(target), catch: (error) => error }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isMissing, () => Effect.succeedNone),
    Effect.mapError(
      (error) =>
        new FileNotSaved({
          message: `Could not use ${target}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );

/**
 * Makes sure a directory is a plain one of this user's that nobody else can
 * enter, creating it if needed. Whoever controls a directory decides where a
 * file written into it lands, and previews of private photos sit there.
 */
const privateDirectory = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Two previews saved at once both try to create it; the loser checks the
    // directory the winner made.
    const created = yield* fs
      .makeDirectory(target, { mode: ownerOnlyDirectory })
      .pipe(
        Effect.as(true),
        Effect.catchReason('PlatformError', 'AlreadyExists', () =>
          Effect.succeed(false),
        ),
        Effect.mapError(notSaved(target)),
      );
    if (created) {
      return;
    }
    const entry = yield* entryAt(target);
    if (
      Option.isNone(entry) ||
      !entry.value.isDirectory() ||
      entry.value.uid !== process.getuid?.()
    ) {
      return yield* new FileNotSaved({
        message: `${target} is not a plain directory of yours. Remove it, then try again.`,
      });
    }
    if (entry.value.mode % permissionDigits !== ownerOnlyDirectory) {
      yield* fs
        .chmod(target, ownerOnlyDirectory)
        .pipe(Effect.mapError(notSaved(target)));
    }
  });

/**
 * Where previews go: the per-user runtime directory, which lives in memory
 * and is emptied at logout, or else a private directory under /tmp.
 */
const previewsLocation = Effect.gen(function* () {
  const path = yield* Path.Path;
  const runtime = yield* Config.option(
    Config.NonEmptyString('XDG_RUNTIME_DIR'),
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const base = Option.match(runtime, {
    onSome: (runtimeDirectory) => path.join(runtimeDirectory, 'photos'),
    onNone: () => `/tmp/photos-${process.getuid?.() ?? 'user'}`,
  });
  return { base, directory: path.join(base, 'previews') };
});

const previewsDirectory = Effect.gen(function* () {
  const { base, directory } = yield* previewsLocation;
  yield* privateDirectory(base);
  yield* privateDirectory(directory);
  return directory;
});

/** Deletes every saved preview and says whether there were any. */
export const removePreviews = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { directory } = yield* previewsLocation;
  const entry = yield* entryAt(directory);
  if (Option.isNone(entry)) {
    return false;
  }
  // A link is removed itself; what it points to is left alone.
  yield* fs
    .remove(directory, { recursive: true, force: true })
    .pipe(Effect.mapError(notSaved(directory)));
  return true;
});

const extensions: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

const extensionFor = (contentType: string | undefined) => {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return extensions[type] ?? 'jpg';
};

/**
 * Saves an image Immich renders into the previews directory under `name`,
 * with the extension its type calls for, and returns its absolute path.
 */
const saveImage = Effect.fn('saveImage')(function* (
  request: ImmichRequest,
  what: string,
  name: string,
) {
  const { execute, server } = yield* Immich;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const response = yield* execute(request);
  const bytes = yield* response.arrayBuffer.pipe(
    Effect.mapError(
      (error) =>
        new FileNotSaved({
          message: `${server} broke off ${what}: ${error.message}`,
        }),
    ),
  );
  const directory = yield* previewsDirectory;
  const file = path.join(
    directory,
    `${name}.${extensionFor(response.headers['content-type'])}`,
  );
  // Written as a new file beside the final name and renamed, so a broken
  // download never poses as a preview, and a link at the final name is
  // replaced rather than followed.
  const draft = `${file}.${crypto.randomUUID()}.tmp`;
  yield* Effect.gen(function* () {
    yield* fs.writeFile(draft, new Uint8Array(bytes), {
      flag: 'wx',
      mode: ownerOnlyFile,
    });
    yield* fs.rename(draft, file);
  }).pipe(
    Effect.onError(() => fs.remove(draft, { force: true }).pipe(Effect.ignore)),
    Effect.mapError(notSaved(file)),
  );
  return file;
});

/**
 * Saves the preview Immich renders of a photo or video and returns its
 * absolute path. Previews are re-encoded by Immich, so they are small and
 * carry no camera metadata.
 */
export const savePreview = (id: string, size: PreviewSize) =>
  saveImage(
    { method: 'GET', path: `/assets/${id}/thumbnail`, query: { size } },
    `the preview of ${id}`,
    `${id}-${size}`,
  );

/**
 * Saves the picture of a person's face that Immich shows for them, beside
 * the previews, and returns its absolute path.
 */
export const saveFace = (personId: string) =>
  saveImage(
    { method: 'GET', path: `/people/${personId}/thumbnail` },
    `the face of ${personId}`,
    `${personId}-face`,
  );

// Characters no file name should carry: path separators and control codes.
const unsafeCharacters = /[/\\\p{Cc}]/gu;

/** A file name for an original that cannot leave the chosen directory. */
export const safeFileName = (name: string, fallback: string) => {
  const cleaned = name.replace(unsafeCharacters, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? fallback
    : cleaned;
};

// The first block of an id, enough to tell two photos apart.
const idPrefixLength = 8;

/**
 * Names for the originals of several photos. Two photos with the same name
 * get the start of their id added, so neither replaces the other.
 */
export const originalNames = (assets: ReadonlyArray<Asset>) => {
  const counts = new Map<string, number>();
  const names = assets.map((asset) =>
    safeFileName(asset.originalFileName, asset.id),
  );
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return names.map((name, index) => {
    const asset = assets[index];
    if ((counts.get(name) ?? 0) < 2 || asset === undefined) {
      return name;
    }
    const dot = name.lastIndexOf('.');
    const suffix = `-${asset.id.slice(0, idPrefixLength)}`;
    return dot <= 0
      ? `${name}${suffix}`
      : `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  });
};

const alreadyThere = (file: string) =>
  new FileNotSaved({
    message: `${file} already exists. photos never replaces a file; choose another directory or remove it.`,
  });

/** Refuses a destination that already holds any of the files. */
export const checkFree = (files: ReadonlyArray<string>) =>
  Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const entry = yield* entryAt(file);
      if (Option.isSome(entry)) {
        return yield* alreadyThere(file);
      }
    }),
  );

/**
 * Streams the original file of a photo into a new file. It is written under
 * a draft name first, so a broken download never passes for the photo, and
 * then linked to its name, which fails instead of replacing a file that
 * appeared there meanwhile.
 */
export const saveOriginal = Effect.fn('saveOriginal')(function* (
  id: string,
  file: string,
) {
  const { execute, server } = yield* Immich;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const response = yield* execute({
    method: 'GET',
    path: `/assets/${id}/original`,
  });
  const draft = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${crypto.randomUUID()}.part`,
  );
  yield* Effect.gen(function* () {
    yield* response.stream.pipe(
      Stream.mapError(
        (error) =>
          new FileNotSaved({
            message: `${server} broke off the original of ${id}: ${error.message}`,
          }),
      ),
      Stream.run(fs.sink(draft, { flag: 'wx', mode: ownerOnlyFile })),
    );
    yield* fs.link(draft, file).pipe(
      Effect.catchReason('PlatformError', 'AlreadyExists', () =>
        Effect.fail(alreadyThere(file)),
      ),
      // Some file systems, such as exFAT, have no hard links.
      Effect.catchTag('PlatformError', () =>
        Effect.gen(function* () {
          const entry = yield* entryAt(file);
          if (Option.isSome(entry)) {
            return yield* alreadyThere(file);
          }
          yield* fs.rename(draft, file);
        }),
      ),
    );
  }).pipe(
    Effect.mapError((error) =>
      error._tag === 'FileNotSaved' ? error : notSaved(file)(error),
    ),
    Effect.ensuring(fs.remove(draft, { force: true }).pipe(Effect.ignore)),
  );
  const info = yield* fs.stat(file).pipe(Effect.mapError(notSaved(file)));
  return { path: file, bytes: Number(info.size) };
});
