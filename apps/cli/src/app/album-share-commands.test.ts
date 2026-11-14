import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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

beforeEach(() => setUp(spyOn));
afterEach(tearDown);

const owner = {
  role: 'owner',
  user: { id: '00000900-0000-4000-8000-000000000000', name: 'Owner' },
};
const anna = { role: 'viewer', user: { id: id(91), name: 'Anna' } };
const ben = { role: 'editor', user: { id: id(92), name: 'Ben' } };

/** The album as it is before the command and after it. */
const albumChanging = (
  before: ReadonlyArray<object>,
  after: ReadonlyArray<object>,
) => {
  let changed = false;
  return {
    [`GET /api/albums/${id(50)}`]: () =>
      Response.json(
        album(id(50), {
          albumUsers: changed ? after : before,
          shared: (changed ? after : before).length > 1,
        }),
      ),
    change: () => {
      changed = true;
    },
  };
};

describe('photos albums share', () => {
  it('adds new users, changes the role of those already in it, and prints whom it is shared with', async () => {
    const { change, ...lookup } = albumChanging(
      [owner, ben],
      [owner, { ...anna, role: 'editor' }, ben],
    );
    respond({
      ...lookup,
      [`PUT /api/albums/${id(50)}/users`]: () => {
        change();
        return Response.json(album(id(50)));
      },
      [`PUT /api/albums/${id(50)}/user/${id(92)}`]: null,
    });
    const output = await runOk(
      'albums',
      'share',
      id(50),
      id(91),
      id(92),
      '--role',
      'editor',
    );
    expect(requests()).toContainEqual({
      [`PUT /api/albums/${id(50)}/users`]: {
        albumUsers: [{ userId: id(91), role: 'editor' }],
      },
    });
    expect(requests()).not.toContainEqual(
      expect.objectContaining({
        [`PUT /api/albums/${id(50)}/user/${id(92)}`]: expect.anything(),
      }),
    );
    expect(output).toEqual({
      album: expect.objectContaining({
        shared: true,
        sharedWith: [
          { id: id(91), name: 'Anna', role: 'editor' },
          { id: id(92), name: 'Ben', role: 'editor' },
        ],
      }),
      added: [id(91)],
      roleChanged: [],
      unchanged: [id(92)],
    });
  });

  it('changes the role of someone the album is shared with already', async () => {
    const { change, ...lookup } = albumChanging(
      [owner, ben],
      [owner, { ...ben, role: 'viewer' }],
    );
    respond({
      ...lookup,
      [`PUT /api/albums/${id(50)}/user/${id(92)}`]: () => {
        change();
        return new Response(null, { status: 204 });
      },
    });
    const output = await runOk(
      'albums',
      'share',
      id(50),
      id(92),
      '--role',
      'viewer',
    );
    expect(requests()).toContainEqual({
      [`PUT /api/albums/${id(50)}/user/${id(92)}`]: { role: 'viewer' },
    });
    expect(output).toMatchObject({
      album: { sharedWith: [{ id: id(92), role: 'viewer' }] },
      added: [],
      roleChanged: [id(92)],
    });
  });

  it('refuses to change the owner', async () => {
    respond({ [`GET /api/albums/${id(50)}`]: album(id(50)) });
    const failure = await failureOf(
      'albums',
      'share',
      id(50),
      owner.user.id,
      '--role',
      'viewer',
    );
    expect(failure._tag).toBe('InvalidInput');
    expect(fake.sent.map(({ method }) => method)).toEqual(['GET']);
  });
});

describe('photos albums unshare', () => {
  it('takes users off the album and lists those it was not shared with', async () => {
    const { change, ...lookup } = albumChanging(
      [owner, anna, ben],
      [owner, ben],
    );
    respond({
      ...lookup,
      [`DELETE /api/albums/${id(50)}/user/${id(91)}`]: () => {
        change();
        return new Response(null, { status: 204 });
      },
    });
    const output = await runOk('albums', 'unshare', id(50), id(91), id(93));
    expect(output).toEqual({
      album: expect.objectContaining({
        sharedWith: [{ id: id(92), name: 'Ben', role: 'editor' }],
      }),
      removed: [id(91)],
      notSharedWith: [id(93)],
    });
  });
});
