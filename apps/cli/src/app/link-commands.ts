import { DateTime, Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import { browsable, getAssets } from '../features/assets/library.ts';
import {
  getLink,
  LinkAssetResultSchema,
  linkOrigin,
  type SharedLink,
  SharedLinkListSchema,
  SharedLinkSchema,
  summarizeLink,
} from '../features/links/links.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  choice,
  fail,
  flag,
  idArgument,
  idsArgument,
  optionalString,
  validId,
  validIds,
} from './command-inputs.ts';
import {
  clearable,
  defaultExpiry,
  expiryTime,
  linkPassword,
} from './link-inputs.ts';
import { runImmich } from './root.ts';

const expiresHelp =
  'an age from now such as 3d or 2w, a day as YYYY-MM-DD (it works through that day), a time, or never';

const downloadHelp =
  'the originals carry the metadata, GPS position included, so downloads need --show-metadata';

/** A link as photos prints it, with the address to send. */
const describeLink = (link: SharedLink, withAssets = true) =>
  Effect.gen(function* () {
    const origin = yield* linkOrigin;
    const now = yield* DateTime.now;
    return summarizeLink(link, origin, now, withAssets);
  });

// Immich hides downloads when the metadata is hidden, since the originals
// carry it, so a link that allows one but hides the other is refused rather
// than changed behind the caller's back.
const downloadNeedsMetadata = (
  allowDownload: boolean,
  showMetadata: boolean,
) =>
  allowDownload && !showMetadata
    ? fail(`--allow-download needs --show-metadata: ${downloadHelp}.`)
    : Effect.void;

const optionalId = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.succeed(undefined),
    onSome: validId,
  });

const list = Command.make(
  'list',
  { album: optionalString('album', 'Only the links to this album (album id)') },
  ({ album }) =>
    runImmich(optionalId(album), (albumId) =>
      Effect.gen(function* () {
        const links = yield* requestJson(
          { method: 'GET', path: '/shared-links', query: { albumId } },
          SharedLinkListSchema,
        );
        const origin = yield* linkOrigin;
        const now = yield* DateTime.now;
        return links.map((link) => summarizeLink(link, origin, now));
      }),
    ),
).pipe(
  Command.withDescription(
    'List the shared links of this account, each with its address, when it expires, and what it lets people do',
  ),
);

const show = Command.make(
  'show',
  { link: idArgument('link', 'Link id') },
  ({ link }) =>
    runImmich(validId(link), (id) =>
      Effect.flatMap(getLink(id), (found) => describeLink(found)),
    ),
).pipe(
  Command.withDescription(
    'Show a shared link: its address, the album or photos it shares, when it expires, and what it lets people do',
  ),
);

const create = Command.make(
  'create',
  {
    album: optionalString(
      'album',
      'Share this album (album id); photos added to it later are shared too',
    ),
    assets: Argument.String('asset').pipe(
      Argument.withDescription('Asset ids to share, in place of --album'),
      Argument.variadic(),
    ),
    expires: optionalString(
      'expires',
      `When the link stops working: ${expiresHelp} (default ${defaultExpiry})`,
    ),
    allowDownload: flag(
      'allow-download',
      `Let people download the originals (off unless given; ${downloadHelp})`,
    ),
    showMetadata: flag(
      'show-metadata',
      'Show the metadata, such as the place, the camera and the time (off unless given)',
    ),
    password: optionalString('password', 'A password people need to open it'),
    description: optionalString('description', 'A note shown with the photos'),
  },
  (options) =>
    runImmich(
      Effect.gen(function* () {
        const { album, assets } = options;
        if (Option.isSome(album) === assets.length > 0) {
          return yield* fail(
            'Pass either --album or asset ids: a link shares one album or a set of photos.',
          );
        }
        yield* downloadNeedsMetadata(
          options.allowDownload,
          options.showMetadata,
        );
        const target: {
          readonly type: 'ALBUM' | 'INDIVIDUAL';
          readonly albumId?: string;
          readonly assetIds?: ReadonlyArray<string>;
        } = Option.isSome(album)
          ? { type: 'ALBUM', albumId: yield* validId(album.value) }
          : { type: 'INDIVIDUAL', assetIds: yield* validIds(assets) };
        return {
          ...target,
          expiresAt: yield* expiryTime(
            Option.getOrElse(options.expires, () => defaultExpiry),
          ),
          allowDownload: options.allowDownload,
          showMetadata: options.showMetadata,
          // Immich lets people upload into a link unless told otherwise.
          allowUpload: false,
          ...(Option.isSome(options.password)
            ? { password: yield* linkPassword(options.password.value) }
            : {}),
          ...(Option.isSome(options.description)
            ? { description: clearable(options.description.value) }
            : {}),
        };
      }),
      (body) =>
        Effect.gen(function* () {
          if (body.assetIds !== undefined) {
            yield* browsable(yield* getAssets(body.assetIds));
          }
          const link = yield* requestJson(
            { method: 'POST', path: '/shared-links', body },
            SharedLinkSchema,
          );
          return yield* describeLink(link);
        }),
    ),
).pipe(
  Command.withDescription(
    `Create a link that lets anyone who has it see an album or some photos, without an account. It expires after ${defaultExpiry} unless --expires says otherwise, and shows no metadata and allows no downloads or uploads unless asked. Prints the address to send.`,
  ),
);

type LinkChanges = {
  readonly expiresAt?: string | null;
  readonly allowDownload?: boolean;
  readonly showMetadata?: boolean;
  readonly password?: string | null;
  readonly description?: string | null;
};

const update = Command.make(
  'update',
  {
    link: idArgument('link', 'Link id'),
    expires: optionalString('expires', `When it stops working: ${expiresHelp}`),
    allowDownload: choice(
      'allow-download',
      `Let people download the originals, or stop them with --no-allow-download (${downloadHelp})`,
    ),
    showMetadata: choice(
      'show-metadata',
      'Show the metadata, or hide it with --no-show-metadata',
    ),
    password: optionalString('password', 'A new password'),
    removePassword: flag('remove-password', 'Let people in without one'),
    description: optionalString(
      'description',
      'A new note; an empty one clears it',
    ),
  },
  (options) =>
    runImmich(
      Effect.gen(function* () {
        if (Option.isSome(options.password) && options.removePassword) {
          return yield* fail('Pass --password or --remove-password, not both.');
        }
        const changes: LinkChanges = {
          ...(Option.isSome(options.expires)
            ? { expiresAt: yield* expiryTime(options.expires.value) }
            : {}),
          ...Option.match(options.allowDownload, {
            onNone: () => ({}),
            onSome: (allowDownload) => ({ allowDownload }),
          }),
          ...Option.match(options.showMetadata, {
            onNone: () => ({}),
            onSome: (showMetadata) => ({ showMetadata }),
          }),
          ...(Option.isSome(options.password)
            ? { password: yield* linkPassword(options.password.value) }
            : {}),
          ...(options.removePassword ? { password: null } : {}),
          ...(Option.isSome(options.description)
            ? { description: clearable(options.description.value) }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --expires, --allow-download, --show-metadata, --password, --remove-password or --description.',
          );
        }
        return { id: yield* validId(options.link), changes };
      }),
      ({ id, changes }) =>
        Effect.gen(function* () {
          const current = yield* getLink(id);
          yield* downloadNeedsMetadata(
            changes.allowDownload ?? current.allowDownload,
            changes.showMetadata ?? current.showMetadata,
          );
          // Immich drops a custom slug that an update leaves out.
          const body = { ...changes, slug: current.slug ?? null };
          const link = yield* requestJson(
            { method: 'PATCH', path: `/shared-links/${id}`, body },
            SharedLinkSchema,
          );
          return yield* describeLink(link);
        }),
    ),
).pipe(
  Command.withDescription(
    'Change when a shared link expires, whether it allows downloads or shows metadata, its password or its note. The address stays the same.',
  ),
);

/** A link that shares a set of photos, not an album, whose photos change. */
const photoLink = (id: string) =>
  Effect.flatMap(getLink(id), (link) =>
    link.type === 'ALBUM'
      ? fail(
          'This link shares an album, so it shows whatever the album holds. Add or remove photos with `photos albums add` or `photos albums remove`.',
        )
      : Effect.succeed(link),
  );

const linkAndAssets = (link: string, assets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return { id: yield* validId(link), assetIds: yield* validIds(assets) };
  });

const changeAssets = (
  method: 'PUT' | 'DELETE',
  id: string,
  assetIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const results = yield* requestJson(
      { method, path: `/shared-links/${id}/assets`, body: { assetIds } },
      LinkAssetResultSchema,
    );
    const link = yield* describeLink(yield* getLink(id));
    return {
      link,
      changed: results
        .filter((result) => result.success)
        .map(({ assetId }) => assetId),
      unchanged: results
        .filter((result) => !result.success)
        .map(({ assetId, error }) => ({
          id: assetId,
          reason: error ?? 'unknown',
        })),
    };
  });

const add = Command.make(
  'add',
  {
    link: idArgument('link', 'Link id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ link, assets }) =>
    runImmich(linkAndAssets(link, assets), ({ id, assetIds }) =>
      Effect.gen(function* () {
        yield* photoLink(id);
        yield* browsable(yield* getAssets(assetIds));
        const { changed, ...rest } = yield* changeAssets('PUT', id, assetIds);
        return { ...rest, added: changed };
      }),
    ),
).pipe(
  Command.withDescription(
    'Share more photos through a link that shares photos rather than an album. Photos it already shares are listed as unchanged.',
  ),
);

const remove = Command.make(
  'remove',
  {
    link: idArgument('link', 'Link id'),
    assets: idsArgument('asset', 'Asset ids'),
  },
  ({ link, assets }) =>
    runImmich(linkAndAssets(link, assets), ({ id, assetIds }) =>
      Effect.gen(function* () {
        yield* photoLink(id);
        const { changed, ...rest } = yield* changeAssets(
          'DELETE',
          id,
          assetIds,
        );
        return { ...rest, removed: changed };
      }),
    ),
).pipe(
  Command.withDescription(
    'Stop sharing some photos through a link. They stay in the library.',
  ),
);

const deleteLink = Command.make(
  'delete',
  { link: idArgument('link', 'Link id') },
  ({ link }) =>
    runImmich(validId(link), (id) =>
      Effect.gen(function* () {
        const deleted = yield* describeLink(yield* getLink(id));
        yield* requestNothing({
          method: 'DELETE',
          path: `/shared-links/${id}`,
        });
        return {
          deleted,
          note: 'The address no longer opens. The photos stay in the library. A new link gets a new address.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    'Delete a shared link, so its address stops working. The photos stay in the library. A new link would get a new address.',
  ),
);

export const links = Command.make('links').pipe(
  Command.withDescription(
    'List, create, change and delete links that let people without an account see an album or some photos',
  ),
  Command.withSubcommands([
    list,
    show,
    create,
    update,
    add,
    remove,
    deleteLink,
  ]),
);
