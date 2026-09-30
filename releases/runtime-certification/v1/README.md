# Runtime certification evidence

This directory holds reviewed evidence for exact packaged Desktop and
OpenMinion runtime pairs. Evidence is committed through a normal protected PR;
the OpenMinion publisher accepts only a full evidence commit reachable from
Desktop `main`.

Qualification files use this path:

```text
qualification/<runtime-version>/<evidence-id>.json
```

Each file has this shape:

```json
{
  "schema_version": 1,
  "kind": "openminion-source-runtime-qualification",
  "runtime": {
    "version": "X.Y.Z",
    "source_release_id": "source.<run>.<attempt>",
    "wheel_sha256": "<64 lowercase hex characters>",
    "wheel_size_bytes": 123
  },
  "desktop": {
    "version": "A.B.C",
    "source_commit": "<40 lowercase hex characters>"
  },
  "compatibility": {
    "min_version": "A.B.C",
    "max_version_exclusive": "A.B.D"
  },
  "targets": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "package_sha256": "<64 lowercase hex characters>",
      "app_asar_sha256": "<64 lowercase hex characters>",
      "verification_id": "<immutable evidence identity>",
      "result": "passed",
      "checks": [
        "old_runtime_reply",
        "owned_daemon_shutdown",
        "packaged_startup",
        "prepare_update",
        "runtime_integrity",
        "same_chat_reply",
        "startup_activation"
      ]
    }
  ],
  "completed_at": "YYYY-MM-DDTHH:MM:SSZ"
}
```

The final file must contain exactly one passing target for each supported
Desktop package: `darwin-arm64`, `linux-x64`, and `win32-x64`. Repeat the target
object with the exact package and `app.asar` digests from each host. The
Desktop version must be a real three-part release version; `0.0.0` is rejected.

Do not hand-author passing results from build logs. Generate the values from
the exact packaged acceptance runs, review the combined file, and retain the
underlying verification artifacts named by each `verification_id`. Publishing
a compatibility record still requires protected environment approval and a
separate metadata PR in `openminion/openminion`.
