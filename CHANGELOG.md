# Changelog

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
- Vitest test suite (49 tests)
- GitHub Actions CI (build + typecheck + test)
- CHANGELOG.md

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
