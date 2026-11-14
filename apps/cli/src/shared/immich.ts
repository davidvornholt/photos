import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from 'effect/http';
import { type Credentials, readCredentials } from './credentials.ts';
import {
  type ImmichFailure,
  ImmichRejected,
  MissingPermission,
  NotSignedIn,
  ServerUnreachable,
  UnexpectedResponse,
} from './errors/errors.ts';

/**
 * HTTP for every request. A redirect comes back as its own answer instead of
 * being followed, because every request carries the API key, which only the
 * Immich server may see.
 */
export const httpLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'manual' }),
  ),
);

export type ImmichRequest = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Below `/api`, such as `/assets/{id}`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
} & (
  | {
      /** Sent as JSON. */
      readonly body?: unknown;
      readonly form?: undefined;
    }
  | {
      /** Sent as multipart form data, as an upload is. */
      readonly form: FormData;
      readonly body?: undefined;
    }
);

/** The Immich API, signed in with this machine's key. */
export class Immich extends Context.Service<
  Immich,
  {
    readonly server: string;
    /** Sends a request and fails unless Immich answers with a 2xx status. */
    readonly execute: (
      request: ImmichRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, ImmichFailure>;
  }
>()('@photos/cli/shared/Immich') {}

export const notSignedIn = new NotSignedIn({
  message:
    'This machine has no Immich API key. Run `photos login --server <address of your Immich>` and paste a key.',
});

export const unexpected = (server: string, detail: string) =>
  new UnexpectedResponse({
    message: `${server} answered in a way photos does not understand (${detail}). Update photos or check the server.`,
  });

// Immich explains a failure in `message`, which validation errors send as a
// list.
const ErrorBody = Schema.Struct({
  message: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});

const explanation = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    Effect.map(({ message }) =>
      typeof message === 'string' ? message : (message ?? []).join('; '),
    ),
    Effect.orElseSucceed(() => ''),
  );

const unauthorized = 401;
const forbidden = 403;
const hundreds = 100;
const statusClass = (status: number) => Math.floor(status / hundreds);
const success = 2;
const redirection = 3;
const clientError = 4;

/** Whether Immich answered with a 2xx status. */
const succeeded = (response: HttpClientResponse.HttpClientResponse) =>
  statusClass(response.status) === success;

const redirected = (server: string, location: string | undefined) =>
  new UnexpectedResponse({
    message: `${server} redirected the request${location === undefined ? '' : ` to ${location}`}. photos never follows a redirect, so the API key stays with the server. Check the server address.`,
  });

/** The failure Immich's answer stands for, with Immich's own explanation. */
const failureFrom = (
  server: string,
  response: HttpClientResponse.HttpClientResponse,
  detail: string,
): ImmichFailure => {
  const { status, headers } = response;
  const because = detail === '' ? '' : ` (${detail})`;
  if (status === unauthorized) {
    return new NotSignedIn({
      message: `${server} no longer accepts the API key on this machine${because}. Create a new key in Immich and run \`photos login\` again.`,
    });
  }
  if (status === forbidden) {
    const missing =
      detail === ''
        ? 'The API key lacks a permission this command needs'
        : detail;
    return new MissingPermission({
      message: `${missing}. Give the key that permission in Immich under Account Settings > API Keys; \`photos status\` lists what it is missing.`,
    });
  }
  if (statusClass(status) === redirection) {
    return redirected(server, headers.location);
  }
  if (statusClass(status) === clientError) {
    return new ImmichRejected({
      status,
      message:
        detail === '' ? `Immich refused the request (HTTP ${status}).` : detail,
    });
  }
  return new UnexpectedResponse({
    message: `${server} failed with HTTP ${status}${because}.`,
  });
};

const failureFor = (
  server: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.map(explanation(response), (detail) =>
    failureFrom(server, response, detail),
  );

const unreachable =
  (server: string) => (error: HttpClientError.HttpClientError) =>
    error.reason._tag === 'TransportError'
      ? new ServerUnreachable({
          message: `Could not reach ${server}: ${error.message}`,
        })
      : unexpected(server, error.message);

const outgoingBody = (
  base: HttpClientRequest.HttpClientRequest,
  request: ImmichRequest,
) => {
  if (request.form !== undefined) {
    return HttpClientRequest.bodyFormData(base, request.form);
  }
  return request.body === undefined
    ? base
    : HttpClientRequest.bodyJsonUnsafe(base, request.body);
};

/** The API of one server with one key, for checking a key before it is saved. */
export const makeImmich = (credentials: Credentials) =>
  Effect.gen(function* () {
    const { server, apiKey } = credentials;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((outgoing) =>
        outgoing.pipe(
          HttpClientRequest.prependUrl(`${server}/api`),
          HttpClientRequest.setHeader('x-api-key', apiKey),
        ),
      ),
    );
    const execute = Effect.fn('Immich.execute')(function* (
      request: ImmichRequest,
    ) {
      const urlParams = Object.fromEntries(
        Object.entries(request.query ?? {}).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, value]],
        ),
      );
      const base = HttpClientRequest.make(request.method)(request.path, {
        urlParams,
      });
      const outgoing = outgoingBody(base, request);
      const response = yield* client
        .execute(outgoing)
        .pipe(Effect.mapError(unreachable(server)));
      if (succeeded(response)) {
        return response;
      }
      return yield* yield* failureFor(server, response);
    });
    return Immich.of({ server, execute });
  });

/** The API of the server this machine signed in to. */
export const immichLayer = Layer.effect(
  Immich,
  Effect.gen(function* () {
    const credentials = yield* readCredentials;
    if (Option.isNone(credentials)) {
      return yield* notSignedIn;
    }
    return yield* makeImmich(credentials.value);
  }),
).pipe(Layer.provide(httpLayer));

/** Sends a request and decodes Immich's JSON answer. */
export const requestJson = <A>(
  request: ImmichRequest,
  schema: Schema.Decoder<A>,
) =>
  Effect.gen(function* () {
    const { server, execute } = yield* Immich;
    const response = yield* execute(request);
    const json = yield* response.json.pipe(
      Effect.mapError(() => unexpected(server, `${request.path} sent no JSON`)),
    );
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError((error) =>
        unexpected(server, `${request.path}: ${error.message}`),
      ),
    );
  });

/** Sends a request whose answer has no body worth reading. */
export const requestNothing = (request: ImmichRequest) =>
  Effect.gen(function* () {
    const { execute } = yield* Immich;
    yield* execute(request);
  });
