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

/** A photo 4080 pixels wide and 3072 high, stored with an EXIF orientation. */
const photo = (orientation = '1', overrides: object = {}) => {
  const base = asset(id(1));
  return asset(id(1), {
    exifInfo: {
      ...base.exifInfo,
      exifImageWidth: 4080,
      exifImageHeight: 3072,
      orientation,
    },
    ...overrides,
  });
};

const crop = {
  action: 'crop',
  parameters: { x: 10, y: 20, width: 2000, height: 1000 },
};
const rotate = (angle: number) => ({ action: 'rotate', parameters: { angle } });
const mirror = (axis: string) => ({ action: 'mirror', parameters: { axis } });

/** Immich's answer listing a photo's edits, each with the id it gives it. */
const editList = (edits: ReadonlyArray<object>) => ({
  assetId: id(1),
  edits: edits.map((edit, index) => ({ id: id(800 + index), ...edit })),
});

/** The photo with these edits, and Immich's answer once they are replaced. */
const editing = (
  before: ReadonlyArray<object>,
  after: ReadonlyArray<object> = [],
) => ({
  [`GET /api/assets/${id(1)}`]: photo(),
  [`GET /api/assets/${id(1)}/edits`]: editList(before),
  [`PUT /api/assets/${id(1)}/edits`]: editList(after),
  [`DELETE /api/assets/${id(1)}/edits`]: null,
});

const writes = () =>
  requests().filter(
    (request) =>
      typeof request === 'object' ||
      String(request).startsWith('DELETE') ||
      String(request).startsWith('PUT'),
  );

describe('photos edits show', () => {
  it('lists the edits in order and the size a crop is measured in', async () => {
    respond({
      ...editing([crop, rotate(90)]),
      [`GET /api/assets/${id(1)}`]: photo('6'),
    });
    const output = await runOk('edits', 'show', id(1));
    expect(output).toEqual({
      assetId: id(1),
      // Orientation 6 stands the picture on its side.
      original: { width: 3072, height: 4080 },
      edits: [
        { action: 'crop', x: 10, y: 20, width: 2000, height: 1000 },
        { action: 'rotate', angle: 90 },
      ],
    });
    expect(JSON.stringify(output)).not.toContain('52.52');
  });

  it('refuses a locked photo', async () => {
    respond({
      ...editing([]),
      [`GET /api/assets/${id(1)}`]: photo('1', { visibility: 'locked' }),
    });
    const failure = await failureOf('edits', 'show', id(1));
    expect(failure.message).toContain('not in the library');
  });
});

describe('photos edits apply', () => {
  it('adds a rotation after the edits there are, keeping them', async () => {
    const after = [crop, mirror('horizontal'), rotate(90)];
    respond(editing([crop, mirror('horizontal')], after));
    const output = await runOk('edits', 'apply', id(1), '--rotate', '90');
    expect(writes()).toEqual([
      { [`PUT /api/assets/${id(1)}/edits`]: { edits: after } },
    ]);
    expect(output).toMatchObject({
      assetId: id(1),
      changed: true,
      edits: [
        { action: 'crop' },
        { action: 'mirror', axis: 'horizontal' },
        { action: 'rotate', angle: 90 },
      ],
      previous: [{ action: 'crop' }, { action: 'mirror' }],
      note: expect.stringContaining('keeps the original'),
    });
  });

  it('sets the rotation rather than adding to it, in its place', async () => {
    respond(editing([rotate(90), mirror('vertical')]));
    await runOk('edits', 'apply', id(1), '--rotate', '180');
    expect(writes()).toEqual([
      {
        [`PUT /api/assets/${id(1)}/edits`]: {
          edits: [rotate(180), mirror('vertical')],
        },
      },
    ]);
  });

  it('puts new mirroring before the rotation and a new crop first', async () => {
    respond(editing([rotate(270)]));
    await runOk(
      'edits',
      'apply',
      id(1),
      '--mirror',
      'both',
      '--crop',
      '10,20,2000,1000',
    );
    expect(writes()).toEqual([
      {
        [`PUT /api/assets/${id(1)}/edits`]: {
          edits: [crop, mirror('horizontal'), mirror('vertical'), rotate(270)],
        },
      },
    ]);
  });

  it('removes one kind of edit with none or 0 and leaves the rest', async () => {
    respond(editing([crop, mirror('horizontal'), rotate(90)]));
    await runOk('edits', 'apply', id(1), '--crop', 'none', '--rotate', '0');
    expect(writes()).toEqual([
      {
        [`PUT /api/assets/${id(1)}/edits`]: {
          edits: [mirror('horizontal')],
        },
      },
    ]);
  });

  it('clears the edits when none are left, since Immich takes no empty list', async () => {
    respond(editing([mirror('horizontal'), mirror('vertical')]));
    const output = await runOk('edits', 'apply', id(1), '--mirror', 'none');
    expect(writes()).toEqual([`DELETE /api/assets/${id(1)}/edits`]);
    expect(output).toMatchObject({ changed: true, edits: [] });
  });

  it('sends nothing when the photo is already edited that way', async () => {
    respond(editing([crop, rotate(90)]));
    const output = await runOk(
      'edits',
      'apply',
      id(1),
      '--rotate',
      '90',
      '--crop',
      '10, 20, 2000, 1000',
    );
    expect(writes()).toEqual([]);
    expect(output).toMatchObject({ changed: false, note: expect.any(String) });
  });

  it('refuses a crop that reaches past the photo as it shows', async () => {
    respond({
      ...editing([]),
      [`GET /api/assets/${id(1)}`]: photo('8'),
    });
    const failure = await failureOf(
      'edits',
      'apply',
      id(1),
      '--crop',
      '0,0,4080,3072',
    );
    expect(failure.message).toContain('3072×4080');
    expect(writes()).toEqual([]);
  });

  it('changes nothing when Immich holds an edit photos does not know', async () => {
    respond(editing([crop, { action: 'blur', parameters: { radius: 3 } }]));
    const failure = await failureOf('edits', 'apply', id(1), '--rotate', '90');
    expect(failure._tag).toBe('UnexpectedResponse');
    expect(writes()).toEqual([]);
  });

  it.each([
    [[id(1)], 'Nothing to change'],
    [[id(1), '--rotate', '45'], '0, 90, 180 or 270'],
    [[id(1), '--crop', '1,2,3'], 'is not a crop'],
    [[id(1), '--crop', '0,0,0,10'], 'at least 1'],
    [[id(1), '--crop=-1,0,10,10'], 'is not a crop'],
    [[id(1), '--mirror', 'diagonal'], 'horizontal, vertical, both or none'],
    [['photo', '--rotate', '90'], 'not an Immich id'],
  ])('refuses %p before sending anything', async (args, message) => {
    const failure = await failureOf('edits', 'apply', ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});

describe('photos edits reset', () => {
  it('removes every edit and prints them, to apply again', async () => {
    respond(editing([crop, rotate(90)]));
    const output = await runOk('edits', 'reset', id(1));
    expect(writes()).toEqual([`DELETE /api/assets/${id(1)}/edits`]);
    expect(output).toEqual({
      assetId: id(1),
      removed: [
        { action: 'crop', x: 10, y: 20, width: 2000, height: 1000 },
        { action: 'rotate', angle: 90 },
      ],
      note: expect.stringContaining('original file was never changed'),
    });
  });

  it('sends nothing for a photo without edits', async () => {
    respond(editing([]));
    const output = await runOk('edits', 'reset', id(1));
    expect(writes()).toEqual([]);
    expect(output).toMatchObject({ removed: [] });
  });
});
