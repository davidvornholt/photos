import { Schema } from 'effect';

/**
 * A stack as Immich answers it, with its photos decoded by `asset`. Immich
 * leaves out the photos in the trash and the hidden ones.
 */
export const stackSchema = <S extends Schema.Top>(asset: S) =>
  Schema.Struct({
    id: Schema.String,
    primaryAssetId: Schema.String,
    assets: Schema.Array(asset),
  });

type Stack<A> = {
  readonly id: string;
  readonly primaryAssetId: string;
  readonly assets: ReadonlyArray<A>;
};

type WithId = { readonly id: string };

/** The stack a photo is in, as Immich reports it with the photo. */
export const AssetStackSchema = Schema.Struct({
  stack: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
});

/** The stack's photos, the primary one first and the rest as Immich orders them. */
const primaryFirst = <A extends WithId>(stack: Stack<A>) => [
  ...stack.assets.filter(({ id }) => id === stack.primaryAssetId),
  ...stack.assets.filter(({ id }) => id !== stack.primaryAssetId),
];

/** What a list of stacks shows of each one: its primary photo and the ids of all. */
export const listedStack = <A extends WithId, S>(
  stack: Stack<A>,
  summarize: (asset: A) => S,
) => {
  const assets = primaryFirst(stack);
  const [primary] = assets;
  return {
    id: stack.id,
    primaryAssetId: stack.primaryAssetId,
    assetCount: assets.length,
    assetIds: assets.map(({ id }) => id),
    primary: primary?.id === stack.primaryAssetId ? summarize(primary) : null,
  };
};

/** A stack with all its photos, the primary one first. */
export const describeStack = <A extends WithId, S>(
  stack: Stack<A>,
  summarize: (asset: A) => S,
) => ({
  id: stack.id,
  primaryAssetId: stack.primaryAssetId,
  assetCount: stack.assets.length,
  assets: primaryFirst(stack).map(summarize),
});
