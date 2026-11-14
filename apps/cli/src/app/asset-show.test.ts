import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  album,
  asset,
  id,
  respond,
  runOk,
  setUp,
  tearDown,
} from './command-fixtures.ts';

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

describe('photos show', () => {
  it('describes photos with place names but never coordinates', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), {
        exifInfo: {
          ...asset(id(1)).exifInfo,
          description: ' Receipt ',
          rating: 4,
        },
      }),
      [`GET /api/albums?assetId=${id(1)}`]: [album(id(50))],
      [`GET /api/assets/${id(1)}/ocr`]: [
        { text: 'Apotheke' },
        { text: ' 12,40 ' },
      ],
    });
    const output = await runOk('show', id(1).toUpperCase());
    expect(output).toEqual([
      expect.objectContaining({
        id: id(1),
        description: 'Receipt',
        mimeType: 'image/jpeg',
        fileSize: 2_400_000,
        camera: 'Google Pixel 6',
        lens: null,
        place: 'Berlin, Berlin, Germany',
        timeZone: 'Europe/Berlin',
        rating: 4,
        albums: [{ id: id(50), name: 'Scans' }],
        people: [],
        tags: [],
        stack: null,
        text: 'Apotheke\n12,40',
      }),
    ]);
    const shown = JSON.stringify(output);
    expect(shown).not.toContain('52.52');
    expect(shown).not.toContain('13.405');
    expect(shown).not.toContain('/data/library');
  });

  it('names the people, tags and stack of a photo', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), {
        people: [
          {
            id: id(60),
            name: 'Anna',
            birthDate: null,
            isHidden: false,
            thumbnailPath: '/data/thumbs/anna.jpeg',
            otherPeople: [],
            sharedBy: [],
            sharedWith: [],
          },
          {
            id: id(61),
            name: '',
            birthDate: null,
            isHidden: true,
            thumbnailPath: '/data/thumbs/someone.jpeg',
            otherPeople: [],
            sharedBy: [],
            sharedWith: [],
          },
        ],
        tags: [
          {
            id: id(70),
            name: 'Italy',
            value: 'Travel/Italy',
            createdAt: '2026-11-01T12:00:00.000Z',
            updatedAt: '2026-11-01T12:00:00.000Z',
          },
        ],
        stack: { id: id(80), primaryAssetId: id(2), assetCount: 3 },
      }),
      [`GET /api/albums?assetId=${id(1)}`]: [],
      [`GET /api/assets/${id(1)}/ocr`]: [],
    });
    const [shown] = await runOk('show', id(1));
    expect(shown.people).toEqual([
      { id: id(60), name: 'Anna' },
      { id: id(61), name: null },
    ]);
    expect(shown.tags).toEqual([{ id: id(70), name: 'Travel/Italy' }]);
    expect(shown.stack).toEqual({
      id: id(80),
      primaryAssetId: id(2),
      count: 3,
    });
    expect(JSON.stringify(shown)).not.toContain('/data/thumbs');
  });
});
