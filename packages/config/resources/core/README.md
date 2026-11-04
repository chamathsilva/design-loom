# Core release resources (edition 0.1.0)

The built-in definitions every application resolves against (design doc 03, "Configuration resolution", step 1). The release build (B11) copies this folder into the plugin unchanged.

| File | What it is |
|---|---|
| `release.json` | Framework version, core artifact types, core rule IDs and the list of resource files below |
| `workflows/` | Workflow descriptors (`workflow.schema.json`) |
| `templates/*.template.json` | Template descriptors (`template.schema.json`); each names its Markdown starter in `content_path` |
| `templates/*.md` | Markdown starters for new artifacts |

`release.json` is ours. The other files are exact copies from the Design Loom design package. Don't edit them here: change the design package, then copy the files again and update this table. A test checks every copy against it.

| File | Copied from | SHA-256 |
|---|---|---|
| `workflows/core.feature-design.json` | `examples/workflow.json` | `7d3d133c72c328306ca0bc730649e393bb52c616de0ed722492b1c99ce4609a5` |
| `templates/contract.md` | `templates/contract.md` | `4970734bbd08fc7a8870b2806574a86263411df3e5bfb8bf4cf570ab62fd18c0` |
| `templates/contract.template.json` | `templates/contract.template.json` | `0cb94b7614730be9a0e91378317e78e557d12288ce9f4b9fa59423d76bdf4de9` |
| `templates/engineering-design.md` | `templates/engineering-design.md` | `6ad55cb5ce22c7d4a7df7362607eb2246d5d996e95df6521f51b4b9a94e434b4` |
| `templates/engineering-design.template.json` | `templates/engineering-design.template.json` | `6258b06c4b07fe1980ef4c33bf5926a7feede7e7fc646e8957dd1da070e36525` |
| `templates/implementation-evidence.md` | `templates/implementation-evidence.md` | `0dad1e8e02ae137e0d08231b572fd007c9934a0de62a4060d7af544075595f56` |
| `templates/implementation-evidence.template.json` | `templates/implementation-evidence.template.json` | `82b8d2fe5983be16891d74f05f18d8770872f71b30f31635f8f55fc6e2e8b14c` |
| `templates/requirements.md` | `templates/requirements.md` | `52d3a33a607fb0db4e8305e1a025f9e36110fc53ec84a9f8bc2d20bd7b66f1f3` |
| `templates/requirements.template.json` | `templates/requirements.template.json` | `8c6153039b638df30541f303c23f92e05067439274943680c9ddde40e7f6d785` |
| `templates/review.md` | `templates/review.md` | `4db5cc8af52e57b3fa3989e811d7a3da5f4d19bbf381f268a368bfb3ebfcf8fe` |
| `templates/review.template.json` | `templates/review.template.json` | `3abcdae23fe278d1453f70945eb5a86fc27248a47d270f2d96b4d91247333674` |
| `templates/test-design.md` | `templates/test-design.md` | `0d2a36e7e988c1e889d75d08537005c63f8a6cd761783b8b8d560941f89912e1` |
| `templates/test-design.template.json` | `templates/test-design.template.json` | `f8725b06d6444d5b81626d3b47a41dcf57859c5747fd69be526fcc2ac20f5785` |

The handoff starter `templates/coding-task.md` arrives with handoffs (B14).

## Digests

- **`resources_sha256`** in an application's framework lock binds these bytes. It is the `resource-inventory-v1` digest: SHA-256 of `canonical-json-v1` over `{"digest_contract": "resource-inventory-v1", "files": [{"path", "sha256"}, ...]}`. `files` lists `release.json`, every workflow and template descriptor, and every template's Markdown starter. Each `sha256` hashes the raw file bytes, and entries are sorted by path in Unicode code-point order.
- An extension's `sha256` in the lock uses the same digest over its `extension.json` and every file the manifest declares.

The design package requires these digests but doesn't define how to compute them. This definition is ours, and it's recorded here until the design package adopts one.
