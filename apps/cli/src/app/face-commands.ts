import { Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import { getAsset } from '../features/assets/library.ts';
import {
  type Box,
  boxInPixels,
  FaceListSchema,
  PersonSchema,
  summarizeFace,
  summarizePerson,
} from '../features/people/people.ts';
import { InvalidInput } from '../shared/errors/errors.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  fail,
  idArgument,
  idsArgument,
  validId,
  validIds,
} from './command-inputs.ts';
import { runImmich } from './root.ts';

/** The faces on a photo, each with its person and box. */
const facesOn = (assetId: string) =>
  requestJson(
    { method: 'GET', path: '/faces', query: { id: assetId } },
    FaceListSchema,
  ).pipe(Effect.map((found) => ({ assetId, faces: found.map(summarizeFace) })));

const boxHelp =
  "left,top,width,height in fractions of the photo's width and height, from 0 to 1, such as 0.42,0.18,0.12,0.16";

const boxParts = 4;
// Fractions an agent adds up, such as 0.7 and 0.3, may pass 1 by a rounding
// error; that much is let through, since the pixels are kept on the photo.
const tolerance = 1e-9;

const parseBox = (value: string) => {
  const parts = value.split(',').map((part) => part.trim());
  const [left, top, width, height] = parts.map(Number);
  if (
    parts.length !== boxParts ||
    parts.includes('') ||
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined ||
    ![left, top, width, height].every(Number.isFinite)
  ) {
    return fail(`--box ${value} is not a box. Give ${boxHelp}.`);
  }
  if (
    left < 0 ||
    top < 0 ||
    width <= 0 ||
    height <= 0 ||
    left + width > 1 + tolerance ||
    top + height > 1 + tolerance
  ) {
    return fail(
      `--box ${value} reaches outside the photo. left and top are at least 0, width and height more than 0, and left plus width and top plus height at most 1.`,
    );
  }
  const box: Box = { left, top, width, height };
  return Effect.succeed(box);
};

const list = Command.make(
  'list',
  { asset: idArgument('asset', 'Asset id of the photo') },
  ({ asset }) => runImmich(validId(asset), facesOn),
).pipe(
  Command.withDescription(
    "List the faces on a photo, each with the person it belongs to (null for nobody), where it came from (machine-learning, exif or manual), and its box: left, top, width and height in fractions of the photo's width and height as its preview shows it.",
  ),
);

const assign = Command.make(
  'assign',
  {
    face: idArgument('face', 'Face id from `photos faces list`'),
    person: idArgument('person', 'Person id'),
  },
  ({ face, person }) =>
    runImmich(
      Effect.all({ face: validId(face), person: validId(person) }),
      (ids) =>
        requestJson(
          {
            method: 'PUT',
            path: `/faces/${ids.person}`,
            body: { id: ids.face },
          },
          PersonSchema,
        ).pipe(
          Effect.map((now) => ({
            face: ids.face,
            person: summarizePerson(now),
          })),
        ),
    ),
).pipe(
  Command.withDescription(
    "Give a face to a person, taking it from whoever had it. Immich's nightly cleanup removes a person left without faces.",
  ),
);

const add = Command.make(
  'add',
  {
    asset: idArgument('asset', 'Asset id of the photo'),
    person: Flag.String('person').pipe(
      Flag.withDescription('Person id of whose face it is'),
    ),
    box: Flag.String('box').pipe(
      Flag.withDescription(
        `Where the face is: ${boxHelp}. Measure it on the preview from \`photos preview\`; \`photos faces list\` prints boxes the same way.`,
      ),
    ),
  },
  ({ asset, person, box }) =>
    runImmich(
      Effect.gen(function* () {
        return {
          assetId: yield* validId(asset),
          personId: yield* validId(person),
          box: yield* parseBox(box),
        };
      }),
      ({ assetId, personId, box: chosen }) =>
        Effect.gen(function* () {
          const photo = yield* getAsset(assetId);
          const { width, height } = photo;
          if (
            width === undefined ||
            width === null ||
            height === undefined ||
            height === null
          ) {
            return yield* new InvalidInput({
              message: `Immich does not know the size of ${assetId} yet, so the box cannot be placed. Try again once Immich has processed the photo.`,
            });
          }
          yield* requestNothing({
            method: 'POST',
            path: '/faces',
            body: {
              assetId,
              personId,
              ...boxInPixels(chosen, { width, height }),
            },
          });
          return yield* facesOn(assetId);
        }),
    ),
).pipe(
  Command.withDescription(
    'Mark a face on a photo that facial recognition missed, and give it to a person. Prints the faces on the photo afterwards.',
  ),
);

const deleteFaces = Command.make(
  'delete',
  { ids: idsArgument('face', 'Face ids from `photos faces list`') },
  ({ ids }) =>
    runImmich(validIds(ids), (valid) =>
      Effect.gen(function* () {
        // Immich can also erase a face for good (force); photos never asks
        // for that, so a face deleted by mistake stays in Immich's database.
        yield* Effect.forEach(valid, (faceId) =>
          requestNothing({
            method: 'DELETE',
            path: `/faces/${faceId}`,
            body: { force: false },
          }),
        );
        return {
          deleted: valid,
          note: 'The photos stay. photos cannot bring a deleted face back; `photos faces add` can mark it again.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    "Delete faces that are wrong, such as a face on a poster or a pattern taken for one. The photo stays, and the face no longer counts for its person. Immich marks the face deleted instead of erasing it, but nothing brings it back; `photos faces add` can mark it again. Immich's nightly cleanup removes a person left without faces.",
  ),
);

export const faces = Command.make('faces').pipe(
  Command.withDescription(
    'List the faces on a photo, give them to people, mark missed faces and delete wrong ones',
  ),
  Command.withSubcommands([list, assign, add, deleteFaces]),
);
