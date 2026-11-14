import { DateTime, Effect, Option, Schema } from 'effect';
import { Immich, requestJson } from '../../shared/immich.ts';

const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/**
 * A shared link as Immich answers it. Only the ids of its photos are read:
 * Immich sends each with its EXIF data, the GPS position included.
 */
export const SharedLinkSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  slug: nullable(Schema.String),
  // ALBUM or INDIVIDUAL.
  type: Schema.String,
  description: nullable(Schema.String),
  // Immich sends the password itself; photos only tells whether there is one.
  password: nullable(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  allowDownload: Schema.Boolean,
  allowUpload: Schema.Boolean,
  showMetadata: Schema.Boolean,
  album: Schema.optional(
    Schema.Struct({ id: Schema.String, albumName: Schema.String }),
  ),
  assets: Schema.Array(Schema.Struct({ id: Schema.String })),
});
export type SharedLink = typeof SharedLinkSchema.Type;

export const SharedLinkListSchema = Schema.Array(SharedLinkSchema);

/** What Immich answers for each photo added to or removed from a link. */
export const LinkAssetResultSchema = Schema.Array(
  Schema.Struct({
    assetId: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
);

const ServerConfigSchema = Schema.Struct({ externalDomain: Schema.String });

/**
 * The address people open links at, as Immich's web app builds it: the
 * public address set under Server Settings > Server, else the server's own.
 */
export const linkOrigin = Effect.gen(function* () {
  const { server } = yield* Immich;
  const { externalDomain } = yield* requestJson(
    { method: 'GET', path: '/server/config' },
    ServerConfigSchema,
  );
  const domain = externalDomain.trim();
  return domain !== '' && URL.canParse(domain) ? domain : server;
});

/** The link to send: `/s/<slug>` when it has a custom one, else `/share/<key>`. */
export const linkUrl = (link: SharedLink, origin: string) =>
  new URL(
    link.slug === undefined || link.slug === null || link.slug === ''
      ? `/share/${link.key}`
      : `/s/${encodeURIComponent(link.slug)}`,
    origin,
  ).href;

const text = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim() === ''
    ? null
    : value.trim();

const hasExpired = (expiresAt: string | null, now: DateTime.Utc) => {
  if (expiresAt === null) {
    return false;
  }
  return Option.exists(
    DateTime.make(expiresAt),
    (end) => !DateTime.isGreaterThan(end, now),
  );
};

/**
 * What photos tells about a link. A list from Immich carries only the cover
 * of a link's photos, so the ids come only with `withAssets`.
 */
export const summarizeLink = (
  link: SharedLink,
  origin: string,
  now: DateTime.Utc,
  withAssets = false,
) => {
  const forAlbum = link.type === 'ALBUM';
  return {
    id: link.id,
    url: linkUrl(link, origin),
    type: forAlbum ? 'album' : 'photos',
    album:
      link.album === undefined
        ? null
        : { id: link.album.id, name: link.album.albumName },
    ...(withAssets && !forAlbum
      ? { assetIds: link.assets.map(({ id }) => id) }
      : {}),
    description: text(link.description),
    expiresAt: link.expiresAt,
    expired: hasExpired(link.expiresAt, now),
    passwordProtected: text(link.password) !== null,
    allowDownload: link.allowDownload,
    showMetadata: link.showMetadata,
    allowUpload: link.allowUpload,
    createdAt: link.createdAt,
  };
};
export type LinkSummary = ReturnType<typeof summarizeLink>;

export const getLink = (id: string) =>
  requestJson({ method: 'GET', path: `/shared-links/${id}` }, SharedLinkSchema);
