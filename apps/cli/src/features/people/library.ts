import { Effect } from 'effect';
import { requestJson } from '../../shared/immich.ts';
import { AssetPageSchema } from '../assets/assets.ts';
import { maxPage } from '../assets/library.ts';
import { searchRequest } from '../assets/search.ts';
import { PersonSchema, StatisticsSchema, summarizePerson } from './people.ts';

export const getPerson = (id: string) =>
  requestJson({ method: 'GET', path: `/people/${id}` }, PersonSchema);

/** A person and how many photos and videos show them. */
export const personWithCount = (id: string) =>
  Effect.all(
    [
      getPerson(id),
      requestJson(
        { method: 'GET', path: `/people/${id}/statistics` },
        StatisticsSchema,
      ),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(([person, statistics]) => ({
      ...summarizePerson(person),
      assetCount: statistics.assets,
    })),
  );

/** Every photo in the library that shows a person, page by page. */
export const personAssetIds = (personId: string) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let cursor: string | undefined;
    do {
      const { assets } = yield* requestJson(
        searchRequest({ personIds: [personId], limit: maxPage, cursor }),
        AssetPageSchema,
      );
      ids.push(...assets.items.map(({ id }) => id));
      cursor = assets.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return ids;
  });
