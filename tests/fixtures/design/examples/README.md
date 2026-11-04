# Design package example fixtures

This folder and `../templates/` hold exact copies of the Design Loom implementation design package, edition 0.1.0 (`SHA256SUMS.txt` sha256 `0d9f1f38afa5a564a1004681df38492068052a6c8ba221c0a85e8e6203c8a4e5`):

- `examples/`: every JSON file under the design package's `examples/`, except the hashing vectors and the native plugin placement examples, plus the example extension's Markdown template `extension/templates/database-design.md`.
- `templates/`: the design package's `templates/*.template.json` descriptors.

Each file's sha256 matches its entry in the design package's `SHA256SUMS.txt`. Do not edit or reformat them; Biome skips `tests/fixtures/`. To update, copy the files from a newer design package revision and note the design change in the PR.
