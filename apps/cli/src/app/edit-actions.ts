import { Effect, Option, Schema } from 'effect';
import { fail } from './command-inputs.ts';

const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

const axes = ['horizontal', 'vertical'] as const;
type Axis = (typeof axes)[number];

// Immich turns a photo clockwise by whole quarter turns.
const quarterTurn = 90;
const fullTurn = 360;

const CropSchema = Schema.Struct({
  action: Schema.Literal('crop'),
  parameters: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});

const RotateSchema = Schema.Struct({
  action: Schema.Literal('rotate'),
  parameters: Schema.Struct({ angle: Schema.Number }),
});

const MirrorSchema = Schema.Struct({
  action: Schema.Literal('mirror'),
  parameters: Schema.Struct({ axis: Schema.Literals(axes) }),
});

/**
 * The edits Immich keeps for a photo, in the order it applies them. An edit
 * of a kind photos does not know fails the decoding, so photos never writes
 * back a list that has lost it.
 */
export const EditsSchema = Schema.Struct({
  assetId: Schema.String,
  edits: Schema.Array(Schema.Union([CropSchema, RotateSchema, MirrorSchema])),
});
export type Edit = (typeof EditsSchema.Type)['edits'][number];
type Crop = (typeof CropSchema.Type)['parameters'];

/** The EXIF fields that size the photo the way Immich checks a crop. */
export const DimensionsSchema = Schema.Struct({
  exifInfo: Schema.optional(
    Schema.Struct({
      exifImageWidth: nullable(Schema.Number),
      exifImageHeight: nullable(Schema.Number),
      orientation: nullable(Schema.String),
    }),
  ),
});

// EXIF orientations 5 to 8 stand the picture on its side, and Immich also
// takes -90 and 90 for that, so its width and height trade places, as in
// Immich's own `getDimensions`.
const sideways = new Set(['5', '6', '7', '8', '-90', '90']);

/** The photo's size as it shows without edits, which a crop is measured in. */
export const originalSize = ({ exifInfo }: typeof DimensionsSchema.Type) => {
  const width = exifInfo?.exifImageWidth ?? 0;
  const height = exifInfo?.exifImageHeight ?? 0;
  if (width === 0 || height === 0) {
    return null;
  }
  return sideways.has(String(Number(exifInfo?.orientation)))
    ? { width: height, height: width }
    : { width, height };
};

/** An edit as photos prints it: the action with its values beside it. */
export const flat = (edit: Edit) => ({
  action: edit.action,
  ...edit.parameters,
});

/** What `photos edits apply` sets; anything left out stays as it is. */
export type Wanted = {
  /** The part to keep, or null to show the whole photo again. */
  readonly crop?: Crop | null;
  /** Clockwise from the original, in degrees. */
  readonly rotate?: number;
  /** The axes to mirror on; none means not mirrored. */
  readonly mirror?: ReadonlyArray<Axis>;
};

const cropPattern =
  /^\s*(?<x>\d+)\s*,\s*(?<y>\d+)\s*,\s*(?<width>\d+)\s*,\s*(?<height>\d+)\s*$/u;

export const parseCrop = (value: string) => {
  if (value.trim().toLowerCase() === 'none') {
    return Effect.succeed(null);
  }
  const groups = cropPattern.exec(value)?.groups;
  const crop = groups && {
    x: Number(groups.x),
    y: Number(groups.y),
    width: Number(groups.width),
    height: Number(groups.height),
  };
  return crop === undefined || crop.width < 1 || crop.height < 1
    ? fail(
        `--crop ${value} is not a crop. Give x,y,width,height in whole pixels, such as 0,0,3000,2000, with a width and height of at least 1, or none.`,
      )
    : Effect.succeed(crop);
};

export const parseRotate = (value: number) =>
  value >= 0 && value < fullTurn && value % quarterTurn === 0
    ? Effect.succeed(value)
    : fail(`--rotate must be 0, 90, 180 or 270, not ${value}.`);

const mirrorChoices: Readonly<Record<string, ReadonlyArray<Axis>>> = {
  horizontal: ['horizontal'],
  vertical: ['vertical'],
  both: ['horizontal', 'vertical'],
  none: [],
};

export const parseMirror = (value: string) => {
  const axesWanted = mirrorChoices[value.trim().toLowerCase()];
  return axesWanted === undefined
    ? fail(`--mirror must be horizontal, vertical, both or none, not ${value}.`)
    : Effect.succeed(axesWanted);
};

/** The flags of `photos edits apply`, checked. */
export const wantedEdits = (options: {
  readonly crop: Option.Option<string>;
  readonly rotate: Option.Option<number>;
  readonly mirror: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const wanted: Wanted = {
      ...(Option.isSome(options.crop)
        ? { crop: yield* parseCrop(options.crop.value) }
        : {}),
      ...(Option.isSome(options.rotate)
        ? { rotate: yield* parseRotate(options.rotate.value) }
        : {}),
      ...(Option.isSome(options.mirror)
        ? { mirror: yield* parseMirror(options.mirror.value) }
        : {}),
    };
    return Object.keys(wanted).length === 0
      ? yield* fail('Nothing to change. Pass --crop, --rotate or --mirror.')
      : wanted;
  });

const rotation = (angle: number): Edit => ({
  action: 'rotate',
  parameters: { angle },
});

const mirroring = (axis: Axis): Edit => ({
  action: 'mirror',
  parameters: { axis },
});

const keeps = (edit: Edit, wanted: Wanted) => {
  if (edit.action === 'crop') {
    return wanted.crop === undefined;
  }
  if (edit.action === 'rotate') {
    return wanted.rotate === undefined;
  }
  return (
    wanted.mirror === undefined || wanted.mirror.includes(edit.parameters.axis)
  );
};

/**
 * The photo's edits once `wanted` is applied to them. Each flag sets one
 * thing, the crop, the rotation or the mirroring, and leaves the others
 * as they were, so no earlier edit is lost by leaving its flag out. A changed
 * edit keeps its place; a new one goes where Immich's own editor puts it:
 * the crop first (Immich requires it), then the mirroring, then the rotation.
 */
export const mergeEdits = (
  current: ReadonlyArray<Edit>,
  wanted: Wanted,
): ReadonlyArray<Edit> => {
  const edits = current.flatMap((edit): Array<Edit> => {
    if (keeps(edit, wanted)) {
      return [edit];
    }
    return edit.action === 'rotate' && wanted.rotate !== 0
      ? [rotation(wanted.rotate ?? 0)]
      : [];
  });
  if (wanted.crop !== undefined && wanted.crop !== null) {
    edits.unshift({ action: 'crop', parameters: wanted.crop });
  }
  for (const axis of wanted.mirror ?? []) {
    const mirrored = edits.some(
      (edit) => edit.action === 'mirror' && edit.parameters.axis === axis,
    );
    if (!mirrored) {
      const rotateAt = edits.findIndex((edit) => edit.action === 'rotate');
      edits.splice(
        rotateAt === -1 ? edits.length : rotateAt,
        0,
        mirroring(axis),
      );
    }
  }
  const rotated = edits.some((edit) => edit.action === 'rotate');
  if (wanted.rotate !== undefined && wanted.rotate !== 0 && !rotated) {
    edits.push(rotation(wanted.rotate));
  }
  return edits;
};

/** Whether two lists of edits say the same, in the same order. */
export const sameEdits = (
  left: ReadonlyArray<Edit>,
  right: ReadonlyArray<Edit>,
) =>
  left.length === right.length &&
  left.every((edit, index) => {
    const mine: Readonly<Record<string, unknown>> = flat(edit);
    const other = right[index];
    if (other === undefined) {
      return false;
    }
    const theirs: Readonly<Record<string, unknown>> = flat(other);
    const keys = Object.keys(mine);
    return (
      keys.length === Object.keys(theirs).length &&
      keys.every((key) => mine[key] === theirs[key])
    );
  });

/** Refuses a crop that reaches past the photo, before Immich does it vaguely. */
export const cropFits = (
  edits: ReadonlyArray<Edit>,
  size: { readonly width: number; readonly height: number } | null,
) => {
  const crop = edits.find((edit) => edit.action === 'crop');
  if (crop === undefined || crop.action !== 'crop') {
    return Effect.void;
  }
  if (size === null) {
    return fail(
      'Immich does not know the size of this photo, so it cannot be cropped.',
    );
  }
  const { x, y, width, height } = crop.parameters;
  return x + width > size.width || y + height > size.height
    ? fail(
        `The crop reaches past the photo, which is ${size.width}×${size.height} pixels as it shows without edits. Keep x + width within ${size.width} and y + height within ${size.height}.`,
      )
    : Effect.void;
};
