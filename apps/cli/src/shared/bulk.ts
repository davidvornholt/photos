import { Schema } from 'effect';

/** What Immich answers for each id when it adds or removes many at once. */
export const BulkResultSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
);
export type BulkResult = typeof BulkResultSchema.Type;

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
