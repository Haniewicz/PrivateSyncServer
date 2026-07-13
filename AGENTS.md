# Codex Instructions

## Branch policy

- Default development branch: `dev`.
- If work starts on any branch other than `dev`, switch to `dev` before making changes.
- Do not make ordinary server changes directly on `master`.
- The deployed Private Sync server should run from `dev` unless the user explicitly asks for a full production release from `master`.
- For server fixes, commit to `dev`, build/test there, and deploy the checked-out `dev` working tree.
- Push `dev` to GitHub when credentials are available; if this server cannot push, create or update the remote `dev` ref from a credentialed environment.
