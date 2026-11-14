import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  asset,
  fake,
  id,
  requests,
  respond,
  runOk,
  setUp,
  tearDown,
} from './command-fixtures.ts';

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

const counts = (images: number, videos: number) => ({
  images,
  videos,
  total: images + videos,
});

describe('photos stats', () => {
  it('counts the library, its parts, the trash, albums, people and memories', async () => {
    respond({
      'GET /api/assets/statistics': counts(900, 100),
      'GET /api/assets/statistics?isFavorite=true': counts(40, 2),
      'GET /api/assets/statistics?visibility=archive': counts(30, 0),
      'GET /api/assets/statistics?isTrashed=true': counts(5, 1),
      'GET /api/albums/statistics': { owned: 12, shared: 3, notShared: 10 },
      'GET /api/people?size=1': {
        people: [],
        total: 25,
        hidden: 4,
        hasNextPage: true,
      },
      'GET /api/memories/statistics': { total: 7 },
    });
    expect(await runOk('stats')).toEqual({
      library: { photos: 900, videos: 100, total: 1000 },
      favorites: { photos: 40, videos: 2, total: 42 },
      archived: { photos: 30, videos: 0, total: 30 },
      trash: { photos: 5, videos: 1, total: 6 },
      albums: { owned: 12, shared: 3, notShared: 10 },
      people: { total: 25, hidden: 4 },
      memories: 7,
    });
    expect(fake.sent.every(({ method }) => method === 'GET')).toBe(true);
  });
});

describe('photos folders', () => {
  const folderPaths = ['/data/library/2019/Urlaub', '/data/library/2026/11'];

  it('lists the folders', async () => {
    respond({ 'GET /api/view/folder/unique-paths': folderPaths });
    expect(await runOk('folders', 'list')).toEqual(folderPaths);
  });

  it('lists only the folders whose path contains the text, in any case', async () => {
    respond({ 'GET /api/view/folder/unique-paths': folderPaths });
    expect(await runOk('folders', 'list', '--path', 'urlaub')).toEqual([
      '/data/library/2019/Urlaub',
    ]);
  });

  it('summarizes the photos in one folder, up to the limit', async () => {
    const answer = [asset(id(1)), asset(id(2)), asset(id(3))];
    respond({
      'GET /api/view/folder?path=%2Fdata%2Flibrary%2F2026%2F11': answer,
    });
    const output = await runOk(
      'folders',
      'show',
      '/data/library/2026/11/',
      '--limit',
      '2',
    );
    expect(output).toMatchObject({
      path: '/data/library/2026/11',
      count: 3,
      assets: [{ id: id(1) }, { id: id(2) }],
    });
    expect(requests()).toEqual([
      'GET /api/view/folder?path=%2Fdata%2Flibrary%2F2026%2F11',
    ]);
  });
});

describe('photos users', () => {
  it('lists the accounts and marks this one', async () => {
    const user = (userId: string, name: string) => ({
      id: userId,
      name,
      email: `${name.toLowerCase()}@example.com`,
      profileImagePath: '',
      avatarColor: 'primary',
      profileChangedAt: '2026-01-01T00:00:00.000Z',
    });
    respond({
      'GET /api/users': [user(id(90), 'Owner'), user(id(91), 'Friend')],
      'GET /api/users/me': user(id(90), 'Owner'),
    });
    expect(await runOk('users')).toEqual([
      {
        id: id(90),
        name: 'Owner',
        email: 'owner@example.com',
        isThisAccount: true,
      },
      {
        id: id(91),
        name: 'Friend',
        email: 'friend@example.com',
        isThisAccount: false,
      },
    ]);
  });
});
