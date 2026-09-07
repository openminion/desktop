# Engineering patterns

1. Keep privileged operating-system and daemon communication in Electron main.
2. Keep preload small, typed, and fixed-purpose; never expose raw IPC.
3. Treat renderer payloads as untrusted at the process boundary.
4. Let OpenMinion own agent semantics, sessions, policy, and credentials.
5. Prefer direct code in the current owner over wrappers, managers, registries,
   retries, or fallback behavior without a present contract.
6. Keep one source of truth for each lifecycle and protocol fact.
7. Bind security-sensitive operations to the session, source, grant, frame, and
   current lifecycle state required by their contract.
8. Add focused tests before changing a cross-process or daemon contract.
9. Keep comments short and limited to non-obvious ownership or safety reasons.
10. Keep generated builds, captured media, runtime state, and credentials out of
    Git.

Paths should communicate ownership: the directory names the subsystem and the
file names its local role. Add a new file only when it creates a clearer owner.
