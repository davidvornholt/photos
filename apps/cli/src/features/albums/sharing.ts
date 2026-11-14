import { Schema } from 'effect';

/** The roles an album can be shared with; the owner's role is not one. */
export const albumRoles = ['viewer', 'editor'] as const;

/** The accounts on the server, as Immich lists them. */
export const ServerUsersSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
  }),
);

/** The account this machine's key belongs to. */
export const CurrentUserSchema = Schema.Struct({ id: Schema.String });
