import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  asset,
  failureOf,
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

const memory = (memoryId: string, overrides: object = {}) => ({
  id: memoryId,
  ownerId: '00000900-0000-4000-8000-000000000000',
  type: 'on_this_day',
  data: { year: 2019 },
  memoryAt: '2019-11-14T00:00:00.000Z',
  showAt: '2026-11-14T00:00:00.000Z',
  hideAt: '2026-11-14T23:59:59.999Z',
  isSaved: false,
  assets: [asset(id(1)), asset(id(2))],
  createdAt: '2026-11-14T01:00:00.000Z',
  updatedAt: '2026-11-14T01:00:00.000Z',
  ...overrides,
});

const sentMethods = () => fake.sent.map(({ method }) => method);

describe('photos memories list and show', () => {
  it('lists memories with the filters given and says whether more follow', async () => {
    respond({
      'GET /api/memories?for=2026-11-14&isSaved=false&type=on_this_day&order=asc&size=1&page=1':
        [memory(id(80))],
      'GET /api/memories/statistics?for=2026-11-14&isSaved=false&type=on_this_day':
        { total: 2 },
    });
    const output = await runOk(
      'memories',
      'list',
      '--for',
      '2026-11-14',
      '--no-saved',
      '--type',
      'on_this_day',
      '--oldest-first',
      '--limit',
      '1',
    );
    expect(output).toEqual({
      total: 2,
      page: 1,
      nextPage: 2,
      memories: [
        {
          id: id(80),
          type: 'on_this_day',
          year: 2019,
          date: '2019-11-14T00:00:00.000Z',
          showFrom: '2026-11-14T00:00:00.000Z',
          showUntil: '2026-11-14T23:59:59.999Z',
          saved: false,
          seenAt: null,
          assetCount: 2,
          createdAt: '2026-11-14T01:00:00.000Z',
          updatedAt: '2026-11-14T01:00:00.000Z',
        },
      ],
    });
  });

  it('names the person of a birthday memory', async () => {
    respond({
      'GET /api/memories?order=desc&size=50&page=1': [
        memory(id(81), {
          type: 'birthday',
          data: { year: 1990, personId: id(60), personName: 'Anna' },
        }),
      ],
      'GET /api/memories/statistics': { total: 1 },
    });
    const output = await runOk('memories', 'list');
    expect(output).toMatchObject({
      nextPage: null,
      memories: [{ type: 'birthday', person: 'Anna', personId: id(60) }],
    });
  });

  it('refuses a day that does not exist', async () => {
    const failure = await failureOf('memories', 'list', '--for', '2026-02-30');
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });

  it('shows a memory with its photos', async () => {
    respond({ [`GET /api/memories/${id(80)}`]: memory(id(80)) });
    const output = await runOk('memories', 'show', id(80));
    expect(output).toMatchObject({
      memory: { id: id(80), assetCount: 2 },
      assets: [{ id: id(1) }, { id: id(2) }],
    });
  });
});

describe('photos memories create and update', () => {
  it('makes a memory of the day the earliest photo was taken', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(2)}`]: asset(id(2), {
        fileCreatedAt: '2019-11-13T23:30:00.000Z',
        localDateTime: '2019-11-14T00:30:00.000Z',
      }),
      'POST /api/memories': memory(id(82)),
    });
    const output = await runOk('memories', 'create', id(1), id(2));
    expect(requests()).toContainEqual({
      'POST /api/memories': {
        type: 'on_this_day',
        data: { year: 2019 },
        memoryAt: '2019-11-14T00:00:00.000Z',
        assetIds: [id(1), id(2)],
        isSaved: false,
      },
    });
    expect(output).toMatchObject({
      id: id(82),
      note: expect.stringContaining('30 days'),
    });
  });

  it('takes the day, the time to show it and the saved mark as given', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      'POST /api/memories': memory(id(82), { isSaved: true }),
    });
    const output = await runOk(
      'memories',
      'create',
      id(1),
      '--date',
      '2020-07-01',
      '--show-from',
      '2026-11-14',
      '--show-until',
      '2026-11-20',
      '--saved',
    );
    expect(requests()).toContainEqual({
      'POST /api/memories': {
        type: 'on_this_day',
        data: { year: 2020 },
        memoryAt: '2020-07-01T00:00:00.000Z',
        assetIds: [id(1)],
        showAt: '2026-11-13T23:00:00.000Z',
        hideAt: '2026-11-20T22:59:59.999Z',
        isSaved: true,
      },
    });
    expect(output).not.toHaveProperty('note');
  });

  it('refuses archived photos, which memories do not show', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), {
        isArchived: true,
        visibility: 'archive',
      }),
    });
    const failure = await failureOf('memories', 'create', id(1));
    expect(failure._tag).toBe('InvalidInput');
    expect(sentMethods()).not.toContain('POST');
  });

  it('saves a memory and marks it as seen', async () => {
    respond({
      [`PUT /api/memories/${id(80)}`]: memory(id(80), { isSaved: true }),
    });
    const output = await runOk(
      'memories',
      'update',
      id(80),
      '--saved',
      '--seen',
      '--date',
      '2019-11-15',
    );
    expect(requests()).toContainEqual({
      [`PUT /api/memories/${id(80)}`]: {
        isSaved: true,
        seenAt: expect.any(String),
        memoryAt: '2019-11-15T00:00:00.000Z',
      },
    });
    expect(output).toMatchObject({ id: id(80), saved: true });
  });

  it('refuses an update that changes nothing', async () => {
    const failure = await failureOf('memories', 'update', id(80));
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos memories add, remove and delete', () => {
  it('puts photos in a memory', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(3)}`]: asset(id(3)),
      [`PUT /api/memories/${id(80)}/assets`]: [
        { id: id(3), success: true },
        { id: id(1), success: false, error: 'duplicate' },
      ],
      [`GET /api/memories/${id(80)}`]: memory(id(80)),
    });
    const output = await runOk('memories', 'add', id(80), id(3), id(1));
    expect(output).toMatchObject({
      memory: { id: id(80) },
      added: [id(3)],
      unchanged: [{ id: id(1), reason: 'duplicate' }],
    });
  });

  it('takes photos out of a memory', async () => {
    respond({
      [`DELETE /api/memories/${id(80)}/assets`]: [{ id: id(2), success: true }],
      [`GET /api/memories/${id(80)}`]: memory(id(80)),
    });
    const output = await runOk('memories', 'remove', id(80), id(2));
    expect(requests()).toContainEqual({
      [`DELETE /api/memories/${id(80)}/assets`]: { ids: [id(2)] },
    });
    expect(output).toMatchObject({ removed: [id(2)], unchanged: [] });
  });

  it('deletes a memory and lists its photos, which stay', async () => {
    respond({
      [`GET /api/memories/${id(80)}`]: memory(id(80)),
      [`DELETE /api/memories/${id(80)}`]: null,
    });
    const output = await runOk('memories', 'delete', id(80));
    expect(output).toMatchObject({
      deleted: { id: id(80) },
      assetIds: [id(1), id(2)],
      note: expect.stringContaining('--date 2019-11-14'),
    });
  });
});
