import { Schema } from 'effect';

/**
 * The permissions the commands use. An API key with fewer still works for
 * the commands it covers; `photos status` lists what is missing.
 */
export const requiredPermissions = [
  'asset.read',
  'asset.view',
  'asset.download',
  'asset.update',
  'asset.delete',
  'album.read',
  'album.create',
  'album.update',
  'album.delete',
  'albumAsset.create',
  'albumAsset.delete',
  'duplicate.read',
  'user.read',
] as const;

export const ApiKeySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  permissions: Schema.Array(Schema.String),
});
export type ApiKey = typeof ApiKeySchema.Type;

export const missingPermissions = (key: ApiKey) =>
  key.permissions.includes('all')
    ? []
    : requiredPermissions.filter(
        (permission) => !key.permissions.includes(permission),
      );

export const UserSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const VersionSchema = Schema.Struct({
  major: Schema.Number,
  minor: Schema.Number,
  patch: Schema.Number,
});

export const FeaturesSchema = Schema.Struct({
  trash: Schema.Boolean,
  smartSearch: Schema.Boolean,
  ocr: Schema.Boolean,
  duplicateDetection: Schema.Boolean,
});

export const ServerConfigSchema = Schema.Struct({
  trashDays: Schema.Number,
});
