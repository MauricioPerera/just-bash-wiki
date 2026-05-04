# Changelog

## [Unreleased]

### Added
- `wiki log trim --keep=N` — explicit log trim, removes all entries beyond the N most-recent (uses `_id`-based removal so concurrent writes with identical timestamps are handled correctly) (#9)
- `WikiOptions.logMaxEntries` — when set, the plugin samples log size every 16 commands and opportunistically trims back to the cap when the count exceeds 1.5× the cap (#9)
- `safeParseAny` helper for tolerant `JSON.parse` of tool stdout

## [1.1.3] - 2026-05-02

### Fixed
- `pageRename`: validate `oldSlug` too (support legacy data migration)
- `pageRename`: explicit comment documenting single-writer race window between read and mutate
- `pageRename`: comment on vec interpolation safety being guarded by slug regex

### Changed
- README: document slug format requirement (`^[a-z0-9][a-z0-9_-]*$`) in Pages section
- README: document `wiki source update` and `wiki source delete` in Sources section

## [1.1.2] - 2026-05-02

### Fixed
- `pageRename`: read affected pages BEFORE mutating, batch `$pull --many` + targeted `$push`
- `pluginDefaults`: eliminated global mutable state, closed in `buildWikiCommand(defaults)` closure
- `pageRename`: `safeParse()` helper prevents `JSON.parse` of empty strings
- Slug validation (`^[a-z0-9][a-z0-9_-]*$`) on `pageCreate` and `pageRename`

### Added
- 7 new tests: slug validation suite (5), multi-instance isolation (1), rename-to-invalid-slug (1)

## [1.1.1] - 2026-05-02

### Added
- Vitest test suite (49 tests) covering all commands
- GitHub Actions CI (build + typecheck + test on push/PR)
- CHANGELOG.md

## [1.1.0] - 2026-05-02

### Added
- `wiki page rename <old-slug> <new-slug>` — updates slug, links_to, linked_from, and re-keys vector embedding
- `wiki source update <id> '<json>'` — modify source documents
- `wiki source delete <id>` — remove source and its embedding
- `wiki index --rebuild` — re-derive all `linked_from` from `links_to`
- `--status` filter on `wiki source list` and `wiki page list`
- Exported types: `Page`, `Source`, `LogEntry`, `LintIssue`, `LintResult`
- `WikiOptions.embeddingDim`, `.metric`, `.quantize` now used as defaults in `wiki init`
- `prepublishOnly` script prevents publishing without build
- `homepage` and `bugs` fields in package.json

### Fixed
- All JSON construction migrated to `JSON.stringify` via `dbCmd()` helper, eliminating template injection bugs with special characters in slugs/values
- `wikiEmbed` rewritten with structured positional args instead of fragile string re-parsing
- `wiki index` comment corrected (no longer says "rebuild" when it only lists)

### Changed
- Single-writer assumption documented in source comments

## [1.0.2] - 2026-05-02

### Fixed
- Bidirectional cross-references: on page creation, scans existing pages that already link to the new slug and populates `linked_from`

## [1.0.1] - 2026-05-02

### Added
- README with full command reference, architecture diagram, and usage examples

## [1.0.0] - 2026-05-02

### Added
- Initial release implementing Karpathy's LLM Wiki pattern
- `wiki` command with subcommands: init, source (add/list/get/count), page (create/update/get/list/delete/orphans), search, embed, lint, log, stats, index
- Built on just-bash-data (db + vec)
- Automatic cross-reference management (linked_from)
- Automatic operation logging
- Lint with orphan detection, broken links, missing embeddings
