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

const group = {
  duplicateId: id(70),
  assets: [asset(id(1)), asset(id(2)), asset(id(3))],
  suggestedKeepAssetIds: [id(1)],
};

const server = (trash = true) => ({
  'GET /api/server/features': features({ trash }),
  'GET /api/server/config': { trashDays: 30 },
  'GET /api/duplicates': [
    group,
    { duplicateId: id(71), assets: [], suggestedKeepAssetIds: [] },
  ],
});

const sentMethods = () => fake.sent.map(({ method }) => method);

describe('photos duplicates list', () => {
  it('lists look-alike groups with the ones to keep', async () => {
    respond(server());
    const output = await runOk('duplicates', 'list', '--limit', '1');
    expect(output).toEqual({
      groups: 2,
      duplicates: [
        {
          duplicateId: id(70),
          keep: [id(1)],
          assets: [
            expect.objectContaining({ id: id(1) }),
            expect.objectContaining({ id: id(2) }),
            expect.objectContaining({ id: id(3) }),
          ],
        },
      ],
    });
  });
});

describe('photos duplicates resolve', () => {
  it('keeps the chosen photos and moves the rest of the group to the trash', async () => {
    respond({
      ...server(),
      'POST /api/duplicates/resolve': [{ id: id(70), success: true }],
      [`GET /api/assets/${id(1)}`]: asset(id(1), { isFavorite: true }),
    });
    const output = await runOk(
      'duplicates',
      'resolve',
      id(70),
      '--keep',
      id(1),
    );
    expect(requests()).toContainEqual({
      'POST /api/duplicates/resolve': {
        groups: [
          {
            duplicateId: id(70),
            keepAssetIds: [id(1)],
            trashAssetIds: [id(2), id(3)],
          },
        ],
      },
    });
    expect(output).toEqual({
      kept: [expect.objectContaining({ id: id(1), favorite: true })],
      trashed: [
        expect.objectContaining({ id: id(2), trashed: true }),
        expect.objectContaining({ id: id(3), trashed: true }),
      ],
      trashDays: 30,
      restoreWith: `photos restore ${id(2)} ${id(3)}`,
    });
  });

  it('keeps several photos when --keep is repeated', async () => {
    respond({
      ...server(),
      'POST /api/duplicates/resolve': [{ id: id(70), success: true }],
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(2)}`]: asset(id(2)),
    });
    await runOk(
      'duplicates',
      'resolve',
      id(70),
      '--keep',
      id(1),
      '--keep',
      id(2),
    );
    expect(requests()).toContainEqual({
      'POST /api/duplicates/resolve': {
        groups: [
          {
            duplicateId: id(70),
            keepAssetIds: [id(1), id(2)],
            trashAssetIds: [id(3)],
          },
        ],
      },
    });
  });

  it("refuses while Immich's trash is off, since Immich would delete for good", async () => {
    respond(server(false));
    const failure = await failureOf(
      'duplicates',
      'resolve',
      id(70),
      '--keep',
      id(1),
    );
    expect(failure._tag).toBe('TrashDisabled');
    expect(sentMethods()).not.toContain('POST');
  });

  it.each([
    ['a photo outside the group', id(70), id(9)],
    ['a group that does not exist', id(72), id(1)],
  ])('refuses %s', async (_case, groupId, keep) => {
    respond(server());
    const failure = await failureOf(
      'duplicates',
      'resolve',
      groupId,
      '--keep',
      keep,
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(sentMethods()).not.toContain('POST');
  });

  it("reports Immich's reason when it does not resolve the group", async () => {
    respond({
      ...server(),
      'POST /api/duplicates/resolve': [
        {
          id: id(70),
          success: false,
          error: 'no_permission',
          errorMessage: 'No permission to delete assets',
        },
      ],
    });
    const failure = await failureOf(
      'duplicates',
      'resolve',
      id(70),
      '--keep',
      id(1),
    );
    expect(failure._tag).toBe('ImmichRejected');
    expect(failure.message).toContain('No permission to delete assets');
  });
});

describe('photos duplicates dismiss', () => {
  it('marks groups as not duplicates and keeps every photo', async () => {
    respond({ ...server(), 'DELETE /api/duplicates': null });
    const output = await runOk('duplicates', 'dismiss', id(70));
    expect(requests()).toContainEqual({
      'DELETE /api/duplicates': { ids: [id(70)] },
    });
    expect(output).toMatchObject({
      dismissed: [{ duplicateId: id(70), assetIds: [id(1), id(2), id(3)] }],
    });
  });

  it('refuses a group that does not exist', async () => {
    respond(server());
    const failure = await failureOf('duplicates', 'dismiss', id(72));
    expect(failure._tag).toBe('InvalidInput');
    expect(sentMethods()).not.toContain('DELETE');
  });
});
