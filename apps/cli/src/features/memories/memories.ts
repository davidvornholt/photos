import { DateTime, Effect, Option, Schema } from 'effect';
import { InvalidInput } from '../../shared/errors/errors.ts';

const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/**
 * on_this_day shows photos taken on this day in an earlier year; Immich makes
 * birthday memories itself from the people it knows the birthdays of.
 */
export const memoryTypes = ['on_this_day', 'birthday'] as const;

/** Immich deletes a memory that is not saved this many days after it was made. */
export const unsavedMemoryDays = 30;

/** A memory as Immich answers it, apart from its photos. */
export const MemorySchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  data: Schema.Struct({
    // The year the photos are from, or a birthday person's year of birth.
    year: Schema.optional(Schema.Number),
    personId: nullable(Schema.String),
    personName: nullable(Schema.String),
  }),
  memoryAt: Schema.String,
  showAt: nullable(Schema.String),
  hideAt: nullable(Schema.String),
  seenAt: nullable(Schema.String),
  isSaved: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Memory = typeof MemorySchema.Type;

export const MemoryCountSchema = Schema.Struct({ total: Schema.Number });

export const summarizeMemory = (memory: Memory, assetCount: number) => ({
  id: memory.id,
  type: memory.type,
  year: memory.data.year ?? null,
  ...(memory.type === 'birthday'
    ? {
        person: memory.data.personName ?? null,
        personId: memory.data.personId ?? null,
      }
    : {}),
  date: memory.memoryAt,
  showFrom: memory.showAt ?? null,
  showUntil: memory.hideAt ?? null,
  saved: memory.isSaved,
  seenAt: memory.seenAt ?? null,
  assetCount,
  createdAt: memory.createdAt,
  updatedAt: memory.updatedAt,
});

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

/** A calendar day as YYYY-MM-DD, the form Immich's memory dates take. */
export const validDay = (flag: string, value: string) => {
  const text = value.trim();
  const real = Option.exists(
    DateTime.make(`${text}T00:00:00Z`),
    (day) => DateTime.formatIsoDateUtc(day) === text,
  );
  return dayPattern.test(text) && real
    ? Effect.succeed(text)
    : Effect.fail(
        new InvalidInput({
          message: `--${flag} ${value} is not a day. Use YYYY-MM-DD.`,
        }),
      );
};

/**
 * The instant Immich keeps for a memory of this day: its start in UTC, as
 * Immich's own memories have it.
 */
export const memoryAt = (day: string) => `${day}T00:00:00.000Z`;

/** The year Immich titles a memory with, from its day. */
export const yearOf = (day: string) => Number(day.slice(0, 'YYYY'.length));
