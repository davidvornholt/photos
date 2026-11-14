import { Schema } from 'effect';

export const AlbumSchema = Schema.Struct({
  id: Schema.String,
  albumName: Schema.String,
  description: Schema.String,
  assetCount: Schema.Number,
  albumThumbnailAssetId: Schema.optional(Schema.NullOr(Schema.String)),
  // The first entry is always the owner.
  albumUsers: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      user: Schema.Struct({ id: Schema.String, name: Schema.String }),
    }),
  ),
  shared: Schema.Boolean,
  hasSharedLink: Schema.Boolean,
  startDate: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  order: Schema.optional(Schema.String),
});
export type Album = typeof AlbumSchema.Type;

export const AlbumListSchema = Schema.Array(AlbumSchema);

/** What Immich answers for each id when photos are added to or removed from an album. */
export const BulkResultSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
);
export type BulkResult = typeof BulkResultSchema.Type;

// The day part of an album's first or last photo. Immich keeps the wall-clock
// time there, marked as UTC, and sometimes only the day, so the day is all
// that can be trusted.
const dayLength = 'YYYY-MM-DD'.length;
const day = (value: string | undefined) => value?.slice(0, dayLength) ?? null;

export const summarizeAlbum = (album: Album) => ({
  id: album.id,
  name: album.albumName,
  description: album.description.trim() === '' ? null : album.description,
  assetCount: album.assetCount,
  owner: album.albumUsers[0]?.user.name ?? null,
  shared: album.shared,
  sharedLink: album.hasSharedLink,
  coverAssetId: album.albumThumbnailAssetId ?? null,
  firstTakenOn: day(album.startDate),
  lastTakenOn: day(album.endDate),
  createdAt: album.createdAt,
  updatedAt: album.updatedAt,
});

/**
 * Splits Immich's answer into the ids that changed and the ones that did
 * not, with Immich's reason, such as `duplicate` for a photo already there.
 */
export const splitResults = (results: BulkResult) => ({
  changed: results.filter((result) => result.success).map(({ id }) => id),
  unchanged: results
    .filter((result) => !result.success)
    .map(({ id, error, errorMessage }) => ({
      id,
      reason: errorMessage ?? error ?? 'unknown',
    })),
});

/** Whether an album name contains the text, ignoring case. */
export const matchesName = (album: Album, name: string) =>
  album.albumName.toLowerCase().includes(name.trim().toLowerCase());
