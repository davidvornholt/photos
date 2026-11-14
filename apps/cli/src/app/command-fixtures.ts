import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, DateTime, Effect, Stdio, Stream } from 'effect';
import { Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { photos } from './cli.ts';

export const server = 'https://immich.example.com';
export const apiKey = 'test-api-key';

const idPrefixLength = 8;
const ownerId = '00000900-0000-4000-8000-000000000000';

/** An Immich id built from a number, such as `00000001-0000-4000-8000-000000000000`. */
export const id = (number: number) =>
  `${String(number).padStart(idPrefixLength, '0')}-0000-4000-8000-000000000000`;

/** An asset as Immich answers it, taken in Berlin in winter (UTC+1). */
export const asset = (assetId: string, overrides: object = {}) => ({
  id: assetId,
  type: 'IMAGE',
  originalFileName: 'PXL_20261114_093000.jpg',
  originalMimeType: 'image/jpeg',
  originalPath: '/data/library/secret/path.jpg',
  checksum: 'abc',
  ownerId,
  fileCreatedAt: '2026-11-14T09:30:00.000Z',
  fileModifiedAt: '2026-11-14T09:30:00.000Z',
  localDateTime: '2026-11-14T10:30:00.000Z',
  createdAt: '2026-11-14T09:31:00.000Z',
  updatedAt: '2026-11-14T09:31:00.000Z',
  width: 4080,
  height: 3072,
  duration: null,
  isFavorite: false,
  isArchived: false,
  isTrashed: false,
  isOffline: false,
  isEdited: false,
  hasMetadata: true,
  visibility: 'timeline',
  duplicateId: null,
  thumbhash: null,
  exifInfo: {
    description: '',
    make: 'Google',
    model: 'Pixel 6',
    lensModel: null,
    city: 'Berlin',
    state: 'Berlin',
    country: 'Germany',
    timeZone: 'Europe/Berlin',
    fileSizeInByte: 2_400_000,
    rating: null,
    latitude: 52.52,
    longitude: 13.405,
  },
  ...overrides,
});

export const album = (albumId: string, overrides: object = {}) => ({
  id: albumId,
  albumName: 'Scans',
  description: '',
  assetCount: 2,
  albumThumbnailAssetId: id(1),
  albumUsers: [{ role: 'owner', user: { id: ownerId, name: 'Owner' } }],
  shared: false,
  hasSharedLink: false,
  startDate: '2026-11-01T10:00:00.000Z',
  endDate: '2026-11-14T10:30:00.000Z',
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-14T12:00:00.000Z',
  order: 'desc',
  ...overrides,
});

export const page = (
  items: ReadonlyArray<object>,
  nextCursor: string | null = null,
) => ({
  assets: { total: items.length, count: items.length, items, nextCursor },
  albums: { total: 0, count: 0, items: [] },
});

export const features = (overrides: object = {}) => ({
  trash: true,
  smartSearch: true,
  ocr: true,
  duplicateDetection: true,
  ...overrides,
});

export type Sent = {
  readonly method: string;
  readonly path: string;
  readonly apiKey: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly body: unknown;
};

/**
 * Stands in for the Immich server: records each request and answers it with
 * `answer`, so no test reaches a real server.
 */
export const fake = {
  sent: [] as Array<Sent>,
  answer: (_method: string, _path: string): Response => Response.json({}),
  stdin: '',
  home: '',
};

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const text = await request.text();
  const path = `${url.pathname}${url.search}`;
  fake.sent.push({
    method: request.method,
    path,
    apiKey: request.headers.get('x-api-key'),
    redirect: init?.redirect,
    body: text === '' ? undefined : JSON.parse(text),
  });
  if (url.origin !== server) {
    return new Response('unknown server', { status: 599 });
  }
  return fake.answer(request.method, path);
}) as typeof globalThis.fetch;

/** The requests sent, without the details every request shares. */
export const requests = () =>
  fake.sent.map(({ method, path, body }) =>
    body === undefined ? `${method} ${path}` : { [`${method} ${path}`]: body },
  );

let stdout: ReturnType<typeof import('bun:test').spyOn> | undefined;

export const printed = () =>
  JSON.parse(String(stdout?.mock.calls.at(-1)?.[0] ?? 'null'));

export const run = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(photos, { version: 'test' })(args).pipe(
      // The key arrives piped in, as from `photos login < key-file`.
      Effect.provide(
        Stdio.layerTest({
          stdin: Stream.suspend(() =>
            Stream.make(new TextEncoder().encode(fake.stdin)),
          ),
          stdinIsTerminal: Effect.succeed(false),
        }),
      ),
      Effect.provide(BunServices.layer),
      Effect.provide(DateTime.layerCurrentZoneNamed('Europe/Berlin')),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromDotEnvContents(
            [
              `HOME=${fake.home}`,
              `XDG_CONFIG_HOME=${join(fake.home, 'config')}`,
              `XDG_RUNTIME_DIR=${join(fake.home, 'runtime')}`,
            ].join('\n'),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.result,
    ),
  );

export const runOk = async (...args: ReadonlyArray<string>) => {
  const result = await run(...args);
  if (result._tag === 'Failure') {
    throw new Error(
      `photos ${args.join(' ')} failed: ${JSON.stringify(result.failure)}`,
    );
  }
  return printed();
};

export const failureOf = async (...args: ReadonlyArray<string>) => {
  const result = await run(...args);
  if (result._tag === 'Success') {
    throw new Error(`photos ${args.join(' ')} succeeded`);
  }
  return result.failure as { readonly _tag: string; readonly message: string };
};

export const credentialsPath = () =>
  join(fake.home, 'config', 'photos', 'credentials.json');

/** A fresh home with a stored key; call it in `beforeEach`. */
export const setUp = async (spyOn: typeof import('bun:test').spyOn) => {
  fake.sent = [];
  fake.answer = () => Response.json({});
  fake.stdin = '';
  fake.home = await mkdtemp(join(tmpdir(), 'photos-cli-'));
  await Bun.write(credentialsPath(), JSON.stringify({ server, apiKey }));
  // The session's runtime directory exists before any program runs.
  await mkdir(join(fake.home, 'runtime'), { mode: 0o700 });
  stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
};

export const tearDown = async () => {
  stdout?.mockRestore();
  await rm(fake.home, { recursive: true, force: true });
};

type Answer = unknown | (() => Response);

/**
 * Answers requests from a table keyed by `METHOD /api/path?query`. A value is
 * sent as JSON, `null` as an empty 204, and a function's Response as is.
 * Anything not in the table gets Immich's 404.
 */
export const respond = (table: Readonly<Record<string, Answer>>) => {
  fake.answer = (method, path) => {
    const key = `${method} ${path}`;
    if (!Object.hasOwn(table, key)) {
      return Response.json(
        { message: `Cannot ${key}`, statusCode: 404 },
        { status: 404 },
      );
    }
    const value = table[key];
    if (typeof value === 'function') {
      return (value as () => Response)();
    }
    return value === null
      ? new Response(null, { status: 204 })
      : Response.json(value);
  };
};
