import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  asset,
  failureOf,
  fake,
  features,
  id,
  requests,
  respond,
  runOk,
  setUp,
  tearDown,
} from './command-fixtures.ts';

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

const server = (trash = true) => ({
  'GET /api/server/features': features({ trash }),
  'GET /api/server/config': { trashDays: 30 },
});

describe('photos trash', () => {
  it('moves photos to the trash and never deletes for good', async () => {
    respond({
      ...server(),
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(2)}`]: asset(id(2), { isTrashed: true }),
      'DELETE /api/assets': null,
    });
    const output = await runOk('trash', id(1), id(2), id(1));
    expect(requests()).toContainEqual({
      'DELETE /api/assets': { ids: [id(1)], force: false },
    });
    expect(output).toEqual({
      trashed: [expect.objectContaining({ id: id(1), trashed: true })],
      alreadyInTrash: [id(2)],
      trashDays: 30,
      restoreWith: `photos restore ${id(1)} ${id(2)}`,
    });
  });

  it('sends nothing to delete when everything is in the trash already', async () => {
    respond({
      ...server(),
      [`GET /api/assets/${id(2)}`]: asset(id(2), { isTrashed: true }),
    });
    await runOk('trash', id(2));
    expect(fake.sent.map(({ method }) => method)).not.toContain('DELETE');
  });

  it("refuses while Immich's trash is off, since deleting would be for good", async () => {
    respond({ ...server(false), [`GET /api/assets/${id(1)}`]: asset(id(1)) });
    const failure = await failureOf('trash', id(1));
    expect(failure._tag).toBe('TrashDisabled');
    expect(fake.sent.map(({ method }) => method)).not.toContain('DELETE');
  });

  it('refuses the hidden video half of a live photo', async () => {
    respond({
      ...server(),
      [`GET /api/assets/${id(3)}`]: asset(id(3), { visibility: 'hidden' }),
    });
    const failure = await failureOf('trash', id(3));
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent.map(({ method }) => method)).not.toContain('DELETE');
  });
});

describe('photos restore', () => {
  it('brings back only what is in the trash', async () => {
    let restored = false;
    respond({
      [`GET /api/assets/${id(1)}`]: () =>
        Response.json(asset(id(1), { isTrashed: !restored })),
      [`GET /api/assets/${id(2)}`]: asset(id(2)),
      'POST /api/trash/restore/assets': () => {
        restored = true;
        return Response.json({ count: 1 });
      },
    });
    const output = await runOk('restore', id(1), id(2));
    expect(requests()).toContainEqual({
      'POST /api/trash/restore/assets': { ids: [id(1)] },
    });
    expect(output).toEqual({
      restored: [expect.objectContaining({ id: id(1), trashed: false })],
      notInTrash: [id(2)],
    });
  });
});

describe('photos update', () => {
  it('changes the marks Immich keeps and prints the photos as they are now', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      'PUT /api/assets': null,
    });
    await runOk(
      'update',
      id(1),
      '--favorite',
      '--archived',
      '--description',
      ' Tax 2026 ',
      '--rating',
      '0',
    );
    expect(requests()).toEqual([
      `GET /api/assets/${id(1)}`,
      {
        'PUT /api/assets': {
          ids: [id(1)],
          isFavorite: true,
          visibility: 'archive',
          description: 'Tax 2026',
          rating: null,
        },
      },
      `GET /api/assets/${id(1)}`,
    ]);
  });

  it('moves photos back to the timeline', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      'PUT /api/assets': null,
    });
    await runOk(
      'update',
      id(1),
      '--no-archived',
      '--no-favorite',
      '--rating',
      '5',
    );
    expect(requests()).toContainEqual({
      'PUT /api/assets': {
        ids: [id(1)],
        isFavorite: false,
        visibility: 'timeline',
        rating: 5,
      },
    });
  });

  it.each([[[]], [['--rating', '6']]])('refuses %j', async (args) => {
    const failure = await failureOf('update', id(1), ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});
