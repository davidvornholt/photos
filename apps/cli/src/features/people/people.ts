import { Schema } from 'effect';

/**
 * A person as Immich answers it. Immich also sends the server path of the
 * person's thumbnail and whom the person is shared with; photos leaves both
 * out.
 */
export const PersonSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  birthDate: Schema.optional(Schema.NullOr(Schema.String)),
  isHidden: Schema.Boolean,
  isFavorite: Schema.optional(Schema.Boolean),
});
export type Person = typeof PersonSchema.Type;

/** One page of people. `total` and `hidden` count every match, not the page. */
export const PeoplePageSchema = Schema.Struct({
  people: Schema.Array(PersonSchema),
  total: Schema.Number,
  hidden: Schema.Number,
  hasNextPage: Schema.optional(Schema.Boolean),
});

/** How many photos and videos show a person. */
export const StatisticsSchema = Schema.Struct({ assets: Schema.Number });

/** A person's name, or null for one facial recognition found but nobody named. */
export const nameOf = (person: Person) =>
  person.name.trim() === '' ? null : person.name.trim();

export const summarizePerson = (person: Person) => ({
  id: person.id,
  name: nameOf(person),
  birthDate: person.birthDate ?? null,
  hidden: person.isHidden,
  favorite: person.isFavorite ?? false,
});

/**
 * A face on a photo. The box is in pixels of an image `imageWidth` by
 * `imageHeight` in size, which need not be the size of any file.
 */
export const FaceSchema = Schema.Struct({
  id: Schema.String,
  boundingBoxX1: Schema.Number,
  boundingBoxY1: Schema.Number,
  boundingBoxX2: Schema.Number,
  boundingBoxY2: Schema.Number,
  imageWidth: Schema.Number,
  imageHeight: Schema.Number,
  person: Schema.optional(Schema.NullOr(PersonSchema)),
  // machine-learning, exif or manual.
  sourceType: Schema.optional(Schema.String),
});
export type Face = typeof FaceSchema.Type;

export const FaceListSchema = Schema.Array(FaceSchema);

/**
 * Where a face is, in fractions of the photo's width and height, so the same
 * numbers fit the preview at any size.
 */
export type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

// Four places tell apart a tenth of a pixel on a photo 4000 pixels wide.
const boxDigits = 4;

const fraction = (value: number, whole: number) =>
  whole > 0 ? Number((value / whole).toFixed(boxDigits)) : 0;

export const summarizeFace = (face: Face) => ({
  id: face.id,
  person:
    face.person === undefined || face.person === null
      ? null
      : { id: face.person.id, name: nameOf(face.person) },
  box: {
    left: fraction(face.boundingBoxX1, face.imageWidth),
    top: fraction(face.boundingBoxY1, face.imageHeight),
    width: fraction(face.boundingBoxX2 - face.boundingBoxX1, face.imageWidth),
    height: fraction(face.boundingBoxY2 - face.boundingBoxY1, face.imageHeight),
  },
  source: face.sourceType ?? null,
});

/**
 * A box in pixels of an image of the given size, as Immich takes it for a new
 * face. Immich reads the pixels against the photo as it is shown, with its
 * edits, so the size is the photo's own.
 */
export const boxInPixels = (
  box: Box,
  size: { readonly width: number; readonly height: number },
) => {
  const x = Math.round(box.left * size.width);
  const y = Math.round(box.top * size.height);
  return {
    x,
    y,
    width: Math.max(
      1,
      Math.min(size.width - x, Math.round(box.width * size.width)),
    ),
    height: Math.max(
      1,
      Math.min(size.height - y, Math.round(box.height * size.height)),
    ),
    imageWidth: size.width,
    imageHeight: size.height,
  };
};
