import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { saveFace } from '../features/assets/files.ts';
import { maxPage } from '../features/assets/library.ts';
import {
  getPerson,
  personAssetIds,
  personWithCount,
} from '../features/people/library.ts';
import {
  nameOf,
  PeoplePageSchema,
  PersonSchema,
  summarizePerson,
} from '../features/people/people.ts';
import { BulkResultSchema, splitResults } from '../shared/bulk.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  bounded,
  choice,
  fail,
  flag,
  idArgument,
  idsArgument,
  optionalInt,
  optionalString,
  pageSize,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

const peoplePageDefault = 100;
// Enough to look at a handful of people quickly without crowding the server.
const lookupConcurrency = 4;

const personName = (value: string) => {
  const name = value.trim();
  return name === '' ? fail('A person needs a name.') : Effect.succeed(name);
};

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

/** A birthday as YYYY-MM-DD, or null for an empty value, which removes it. */
const birthDate = (value: string) => {
  const day = value.trim();
  if (day === '') {
    return Effect.succeed(null);
  }
  const parsed = new Date(`${day}T00:00:00Z`);
  return dayPattern.test(day) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(day)
    ? Effect.succeed(day)
    : fail(
        `--birth-date ${value} is not a day. Use YYYY-MM-DD, or an empty value to remove it.`,
      );
};

const flagValue = (value: boolean | undefined) =>
  value === undefined ? undefined : String(value);

const list = Command.make(
  'list',
  {
    name: optionalString(
      'name',
      'Only people whose name is like this. Immich matches loosely, ignoring accents and small differences.',
    ),
    withHidden: flag(
      'with-hidden',
      'Also list the people hidden in Immich, after the others',
    ),
    favorite: choice(
      'favorite',
      'Only favorites, or with --no-favorite only the rest',
    ),
    like: optionalString(
      'like',
      'Sort by how much each face looks like this person (person id), most alike first, to find one person that Immich split in two',
    ),
    limit: optionalInt(
      'limit',
      `How many people (default ${peoplePageDefault}, at most ${maxPage})`,
    ),
    page: optionalInt('page', 'The nextPage of the previous page'),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const name = Option.getOrUndefined(
          Option.filter(
            Option.map(flags.name, (text) => text.trim()),
            (text) => text !== '',
          ),
        );
        return {
          name,
          withHidden: flags.withHidden,
          favorite: Option.getOrUndefined(flags.favorite),
          like: Option.isSome(flags.like)
            ? yield* validId(flags.like.value)
            : undefined,
          size: yield* pageSize(flags.limit, peoplePageDefault),
          page: yield* bounded('page', flags.page, {
            fallback: 1,
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
        };
      }),
      (input) =>
        requestJson(
          {
            method: 'GET',
            path: '/people',
            query: {
              name: input.name,
              withHidden: input.withHidden ? 'true' : undefined,
              isFavorite: flagValue(input.favorite),
              closestPersonId: input.like,
              page: String(input.page),
              size: String(input.size),
            },
          },
          PeoplePageSchema,
        ).pipe(
          Effect.map((result) => ({
            total: result.total,
            hidden: result.hidden,
            page: input.page,
            nextPage:
              (result.hasNextPage ?? result.people.length === input.size)
                ? input.page + 1
                : null,
            people: result.people.map(summarizePerson),
          })),
        ),
    ),
).pipe(
  Command.withDescription(
    'List the people Immich recognized in the photos: favorites first, then named ones, then by how often they appear. Leaves out hidden people unless asked, and unnamed ones Immich saw too rarely. total and hidden count every match, hidden ones included.',
  ),
);

const show = Command.make(
  'show',
  { ids: idsArgument('person', 'Person ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.forEach(valid, personWithCount, {
        concurrency: lookupConcurrency,
      }),
    ),
).pipe(
  Command.withDescription(
    'Show people: name, birth date, whether hidden or a favorite, and how many photos and videos show them. `photos search --person <id>` lists those photos.',
  ),
);

const preview = Command.make(
  'preview',
  { ids: idsArgument('person', 'Person ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.forEach(
        valid,
        (id) => Effect.map(saveFace(id), (path) => ({ id, path })),
        { concurrency: lookupConcurrency },
      ),
    ),
).pipe(
  Command.withDescription(
    "Save the picture of each person's face that Immich shows for them to a private temporary directory and print its path, to look at it",
  ),
);

const create = Command.make(
  'create',
  {
    name: Flag.String('name').pipe(Flag.withDescription('Their name')),
    birthDate: optionalString('birth-date', 'Their birthday as YYYY-MM-DD'),
  },
  ({ name, birthDate: birthday }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          name: yield* personName(name),
          ...(Option.isSome(birthday)
            ? { birthDate: yield* birthDate(birthday.value) }
            : {}),
        };
      }),
      (body) =>
        requestJson(
          { method: 'POST', path: '/people', body },
          PersonSchema,
        ).pipe(Effect.map(summarizePerson)),
    ),
).pipe(
  Command.withDescription(
    'Add a person whom facial recognition did not find, with no faces yet. Give them a face right away with `photos faces assign` or `photos faces add`: Immich removes people without faces every night.',
  ),
);

const update = Command.make(
  'update',
  {
    id: idArgument('person', 'Person id'),
    name: optionalString('name', 'New name'),
    birthDate: optionalString(
      'birth-date',
      'Birthday as YYYY-MM-DD; an empty one removes it',
    ),
    hidden: choice(
      'hidden',
      'Hide them from the people Immich lists, or with --no-hidden list them again. Their photos stay where they are.',
    ),
    favorite: choice(
      'favorite',
      'Make them a favorite, or with --no-favorite no longer',
    ),
    cover: optionalString(
      'cover',
      'Asset id of a photo showing them; their face on it becomes the picture Immich shows for them',
    ),
  },
  (flags) =>
    runImmich(
      Effect.gen(function* () {
        const changes = {
          ...(Option.isSome(flags.name)
            ? { name: yield* personName(flags.name.value) }
            : {}),
          ...(Option.isSome(flags.birthDate)
            ? { birthDate: yield* birthDate(flags.birthDate.value) }
            : {}),
          ...(Option.isSome(flags.hidden)
            ? { isHidden: flags.hidden.value }
            : {}),
          ...(Option.isSome(flags.favorite)
            ? { isFavorite: flags.favorite.value }
            : {}),
          ...(Option.isSome(flags.cover)
            ? { featureFaceAssetId: yield* validId(flags.cover.value) }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          return yield* fail(
            'Nothing to change. Pass --name, --birth-date, --hidden, --favorite or --cover, or their --no- forms.',
          );
        }
        return { id: yield* validId(flags.id), changes };
      }),
      ({ id, changes }) =>
        requestJson(
          { method: 'PUT', path: `/people/${id}`, body: changes },
          PersonSchema,
        ).pipe(Effect.map(summarizePerson)),
    ),
).pipe(
  Command.withDescription(
    'Name or rename a person, set their birthday, hide them, make them a favorite, or choose the photo their picture comes from. A new picture is made in the background, so `photos people preview` may show the old one for a minute.',
  ),
);

const merge = Command.make(
  'merge',
  {
    id: idArgument('person', 'The person to keep'),
    others: idsArgument(
      'other',
      'People who are really the same person; they are merged into the first one and removed',
    ),
  },
  ({ id, others }) =>
    runImmich(
      Effect.gen(function* () {
        const keep = yield* validId(id);
        const merged = yield* validIds(others);
        if (merged.includes(keep)) {
          return yield* fail(
            'A person cannot be merged into themselves. Name the person to keep first and only once.',
          );
        }
        return { keep, merged };
      }),
      ({ keep, merged }) =>
        Effect.gen(function* () {
          // Immich keeps the first of the people it finds, so a missing first
          // person would make the next one the person kept. Looking each up
          // first refuses that.
          const before = yield* Effect.forEach([keep, ...merged], getPerson, {
            concurrency: lookupConcurrency,
          });
          const names = new Map(
            before.map((person) => [person.id, nameOf(person)]),
          );
          const results = yield* requestJson(
            {
              method: 'POST',
              path: '/people/merge',
              body: { ids: [keep, ...merged] },
            },
            BulkResultSchema,
          );
          const { changed, unchanged } = splitResults(
            results.filter((result) => result.id !== keep),
          );
          return {
            person: yield* personWithCount(keep),
            merged: changed.map((other) => ({
              id: other,
              name: names.get(other) ?? null,
            })),
            notMerged: unchanged,
          };
        }),
    ),
).pipe(
  Command.withDescription(
    'Merge people who are the same person into the first one: their faces move to it and they are removed. The first keeps their name and birth date; what it lacks comes from the others, in order. Cannot be undone.',
  ),
);

const deletePeople = Command.make(
  'delete',
  { ids: idsArgument('person', 'Person ids') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.gen(function* () {
        const people = yield* Effect.forEach(
          valid,
          (personId) =>
            Effect.all([getPerson(personId), personAssetIds(personId)]).pipe(
              Effect.map(([person, assetIds]) => ({
                ...summarizePerson(person),
                assetIds,
              })),
            ),
          { concurrency: lookupConcurrency },
        );
        yield* requestNothing({
          method: 'DELETE',
          path: '/people',
          body: { ids: valid },
        });
        return {
          deleted: people,
          note: 'The photos stay, and so do the faces in them, which now belong to nobody. To make a person again, run `photos people create`, then `photos faces list` on these photos and `photos faces assign` for their faces.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    "Delete people. Their photos stay, and so do the faces in them, which then belong to nobody until facial recognition, when it next runs, may group them into a new unnamed person. The output lists each person's photos, so they can be made again. To keep someone but stop seeing them, use `photos people update --hidden`.",
  ),
);

export const people = Command.make('people').pipe(
  Command.withDescription(
    'List, look at, name, merge and delete the people Immich recognized in the photos',
  ),
  Command.withSubcommands([
    list,
    show,
    preview,
    create,
    update,
    merge,
    deletePeople,
  ]),
);
