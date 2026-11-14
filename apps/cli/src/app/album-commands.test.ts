import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  album,
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

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

const inAlbum = (albumId: string) => ({
  trashedAt: { eq: null },
  visibility: { in: ['timeline', 'archive'] },
  albumIds: { any: [albumId] },
});

describe('photos albums list and show', () => {
  it('lists albums whose name contains the text', async () => {
    respond({
      'GET /api/albums': [
        album(id(50)),
        album(id(51), { albumName: 'Holidays', description: 'Sea' }),
      ],
    });
    const output = await runOk('albums', 'list', '--name', 'scan');
    expect(output).toEqual([
      {
        id: id(50),
        name: 'Scans',
        description: null,
        assetCount: 2,
        owner: 'Owner',
        shared: false,
        sharedLink: false,
        coverAssetId: id(1),
        firstTakenOn: '2026-11-01',
        lastTakenOn: '2026-11-14',
        createdAt: '2026-11-01T12:00:00.000Z',
        updatedAt: '2026-11-14T12:00:00.000Z',
      },
    ]);
  });

  it('shows an album with its photos in the order it sorts them', async () => {
    respond({
      [`GET /api/albums/${id(50)}`]: album(id(50), { order: 'asc' }),
      'POST /api/search/metadata': page([asset(id(1))]),
    });
    const output = await runOk('albums', 'show', id(50));
    expect(requests()).toContainEqual({
      'POST /api/search/metadata': {
        filter: inAlbum(id(50)),
        orderBy: { field: 'fileCreatedAt', direction: 'asc' },
        size: 100,
        withExif: true,
      },
    });
    expect(output).toMatchObject({
      album: { id: id(50), name: 'Scans' },
      assets: [{ id: id(1) }],
    });
  });
});

describe('photos albums create and update', () => {
  it('creates an album with photos in it', async () => {
    respond({ 'POST /api/albums': album(id(52), { albumName: 'Receipts' }) });
    await runOk(
      'albums',
      'create',
      ' Receipts ',
      id(1),
      id(2),
      '--description',
      'Tax',
    );
    expect(requests()).toEqual([
      {
        'POST /api/albums': {
          albumName: 'Receipts',
          description: 'Tax',
          assetIds: [id(1), id(2)],
        },
      },
    ]);
  });

  it('renames an album and changes its cover', async () => {
    respond({ [`PATCH /api/albums/${id(50)}`]: album(id(50)) });
    await runOk(
      'albums',
      'update',
      id(50),
      '--name',
      'Old scans',
      '--cover',
      id(2),
    );
    expect(requests()).toEqual([
      {
        [`PATCH /api/albums/${id(50)}`]: {
          albumName: 'Old scans',
          albumThumbnailAssetId: id(2),
        },
      },
    ]);
  });
});

describe('photos albums add, remove and delete', () => {
  it('adds photos and says which were there already', async () => {
    respond({
      [`PUT /api/albums/${id(50)}/assets`]: [
        { id: id(1), success: true },
        { id: id(2), success: false, error: 'duplicate' },
      ],
      [`GET /api/albums/${id(50)}`]: album(id(50), { assetCount: 3 }),
    });
    const output = await runOk('albums', 'add', id(50), id(1), id(2));
    expect(output).toMatchObject({
      album: { assetCount: 3 },
      added: [id(1)],
      unchanged: [{ id: id(2), reason: 'duplicate' }],
    });
  });

  it('removes photos from an album', async () => {
    respond({
      [`DELETE /api/albums/${id(50)}/assets`]: [{ id: id(1), success: true }],
      [`GET /api/albums/${id(50)}`]: album(id(50), { assetCount: 1 }),
    });
    const output = await runOk('albums', 'remove', id(50), id(1));
    expect(requests()[0]).toEqual({
      [`DELETE /api/albums/${id(50)}/assets`]: { ids: [id(1)] },
    });
    expect(output).toMatchObject({ removed: [id(1)], unchanged: [] });
  });

  it('deletes an album after noting every photo in it', async () => {
    let call = 0;
    respond({
      [`GET /api/albums/${id(50)}`]: album(id(50)),
      'POST /api/search/metadata': () => {
        call += 1;
        return Response.json(
          call === 1 ? page([asset(id(1))], 'second') : page([asset(id(2))]),
        );
      },
      [`DELETE /api/albums/${id(50)}`]: null,
    });
    const output = await runOk('albums', 'delete', id(50));
    expect(requests()).toEqual([
      `GET /api/albums/${id(50)}`,
      {
        'POST /api/search/metadata': {
          filter: inAlbum(id(50)),
          orderBy: { field: 'fileCreatedAt', direction: 'desc' },
          size: 1000,
          withExif: true,
        },
      },
      {
        'POST /api/search/metadata': {
          filter: inAlbum(id(50)),
          orderBy: { field: 'fileCreatedAt', direction: 'desc' },
          size: 1000,
          withExif: true,
          cursor: 'second',
        },
      },
      `DELETE /api/albums/${id(50)}`,
    ]);
    expect(output).toMatchObject({
      deleted: { id: id(50), name: 'Scans' },
      assetIds: [id(1), id(2)],
    });
  });
});

describe('photos albums input', () => {
  it.each([
    [['update', id(50)], 'Nothing to change'],
    [['create', '  '], 'needs a name'],
    [['add', 'scans', id(1)], 'is not an Immich id'],
  ])('refuses %j', async (args, message) => {
    const failure = await failureOf('albums', ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});
