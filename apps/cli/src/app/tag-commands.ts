import { Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import { maxPage } from '../features/assets/library.ts';
import {
  findTag,
  isHexColor,
  summarizeTag,
  TaggedPhotosSchema,
  TagListSchema,
  TagSchema,
  taggedPhotosRequest,
  tagNameParts,
  tagsBelow,
  UpsertedTagSchema,
} from '../features/tags/tags.ts';
import { BulkResultSchema, splitResults } from '../shared/bulk.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  fail,
  idsArgument,
  optionalString,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const tagArgument = Argument.String('tag').pipe(
  Argument.withDescription('Tag id or full name, such as Trips/2026'),
);

const listTags = requestJson({ method: 'GET', path: '/tags' }, TagListSchema);

const tagName = (value: string) => {
  const parts = tagNameParts(value);
  return parts === undefined
    ? fail(
        `"${value}" is not a tag name. A slash separates a tag from the one above it, as in Trips/2026, and no part may be empty.`,
      )
    : Effect.succeed(parts);
};

const tagReference = (value: string) =>
  value.trim() === ''
    ? fail('Name a tag by its id or full name.')
    : Effect.succeed(value);

const tagColor = (value: string) => {
  const color = value.trim();
  return isHexColor(color)
    ? Effect.succeed(color)
    : fail(`${value} is not a color. Give a hex code such as #ff8800.`);
};

/** The tag with this id or full name, from all of this account's tags. */
const resolveTag = (wanted: string) =>
  Effect.gen(function* () {
    const all = yield* listTags;
    const tag = findTag(all, wanted);
    if (tag === undefined) {
      return yield* fail(
        `No tag has the id or name "${wanted}". \`photos tags list\` lists the tags.`,
      );
    }
    return { tag, all };
  });

const list = Command.make('list', {}, () =>
  runImmich(Effect.void, () =>
    listTags.pipe(Effect.map((all) => all.map(summarizeTag))),
  ),
).pipe(
  Command.withDescription(
    "List this account's tags by full name, such as Trips/2026 for the tag 2026 below Trips, with each tag's color",
  ),
);

const create = Command.make(
  'create',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        'Full name of the tag. A slash puts it below another tag, as in Trips/2026.',
      ),
    ),
    color: optionalString('color', 'Color as a hex code, such as #ff8800'),
  },
  ({ name, color }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          parts: yield* tagName(name),
          color: Option.isSome(color)
            ? yield* tagColor(color.value)
            : undefined,
        };
      }),
      ({ parts, color: chosen }) =>
        Effect.gen(function* () {
          const above = parts.slice(0, -1);
          // Immich creates one level at a time, so the tags above are made
          // first, or found when they exist.
          const parent =
            above.length === 0
              ? undefined
              : (yield* requestJson(
                  {
                    method: 'PUT',
                    path: '/tags',
                    body: { tags: [above.join('/')] },
                  },
                  UpsertedTagSchema,
                ))[0];
          const tag = yield* requestJson(
            {
              method: 'POST',
              path: '/tags',
              body: {
                name: parts.at(-1),
                ...(parent === undefined ? {} : { parentId: parent.id }),
                ...(chosen === undefined ? {} : { color: chosen }),
              },
            },
            TagSchema,
          );
          return summarizeTag(tag);
        }),
    ),
).pipe(
  Command.withDescription(
    'Create a tag, and the tags above it that do not exist yet. Fails when the tag exists.',
  ),
);

const newLastPart = (value: string) => {
  const name = value.trim();
  if (name === '') {
    return fail('A tag needs a name.');
  }
  return name.includes('/')
    ? fail(
        '--name is only the last part of the name, without a slash. A tag cannot move below another tag.',
      )
    : Effect.succeed(name);
};

const update = Command.make(
  'update',
  {
    tag: tagArgument,
    name: optionalString(
      'name',
      'New last part of the name. The tag stays below the same tag, and the tags below it follow.',
    ),
    color: optionalString(
      'color',
      'New color as a hex code, such as #ff8800; an empty one removes it',
    ),
  },
  ({ tag, name, color }) =>
    runImmich(
      Effect.gen(function* () {
        const changes = {
          ...(Option.isSome(name)
            ? { name: yield* newLastPart(name.value) }
            : {}),
          ...(Option.isSome(color)
            ? {
                color:
                  color.value.trim() === ''
                    ? null
                    : yield* tagColor(color.value),
              }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail('Nothing to change. Pass --name or --color.');
        }
        return { wanted: yield* tagReference(tag), changes };
      }),
      ({ wanted, changes }) =>
        Effect.gen(function* () {
          const { tag: found } = yield* resolveTag(wanted);
          const updated = yield* requestJson(
            { method: 'PUT', path: `/tags/${found.id}`, body: changes },
            TagSchema,
          );
          return summarizeTag(updated);
        }),
    ),
).pipe(
  Command.withDescription(
    'Rename a tag or change its color. Its photos keep it.',
  ),
);

/** Every photo that carries a tag, page by page. */
const taggedAssetIds = (tagId: string) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let cursor: string | undefined;
    do {
      const { assets } = yield* requestJson(
        taggedPhotosRequest(tagId, maxPage, cursor),
        TaggedPhotosSchema,
      );
      ids.push(...assets.items.map(({ id }) => id));
      cursor = assets.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return ids;
  });

const deleteTag = Command.make('delete', { tag: tagArgument }, ({ tag }) =>
  runImmich(tagReference(tag), (wanted) =>
    Effect.gen(function* () {
      const { tag: found, all } = yield* resolveTag(wanted);
      // Immich deletes the tags below a tag along with it, so those go first,
      // one by one, each with its own list of photos.
      const below = tagsBelow(all, found);
      if (below.length > 0) {
        return yield* fail(
          `${found.value} has tags below it: ${below.map(({ value }) => value).join(', ')}. Delete those first.`,
        );
      }
      const assetIds = yield* taggedAssetIds(found.id);
      yield* requestNothing({ method: 'DELETE', path: `/tags/${found.id}` });
      return {
        deleted: summarizeTag(found),
        assetIds,
        note: 'The photos stay in the library; only the tag is gone from them. To bring the tag back, run `photos tags create` with its name and `photos tags add` with these asset ids.',
      };
    }),
  ),
).pipe(
  Command.withDescription(
    'Delete a tag that has no tags below it. Its photos stay in the library and only lose the tag; the output lists them, so the tag can be put back.',
  ),
);

const tagAndAssets = (tag: string, assets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return { wanted: yield* tagReference(tag), ids: yield* validIds(assets) };
  });

const changeAssets =
  (method: 'PUT' | 'DELETE') =>
  ({
    wanted,
    ids,
  }: {
    readonly wanted: string;
    readonly ids: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const { tag } = yield* resolveTag(wanted);
      const results = yield* requestJson(
        { method, path: `/tags/${tag.id}/assets`, body: { ids } },
        BulkResultSchema,
      );
      return { tag: summarizeTag(tag), ...splitResults(results) };
    });

const add = Command.make(
  'add',
  { tag: tagArgument, assets: idsArgument('asset', 'Asset ids') },
  ({ tag, assets }) =>
    runImmich(tagAndAssets(tag, assets), (input) =>
      changeAssets('PUT')(input).pipe(
        Effect.map(({ tag: tagged, changed, unchanged }) => ({
          tag: tagged,
          added: changed,
          unchanged,
        })),
      ),
    ),
).pipe(
  Command.withDescription(
    'Tag photos. Photos that already have the tag are listed as unchanged.',
  ),
);

const remove = Command.make(
  'remove',
  { tag: tagArgument, assets: idsArgument('asset', 'Asset ids') },
  ({ tag, assets }) =>
    runImmich(tagAndAssets(tag, assets), (input) =>
      changeAssets('DELETE')(input).pipe(
        Effect.map(({ tag: tagged, changed, unchanged }) => ({
          tag: tagged,
          removed: changed,
          unchanged,
        })),
      ),
    ),
).pipe(
  Command.withDescription(
    'Take a tag off photos. Photos without the tag are listed as unchanged. The photos stay in the library.',
  ),
);

export const tags = Command.make('tags').pipe(
  Command.withDescription(
    'List, create, rename and delete tags, and tag photos. To find the photos with a tag, use `photos search --tag`.',
  ),
  Command.withSubcommands([list, create, update, deleteTag, add, remove]),
);
