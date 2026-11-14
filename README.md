# photos

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

`photos` is a command-line tool for AI agents to find, look at, download, and tidy the photos and videos in an [Immich](https://immich.app) library. An agent can find the photos you just took on your phone and look at them without you downloading anything, search by what photos show or the text in them, sort photos into albums, and move temporary scans or duplicates to the trash. It talks to Immich's REST API with an API key and prints JSON.

photos can't delete anything for good. Deleting moves photos to Immich's trash, which keeps them for 30 days by default, and `photos restore` brings them back. It never prints GPS coordinates, and the previews it saves for an agent to look at are Immich's re-encoded thumbnails without camera metadata.

## Install

With Nix, use the flake's `packages.<system>.default`, which installs the `photos` command and its agent skill in `share/photos/skills`.

From source on Linux, install [Bun](https://bun.sh), clone this repository, and run these commands in it:

```bash
bun install
bun run --filter @photos/cli install:user
```

Where [just](https://just.systems) is installed, `just install` runs the second command. The installer builds a standalone binary to `~/.local/bin/photos` and installs the agent skill to `~/.agents/skills`, where Codex and Claude Code find it. Run the commands again after pulling changes.

## Sign in

In Immich, open Account Settings > API Keys and create a key for each machine with these permissions:

- `asset.read`, `asset.view`, `asset.download`, `asset.update`, `asset.delete`
- `album.read`, `album.create`, `album.update`, `album.delete`
- `albumAsset.create`, `albumAsset.delete`
- `duplicate.read`, `user.read`

Then store it on the machine:

```bash
photos login --server https://immich.example.com
```

photos asks for the key without showing it, or reads it from stdin (`photos login --server … < key-file`). It checks the key with the server before it saves it to `~/.config/photos/credentials.json`, readable only by you. `photos status` shows whose key it is, the permissions it lacks, and what the server offers. `photos logout` removes the key and the saved previews; the key keeps working until you delete it in Immich.

## Use

Run `photos --help` for the commands and `photos <command> --help` for their options. The skill in [`apps/cli/skills/photos`](apps/cli/skills/photos/SKILL.md) tells agents how to use them, including that they show you what they picked and wait for your OK before they move anything to the trash.

## Develop

`bun run check` runs the standards drift check, lint, type checks, tests, and the build. It must pass before a change is done. Run the command from source with `bun apps/cli/src/app/cli.ts`.

## License

[MIT](LICENSE) © David Vornholt
