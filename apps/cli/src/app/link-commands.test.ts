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

const day = 86_400_000;

/** A shared link as Immich answers it, sharing two photos. */
const link = (linkId: string, overrides: object = {}) => ({
  id: linkId,
  key: 'k3y-0f-the-link',
  slug: null,
  type: 'INDIVIDUAL',
  description: null,
  password: null,
  userId: id(900),
  token: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-11-14T12:00:00.000Z',
  allowDownload: false,
  allowUpload: false,
  showMetadata: false,
  assets: [asset(id(1)), asset(id(2))],
  ...overrides,
});

const albumLink = (linkId: string, overrides: object = {}) =>
  link(linkId, {
    type: 'ALBUM',
    album: album(id(50), { albumName: 'Summer' }),
    assets: [],
    ...overrides,
  });

const config = (externalDomain = '') => ({
  'GET /api/server/config': { externalDomain, loginPageMessage: '' },
});

const sentBody = (key: string) =>
  requests().find(
    (request): request is Record<string, Record<string, unknown>> =>
      typeof request === 'object' && Object.hasOwn(request, key),
  )?.[key];

describe('photos links create', () => {
  it('shares photos for seven days, without downloads, metadata or uploads, and prints the address', async () => {
    respond({
      ...config(),
      [`GET /api/assets/${id(1)}`]: asset(id(1)),
      [`GET /api/assets/${id(2)}`]: asset(id(2)),
      'POST /api/shared-links': link(id(70)),
    });
    const output = await runOk('links', 'create', id(1), id(2));
    const body = sentBody('POST /api/shared-links');
    expect(body).toEqual({
      type: 'INDIVIDUAL',
      assetIds: [id(1), id(2)],
      expiresAt: expect.any(String),
      allowDownload: false,
      showMetadata: false,
      allowUpload: false,
    });
    const expires = Date.parse(String(body?.expiresAt));
    expect(Math.abs(expires - (Date.now() + 7 * day))).toBeLessThan(60_000);
    expect(output).toEqual({
      id: id(70),
      url: 'https://immich.example.com/share/k3y-0f-the-link',
      type: 'photos',
      album: null,
      assetIds: [id(1), id(2)],
      description: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expired: false,
      passwordProtected: false,
      allowDownload: false,
      showMetadata: false,
      allowUpload: false,
      createdAt: '2026-11-14T12:00:00.000Z',
    });
    expect(JSON.stringify(output)).not.toContain('52.52');
  });

  it('shares an album until a day ends, with a password it never prints, at the public address', async () => {
    respond({
      ...config('https://photos.example.org'),
      'POST /api/shared-links': albumLink(id(71), {
        password: 'hunter2',
        description: 'For the family',
        expiresAt: '2099-12-24T22:59:59.999Z',
        allowDownload: true,
        showMetadata: true,
      }),
    });
    const output = await runOk(
      'links',
      'create',
      '--album',
      id(50),
      '--expires',
      '2099-12-24',
      '--password',
      'hunter2',
      '--description',
      'For the family',
      '--allow-download',
      '--show-metadata',
    );
    expect(requests()).toContainEqual({
      'POST /api/shared-links': {
        type: 'ALBUM',
        albumId: id(50),
        expiresAt: '2099-12-24T22:59:59.999Z',
        allowDownload: true,
        showMetadata: true,
        allowUpload: false,
        password: 'hunter2',
        description: 'For the family',
      },
    });
    expect(output).toMatchObject({
      url: 'https://photos.example.org/share/k3y-0f-the-link',
      type: 'album',
      album: { id: id(50), name: 'Summer' },
      passwordProtected: true,
    });
    expect(output).not.toHaveProperty('assetIds');
    expect(JSON.stringify(output)).not.toContain('hunter2');
  });
});

describe('photos links create, expiry and refused input', () => {
  it('makes a link that never expires when asked', async () => {
    respond({
      ...config(),
      'POST /api/shared-links': albumLink(id(71), { expiresAt: null }),
    });
    const output = await runOk(
      'links',
      'create',
      '--album',
      id(50),
      '--expires',
      'never',
    );
    expect(sentBody('POST /api/shared-links')).toMatchObject({
      expiresAt: null,
    });
    expect(output).toMatchObject({ expiresAt: null, expired: false });
  });

  it.each([
    [['links', 'create'], 'either --album or asset ids'],
    [
      ['links', 'create', '--album', id(50), id(1)],
      'either --album or asset ids',
    ],
    [['links', 'create', id(1), '--allow-download'], '--show-metadata'],
    [
      ['links', 'create', id(1), '--expires', '2020-01-01'],
      'not in the future',
    ],
    [['links', 'create', id(1), '--expires', 'soon'], 'is not a time'],
    [['links', 'create', id(1), '--password', ''], '--remove-password'],
    [['links', 'create', 'not-an-id'], 'not an Immich id'],
  ])('refuses %p before sending anything', async (args, message) => {
    const failure = await failureOf(...args);
    expect(failure._tag).toBe('InvalidInput');
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });

  it('refuses photos a person browsing the library does not see', async () => {
    respond({
      [`GET /api/assets/${id(1)}`]: asset(id(1), { visibility: 'locked' }),
    });
    const failure = await failureOf('links', 'create', id(1));
    expect(failure.message).toContain('not in the library');
    expect(requests()).not.toContainEqual(
      expect.objectContaining({ 'POST /api/shared-links': expect.anything() }),
    );
  });
});

describe('photos links list and show', () => {
  it('lists links with their addresses, a custom one included, and marks expired ones', async () => {
    respond({
      ...config(),
      'GET /api/shared-links': [
        link(id(70), { expiresAt: '2020-01-01T00:00:00.000Z' }),
        albumLink(id(71), { slug: 'summer 2026' }),
      ],
    });
    const output = await runOk('links', 'list');
    expect(output).toMatchObject([
      { id: id(70), expired: true, type: 'photos' },
      {
        id: id(71),
        url: 'https://immich.example.com/s/summer%202026',
        expired: false,
      },
    ]);
    expect(output[0]).not.toHaveProperty('assetIds');
  });

  it('lists only the links to an album', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links?albumId=${id(50)}`]: [albumLink(id(71))],
    });
    await runOk('links', 'list', '--album', id(50));
    expect(requests()).toContain(`GET /api/shared-links?albumId=${id(50)}`);
  });

  it('shows a link with the ids of every photo it shares', async () => {
    respond({ ...config(), [`GET /api/shared-links/${id(70)}`]: link(id(70)) });
    const output = await runOk('links', 'show', id(70));
    expect(output).toMatchObject({ id: id(70), assetIds: [id(1), id(2)] });
  });
});

describe('photos links update', () => {
  it('sends only what changes, and keeps the custom address', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links/${id(70)}`]: link(id(70), {
        slug: 'trip',
        password: 'old',
      }),
      [`PATCH /api/shared-links/${id(70)}`]: link(id(70), { slug: 'trip' }),
    });
    const output = await runOk(
      'links',
      'update',
      id(70),
      '--expires',
      'never',
      '--remove-password',
      '--description',
      '',
    );
    expect(requests()).toContainEqual({
      [`PATCH /api/shared-links/${id(70)}`]: {
        expiresAt: null,
        password: null,
        description: null,
        slug: 'trip',
      },
    });
    expect(output).toMatchObject({ url: 'https://immich.example.com/s/trip' });
  });

  it('turns downloads on together with the metadata', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links/${id(70)}`]: link(id(70)),
      [`PATCH /api/shared-links/${id(70)}`]: link(id(70)),
    });
    await runOk(
      'links',
      'update',
      id(70),
      '--allow-download',
      '--show-metadata',
    );
    expect(sentBody(`PATCH /api/shared-links/${id(70)}`)).toEqual({
      allowDownload: true,
      showMetadata: true,
      slug: null,
    });
  });

  it('refuses downloads on a link that hides the metadata', async () => {
    respond({ [`GET /api/shared-links/${id(70)}`]: link(id(70)) });
    const failure = await failureOf(
      'links',
      'update',
      id(70),
      '--allow-download',
    );
    expect(failure.message).toContain('--show-metadata');
    expect(requests()).toEqual([`GET /api/shared-links/${id(70)}`]);
  });

  it.each([
    [['links', 'update', id(70)], 'Nothing to change'],
    [
      ['links', 'update', id(70), '--password', 'x', '--remove-password'],
      'not both',
    ],
    [['links', 'update', id(70), '--expires', '30m-ago'], 'is not a time'],
  ])('refuses %p before sending anything', async (args, message) => {
    const failure = await failureOf(...args);
    expect(failure.message).toContain(message);
    expect(fake.sent).toEqual([]);
  });
});

describe('photos links add and remove', () => {
  it('adds photos to a link and lists those it already shared', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links/${id(70)}`]: link(id(70)),
      [`GET /api/assets/${id(2)}`]: asset(id(2)),
      [`GET /api/assets/${id(3)}`]: asset(id(3)),
      [`PUT /api/shared-links/${id(70)}/assets`]: [
        { assetId: id(2), success: false, error: 'duplicate' },
        { assetId: id(3), success: true },
      ],
    });
    const output = await runOk('links', 'add', id(70), id(2), id(3));
    expect(requests()).toContainEqual({
      [`PUT /api/shared-links/${id(70)}/assets`]: { assetIds: [id(2), id(3)] },
    });
    expect(output).toMatchObject({
      link: { id: id(70) },
      added: [id(3)],
      unchanged: [{ id: id(2), reason: 'duplicate' }],
    });
  });

  it('removes photos from a link', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links/${id(70)}`]: link(id(70)),
      [`DELETE /api/shared-links/${id(70)}/assets`]: [
        { assetId: id(1), success: true },
      ],
    });
    const output = await runOk('links', 'remove', id(70), id(1));
    expect(requests()).toContainEqual({
      [`DELETE /api/shared-links/${id(70)}/assets`]: { assetIds: [id(1)] },
    });
    expect(output).toMatchObject({ removed: [id(1)], unchanged: [] });
  });

  it('points to the album commands for a link that shares an album', async () => {
    respond({ [`GET /api/shared-links/${id(71)}`]: albumLink(id(71)) });
    const failure = await failureOf('links', 'add', id(71), id(1));
    expect(failure.message).toContain('photos albums add');
    expect(requests()).toEqual([`GET /api/shared-links/${id(71)}`]);
  });
});

describe('photos links delete', () => {
  it('deletes a link and prints what it was', async () => {
    respond({
      ...config(),
      [`GET /api/shared-links/${id(70)}`]: link(id(70)),
      [`DELETE /api/shared-links/${id(70)}`]: null,
    });
    const output = await runOk('links', 'delete', id(70));
    expect(requests()).toContain(`DELETE /api/shared-links/${id(70)}`);
    expect(output).toMatchObject({
      deleted: { id: id(70), url: expect.stringContaining('/share/') },
      note: expect.stringContaining('no longer opens'),
    });
  });
});
