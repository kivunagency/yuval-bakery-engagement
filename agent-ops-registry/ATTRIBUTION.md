# Attribution and provenance

## Origin

This template is derived from **AgentBridge / NavWebmcp**, a reference
implementation by **eliadco5**:

* Repository: https://github.com/eliadco5/NavWebmcp
* License: **MIT**, Copyright (c) 2026 eliadco5
* Reviewed at commit `0513cff` (master, 2026-07-23)

The MIT license permits this reuse. The copyright notice below must be retained
in any distribution of derived code, including anything we ship to a client.

```
MIT License

Copyright (c) 2026 eliadco5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Relationship: the author is Ran's brother. We have direct access for questions
and can contribute improvements back.

## Security gate

Cleared before adoption, per agency supply-chain policy:

* **SkillSpector** (pinned `skillspector:c2d09df`, `--no-llm`): raw verdict was
  score 100 / CRITICAL / DO_NOT_INSTALL, but roughly 28 of 30 findings were
  false positives (HTML comments read as "hidden instructions", SRI integrity
  hashes read as "tool parameter abuse", documentation code samples matched by
  YARA). The two real findings were outdated dependencies, not malicious code.
* **boaz** (Opus 4.8, 2026-07-19): `malicious_code_found: false`.
  `verdict_read: PASS`, `verdict_adopt: PASS_WITH_CONDITIONS`.
  Report: `~/MakeCompany-clients/kivun-agency/cybersec/skillspector/navwebmcp-boaz-review-2026-07-19.md`

Verified clean: no `eval`/`Function`/`child_process`, no obfuscation, every
`fetch` same-origin, no embedded secrets, no npm lifecycle scripts, all 291
lockfile entries resolving to `registry.npmjs.org`.

The conditions from that review are encoded in `SECURITY.md`.

## What we changed, and why

This is not a copy. Deliberate deviations from the reference implementation:

| Change | Reason |
|---|---|
| `lib/auth.ts` reduced to a contract; demo users and plaintext passwords removed | Those were correct for a demo and forbidden in a Kivun build (Rule 12) |
| `tenantId` added to `OperationContext`, required | Our clients are multi-tenant; makes tenant scoping impossible to forget |
| Audit log made a pluggable sink, with key redaction and `crypto.randomUUID` | Original was a 100-entry in-memory buffer with `Math.random()` ids |
| `runOne` no longer rebuilds its name index on every dispatch | Original called `invalidateOpCache()` per call, O(n) per dispatch. Does not scale to the hundreds or thousands of operations this pattern targets |
| Module tree made config-injected via `createModuleTree` | Original hardcoded the hospitality domain |
| MCP adapter rejects instead of defaulting to a guest role | Fail closed |
| `describe_tool` and `load_tools` return `UNKNOWN_TOOL` rather than `FORBIDDEN` for out-of-role operations | Avoids confirming that a privileged operation exists |
| In-page WebMCP surface not included | Rides an unstable standard and needs a polyfill. Opt in per project |

## Contribute back

The dispatch-cache fix is a genuine bug worth reporting upstream: `runOne`
calls `invalidateOpCache()` on every dispatch, so the name map is rebuilt on
every call. Harmless at 50 operations, material at the ~2,500 the design
targets for the Optima3 port.
