# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2026-09-03

### Added

- Initial release of `@nexkit/json-repair`, a recursive-descent JSON repair
  engine with zero runtime dependencies.
- `repairJson`, which takes malformed or near-JSON text and returns the
  repaired JSON string.
- `parseJson`, which repairs and parses in one step, returning the resulting
  JavaScript value.
- `extractJson`, which locates the best JSON value embedded in a larger body of
  text and returns it verbatim, without repairing it.
- `extractAllJson`, which returns every JSON value embedded in a larger body of
  text, in document order and likewise verbatim.
- Safe and aggressive repair modes, so callers can choose between
  conservative fixes and a more permissive best-effort recovery.
- JSON extraction from Markdown fenced code blocks and from free-form prose,
  for handling output produced by language models and other text sources.
- The `json-repair` command-line interface, with `--pretty`, `--explain`, and
  `--mode` flags.
- Dual ESM and CJS builds, published alongside TypeScript type declarations
  for both module formats.
