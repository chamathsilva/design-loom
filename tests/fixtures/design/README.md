# Design package fixtures

Exact copies of test vectors from the Design Loom implementation design package, edition 0.1.0 (`SHA256SUMS.txt` sha256 `0d9f1f38afa5a564a1004681df38492068052a6c8ba221c0a85e8e6203c8a4e5`). Do not edit or reformat them: the tests depend on their exact bytes, and the hashes below must keep matching the design package's `SHA256SUMS.txt`.

| File | Design package path | sha256 |
|---|---|---|
| `canonical-json-v1-vectors.json` | `examples/canonical-json-v1-vectors.json` | `c9205a8f1147cd8d841a046c0c2b4934b73171f930edfca6019d339f513c25e0` |
| `artifact-semantic-v1-vectors.json` | `examples/artifact-semantic-v1-vectors.json` | `0eff15bf21111d7b7dcf76dd18acf478cb6d018fe4814c8a5778eeffc8f762b8` |

To update them, copy the new files from a newer design package revision, update this table, and note the design change in the PR.
