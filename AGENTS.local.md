# Project-specific rules

- photos only talks to Immich through its REST API with the API key stored by `photos login`. Never read Immich's database or library files directly.
- Never delete permanently. Deleting means `DELETE /assets` with `force: false`, which moves photos to the trash; never send `force: true`, call `/trash/empty`, or add a command that does either.
- Keep GPS coordinates out of everything photos prints. `show` gives the place name only, and previews are Immich's re-encoded thumbnails without metadata.
- No server address, name, or other personal detail belongs in this public repository. Tests use `immich.example.com`.
- Keep the skill in `apps/cli/skills/photos/SKILL.md` in step with the commands.
