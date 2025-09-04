# Diagnostics (2025-09-02)

This folder contains the repo health snapshot and duplicate maps used to lock current file locations as the **canonical** implementation (no code changes).

## How we enforce no drift (zero debugging)

1. Generate canonicals from the duplicate map (picks current paths as the truth):
