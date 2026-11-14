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

const person = (personId: string, name: string) => ({
  id: personId,
  name,
  birthDate: null,
  isHidden: false,
  isFavorite: false,
  thumbnailPath: '/data/thumbs/secret/face.jpeg',
  updatedAt: '2026-11-14T09:31:00.000Z',
});

/** A face as Immich answers it, measured on a preview 2000 by 1000 pixels. */
const face = (
  faceId: string,
  owner: object | null,
  overrides: object = {},
) => ({
  id: faceId,
  boundingBoxX1: 840,
  boundingBoxY1: 180,
  boundingBoxX2: 1080,
  boundingBoxY2: 340,
  imageWidth: 2000,
  imageHeight: 1000,
  person: owner,
  sourceType: 'machine-learning',
  ...overrides,
});

const faces = [
  face(id(90), person(id(60), 'Anna')),
  face(id(91), null, {
    boundingBoxX1: 0,
    boundingBoxY1: 500,
    boundingBoxX2: 500,
    boundingBoxY2: 1000,
    sourceType: 'manual',
  }),
];

const listed = {
  assetId: id(1),
  faces: [
    {
      id: id(90),
      person: { id: id(60), name: 'Anna' },
      box: { left: 0.42, top: 0.18, width: 0.12, height: 0.16 },
      source: 'machine-learning',
    },
    {
      id: id(91),
      person: null,
      box: { left: 0, top: 0.5, width: 0.25, height: 0.5 },
      source: 'manual',
    },
  ],
};

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

describe('photos faces list', () => {
  it("prints each face's person and box in fractions of the photo", async () => {
    respond({ [`GET /api/faces?id=${id(1)}`]: faces });
    const output = await runOk('faces', 'list', id(1));
    expect(output).toEqual(listed);
    expect(JSON.stringify(output)).not.toContain('/data/thumbs');
  });
});

describe('photos faces assign', () => {
  it('gives one face to a person', async () => {
    respond({ [`PUT /api/faces/${id(61)}`]: person(id(61), 'Ben') });
    const output = await runOk('faces', 'assign', id(90), id(61));
    expect(requests()).toEqual([
      { [`PUT /api/faces/${id(61)}`]: { id: id(90) } },
    ]);
    expect(output).toEqual({
      face: id(90),
      person: {
        id: id(61),
        name: 'Ben',
        birthDate: null,
        hidden: false,
        favorite: false,
      },
    });
  });

  it('refuses a face that is not an id', async () => {
    const failure = await failureOf('faces', 'assign', 'left', id(61));
    expect(failure.message).toContain('is not an Immich id');
    expect(fake.sent).toEqual([]);
  });
});

describe('photos faces add', () => {
  it("places the box on the photo's own pixels", async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      'POST /api/faces': () => new Response(null, { status: 201 }),
      [`GET /api/faces?id=${id(1)}`]: faces,
    });
    const output = await runOk(
      'faces',
      'add',
      id(1),
      '--person',
      id(60),
      '--box',
      '0.42, 0.18, 0.12, 0.16',
    );
    expect(requests()).toEqual([
      `GET /api/assets/${id(1)}`,
      {
        'POST /api/faces': {
          assetId: id(1),
          personId: id(60),
          x: 1714,
          y: 553,
          width: 490,
          height: 492,
          imageWidth: 4080,
          imageHeight: 3072,
        },
      },
      `GET /api/faces?id=${id(1)}`,
    ]);
    expect(output).toEqual(listed);
  });

  it('keeps a box at the edge on the photo', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), { width: 10, height: 10 }),
      'POST /api/faces': () => new Response(null, { status: 201 }),
      [`GET /api/faces?id=${id(1)}`]: [],
    });
    await runOk(
      'faces',
      'add',
      id(1),
      '--person',
      id(60),
      '--box',
      '0.75,0.75,0.25,0.25',
    );
    expect(requests()).toContainEqual({
      'POST /api/faces': {
        assetId: id(1),
        personId: id(60),
        x: 8,
        y: 8,
        width: 2,
        height: 2,
        imageWidth: 10,
        imageHeight: 10,
      },
    });
  });

  it.each([
    ['0.42,0.18,0.12', 'is not a box'],
    ['0.42,,0.12,0.16', 'is not a box'],
    ['0.42,0.18,wide,0.16', 'is not a box'],
    ['-0.1,0.18,0.12,0.16', 'reaches outside the photo'],
    ['0.42,0.18,0,0.16', 'reaches outside the photo'],
    ['0.92,0.18,0.12,0.16', 'reaches outside the photo'],
    ['0.42,0.9,0.12,0.16', 'reaches outside the photo'],
  ])('refuses the box %s', async (box, message) => {
    const failure = await failureOf(
      'faces',
      'add',
      id(1),
      '--person',
      id(60),
      // Joined, so a box that starts with a minus is not taken for a flag.
      `--box=${box}`,
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });

  it('marks nothing on a photo whose size Immich does not know yet', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), { width: null, height: null }),
    });
    const failure = await failureOf(
      'faces',
      'add',
      id(1),
      '--person',
      id(60),
      '--box',
      '0.42,0.18,0.12,0.16',
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain('does not know the size');
    expect(requests()).toEqual([`GET /api/assets/${id(1)}`]);
  });
});

describe('photos faces delete', () => {
  it('deletes faces without ever erasing them for good', async () => {
    respond({
      [`DELETE /api/faces/${id(90)}`]: null,
      [`DELETE /api/faces/${id(91)}`]: null,
    });
    const output = await runOk('faces', 'delete', id(90), id(91));
    expect(requests()).toEqual([
      { [`DELETE /api/faces/${id(90)}`]: { force: false } },
      { [`DELETE /api/faces/${id(91)}`]: { force: false } },
    ]);
    expect(output.deleted).toEqual([id(90), id(91)]);
    expect(output.note).toContain('The photos stay');
  });
});
