import { Schema } from 'effect';

// The command's own arguments are wrong, before anything reaches Immich.
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  'InvalidInput',
  { message: Schema.String },
) {}

// No API key is stored on this machine, or Immich no longer accepts it.
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()(
  'NotSignedIn',
  { message: Schema.String },
) {}

// The API key works but lacks the permission a command needs.
export class MissingPermission extends Schema.TaggedError<MissingPermission>()(
  'MissingPermission',
  { message: Schema.String },
) {}

// Immich refused the request, for example because an id does not exist or
// belongs to someone else. The message is Immich's own.
export class ImmichRejected extends Schema.TaggedError<ImmichRejected>()(
  'ImmichRejected',
  { message: Schema.String, status: Schema.Number },
) {}

// Nothing answered: the machine is offline or the server is down.
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  'ServerUnreachable',
  { message: Schema.String },
) {}

// Immich answered with something this CLI does not understand, usually
// because the server is newer or older than the CLI expects.
export class UnexpectedResponse extends Schema.TaggedError<UnexpectedResponse>()(
  'UnexpectedResponse',
  { message: Schema.String },
) {}

// The server would delete trashed photos at once, so moving them to the trash
// would not be undoable.
export class TrashDisabled extends Schema.TaggedError<TrashDisabled>()(
  'TrashDisabled',
  { message: Schema.String },
) {}

// The credentials file exists but cannot be read or written.
export class CredentialsStoreFailed extends Schema.TaggedError<CredentialsStoreFailed>()(
  'CredentialsStoreFailed',
  { message: Schema.String },
) {}

// A preview or an original could not be saved on this machine.
export class FileNotSaved extends Schema.TaggedError<FileNotSaved>()(
  'FileNotSaved',
  { message: Schema.String },
) {}

export type ImmichFailure =
  | NotSignedIn
  | MissingPermission
  | ImmichRejected
  | ServerUnreachable
  | UnexpectedResponse;
