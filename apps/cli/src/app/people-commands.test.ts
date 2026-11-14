import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

/** A person as Immich answers it. */
const person = (personId: string, overrides: object = {}) => ({
  id: personId,
  name: 'Anna',
  birthDate: null,
  isHidden: false,
  isFavorite: false,
  color: '#a0c4ff',
  thumbnailPath: '/data/thumbs/secret/anna.jpeg',
  updatedAt: '2026-11-14T09:31:00.000Z',
  otherPeople: [],
  sharedBy: [],
  sharedWith: [],
  ...overrides,
});

const anna = {
  id: id(60),
  name: 'Anna',
  birthDate: null,
  hidden: false,
  favorite: false,
};

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

describe('photos people list', () => {
  it('lists the visible people, one page at a time', async () => {
    respond({
      'GET /api/people?page=1&size=100': {
        people: [person(id(60)), person(id(61), { name: '' })],
        total: 140,
        hidden: 12,
        hasNextPage: true,
      },
    });
    const output = await runOk('people', 'list');
    expect(output).toEqual({
      total: 140,
      hidden: 12,
      page: 1,
      nextPage: 2,
      people: [anna, { ...anna, id: id(61), name: null }],
    });
    expect(JSON.stringify(output)).not.toContain('/data/thumbs');
  });

  it('turns every filter into Immich query parameters', async () => {
    respond({
      [`GET /api/people?name=Anna&withHidden=true&isFavorite=false&closestPersonId=${id(62)}&page=3&size=2`]:
        { people: [person(id(60))], total: 5, hidden: 1, hasNextPage: false },
    });
    const output = await runOk(
      'people',
      'list',
      '--name',
      ' Anna ',
      '--with-hidden',
      '--no-favorite',
      '--like',
      id(62),
      '--limit',
      '2',
      '--page',
      '3',
    );
    expect(output.nextPage).toBeNull();
    expect(output.people).toEqual([anna]);
  });

  it('refuses a page before the first', async () => {
    const failure = await failureOf('people', 'list', '--page', '0');
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos people show', () => {
  it('counts the photos that show each person', async () => {
    respond({
      [`GET /api/people/${id(60)}`]: person(id(60), {
        birthDate: '1990-05-17',
        isFavorite: true,
      }),
      [`GET /api/people/${id(60)}/statistics`]: { assets: 321 },
    });
    expect(await runOk('people', 'show', id(60))).toEqual([
      { ...anna, birthDate: '1990-05-17', favorite: true, assetCount: 321 },
    ]);
  });
});

describe('photos people preview', () => {
  it("saves a person's face only its user can read", async () => {
    respond({
      [`GET /api/people/${id(60)}/thumbnail`]: () =>
        new Response(new Uint8Array([4, 5]), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    });
    const output = await runOk('people', 'preview', id(60));
    const file = join(
      fake.home,
      'runtime',
      'photos',
      'previews',
      `${id(60)}-face.jpg`,
    );
    expect(output).toEqual([{ id: id(60), path: file }]);
    expect([...(await readFile(file))]).toEqual([4, 5]);
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
  });
});

describe('photos people create', () => {
  it('adds a named person', async () => {
    respond({
      'POST /api/people': person(id(60), { birthDate: '1990-05-17' }),
    });
    const output = await runOk(
      'people',
      'create',
      '--name',
      ' Anna ',
      '--birth-date',
      '1990-05-17',
    );
    expect(requests()).toEqual([
      { 'POST /api/people': { name: 'Anna', birthDate: '1990-05-17' } },
    ]);
    expect(output).toEqual({ ...anna, birthDate: '1990-05-17' });
  });

  it.each([
    [['--name', ' '], 'needs a name'],
    [['--name', 'Anna', '--birth-date', '1990-02-30'], 'is not a day'],
    [['--name', 'Anna', '--birth-date', '17.05.1990'], 'is not a day'],
  ])('refuses %j', async (args, message) => {
    const failure = await failureOf('people', 'create', ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});

describe('photos people update', () => {
  it('sends only what changes', async () => {
    respond({
      [`PUT /api/people/${id(60)}`]: person(id(60), {
        isHidden: true,
        isFavorite: true,
      }),
    });
    const output = await runOk(
      'people',
      'update',
      id(60),
      '--name',
      'Anna',
      '--birth-date',
      '',
      '--hidden',
      '--favorite',
      '--cover',
      id(1),
    );
    expect(requests()).toEqual([
      {
        [`PUT /api/people/${id(60)}`]: {
          name: 'Anna',
          birthDate: null,
          isHidden: true,
          isFavorite: true,
          featureFaceAssetId: id(1),
        },
      },
    ]);
    expect(output).toEqual({ ...anna, hidden: true, favorite: true });
  });

  it('shows a hidden person again', async () => {
    respond({ [`PUT /api/people/${id(60)}`]: person(id(60)) });
    await runOk('people', 'update', id(60), '--no-hidden');
    expect(requests()).toEqual([
      { [`PUT /api/people/${id(60)}`]: { isHidden: false } },
    ]);
  });

  it('refuses an update that changes nothing', async () => {
    const failure = await failureOf('people', 'update', id(60));
    expect(failure.message).toContain('Nothing to change');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos people merge', () => {
  it('merges the others into the first person, in order', async () => {
    respond({
      [`GET /api/people/${id(60)}`]: person(id(60)),
      [`GET /api/people/${id(61)}`]: person(id(61), { name: '' }),
      [`GET /api/people/${id(62)}`]: person(id(62), { name: 'Anni' }),
      'POST /api/people/merge': [
        { id: id(60), success: true },
        { id: id(61), success: true },
        { id: id(62), success: false, error: 'unknown' },
      ],
      [`GET /api/people/${id(60)}/statistics`]: { assets: 40 },
    });
    const output = await runOk('people', 'merge', id(60), id(61), id(62));
    expect(requests()).toContainEqual({
      'POST /api/people/merge': { ids: [id(60), id(61), id(62)] },
    });
    expect(output).toEqual({
      person: { ...anna, assetCount: 40 },
      merged: [{ id: id(61), name: null }],
      notMerged: [{ id: id(62), reason: 'unknown' }],
    });
  });

  it('merges nothing when the person to keep is missing', async () => {
    respond({ [`GET /api/people/${id(61)}`]: person(id(61)) });
    const failure = await failureOf('people', 'merge', id(60), id(61));
    expect(failure._tag).toBe('ImmichRejected');
    expect(requests()).not.toContainEqual(
      expect.objectContaining({ 'POST /api/people/merge': expect.anything() }),
    );
  });

  it('refuses to merge a person into themselves', async () => {
    const failure = await failureOf('people', 'merge', id(60), id(60));
    expect(failure.message).toContain('cannot be merged into themselves');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos people delete', () => {
  it("deletes people and lists each one's photos", async () => {
    const pages = [page([asset(id(1))], 'second'), page([asset(id(2))])];
    respond({
      [`GET /api/people/${id(60)}`]: person(id(60)),
      'POST /api/search/metadata': () => Response.json(pages.shift()),
      'DELETE /api/people': null,
    });
    const output = await runOk('people', 'delete', id(60));
    const search = {
      filter: {
        trashedAt: { eq: null },
        visibility: { in: ['timeline', 'archive'] },
        personIds: { all: [id(60)] },
      },
      orderBy: { field: 'fileCreatedAt', direction: 'desc' },
      size: 1000,
      withExif: true,
    };
    expect(requests()).toEqual([
      `GET /api/people/${id(60)}`,
      { 'POST /api/search/metadata': search },
      { 'POST /api/search/metadata': { ...search, cursor: 'second' } },
      { 'DELETE /api/people': { ids: [id(60)] } },
    ]);
    expect(output.deleted).toEqual([{ ...anna, assetIds: [id(1), id(2)] }]);
    expect(output.note).toContain('photos stay');
  });
});
