import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
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

/** A tag as Immich answers it; `value` is its full name. */
const tag = (tagId: string, value: string, overrides: object = {}) => ({
  id: tagId,
  name: value.split('/').at(-1),
  value,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-14T12:00:00.000Z',
  ...overrides,
});

const trips = tag(id(70), 'Trips', { color: '#ff8800' });
const trips2026 = tag(id(71), 'Trips/2026', { parentId: id(70) });
const receipts = tag(id(72), 'Receipts');

describe('photos tags list', () => {
  it('lists each tag by its full name, with its color', async () => {
    respond({ 'GET /api/tags': [trips, trips2026] });
    const output = await runOk('tags', 'list');
    expect(output).toEqual([
      {
        id: id(70),
        name: 'Trips',
        color: '#ff8800',
        parentId: null,
        createdAt: '2026-11-01T12:00:00.000Z',
        updatedAt: '2026-11-14T12:00:00.000Z',
      },
      {
        id: id(71),
        name: 'Trips/2026',
        color: null,
        parentId: id(70),
        createdAt: '2026-11-01T12:00:00.000Z',
        updatedAt: '2026-11-14T12:00:00.000Z',
      },
    ]);
  });
});

describe('photos tags create', () => {
  it('creates a tag with a color', async () => {
    respond({ 'POST /api/tags': tag(id(72), 'Receipts', { color: '#00f' }) });
    const output = await runOk('tags', 'create', 'Receipts', '--color', '00f');
    expect(requests()).toEqual([
      { 'POST /api/tags': { name: 'Receipts', color: '00f' } },
    ]);
    expect(output).toMatchObject({ name: 'Receipts', color: '#00f' });
  });

  it('creates a tag below another, making the tags above first', async () => {
    respond({
      'PUT /api/tags': [trips],
      'POST /api/tags': trips2026,
    });
    const output = await runOk('tags', 'create', ' Trips / 2026 ');
    expect(requests()).toEqual([
      { 'PUT /api/tags': { tags: ['Trips'] } },
      { 'POST /api/tags': { name: '2026', parentId: id(70) } },
    ]);
    expect(output).toMatchObject({ name: 'Trips/2026', parentId: id(70) });
  });

  it.each<ReadonlyArray<string>>([
    ['Trips//2026'],
    ['/'],
    [' '],
    ['Trips', '--color', 'orange'],
  ])(
    'refuses %p: an empty part of a name or a color that is no hex code',
    async (...args: ReadonlyArray<string>) => {
      const failure = await failureOf('tags', 'create', ...args);
      expect(failure._tag).toBe('InvalidInput');
      expect(fake.sent).toEqual([]);
    },
  );
});

describe('photos tags update', () => {
  it('renames a tag found by name and removes its color', async () => {
    respond({
      'GET /api/tags': [trips, trips2026],
      [`PUT /api/tags/${id(70)}`]: tag(id(70), 'Travel'),
    });
    const output = await runOk(
      'tags',
      'update',
      'trips',
      '--name',
      ' Travel ',
      '--color',
      '',
    );
    expect(requests()).toEqual([
      'GET /api/tags',
      { [`PUT /api/tags/${id(70)}`]: { name: 'Travel', color: null } },
    ]);
    expect(output).toMatchObject({ id: id(70), name: 'Travel', color: null });
  });

  it.each<ReadonlyArray<string>>([['Trips'], ['Trips', '--name', 'Old/Trips']])(
    'refuses %p: nothing to change or a name that moves the tag',
    async (...args: ReadonlyArray<string>) => {
      const failure = await failureOf('tags', 'update', ...args);
      expect(failure._tag).toBe('InvalidInput');
      expect(fake.sent).toEqual([]);
    },
  );

  it('says when no tag has the name', async () => {
    respond({ 'GET /api/tags': [trips] });
    const failure = await failureOf(
      'tags',
      'update',
      'Holidays',
      '--color',
      '#fff',
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain('Holidays');
    expect(requests()).toEqual(['GET /api/tags']);
  });
});

describe('photos tags add and remove', () => {
  it('tags photos and lists the ones that already had the tag', async () => {
    respond({
      'GET /api/tags': [trips, trips2026],
      [`PUT /api/tags/${id(71)}/assets`]: [
        { id: id(1), success: true },
        { id: id(2), success: false, error: 'duplicate' },
      ],
    });
    const output = await runOk(
      'tags',
      'add',
      'Trips/2026',
      id(1),
      id(2),
      id(1),
    );
    expect(requests()).toEqual([
      'GET /api/tags',
      { [`PUT /api/tags/${id(71)}/assets`]: { ids: [id(1), id(2)] } },
    ]);
    expect(output).toEqual({
      tag: expect.objectContaining({ id: id(71), name: 'Trips/2026' }),
      added: [id(1)],
      unchanged: [{ id: id(2), reason: 'duplicate' }],
    });
  });

  it('takes a tag found by id off photos', async () => {
    respond({
      'GET /api/tags': [receipts],
      [`DELETE /api/tags/${id(72)}/assets`]: [
        { id: id(3), success: true },
        { id: id(4), success: false, error: 'not_found' },
      ],
    });
    const output = await runOk(
      'tags',
      'remove',
      id(72).toUpperCase(),
      id(3),
      id(4),
    );
    expect(requests()).toContainEqual({
      [`DELETE /api/tags/${id(72)}/assets`]: { ids: [id(3), id(4)] },
    });
    expect(output).toMatchObject({
      tag: { id: id(72) },
      removed: [id(3)],
      unchanged: [{ id: id(4), reason: 'not_found' }],
    });
  });

  it('refuses an asset id that is no id before sending anything', async () => {
    const failure = await failureOf('tags', 'add', 'Trips', 'IMG_0001.jpg');
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos tags delete', () => {
  it('deletes a tag and lists the photos that had it', async () => {
    let searches = 0;
    respond({
      'GET /api/tags': [trips, trips2026, receipts],
      'POST /api/search/metadata': () => {
        searches += 1;
        return Response.json(
          searches === 1 ? page([asset(id(1))], 'next') : page([asset(id(2))]),
        );
      },
      [`DELETE /api/tags/${id(72)}`]: null,
    });
    const output = await runOk('tags', 'delete', 'receipts');
    const filter = {
      visibility: { in: ['timeline', 'archive'] },
      tagIds: { any: [id(72)] },
    };
    const orderBy = { field: 'fileCreatedAt', direction: 'desc' };
    expect(requests()).toEqual([
      'GET /api/tags',
      { 'POST /api/search/metadata': { filter, orderBy, size: 1000 } },
      {
        'POST /api/search/metadata': {
          filter,
          orderBy,
          size: 1000,
          cursor: 'next',
        },
      },
      `DELETE /api/tags/${id(72)}`,
    ]);
    expect(output).toMatchObject({
      deleted: { id: id(72), name: 'Receipts' },
      assetIds: [id(1), id(2)],
    });
    expect(output.note).toContain('photos tags add');
  });

  it('refuses a tag with tags below it, which Immich would delete too', async () => {
    respond({ 'GET /api/tags': [trips, trips2026] });
    const failure = await failureOf('tags', 'delete', 'Trips');
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain('Trips/2026');
    expect(requests()).toEqual(['GET /api/tags']);
  });
});
