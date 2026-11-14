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

/** A stack as Immich answers it, its photos in the order Immich sorts them. */
const stack = (
  stackId: string,
  assetIds: ReadonlyArray<string>,
  primaryAssetId: string,
) => ({
  id: stackId,
  primaryAssetId,
  assets: assetIds.map((assetId) => asset(assetId)),
});

const burst = stack(id(80), [id(2), id(1), id(3)], id(1));

const rejected = (message: string) => () =>
  Response.json({ message, statusCode: 400 }, { status: 400 });

describe('photos stacks list', () => {
  it('lists each stack with its primary photo first and no coordinates', async () => {
    respond({ 'GET /api/stacks': [burst] });
    const output = await runOk('stacks', 'list');
    expect(output).toEqual([
      {
        id: id(80),
        primaryAssetId: id(1),
        assetCount: 3,
        assetIds: [id(1), id(2), id(3)],
        primary: expect.objectContaining({
          id: id(1),
          fileName: 'PXL_20261114_093000.jpg',
          takenAt: '2026-11-14T10:30:00.000+01:00',
        }),
      },
    ]);
    expect(JSON.stringify(output)).not.toContain('latitude');
  });

  it('finds the stack a photo is in when it is not the primary one', async () => {
    respond({
      [`GET /api/assets/${id(2)}`]: asset(id(2), {
        stack: { id: id(80), primaryAssetId: id(1), assetCount: 3 },
      }),
      [`GET /api/stacks/${id(80)}`]: burst,
    });
    const output = await runOk('stacks', 'list', '--asset', id(2));
    expect(requests()).toEqual([
      `GET /api/assets/${id(2)}`,
      `GET /api/stacks/${id(80)}`,
    ]);
    expect(output).toMatchObject([{ id: id(80), primaryAssetId: id(1) }]);
  });

  it('lists nothing for a photo in no stack', async () => {
    respond({ [`GET /api/assets/${id(4)}`]: asset(id(4), { stack: null }) });
    expect(await runOk('stacks', 'list', '--asset', id(4))).toEqual([]);
    expect(requests()).toEqual([`GET /api/assets/${id(4)}`]);
  });
});

describe('photos stacks show', () => {
  it('shows every photo in a stack, the primary one first', async () => {
    respond({ [`GET /api/stacks/${id(80)}`]: burst });
    const output = await runOk('stacks', 'show', id(80));
    expect(output).toMatchObject({
      id: id(80),
      primaryAssetId: id(1),
      assetCount: 3,
      assets: [{ id: id(1) }, { id: id(2) }, { id: id(3) }],
    });
    expect(output.assets[0]).toEqual(
      expect.objectContaining({ type: 'image', favorite: false }),
    );
    expect(JSON.stringify(output)).not.toContain('latitude');
  });
});

describe('photos stacks create and update', () => {
  it('stacks photos with the first one given as the primary', async () => {
    respond({ 'POST /api/stacks': stack(id(81), [id(1), id(3)], id(3)) });
    const output = await runOk('stacks', 'create', id(3), id(1), id(3));
    expect(requests()).toEqual([
      { 'POST /api/stacks': { assetIds: [id(3), id(1)] } },
    ]);
    expect(output).toMatchObject({
      id: id(81),
      primaryAssetId: id(3),
      assets: [{ id: id(3) }, { id: id(1) }],
    });
  });

  it('refuses a stack of one photo', async () => {
    const failure = await failureOf('stacks', 'create', id(1), id(1));
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });

  it('makes another photo the primary one', async () => {
    respond({
      [`PUT /api/stacks/${id(80)}`]: stack(
        id(80),
        [id(2), id(1), id(3)],
        id(2),
      ),
    });
    const output = await runOk('stacks', 'update', id(80), '--primary', id(2));
    expect(requests()).toEqual([
      { [`PUT /api/stacks/${id(80)}`]: { primaryAssetId: id(2) } },
    ]);
    expect(output).toMatchObject({
      primaryAssetId: id(2),
      assets: [{ id: id(2) }, { id: id(1) }, { id: id(3) }],
    });
  });

  it('refuses an update without --primary', async () => {
    const failure = await failureOf('stacks', 'update', id(80));
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos stacks remove', () => {
  it('takes photos out and lists the ones it could not take out', async () => {
    let lookups = 0;
    respond({
      [`GET /api/stacks/${id(80)}`]: () => {
        lookups += 1;
        return Response.json(
          lookups === 1 ? burst : stack(id(80), [id(1), id(3)], id(1)),
        );
      },
      [`DELETE /api/stacks/${id(80)}/assets/${id(2)}`]: null,
      [`DELETE /api/stacks/${id(80)}/assets/${id(4)}`]:
        rejected('Asset not in stack'),
    });
    const output = await runOk('stacks', 'remove', id(80), id(1), id(2), id(4));
    expect(requests()).toEqual([
      `GET /api/stacks/${id(80)}`,
      `DELETE /api/stacks/${id(80)}/assets/${id(2)}`,
      `DELETE /api/stacks/${id(80)}/assets/${id(4)}`,
      `GET /api/stacks/${id(80)}`,
    ]);
    expect(output).toMatchObject({
      stack: { id: id(80), assetCount: 2 },
      removed: [id(2)],
      unchanged: [
        { id: id(1), reason: expect.stringContaining('primary') },
        { id: id(4), reason: 'Asset not in stack' },
      ],
    });
  });
});

describe('photos stacks delete', () => {
  it('unstacks and lists the photos of each stack, primary first', async () => {
    respond({
      [`GET /api/stacks/${id(80)}`]: burst,
      [`GET /api/stacks/${id(81)}`]: stack(id(81), [id(5), id(6)], id(6)),
      'DELETE /api/stacks': null,
    });
    const output = await runOk('stacks', 'delete', id(80), id(81));
    expect(requests().at(-1)).toEqual({
      'DELETE /api/stacks': { ids: [id(80), id(81)] },
    });
    expect(output).toMatchObject({
      deleted: [
        { id: id(80), primaryAssetId: id(1), assetIds: [id(1), id(2), id(3)] },
        { id: id(81), primaryAssetId: id(6), assetIds: [id(6), id(5)] },
      ],
    });
    expect(output.note).toContain('photos stacks create');
  });

  it('deletes nothing when a stack does not exist', async () => {
    respond({
      [`GET /api/stacks/${id(80)}`]: burst,
      [`GET /api/stacks/${id(82)}`]: rejected('Asset stack not found'),
    });
    const failure = await failureOf('stacks', 'delete', id(80), id(82));
    expect(failure._tag).toBe('ImmichRejected');
    expect(requests()).not.toContainEqual(
      expect.objectContaining({ 'DELETE /api/stacks': expect.anything() }),
    );
  });
});
