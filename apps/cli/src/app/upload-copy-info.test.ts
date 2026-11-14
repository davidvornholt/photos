import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  album,
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

const both = {
  [`GET /api/assets/${id(1)}`]: asset(id(1)),
  [`GET /api/assets/${id(2)}`]: asset(id(2), { isFavorite: true }),
};

describe('photos copy-info', () => {
  it('copies everything by default and prints the target as it is now', async () => {
    respond({
      ...both,
      'PUT /api/assets/copy': null,
      [`GET /api/albums?assetId=${id(2)}`]: [album(id(50))],
    });
    const output = await runOk('copy-info', id(1), id(2));
    expect(requests()).toContainEqual({
      'PUT /api/assets/copy': {
        sourceId: id(1),
        targetId: id(2),
        albums: true,
        favorite: true,
        sharedLinks: true,
        stack: true,
        sidecar: true,
      },
    });
    expect(output).toMatchObject({
      source: id(1),
      target: {
        id: id(2),
        favorite: true,
        albums: [{ id: id(50), name: 'Scans' }],
        stackId: null,
      },
      copied: ['albums', 'favorite', 'sharedLinks', 'stack', 'sidecar'],
      note: expect.stringContaining('photos trash'),
    });
    expect(JSON.stringify(output)).not.toContain('13.405');
  });

  it('skips what a --no- flag names', async () => {
    respond({
      ...both,
      'PUT /api/assets/copy': null,
      [`GET /api/albums?assetId=${id(2)}`]: [],
    });
    const output = await runOk(
      'copy-info',
      id(1),
      id(2),
      '--no-favorite',
      '--no-shared-links',
    );
    expect(requests()).toContainEqual({
      'PUT /api/assets/copy': expect.objectContaining({
        favorite: false,
        sharedLinks: false,
        albums: true,
      }),
    });
    expect(output.copied).toEqual(['albums', 'stack', 'sidecar']);
  });

  it.each([
    [[id(1), id(1)], 'the same asset'],
    [[id(1), 'two'], 'not an Immich id'],
    [
      [
        id(1),
        id(2),
        '--no-albums',
        '--no-favorite',
        '--no-shared-links',
        '--no-stack',
        '--no-sidecar',
      ],
      'nothing to copy',
    ],
  ])('refuses %p before sending anything', async (args, message) => {
    const failure = await failureOf('copy-info', ...args);
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });

  it('refuses a locked photo without copying', async () => {
    respond({
      ...both,
      [`GET /api/assets/${id(2)}`]: asset(id(2), { visibility: 'locked' }),
    });
    const failure = await failureOf('copy-info', id(1), id(2));
    expect(failure.message).toContain('not in the library');
    expect(requests()).not.toContainEqual(
      expect.objectContaining({ 'PUT /api/assets/copy': expect.anything() }),
    );
  });
});
