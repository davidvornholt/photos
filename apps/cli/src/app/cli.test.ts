import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

let home = '';

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'photos-cli-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// Runs the real entrypoint, since what reaches stdout and stderr is decided
// there, around the CLI library.
const photos = async (...args: ReadonlyArray<string>) => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), ...args],
    {
      // Built from entries because environment variable names are not
      // camelCase, and nothing from the caller's environment leaks in.
      env: Object.fromEntries([
        ['HOME', home],
        ['XDG_CONFIG_HOME', join(home, 'config')],
        ['NO_COLOR', '1'],
      ]),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe('photos on the command line', () => {
  it.each(['--bogus', 'show', 'albums add', '--log-level invalid'])(
    'reports `photos %s` as one JSON error and prints no help',
    async (command) => {
      const result = await photos(...command.split(' '));
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        error: { tag: 'UsageError', message: expect.any(String) },
      });
    },
  );

  it.each(['--help', 'albums', 'search --help'])(
    'prints help for `photos %s`',
    async (command) => {
      const result = await photos(...command.split(' '));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('USAGE');
      expect(result.stderr).toBe('');
    },
  );

  it('asks for a key when this machine has none', async () => {
    const result = await photos('recent');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.tag).toBe('NotSignedIn');
  });

  it('reports a wrong id with the usage exit code', async () => {
    const result = await photos('trash', 'IMG_1234.jpg');
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error.tag).toBe('InvalidInput');
  });
});
