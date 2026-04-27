---
'@psraghuveer/memento': patch
---

Fix `memento init` failing on fresh hosts where the platform data directory (e.g. `~/.local/share/memento/` or `%LOCALAPPDATA%\memento\`) did not yet exist. `init` now creates the parent directory recursively before the writability check, so the first run on a brand-new laptop succeeds.
