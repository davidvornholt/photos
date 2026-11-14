import { Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import {
  type Album,
  AlbumSchema,
  getAlbum,
  roleOf,
  summarizeAlbum,
} from '../features/albums/albums.ts';
import { albumRoles } from '../features/albums/sharing.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  fail,
  idArgument,
  idsArgument,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const albumAndUsers = (album: string, users: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return { id: yield* validId(album), users: yield* validIds(users) };
  });

const usersArgument = idsArgument(
  'user',
  'User ids, as `photos users` lists them',
);

/** Fails when one of the users owns the album, whose place cannot change. */
const refuseOwner = (album: Album, users: ReadonlyArray<string>) => {
  const owners = users.filter((user) => roleOf(album, user) === 'owner');
  return owners.length === 0
    ? Effect.void
    : fail(
        `${owners.join(', ')} owns the album, so it cannot be shared with or taken from them.`,
      );
};

export const share = Command.make(
  'share',
  {
    album: idArgument('album', 'Album id'),
    users: usersArgument,
    role: Flag.Literals('role', albumRoles).pipe(
      Flag.withDescription(
        'viewer can look at the album; editor can also add photos to it',
      ),
    ),
  },
  ({ album, users, role }) =>
    runImmich(albumAndUsers(album, users), ({ id, users: valid }) =>
      Effect.gen(function* () {
        const before = yield* getAlbum(id);
        yield* refuseOwner(before, valid);
        const added = valid.filter(
          (user) => roleOf(before, user) === undefined,
        );
        const changed = valid.filter((user) => {
          const current = roleOf(before, user);
          return current !== undefined && current !== role;
        });
        if (added.length > 0) {
          yield* requestJson(
            {
              method: 'PUT',
              path: `/albums/${id}/users`,
              body: { albumUsers: added.map((userId) => ({ userId, role })) },
            },
            AlbumSchema,
          );
        }
        yield* Effect.forEach(
          changed,
          (user) =>
            requestNothing({
              method: 'PUT',
              path: `/albums/${id}/user/${user}`,
              body: { role },
            }),
          { discard: true },
        );
        const now = yield* getAlbum(id);
        return {
          album: summarizeAlbum(now),
          added,
          roleChanged: changed,
          unchanged: valid.filter((user) => roleOf(before, user) === role),
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Share an album with other accounts on the server, as viewers or editors. Users it is shared with already get the role given. Immich tells them about it. Prints the album with everyone it is shared with.',
  ),
);

export const unshare = Command.make(
  'unshare',
  { album: idArgument('album', 'Album id'), users: usersArgument },
  ({ album, users }) =>
    runImmich(albumAndUsers(album, users), ({ id, users: valid }) =>
      Effect.gen(function* () {
        const before = yield* getAlbum(id);
        yield* refuseOwner(before, valid);
        const members = valid.filter(
          (user) => roleOf(before, user) !== undefined,
        );
        yield* Effect.forEach(
          members,
          (user) =>
            requestNothing({
              method: 'DELETE',
              path: `/albums/${id}/user/${user}`,
            }),
          { discard: true },
        );
        const now = yield* getAlbum(id);
        return {
          album: summarizeAlbum(now),
          removed: members,
          notSharedWith: valid.filter((user) => !members.includes(user)),
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Stop sharing an album with some accounts. The album and its photos stay as they are.',
  ),
);
