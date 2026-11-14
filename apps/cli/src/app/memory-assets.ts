import { Effect, Schema } from 'effect';
import {
  type Asset,
  AssetSchema,
  summarize,
} from '../features/assets/assets.ts';
import {
  MemorySchema,
  summarizeMemory,
} from '../features/memories/memories.ts';
import { requestJson } from '../shared/immich.ts';
import { fail } from './command-inputs.ts';

/** A memory as Immich answers it, with its photos. */
export const MemoryWithAssetsSchema = Schema.Struct({
  ...MemorySchema.fields,
  assets: Schema.Array(AssetSchema),
});
export type MemoryWithAssets = typeof MemoryWithAssetsSchema.Type;

export const getMemory = (id: string) =>
  requestJson(
    { method: 'GET', path: `/memories/${id}` },
    MemoryWithAssetsSchema,
  );

export const memorySummary = (memory: MemoryWithAssets) =>
  summarizeMemory(memory, memory.assets.length);

/** A memory and its photos, as `show` prints them. */
export const memoryAndAssets = (memory: MemoryWithAssets) => ({
  memory: memorySummary(memory),
  assets: memory.assets.map(summarize),
});

/**
 * Refuses photos a memory would not show: Immich shows only photos on the
 * timeline in memories and takes archived ones out of them.
 */
export const onTimeline = (assets: ReadonlyArray<Asset>) => {
  const elsewhere = assets.filter(
    (asset) => asset.visibility !== 'timeline' || asset.isTrashed,
  );
  return elsewhere.length === 0
    ? Effect.succeed(assets)
    : fail(
        `${elsewhere.map(({ id }) => id).join(', ')} ${elsewhere.length === 1 ? 'is' : 'are'} archived, hidden, locked or in the trash. Memories show only photos on the timeline, and Immich takes the others out of them.`,
      );
};
