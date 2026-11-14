import process from 'node:process';
import { BunServices } from '@effect/platform-bun';
import { Console, DateTime, Effect } from 'effect';
import { CliError, CliOutput, Command } from 'effect/cli';
import packageJson from '../../package.json' with { type: 'json' };
import { login, logout, status } from './account-commands.ts';
import { albums } from './album-commands.ts';
import { download, preview, recent, search, show } from './asset-commands.ts';
import { duplicates } from './duplicate-commands.ts';
import { edits } from './edit-commands.ts';
import { faces } from './face-commands.ts';
import { folders, stats, users } from './library-commands.ts';
import { links } from './link-commands.ts';
import { memories } from './memory-commands.ts';
import { report } from './output.ts';
import { people } from './people-commands.ts';
import { root } from './root.ts';
import { stacks } from './stack-commands.ts';
import { tags } from './tag-commands.ts';
import { restore, trash, update } from './tidy-commands.ts';
import { copyInfo, upload } from './upload-commands.ts';

export const photos = root.pipe(
  Command.withSubcommands([
    login,
    logout,
    status,
    recent,
    search,
    show,
    preview,
    download,
    update,
    trash,
    restore,
    duplicates,
    albums,
    stacks,
    tags,
    people,
    faces,
    memories,
    links,
    upload,
    copyInfo,
    edits,
    stats,
    folders,
    users,
  ]),
);

// The CLI library prints a command's help to stdout before it fails on a
// parse error. Agents read stdout as data, so the help text is held back and
// printed only when it was asked for: by --help, or by naming a command group
// without one of its commands. Anything else the library prints, such as the
// version, passes straight through. A parse error becomes one JSON error on
// stderr like every other failure, so agents parse a single shape.
const program = Effect.gen(function* () {
  const stdout = yield* Console.Console;
  const formatter = yield* CliOutput.Formatter;
  let help: string | undefined;
  let heldHelp: string | undefined;
  const printHeldHelp = Effect.suspend(() =>
    heldHelp === undefined ? Effect.void : Console.log(heldHelp),
  );
  return yield* Command.runWith(photos, {
    version: packageJson.version,
    renderErrors: false,
  })(process.argv.slice(2)).pipe(
    Effect.provideService(CliOutput.Formatter, {
      ...formatter,
      formatHelpDoc: (doc) => {
        help = formatter.formatHelpDoc(doc);
        return help;
      },
    }),
    Effect.provideService(Console.Console, {
      ...stdout,
      log: (...args) => {
        if (args.length === 1 && args[0] === help) {
          heldHelp = help;
        } else {
          stdout.log(...args);
        }
      },
    }),
    Effect.andThen(printHeldHelp),
    Effect.catchTag('ShowHelp', (shown) =>
      shown.errors.length === 0
        ? printHeldHelp
        : report({
            _tag: 'UsageError',
            message: shown.errors.map((error) => error.message).join('\n'),
          }),
    ),
  );
}).pipe(
  Effect.catch((error) =>
    report(
      CliError.isCliError(error)
        ? { _tag: 'UsageError', message: error.message }
        : error,
    ),
  ),
  Effect.catchDefect((defect) =>
    report({ _tag: 'UnexpectedError', message: String(defect) }),
  ),
  // Days and times without an offset, such as `--from 2026-11-14`, are read
  // in this machine's time zone.
  Effect.provide(DateTime.layerCurrentZoneLocal),
  Effect.provide(BunServices.layer),
);

if (import.meta.main) {
  await Effect.runPromise(program);
}
