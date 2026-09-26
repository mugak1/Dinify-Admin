# Vendored Claude Code plugin marketplace

`claude-code-review.yml` installs the `code-review` plugin from this directory
(`plugin_marketplaces: ./.github/claude-plugins`) instead of from
`https://github.com/anthropics/claude-code.git`. That URL is the upstream default
branch, so every review run would execute whatever the plugin said at that moment,
in a job holding `CLAUDE_CODE_OAUTH_TOKEN` and a PR-write token. The action only
accepts a marketplace URL ending in `.git`, so it cannot be pinned to a ref; a
local path can be.

Source: `anthropics/claude-code` at `7779afb12e3635f46f56ec823979d68350ae000b`,
files copied byte for byte:

- `plugins/code-review/.claude-plugin/plugin.json`
- `plugins/code-review/commands/code-review.md`

`.claude-plugin/marketplace.json` is upstream's, cut down to the `code-review`
entry and renamed `dinify-claude-plugins` (with our own `owner`): Claude Code
reserves the upstream name `claude-code-plugins` for GitHub sources in the
`anthropics` organisation and refuses to add a local marketplace under it. The
workflow therefore installs `code-review@dinify-claude-plugins`; the command is
still `/code-review:code-review`.

To update: fetch a newer upstream commit, review the diff of those two files,
copy them in, and change the commit named here and in `marketplace.json`.
