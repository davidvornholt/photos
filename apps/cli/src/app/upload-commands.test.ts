import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  album,
  failureOf,
  fake,
  id,
  requests,
  respond,
  runOk,
  setUp,
  tearDown,
} from './command-fixtures.ts';

type Field = string | { readonly name: string; readonly size: number };

/** The form fields of each upload, in the order sent. */
let forms: Array<Record<string, Field>> = [];
let text: Mock<(this: Request) => Promise<string>> | undefined;

// The shared fake server reads every body as JSON. An upload is multipart,
// so its fields are recorded here and the fake gets an empty body instead.
const original = Request.prototype.text;
beforeEach(async () => {
  await setUp(spyOn);
  forms = [];
  text = spyOn(Request.prototype, 'text').mockImplementation(async function (
    this: Request,
  ) {
    if (!this.headers.get('content-type')?.startsWith('multipart/form-data')) {
      return original.call(this);
    }
    const form = await this.formData();
    const fields: Record<string, Field> = {};
    for (const [name, value] of form.entries()) {
      // Bun types every entry as a string, though a file arrives as a File.
      const entry: unknown = value;
      fields[name] =
        entry instanceof File
          ? { name: entry.name, size: entry.size }
          : String(entry);
    }
    forms.push(fields);
    return '';
  });
});
afterEach(async () => {
  text?.mockRestore();
  await tearDown();
});

const modified = new Date('2026-07-04T08:15:00.000Z');

/** Writes a file into a fresh folder in the test's home, dated `modified`. */
const photo = async (name: string, content: string) => {
  const folder = join(fake.home, 'camera');
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, content);
  await utimes(path, modified, modified);
  return path;
};

/** A file only its owner could read, and not even them now. */
const unreadable = async () => {
  const path = await photo('locked.jpg', 'locked photo');
  await chmod(path, 0o000);
  return path;
};

const sha1 = (content: string) =>
  createHash('sha1').update(content).digest('hex');

/** Answers each upload with the next of these ids, as newly created. */
const created = (...ids: ReadonlyArray<string>) => {
  let next = 0;
  return () => {
    const answer = Response.json({ id: ids[next], status: 'created' });
    next += 1;
    return answer;
  };
};

describe('photos upload', () => {
  it('checks the files by checksum, sends only new ones with their date and sidecar, and reports each', async () => {
    const first = await photo('a.jpg', 'first photo');
    await writeFile(`${first}.xmp`, '<xmp/>');
    const second = await photo('b.jpg', 'second photo');
    respond({
      'POST /api/assets/bulk-upload-check': {
        results: [
          { id: '0', action: 'accept' },
          {
            id: '1',
            action: 'reject',
            reason: 'duplicate',
            assetId: id(2),
            isTrashed: false,
          },
        ],
      },
      'POST /api/assets': created(id(1)),
    });
    const output = await runOk('upload', first, second);
    expect(requests()).toEqual([
      {
        'POST /api/assets/bulk-upload-check': {
          assets: [
            { id: '0', checksum: sha1('first photo') },
            { id: '1', checksum: sha1('second photo') },
          ],
        },
      },
      'POST /api/assets',
    ]);
    expect(forms).toEqual([
      {
        fileCreatedAt: modified.toISOString(),
        fileModifiedAt: modified.toISOString(),
        assetData: { name: 'a.jpg', size: 'first photo'.length },
        sidecarData: { name: 'a.jpg.xmp', size: '<xmp/>'.length },
      },
    ]);
    expect(output).toEqual({
      files: [
        { file: first, status: 'created', assetId: id(1) },
        { file: second, status: 'duplicate', assetId: id(2), trashed: false },
      ],
      note: expect.stringContaining('not sent again'),
    });
  });

  it('finds a sidecar named without the extension of the photo', async () => {
    const path = await photo('c.jpg', 'third photo');
    await writeFile(join(fake.home, 'camera', 'c.xmp'), '<xmp/>');
    respond({
      'POST /api/assets/bulk-upload-check': {
        results: [{ id: '0', action: 'accept' }],
      },
      'POST /api/assets': created(id(3)),
    });
    await runOk('upload', path);
    expect(forms[0]?.sidecarData).toEqual({ name: 'c.xmp', size: 6 });
  });
});

describe('photos upload, file by file', () => {
  it('puts new and duplicate photos in the album, but not trashed ones', async () => {
    const first = await photo('a.jpg', 'first photo');
    const second = await photo('b.jpg', 'second photo');
    const third = await photo('c.jpg', 'third photo');
    respond({
      [`GET /api/albums/${id(50)}`]: album(id(50)),
      'POST /api/assets/bulk-upload-check': {
        results: [
          { id: '0', action: 'accept' },
          { id: '1', action: 'reject', reason: 'duplicate', assetId: id(2) },
          {
            id: '2',
            action: 'reject',
            reason: 'duplicate',
            assetId: id(3),
            isTrashed: true,
          },
        ],
      },
      'POST /api/assets': created(id(1)),
      [`PUT /api/albums/${id(50)}/assets`]: [
        { id: id(1), success: true },
        { id: id(2), success: false, error: 'duplicate' },
      ],
    });
    const output = await runOk(
      'upload',
      first,
      second,
      third,
      '--album',
      id(50),
    );
    expect(requests()[0]).toBe(`GET /api/albums/${id(50)}`);
    expect(requests()).toContainEqual({
      [`PUT /api/albums/${id(50)}/assets`]: { ids: [id(1), id(2)] },
    });
    expect(output).toMatchObject({
      files: [
        { status: 'created' },
        { status: 'duplicate', trashed: false },
        { status: 'duplicate', assetId: id(3), trashed: true },
      ],
      album: {
        album: { id: id(50) },
        added: [id(1)],
        unchanged: [{ id: id(2), reason: 'duplicate' }],
      },
      note: expect.stringContaining('photos restore'),
    });
  });

  it('reports a file Immich refuses and goes on with the others', async () => {
    const first = await photo('a.txt', 'not a photo');
    const second = await photo('b.jpg', 'second photo');
    const third = await photo('c.jpg', 'third photo');
    let uploads = 0;
    respond({
      'POST /api/assets/bulk-upload-check': {
        results: [
          { id: '0', action: 'reject', reason: 'unsupported-format' },
          { id: '1', action: 'accept' },
          { id: '2', action: 'accept' },
        ],
      },
      'POST /api/assets': () => {
        uploads += 1;
        return uploads === 1
          ? Response.json(
              { message: 'Unsupported file type', statusCode: 400 },
              { status: 400 },
            )
          : Response.json({ id: id(3), status: 'created' });
      },
    });
    const output = await runOk('upload', first, second, third);
    expect(output.files).toEqual([
      {
        file: first,
        status: 'failed',
        reason: 'Immich does not take files of this kind',
      },
      { file: second, status: 'failed', reason: 'Unsupported file type' },
      { file: third, status: 'created', assetId: id(3) },
    ]);
  });

  it('sends a file named twice once', async () => {
    const path = await photo('a.jpg', 'first photo');
    respond({
      'POST /api/assets/bulk-upload-check': {
        results: [{ id: '0', action: 'accept' }],
      },
      'POST /api/assets': created(id(1)),
    });
    const output = await runOk('upload', path, join(path, '..', 'a.jpg'));
    expect(output.files).toHaveLength(1);
    expect(forms).toHaveLength(1);
  });
});

describe('photos upload input', () => {
  it.each([
    ['a missing file', () => join(fake.home, 'missing.jpg'), 'does not exist'],
    ['a folder', () => join(fake.home, 'camera'), 'is not a file'],
    ['a file it cannot read', unreadable, 'cannot be read'],
  ])('refuses %s before sending anything', async (_, other, message) => {
    const path = await photo('a.jpg', 'first photo');
    const failure = await failureOf('upload', path, await other());
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });

  it('refuses a wrong album id before sending anything', async () => {
    const path = await photo('a.jpg', 'first photo');
    const failure = await failureOf('upload', path, '--album', 'summer');
    expect(failure.message).toContain('not an Immich id');
    expect(fake.sent).toEqual([]);
  });

  it('uploads nothing when the album cannot be found', async () => {
    const path = await photo('a.jpg', 'first photo');
    respond({});
    const failure = await failureOf('upload', path, '--album', id(50));
    expect(failure._tag).toBe('ImmichRejected');
    expect(requests()).toEqual([`GET /api/albums/${id(50)}`]);
  });

  it('never follows a redirect with the file and the key', async () => {
    const path = await photo('a.jpg', 'first photo');
    respond({
      'POST /api/assets/bulk-upload-check': {
        results: [{ id: '0', action: 'accept' }],
      },
      'POST /api/assets': () =>
        Response.redirect('https://elsewhere.example.net/upload', 307),
    });
    const failure = await failureOf('upload', path);
    expect(failure._tag).toBe('UnexpectedResponse');
    expect(fake.sent.map(({ redirect }) => redirect)).toEqual([
      'manual',
      'manual',
    ]);
    expect(requests()).toHaveLength(2);
  });
});
