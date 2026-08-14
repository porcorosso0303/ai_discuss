# Task 9 Codex Quality Hardening Plan

> Execute each production change with a focused failing regression first. The protocol baseline is the non-experimental Codex App Server 0.147.0 schema.

## Constraints

- Use only stable App Server request fields. Do not send `experimentalApi`, `runtimeWorkspaceRoots`, or depend on `activePermissionProfile` because the stable 0.147.0 schema does not expose them.
- Establish permission provenance through a caller-provided, absolute, non-symlink, app-owned `CODEX_HOME`. Install and verify the exact strict config before each launch, then start with `app-server --strict-config`.
- Treat all tool, command, file, approval, reasoning, and stderr data as untrusted and never expose them as provider content.
- Preserve ChatGPT browser login only. Never accept or transmit an OpenAI API key.

## RED → GREEN Groups

### 1. Secure process boundary

- Add launcher tests for the exact permission profile/config, atomic config replacement without touching auth, absolute/non-symlink home validation, strict argv, direct spawn, and an explicit minimal environment that excludes secrets and proxy credentials.
- Implement a small configuration installer and inject the spawn boundary for deterministic tests.

### 2. JSON-RPC transport recovery

- Add tests proving a request timeout fails the whole connection, rejects every pending request once, ignores late bytes, and permits retry only through a fresh client.
- Add bounded drain-aware serialized stdin writes and check stdout remainder limits after every processed line.
- Ensure initialization/disposal errors are always `Error` instances.

### 3. Reply lifecycle and cancellation

- Add provider tests for a fresh ephemeral thread and cwd per reply, complete RoleView serialization exactly once, connection recreation after timeout/crash, and concurrent restart/dispose behavior.
- Add abort tests before and during cwd/thread/turn preparation, including accepted-after-abort interruption of the exact turn.
- Remove persistent role thread history and clean every temporary cwd in `finally`.

### 4. Safe event stream, usage, and errors

- Vendor exact stable 0.147.0 schemas for item lifecycle, token usage, and turn errors, with regenerated hashes/provenance.
- Add tests for final-answer agent-message phases, commentary exclusion, hostile item fail-closed behavior, correlated latest usage, and malformed/old event isolation.
- Add official retryable/nonretryable turn-error mappings and JSON-RPC overload handling without leaking raw server data.

### 5. Login and resource cleanup

- Add tests proving login cancellation settles/removes its waiter, late completion is ignored, and disposal clears login state.
- Replace test cwd no-ops with real cleanup and verify all listeners/processes/directories are released.

### 6. Verification and handoff

- Run Codex-specific tests, full tests, typecheck, build, production audit, vendor hashes, and `git diff --check`.
- Self-review the final diff, commit only Task 9 changes, and report RED/GREEN evidence and the commit SHA.
