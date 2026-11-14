import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { requiredPermissions } from '../features/account/account.ts';
import {
  apiKey,
  credentialsPath,
  failureOf,
  fake,
  features,
  id,
  respond,
  runOk,
  server,
  setUp,
  tearDown,
} from './command-fixtures.ts';

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

const everything = {
  'GET /api/api-keys/me': {
    id: id(80),
    name: 'agents on this machine',
    permissions: ['all'],
  },
  'GET /api/server/version': { major: 3, minor: 3, patch: 5 },
  'GET /api/server/features': features(),
  'GET /api/server/config': { trashDays: 30 },
  'GET /api/users/me': { id: id(900), name: 'Owner' },
};

const stored = async () =>
  JSON.parse(await readFile(credentialsPath(), 'utf8'));
const mode = async (path: string) => (await stat(path)).mode % 0o1000;

describe('photos login', () => {
  it('checks the key with the server before it stores it for this user only', async () => {
    await rm(dirname(credentialsPath()), { recursive: true });
    respond(everything);
    fake.stdin = '  new-key\n';
    const output = await runOk('login', '--server', `${server}/photos`);
    expect(fake.sent.every((sent) => sent.apiKey === 'new-key')).toBe(true);
    expect(await stored()).toEqual({ server, apiKey: 'new-key' });
    expect(await mode(credentialsPath())).toBe(0o600);
    expect(await mode(dirname(credentialsPath()))).toBe(0o700);
    expect(output).toEqual({
      signedIn: true,
      server,
      user: 'Owner',
      apiKey: 'agents on this machine',
      missingPermissions: [],
      immich: {
        version: '3.3.5',
        smartSearch: true,
        ocr: true,
        duplicateDetection: true,
        trash: true,
        trashDays: 30,
      },
    });
    expect(JSON.stringify(output)).not.toContain('new-key');
  });

  it('keeps the working key when the new one is refused', async () => {
    respond({
      'GET /api/api-keys/me': () =>
        Response.json(
          { message: 'Invalid API key', statusCode: 401 },
          { status: 401 },
        ),
    });
    fake.stdin = 'typo';
    const failure = await failureOf('login');
    expect(failure._tag).toBe('NotSignedIn');
    expect(failure.message).toContain('does not accept this API key');
    expect(await stored()).toEqual({ server, apiKey });
  });

  it.each([
    [['--server', 'http://immich.example.com'], 'key', 'https'],
    [[], '', 'No API key arrived'],
    [[], 'two words', 'contains spaces'],
  ])('refuses %j with key %j', async (args, key, message) => {
    fake.stdin = key;
    const failure = await failureOf('login', ...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});

describe('photos status', () => {
  it('lists the permissions the key lacks and works without user.read', async () => {
    respond({
      ...everything,
      'GET /api/api-keys/me': {
        id: id(80),
        name: 'reader',
        permissions: requiredPermissions.filter(
          (permission) => !['tag.asset', 'user.read'].includes(permission),
        ),
      },
      'GET /api/users/me': () =>
        Response.json(
          {
            message: 'Missing required permission: user.read',
            statusCode: 403,
          },
          { status: 403 },
        ),
    });
    const output = await runOk('status');
    expect(output.user).toBeNull();
    expect(output.missingPermissions).toEqual(['tag.asset', 'user.read']);
  });

  it('says so when this machine has no key', async () => {
    await rm(credentialsPath());
    expect(await runOk('status')).toEqual({ signedIn: false, server: null });
    expect(fake.sent).toEqual([]);
  });
});

describe('photos logout', () => {
  it('removes the key and the previews from this machine', async () => {
    const previews = join(fake.home, 'runtime', 'photos', 'previews');
    await mkdir(previews, { recursive: true });
    await Bun.write(join(previews, `${id(1)}-preview.webp`), 'photo');
    const output = await runOk('logout');
    expect(output).toMatchObject({
      signedIn: false,
      removedKey: true,
      removedPreviews: true,
    });
    expect(await Bun.file(credentialsPath()).exists()).toBe(false);
    await expect(stat(previews)).rejects.toThrow('ENOENT');
  });

  it('says when there was nothing to remove', async () => {
    await runOk('logout');
    const output = await runOk('logout');
    expect(output).toMatchObject({
      removedKey: false,
      removedPreviews: false,
    });
  });
});

describe('answers from Immich', () => {
  it('explains a missing permission', async () => {
    respond({
      'GET /api/duplicates': () =>
        Response.json(
          {
            message: 'Missing required permission: duplicate.read',
            statusCode: 403,
          },
          { status: 403 },
        ),
    });
    const failure = await failureOf('duplicates', 'list');
    expect(failure._tag).toBe('MissingPermission');
    expect(failure.message).toStartWith(
      'Missing required permission: duplicate.read.',
    );
  });

  it('never follows a redirect with the key', async () => {
    respond({
      'GET /api/duplicates': () =>
        Response.redirect('https://elsewhere.example', 302),
    });
    const failure = await failureOf('duplicates', 'list');
    expect(failure._tag).toBe('UnexpectedResponse');
    expect(failure.message).toContain('https://elsewhere.example');
    expect(fake.sent).toHaveLength(1);
  });

  it('passes on what Immich says about a refused request', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: () =>
        Response.json(
          { message: ['ids must be UUIDs', 'size too large'], statusCode: 400 },
          { status: 400 },
        ),
    });
    const failure = await failureOf('show', id(1));
    expect(failure).toMatchObject({
      _tag: 'ImmichRejected',
      message: 'ids must be UUIDs; size too large',
    });
  });
});
