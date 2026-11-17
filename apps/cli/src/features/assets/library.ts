import { DateTime, Effect, Option, Schema } from 'effect';
import { InvalidInput } from '../../shared/errors/errors.ts';
import { requestJson } from '../../shared/immich.ts';
import {
  type Asset,
  AssetPageSchema,
  AssetSchema,
  isBrowsable,
  summarize,
} from './assets.ts';
import { type AssetQuery, searchRequest } from './search.ts';

/** How many photos and videos match, and everything together. */
export const AssetCountsSchema = Schema.Struct({
  images: Schema.Number,
  videos: Schema.Number,
  total: Schema.Number,
});

/** How many people Immich recognized, and how many of them are hidden. */
export const PeopleCountsSchema = Schema.Struct({
  total: Schema.Number,
  hidden: Schema.Number,
});

/** The folders on the server that hold photos, without a trailing slash. */
export const FolderPathsSchema = Schema.Array(Schema.String);

/** The most results Immich returns for one search request. */
export const maxPage = 1000;

// Enough to look up a handful of photos quickly without crowding the server.
const lookupConcurrency = 4;

export const getAsset = (id: string) =>
  requestJson({ method: 'GET', path: `/assets/${id}` }, AssetSchema);

export const getAssets = (ids: ReadonlyArray<string>) =>
  Effect.forEach(ids, getAsset, { concurrency: lookupConcurrency });

// Immich applies a new time taken in the background, usually within seconds.
const takenAtChecks = 30;
const takenAtCheckInterval = '500 millis';
// Immich may store the time to the second only.
const takenAtTolerance = 1000;

/** Whether Immich shows the asset at the instant and wall-clock time of `takenAt`. */
const isTakenAt = (takenAt: string) => {
  const instant = Date.parse(takenAt);
  // makeZonedFromString refuses Z, which is UTC and has no offset.
  const offset = Option.match(DateTime.makeZonedFromString(takenAt), {
    onNone: () => 0,
    onSome: DateTime.zonedOffset,
  });
  const near = (time: string, wanted: number) =>
    Math.abs(Date.parse(time) - wanted) < takenAtTolerance;
  return (asset: Asset) =>
    near(asset.fileCreatedAt, instant) &&
    near(asset.localDateTime, instant + offset);
};

/**
 * Looks up the assets once Immich shows all of them taken at `takenAt`, an
 * ISO time with offset, or as they are after about 15 seconds.
 */
export const getAssetsTakenAt = (ids: ReadonlyArray<string>, takenAt: string) =>
  Effect.gen(function* () {
    const settled = isTakenAt(takenAt);
    for (let check = 1; ; check += 1) {
      const assets = yield* getAssets(ids);
      if (assets.every(settled) || check === takenAtChecks) {
        return assets;
      }
      yield* Effect.sleep(takenAtCheckInterval);
    }
  });

/**
 * Runs a search and returns one page of results. Immich's `total` counts only
 * the page too, so it is left out rather than read as the library's size.
 */
export const searchAssets = (query: AssetQuery) =>
  requestJson(searchRequest(query), AssetPageSchema).pipe(
    Effect.map(({ assets }) => ({
      count: assets.count,
      nextCursor: assets.nextCursor ?? null,
      assets: assets.items.map(summarize),
    })),
  );

/**
 * Refuses what a person browsing the library never sees: the video half of a
 * live photo, which belongs to its still, and locked photos.
 */
export const browsable = (assets: ReadonlyArray<Asset>) => {
  const hidden = assets.filter((asset) => !isBrowsable(asset));
  return hidden.length === 0
    ? Effect.succeed(assets)
    : Effect.fail(
        new InvalidInput({
          message: `${hidden.map(({ id }) => id).join(', ')} ${hidden.length === 1 ? 'is' : 'are'} not in the library a person browses (the video half of a live photo, or locked). Use the photo it belongs to.`,
        }),
      );
};
