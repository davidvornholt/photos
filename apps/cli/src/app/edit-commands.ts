import { Effect } from 'effect';
import { Command } from 'effect/cli';
import { browsable, getAsset } from '../features/assets/library.ts';
import { requestJson, requestNothing } from '../shared/immich.ts';
import {
  idArgument,
  optionalInt,
  optionalString,
  validId,
} from './command-inputs.ts';
import {
  cropFits,
  DimensionsSchema,
  type Edit,
  EditsSchema,
  flat,
  mergeEdits,
  originalSize,
  sameEdits,
  wantedEdits,
} from './edit-actions.ts';
import { runImmich } from './root.ts';

const keepsOriginal =
  'Immich keeps the original file as it is and shows the edited version in its place.';

const editsOf = (id: string) =>
  requestJson({ method: 'GET', path: `/assets/${id}/edits` }, EditsSchema).pipe(
    Effect.map((found) => found.edits),
  );

/** The photo, refused if a person browsing the library would not see it, and its size. */
const editable = (id: string) =>
  Effect.gen(function* () {
    yield* browsable([yield* getAsset(id)]);
    const dimensions = yield* requestJson(
      { method: 'GET', path: `/assets/${id}` },
      DimensionsSchema,
    );
    return originalSize(dimensions);
  });

/** Writes the whole list, which replaces what Immich had; an empty one clears it. */
const saveEdits = (id: string, list: ReadonlyArray<Edit>) =>
  list.length === 0
    ? requestNothing({ method: 'DELETE', path: `/assets/${id}/edits` }).pipe(
        Effect.as<ReadonlyArray<Edit>>([]),
      )
    : requestJson(
        { method: 'PUT', path: `/assets/${id}/edits`, body: { edits: list } },
        EditsSchema,
      ).pipe(Effect.map((saved) => saved.edits));

const show = Command.make(
  'show',
  { asset: idArgument('asset', 'Asset id') },
  ({ asset }) =>
    runImmich(validId(asset), (id) =>
      Effect.gen(function* () {
        const original = yield* editable(id);
        const edits = yield* editsOf(id);
        return { assetId: id, original, edits: edits.map(flat) };
      }),
    ),
).pipe(
  Command.withDescription(
    `Show how a photo is edited in Immich: its crop, rotation and mirroring, in the order Immich applies them, and the size of the photo without edits, which a crop is measured in. ${keepsOriginal}`,
  ),
);

const apply = Command.make(
  'apply',
  {
    asset: idArgument('asset', 'Asset id'),
    crop: optionalString(
      'crop',
      'The part to keep, as x,y,width,height in pixels of the photo without edits (see `photos edits show`), or none to show all of it again',
    ),
    rotate: optionalInt(
      'rotate',
      'The rotation clockwise from the original: 0, 90, 180 or 270. It is not added to the current one.',
    ),
    mirror: optionalString(
      'mirror',
      'The mirroring: horizontal (left and right swap), vertical (top and bottom swap), both, or none',
    ),
  },
  (options) =>
    runImmich(
      Effect.gen(function* () {
        return {
          id: yield* validId(options.asset),
          wanted: yield* wantedEdits(options),
        };
      }),
      ({ id, wanted }) =>
        Effect.gen(function* () {
          const size = yield* editable(id);
          const previous = yield* editsOf(id);
          const merged = mergeEdits(previous, wanted);
          if (sameEdits(previous, merged)) {
            return {
              assetId: id,
              changed: false,
              edits: previous.map(flat),
              previous: previous.map(flat),
              note: 'The photo is already edited this way, so nothing was sent.',
            };
          }
          yield* cropFits(merged, size);
          const saved = yield* saveEdits(id, merged);
          return {
            assetId: id,
            changed: true,
            edits: saved.map(flat),
            previous: previous.map(flat),
            note: `${keepsOriginal} Its previews are redrawn in the background. \`photos edits reset\` undoes every edit.`,
          };
        }),
    ),
).pipe(
  Command.withDescription(
    `Crop, rotate or mirror a photo. Each flag sets one of the three and leaves the others as they are, so earlier edits stay unless their own flag changes them; --crop none, --rotate 0 and --mirror none remove one. Prints the edits before and after. ${keepsOriginal} Only photos can be edited, not videos, live photos, panoramas, GIFs or SVGs.`,
  ),
);

const reset = Command.make(
  'reset',
  { asset: idArgument('asset', 'Asset id') },
  ({ asset }) =>
    runImmich(validId(asset), (id) =>
      Effect.gen(function* () {
        yield* editable(id);
        const removed = yield* editsOf(id);
        if (removed.length > 0) {
          yield* saveEdits(id, []);
        }
        return {
          assetId: id,
          removed: removed.map(flat),
          note:
            removed.length === 0
              ? 'The photo had no edits, so nothing was sent.'
              : 'The photo shows as it was uploaded again. The original file was never changed. The removed edits are listed, to apply them again with `photos edits apply`.',
        };
      }),
    ),
).pipe(
  Command.withDescription(
    `Remove every edit of a photo, so it shows as it was uploaded. ${keepsOriginal} Prints the edits it removed.`,
  ),
);

export const edits = Command.make('edits').pipe(
  Command.withDescription(
    `See, change and undo how photos are cropped, rotated and mirrored in Immich. ${keepsOriginal}`,
  ),
  Command.withSubcommands([show, apply, reset]),
);
