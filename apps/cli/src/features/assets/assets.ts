import { DateTime, Option, Schema } from 'effect';

const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/**
 * The EXIF fields photos reports. GPS coordinates are left out on purpose:
 * the place name says enough, and coordinates pin down a home.
 */
const ExifSchema = Schema.Struct({
  description: nullable(Schema.String),
  make: nullable(Schema.String),
  model: nullable(Schema.String),
  lensModel: nullable(Schema.String),
  city: nullable(Schema.String),
  state: nullable(Schema.String),
  country: nullable(Schema.String),
  timeZone: nullable(Schema.String),
  fileSizeInByte: nullable(Schema.Number),
  rating: nullable(Schema.Number),
});

export const AssetSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  originalFileName: Schema.String,
  originalMimeType: Schema.optional(Schema.String),
  fileCreatedAt: Schema.String,
  localDateTime: Schema.String,
  createdAt: Schema.String,
  width: nullable(Schema.Number),
  height: nullable(Schema.Number),
  duration: nullable(Schema.Number),
  isFavorite: Schema.Boolean,
  isArchived: Schema.Boolean,
  isTrashed: Schema.Boolean,
  // timeline, archive, hidden (the video half of a live photo) or locked.
  visibility: Schema.String,
  duplicateId: nullable(Schema.String),
  exifInfo: Schema.optional(ExifSchema),
});
export type Asset = typeof AssetSchema.Type;

export const AssetPageSchema = Schema.Struct({
  assets: Schema.Struct({
    count: Schema.Number,
    items: Schema.Array(AssetSchema),
    nextCursor: nullable(Schema.String),
  }),
});
export type AssetPage = typeof AssetPageSchema.Type;

/** How many photos a bulk change touched. */
export const CountSchema = Schema.Struct({ count: Schema.Number });

export const OcrSchema = Schema.Array(Schema.Struct({ text: Schema.String }));

export const DuplicatesSchema = Schema.Array(
  Schema.Struct({
    duplicateId: Schema.String,
    assets: Schema.Array(AssetSchema),
    suggestedKeepAssetIds: Schema.Array(Schema.String),
  }),
);

/** Whether a person browsing the library sees the asset at all. */
export const isBrowsable = (asset: Asset) =>
  asset.visibility === 'timeline' || asset.visibility === 'archive';

const minute = 60_000;
const millisecondsPerSecond = 1000;

/**
 * When the photo was taken, in the time zone it was taken in. Immich keeps the
 * instant and the local wall-clock time; their difference is the offset.
 */
export const takenAt = (asset: Asset): string => {
  const instant = DateTime.make(asset.fileCreatedAt);
  const wallClock = DateTime.make(asset.localDateTime);
  if (Option.isNone(instant) || Option.isNone(wallClock)) {
    return asset.fileCreatedAt;
  }
  const offset =
    Math.round(
      (DateTime.toEpochMillis(wallClock.value) -
        DateTime.toEpochMillis(instant.value)) /
        minute,
    ) * minute;
  return Option.match(DateTime.makeZoned(instant.value, { timeZone: offset }), {
    onNone: () => asset.fileCreatedAt,
    onSome: DateTime.formatIsoOffset,
  });
};

const text = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim() === ''
    ? null
    : value.trim();

/** What a list of photos shows of each one. */
export const summarize = (asset: Asset) => ({
  id: asset.id,
  type: asset.type.toLowerCase(),
  fileName: asset.originalFileName,
  takenAt: takenAt(asset),
  uploadedAt: asset.createdAt,
  width: asset.width ?? null,
  height: asset.height ?? null,
  ...(asset.duration === undefined || asset.duration === null
    ? {}
    : {
        durationSeconds: Number(
          (asset.duration / millisecondsPerSecond).toFixed(1),
        ),
      }),
  favorite: asset.isFavorite,
  archived: asset.isArchived,
  trashed: asset.isTrashed,
  description: text(asset.exifInfo?.description),
  duplicateId: asset.duplicateId ?? null,
});
export type AssetSummary = ReturnType<typeof summarize>;

/** Everything photos tells about one photo. */
export const describeAsset = (
  asset: Asset,
  albums: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  recognizedText: ReadonlyArray<string>,
) => {
  const exif = asset.exifInfo;
  const camera = [text(exif?.make), text(exif?.model)]
    .filter((part) => part !== null)
    .join(' ');
  const place = [text(exif?.city), text(exif?.state), text(exif?.country)]
    .filter((part) => part !== null)
    .join(', ');
  const lines = recognizedText.map((line) => line.trim()).filter(Boolean);
  return {
    ...summarize(asset),
    mimeType: asset.originalMimeType ?? null,
    fileSize: exif?.fileSizeInByte ?? null,
    camera: camera === '' ? null : camera,
    lens: text(exif?.lensModel),
    place: place === '' ? null : place,
    timeZone: text(exif?.timeZone),
    rating: exif?.rating ?? null,
    albums,
    text: lines.length === 0 ? null : lines.join('\n'),
  };
};
