# Local install safety

An enabled user-scoped spacesheep plugin supplies its own remote MCP connection.
`install` reads `plugins/installed_plugins.json` and `settings.json` for each home,
then the installed version's `.mcp.json`. Both bare server maps and `mcpServers`
maps are supported. Paths are followed through symlinks; the plan prints the real
MCP file, its entry key and the `plugin:spacesheep:<server>` name. An entry must
point to the configured MCP endpoint (normally `https://mcp.spacesheep.dev/mcp`)
to suppress the new entry. A server merely
named `spacesheep` at a different endpoint does not suppress it.

The installer skips that home's bridge rather than disable a plugin MCP server.
It writes no per-server disable key and makes no changes to the plugin cache or
its authentication. Existing manually configured routes remain untouched on a
skipped home. `mcp status` also reports plugin routes and any existing bridge.

To migrate the home, set `enabledPlugins["spacesheep@spacesheep"] = false` in its
`settings.json` and rerun install without `--no-skill`. The advisory names the
resolved settings file: on a shared fleet that edit affects every linked home.
Disabling removes both `/sheep` and talk. Install fetches sheep from the existing
skill service and copies talk from the disabled plugin's `commands/talk.md` into
the home's commands directory, marking only its own copy for future updates and
uninstall. An unrelated existing talk command is left alone. A missing cached
talk command is reported; keep/reinstall the plugin cache before migrating.
Enabled plugins continue their own OAuth sign-in until the user disables them.
For homes that are configured, the HTTP/helper route added independently in
1.33.0 is preserved. No plugin cache authentication is changed here. `--except`
and the existing `--skip` both exclude MCP entries and skills; `--skip` also
accepts short home names. Additional homes without `.claude.json` stay unselected
by default, as in 1.33.0.

Claude's [plugin component reference](https://code.claude.com/docs/en/plugins-reference)
documents `.mcp.json` and plugin commands. This is user-home installation; it does
not resolve per-project or managed policy overrides. Project-only installations
in the registry do not suppress a home-wide bridge.

## Claude lock protocol probe

Inspected the published official `@anthropic-ai/claude-code@2.1.63` npm artifact
(`https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.63.tgz`),
without starting Claude or accessing an account. To repeat, unpack `package/cli.js`
into a temporary directory and search its bundled source for
`saveConfigWithLock`, `lockfilePath`, and `Lock file is already being held`.

The config-save function passes an explicit `${configPath}.lock` to the bundled
proper-lockfile `lockSync`, rereads state after acquisition, writes atomically,
and releases in `finally`. The bundled implementation acquires the lock with
`mkdir`, detects `EEXIST`, and releases it with `rmdir`. Its default stale age is
10 seconds. The explicit lock path uses the configured filename even when that
filename is a symlink.

The installer uses the same atomic directory acquisition and holds it for its
synchronous read/modify/rename. It also locks the resolved target when distinct,
so another installer using that target cannot bypass the alias. It refuses any
existing lock, including an old one, without removing it. A dry run only checks
for existing locks and does not create one. Config resolution and atomic writes
also preserve symlinks for Codex, Cursor, VS Code and every other harness config.

Regression tests assert that the lock exists during both read and rename, that a
session save just before acquisition is preserved, that a held lock blocks both
install and uninstall, and that symlinks and file modes survive both operations.

## Repeatable offline fleet plan

Run from this checkout, passing either this checkout or unchanged main:

```sh
node fixtures/install-fleet.cjs /path/to/checkout
```

This uses real harness discovery and planning with a temporary home. Only the
remote key check (107 tools) and skill fetch are stand-ins; it neither contacts a
live account nor changes credentials. It simulates an npx entrypoint, five keyed
homes with one supplied as `CLAUDE_CONFIG_DIR`, and a placeholder. All six link
`settings.json` and `plugins/` to the shared `~/.claude`. The enabled plugin's
registry points to its versioned cache and `.mcp.json`.

The requested options are `--dry-run --only claude-code --except
claude-code:.claude-placeholder`. On main, `--except` was ignored, every home got a
planned bridge and the CLI copy was falsely reported as complete. With the fix,
the placeholder is excluded from MCP and skill plans; the other homes report
the exact plugin route and skip the bridge. The PR includes both complete outputs.
