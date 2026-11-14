import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiKey,
  asset,
  failureOf,
  fake,
  id,
  page,
  requests,
  respond,
  runOk,
  setUp,
  tearDown,
} from './command-fixtures.ts';

const notTrashed = {
  trashedAt: { eq: null },
  visibility: { in: ['timeline', 'archive'] },
};

const newestFirst = { field: 'fileCreatedAt', direction: 'desc' };

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

describe('photos recent', () => {
  it('lists the newest photos in the library with the stored key', async () => {
    respond({ 'POST /api/search/metadata': page([asset(id(1))]) });
    const output = await runOk('recent');
    expect(requests()).toEqual([
      {
        'POST /api/search/metadata': {
          filter: notTrashed,
          orderBy: newestFirst,
          size: 20,
          withExif: true,
        },
      },
    ]);
    expect(fake.sent[0]?.apiKey).toBe(apiKey);
    expect(fake.sent[0]?.redirect).toBe('manual');
    expect(output).toEqual({
      count: 1,
      nextCursor: null,
      assets: [
        {
          id: id(1),
          type: 'image',
          fileName: 'PXL_20261114_093000.jpg',
          takenAt: '2026-11-14T10:30:00.000+01:00',
          uploadedAt: '2026-11-14T09:31:00.000Z',
          width: 4080,
          height: 3072,
          favorite: false,
          archived: false,
          trashed: false,
          description: null,
          duplicateId: null,
        },
      ],
    });
  });

  it('reads a day in the local time zone and reports video length', async () => {
    respond({
      'POST /api/search/metadata': page([
        asset(id(2), { type: 'VIDEO', duration: 12_345 }),
      ]),
    });
    const output = await runOk(
      'recent',
      '--since',
      '2026-11-01',
      '--limit',
      '3',
    );
    expect(requests()).toEqual([
      {
        'POST /api/search/metadata': {
          filter: {
            ...notTrashed,
            takenAt: { gte: '2026-10-31T23:00:00.000Z' },
          },
          orderBy: newestFirst,
          size: 3,
          withExif: true,
        },
      },
    ]);
    expect(output.assets[0]).toMatchObject({
      type: 'video',
      durationSeconds: 12.3,
    });
  });

  it('refuses a limit Immich would not accept', async () => {
    const failure = await failureOf('recent', '--limit', '1001');
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos search', () => {
  it('searches by meaning with smart search', async () => {
    respond({ 'POST /api/search/smart': page([asset(id(1))]) });
    await runOk('search', '--query', 'receipt', '--limit', '5');
    expect(requests()).toEqual([
      {
        'POST /api/search/smart': {
          query: 'receipt',
          filter: notTrashed,
          size: 5,
          withExif: true,
        },
      },
    ]);
  });

  it('turns every filter flag into Immich filters', async () => {
    respond({ 'POST /api/search/metadata': page([], 'next-page') });
    const output = await runOk(
      'search',
      '--ocr',
      'Rechnung',
      '--file-name',
      'scan',
      '--description',
      'tax',
      '--from',
      '2026-11-01',
      '--to',
      '2026-11-14',
      '--uploaded-from',
      '2026-11-14T08:00',
      '--uploaded-to',
      '2026-11-14T12:00:00+01:00',
      '--type',
      'image',
      '--album',
      id(50),
      '--favorite',
      '--no-archived',
      '--trashed',
      '--oldest-first',
      '--cursor',
      'previous-page',
    );
    expect(requests()).toEqual([
      {
        'POST /api/search/metadata': {
          filter: {
            trashedAt: { ne: null },
            visibility: { eq: 'timeline' },
            ocr: { matches: 'Rechnung' },
            originalFileName: { like: 'scan' },
            description: { like: 'tax' },
            takenAt: {
              gte: '2026-10-31T23:00:00.000Z',
              lte: '2026-11-14T22:59:59.999Z',
            },
            createdAt: {
              gte: '2026-11-14T07:00:00.000Z',
              lte: '2026-11-14T11:00:00.000Z',
            },
            type: { eq: 'IMAGE' },
            albumIds: { any: [id(50)] },
            isFavorite: { eq: true },
          },
          orderBy: { field: 'fileCreatedAt', direction: 'asc' },
          size: 50,
          withExif: true,
          cursor: 'previous-page',
        },
      },
    ]);
    expect(output.nextCursor).toBe('next-page');
  });

  it('finds photos in no album, archived only', async () => {
    respond({ 'POST /api/search/metadata': page([]) });
    await runOk('search', '--without-album', '--archived', '--no-favorite');
    expect(requests()).toEqual([
      {
        'POST /api/search/metadata': {
          filter: {
            trashedAt: { eq: null },
            visibility: { eq: 'archive' },
            hasAlbums: { eq: false },
            isFavorite: { eq: false },
          },
          orderBy: newestFirst,
          size: 50,
          withExif: true,
        },
      },
    ]);
  });

  it.each([
    [['--query', 'dog', '--cursor', 'x'], 'no further pages'],
    [['--query', 'dog', '--oldest-first'], 'ranks by likeness'],
    [['--album', id(50), '--without-album'], 'not both'],
    [['--from', '2026-02-31'], 'is not a time'],
    [['--to', '2026-11-14T24:00'], 'is not a time'],
    [['--album', 'scans'], 'is not an Immich id'],
    [['--person', 'Anna'], 'is not an Immich id'],
    [['--tag', 'Travel'], 'is not an Immich id'],
  ])('refuses %j', async (args, message) => {
    const failure = await failureOf('search', ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});

describe('photos search by people and tags', () => {
  it('finds photos that show all the people and have all the tags', async () => {
    respond({ 'POST /api/search/metadata': page([]) });
    await runOk(
      'search',
      '--person',
      id(60),
      '--person',
      id(61).toUpperCase(),
      '--person',
      id(60),
      '--tag',
      id(70),
    );
    expect(requests()).toEqual([
      {
        'POST /api/search/metadata': {
          filter: {
            ...notTrashed,
            personIds: { all: [id(60), id(61)] },
            tagIds: { all: [id(70)] },
          },
          orderBy: newestFirst,
          size: 50,
          withExif: true,
        },
      },
    ]);
  });
});

describe('photos preview', () => {
  it('saves previews only its user can read', async () => {
    respond({
      [`GET /api/assets/${id(1)}/thumbnail?size=preview`]: () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/webp' },
        }),
    });
    const output = await runOk('preview', id(1));
    const file = join(
      fake.home,
      'runtime',
      'photos',
      'previews',
      `${id(1)}-preview.webp`,
    );
    expect(output).toEqual([{ id: id(1), path: file }]);
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
    expect(
      (await stat(join(fake.home, 'runtime', 'photos'))).mode % 0o1000,
    ).toBe(0o700);
  });

  it('asks for the small size', async () => {
    respond({
      [`GET /api/assets/${id(1)}/thumbnail?size=thumbnail`]: () =>
        new Response(new Uint8Array([9]), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    });
    const [saved] = await runOk('preview', id(1), '--size', 'thumbnail');
    expect(saved.path).toEndWith(`${id(1)}-thumbnail.jpg`);
  });

  it('saves several previews at once into a directory none of them made', async () => {
    const image = () =>
      new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/webp' },
      });
    const ids = [id(1), id(2), id(3), id(4)];
    respond(
      Object.fromEntries(
        ids.map((each) => [
          `GET /api/assets/${each}/thumbnail?size=preview`,
          image,
        ]),
      ),
    );
    const output = await runOk('preview', ...ids);
    expect(output.map((saved: { id: string }) => saved.id)).toEqual(ids);
  });

  it('refuses a previews directory someone could redirect', async () => {
    await symlink(fake.home, join(fake.home, 'runtime', 'photos'));
    respond({
      [`GET /api/assets/${id(1)}/thumbnail?size=preview`]: () =>
        new Response(new Uint8Array([1])),
    });
    const failure = await failureOf('preview', id(1));
    expect(failure._tag).toBe('FileNotSaved');
    expect(failure.message).toContain('is not a plain directory of yours');
  });
});

describe('photos download', () => {
  const original = () => new Response(new Uint8Array([7, 7, 7]));

  it('saves originals under their names, telling equal names apart', async () => {
    const to = join(fake.home, 'downloads');
    await mkdir(to);
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(2)}`]: asset(id(2)),
      [`GET /api/assets/${id(1)}/original`]: original,
      [`GET /api/assets/${id(2)}/original`]: original,
    });
    const output = await runOk('download', id(1), id(2), '--to', to);
    expect(output).toEqual([
      {
        id: id(1),
        fileName: 'PXL_20261114_093000.jpg',
        path: join(to, 'PXL_20261114_093000-00000001.jpg'),
        bytes: 3,
      },
      {
        id: id(2),
        fileName: 'PXL_20261114_093000.jpg',
        path: join(to, 'PXL_20261114_093000-00000002.jpg'),
        bytes: 3,
      },
    ]);
    expect(
      (await stat(join(to, 'PXL_20261114_093000-00000001.jpg'))).mode % 0o1000,
    ).toBe(0o600);
  });

  it('never replaces a file that is already there', async () => {
    const to = join(fake.home, 'downloads');
    await mkdir(to);
    await writeFile(join(to, 'PXL_20261114_093000.jpg'), 'mine');
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(1)}/original`]: original,
    });
    const failure = await failureOf('download', id(1), '--to', to);
    expect(failure._tag).toBe('FileNotSaved');
    expect(await readFile(join(to, 'PXL_20261114_093000.jpg'), 'utf8')).toBe(
      'mine',
    );
    expect(requests()).toEqual([`GET /api/assets/${id(1)}`]);
  });

  it('keeps a file name inside the directory', async () => {
    const to = join(fake.home, 'downloads');
    await mkdir(to);
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), {
        originalFileName: '../../.bashrc',
      }),
      [`GET /api/assets/${id(1)}/original`]: original,
    });
    const [saved] = await runOk('download', id(1), '--to', to);
    expect(saved.path).toBe(join(to, '.._.._.bashrc'));
  });

  it('refuses a directory that does not exist', async () => {
    const failure = await failureOf(
      'download',
      id(1),
      '--to',
      join(fake.home, 'missing'),
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});
