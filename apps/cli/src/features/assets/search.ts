import type { ImmichRequest } from '../../shared/immich.ts';

/** What to look for. Times are ISO instants; unset fields do not filter. */
export type AssetQuery = {
  /** What the photo shows, matched by Immich's smart search. */
  readonly query?: string;
  /** Text visible in the photo, as Immich's OCR read it. */
  readonly ocr?: string;
  /** Part of the original file name, ignoring case. */
  readonly fileName?: string;
  /** Part of the description, ignoring case. */
  readonly description?: string;
  readonly takenFrom?: string;
  readonly takenTo?: string;
  readonly uploadedFrom?: string;
  readonly uploadedTo?: string;
  readonly type?: 'IMAGE' | 'VIDEO';
  readonly albumId?: string;
  readonly withoutAlbum?: boolean;
  /** Only favorites when true, only the rest when false. */
  readonly favorite?: boolean;
  /** Only archived photos when true, only the timeline when false. */
  readonly archived?: boolean;
  /** Only the trash instead of the library. */
  readonly trashed?: boolean;
  readonly oldestFirst?: boolean;
  readonly limit: number;
  readonly cursor?: string;
};

const range = (from: string | undefined, to: string | undefined) =>
  from === undefined && to === undefined
    ? undefined
    : {
        ...(from === undefined ? {} : { gte: from }),
        ...(to === undefined ? {} : { lte: to }),
      };

const visibility = (archived: boolean | undefined) => {
  if (archived === undefined) {
    // Hidden assets are the video halves of live photos, and locked ones need
    // a PIN, so neither is part of the library a person browses.
    return { in: ['timeline', 'archive'] };
  }
  return { eq: archived ? 'archive' : 'timeline' };
};

/**
 * The search filter Immich applies. Immich's search includes the trash unless
 * the filter says otherwise, so every filter says.
 */
export const searchFilter = (query: AssetQuery) => {
  const filter: Record<string, unknown> = {
    trashedAt: query.trashed === true ? { ne: null } : { eq: null },
    visibility: visibility(query.archived),
  };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) {
      filter[key] = value;
    }
  };
  set('ocr', query.ocr === undefined ? undefined : { matches: query.ocr });
  set(
    'originalFileName',
    query.fileName === undefined ? undefined : { like: query.fileName },
  );
  set(
    'description',
    query.description === undefined ? undefined : { like: query.description },
  );
  set('takenAt', range(query.takenFrom, query.takenTo));
  set('createdAt', range(query.uploadedFrom, query.uploadedTo));
  set('type', query.type === undefined ? undefined : { eq: query.type });
  set(
    'albumIds',
    query.albumId === undefined ? undefined : { any: [query.albumId] },
  );
  set('hasAlbums', query.withoutAlbum === true ? { eq: false } : undefined);
  set(
    'isFavorite',
    query.favorite === undefined ? undefined : { eq: query.favorite },
  );
  return filter;
};

/**
 * The request for a search: smart search when it asks what a photo shows,
 * which ranks by likeness and has no further pages, else a metadata search by
 * the time each photo was taken.
 */
export const searchRequest = (query: AssetQuery): ImmichRequest =>
  query.query === undefined
    ? {
        method: 'POST',
        path: '/search/metadata',
        body: {
          filter: searchFilter(query),
          orderBy: {
            field: 'fileCreatedAt',
            direction: query.oldestFirst === true ? 'asc' : 'desc',
          },
          size: query.limit,
          withExif: true,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
      }
    : {
        method: 'POST',
        path: '/search/smart',
        body: {
          query: query.query,
          filter: searchFilter(query),
          size: query.limit,
          withExif: true,
        },
      };
