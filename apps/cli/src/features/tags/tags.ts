import { Schema } from 'effect';
import type { ImmichRequest } from '../../shared/immich.ts';

export const TagSchema = Schema.Struct({
  id: Schema.String,
  // The full name, such as `Trips/2026`; Immich's `name` is only the last part.
  value: Schema.String,
  color: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Tag = typeof TagSchema.Type;

export const TagListSchema = Schema.Array(TagSchema);

/** Immich's answer to an upsert of one tag name: that one tag. */
export const UpsertedTagSchema = Schema.Tuple([TagSchema]);

export const summarizeTag = (tag: Tag) => ({
  id: tag.id,
  name: tag.value,
  color: tag.color ?? null,
  parentId: tag.parentId ?? null,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
});

/**
 * The parts of a tag's full name, each trimmed: `Trips / 2026` is the tag
 * `2026` below `Trips`. None when a part is empty, as in `Trips//2026`.
 */
export const tagNameParts = (
  value: string,
): ReadonlyArray<string> | undefined => {
  const parts = value.split('/').map((part) => part.trim());
  return parts.some((part) => part === '') ? undefined : parts;
};

// The colors Immich accepts: a hex code, with or without the `#`.
const hexColor = /^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export const isHexColor = (value: string) => hexColor.test(value);

/**
 * The tag with this id or full name. A name matches exactly, or else ignoring
 * case when only one tag matches that way.
 */
export const findTag = (tags: ReadonlyArray<Tag>, wanted: string) => {
  const id = wanted.trim().toLowerCase();
  const name = tagNameParts(wanted)?.join('/') ?? '';
  const exact = tags.find((tag) => tag.id === id || tag.value === name);
  if (exact !== undefined) {
    return exact;
  }
  const loose = tags.filter(
    (tag) => tag.value.toLowerCase() === name.toLowerCase(),
  );
  return loose.length === 1 ? loose[0] : undefined;
};

/** The tags below a tag, at any depth. */
export const tagsBelow = (tags: ReadonlyArray<Tag>, tag: Tag) =>
  tags.filter((other) => other.value.startsWith(`${tag.value}/`));

/**
 * One page of the photos that carry a tag, in the trash or not. Immich counts
 * a photo with a tag below this one as carrying it too.
 */
export const taggedPhotosRequest = (
  tagId: string,
  size: number,
  cursor: string | undefined,
): ImmichRequest => ({
  method: 'POST',
  path: '/search/metadata',
  body: {
    filter: {
      visibility: { in: ['timeline', 'archive'] },
      tagIds: { any: [tagId] },
    },
    orderBy: { field: 'fileCreatedAt', direction: 'desc' },
    size,
    ...(cursor === undefined ? {} : { cursor }),
  },
});

export const TaggedPhotosSchema = Schema.Struct({
  assets: Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String })),
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
