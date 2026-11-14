import { Schema } from 'effect';
import { requestJson } from '../../shared/immich.ts';

export const AlbumSchema = Schema.Struct({
  id: Schema.String,
  albumName: Schema.String,
  description: Schema.String,
  assetCount: Schema.Number,
  albumThumbnailAssetId: Schema.optional(Schema.NullOr(Schema.String)),
  // Everyone the album belongs to or is shared with, the owner first.
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

/** How many albums this account owns, has shared or has shared with it. */
export const AlbumCountsSchema = Schema.Struct({
  owned: Schema.Number,
  shared: Schema.Number,
  notShared: Schema.Number,
});

export const getAlbum = (id: string) =>
  requestJson({ method: 'GET', path: `/albums/${id}` }, AlbumSchema);

/** The role a user has in an album, or undefined when it is not shared with them. */
export const roleOf = (album: Album, userId: string) =>
  album.albumUsers.find(({ user }) => user.id === userId)?.role;

// The day part of an album's first or last photo. Immich keeps the wall-clock
// time there, marked as UTC, and sometimes only the day, so the day is all
// that can be trusted.
const dayLength = 'YYYY-MM-DD'.length;
const day = (value: string | undefined) => value?.slice(0, dayLength) ?? null;

export const summarizeAlbum = (album: Album) => {
  const owner =
    album.albumUsers.find(({ role }) => role === 'owner') ??
    album.albumUsers[0];
  return {
    id: album.id,
    name: album.albumName,
    description: album.description.trim() === '' ? null : album.description,
    assetCount: album.assetCount,
    owner: owner?.user.name ?? null,
    shared: album.shared,
    sharedWith: album.albumUsers
      .filter((member) => member !== owner)
      .map(({ role, user }) => ({ id: user.id, name: user.name, role })),
    sharedLink: album.hasSharedLink,
    coverAssetId: album.albumThumbnailAssetId ?? null,
    firstTakenOn: day(album.startDate),
    lastTakenOn: day(album.endDate),
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  };
};

/** Whether an album name contains the text, ignoring case. */
export const matchesName = (album: Album, name: string) =>
  album.albumName.toLowerCase().includes(name.trim().toLowerCase());
