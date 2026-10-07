# Claude Usage for GNOME

A GNOME Shell extension that shows your Claude plan usage in the top bar.

![Claude usage in the GNOME top bar](docs/topbar.png)

The first number is your current 5-hour session, the second is your weekly limit. The percentages turn yellow at 75% and red at 90%. Click the indicator to see progress bars and when each limit resets.

> Unofficial project, not affiliated with or endorsed by Anthropic.

## Requirements

- GNOME Shell 50
- `jq`
- Claude Desktop and/or Claude Code, signed in with a Claude subscription

## Install

```bash
git clone https://github.com/DinoMalin/gnome-claude-usage.git
cd gnome-claude-usage
./install.sh
```

Then log out and back in. On Wayland, GNOME only picks up new extensions at login.

The installer:

- copies the extension to `~/.local/share/gnome-shell/extensions/claude-usage@dinomalin`
- installs `claude-usage-statusline` to `~/.local/bin`
- sets it as your Claude Code status line in `~/.claude/settings.json`, unless you already have one
- enables the extension

## Update

```bash
git pull
./install.sh
```

Then log out and back in.

## Uninstall

```bash
./uninstall.sh
```

## How it works

By default the extension makes no network requests and never reads your credentials. It watches two local files and shows whichever was updated most recently:

| Source | File | Updated |
| --- | --- | --- |
| Claude Desktop | `~/.config/Claude/plan-usage-history.json` | every 5 to 15 minutes, by the app |
| Claude Code (terminal) | `~/.cache/claude-usage/usage.json` | after every prompt, by the status line script |

Claude Code passes your current rate limits to its status line command. `claude-usage-statusline` saves them to the cache file and prints a short status line like `Opus · 5h 42% · 7d 18%`.

Reset times only come from Claude Code. If you only use Claude Desktop, the menu shows percentages without reset times.

The status line only runs in a terminal `claude` session. The Code tab of Claude Desktop does not run it, so with Claude Desktop alone the indicator updates every 15 minutes or so.

## Faster updates with the usage API

For quicker updates, the extension can ask Anthropic for your usage directly. This is off by default. Turn it on in the extension's preferences:

```bash
gnome-extensions prefs claude-usage@dinomalin
```

When enabled, the extension reads the Claude Code login from `~/.claude/.credentials.json` and requests `https://api.anthropic.com/api/oauth/usage` at the interval you choose (2 minutes by default, 1 minute minimum). It never refreshes or writes the login. If the token has expired, open Claude Code once to refresh it. Errors show up at the bottom of the menu.

This endpoint is undocumented and may change or stop working at any time.

## Keeping your own Claude Code status line

If you already had a status line, the installer leaves it alone. To feed the extension anyway, make your status line command a small wrapper that passes the same input to both:

```bash
#!/usr/bin/env bash
input="$(cat)"
claude-usage-statusline >/dev/null <<<"$input"
your-existing-statusline-command <<<"$input"
```

## Other GNOME versions

Only GNOME 50 is tested. To try another version, add it to `shell-version` in `claude-usage@dinomalin/metadata.json` before running `./install.sh`.

## Troubleshooting

The indicator shows `–` until one of the two files exists. Send a prompt in a terminal `claude` session, or wait for Claude Desktop's next check.

Extension errors end up in the journal:

```bash
journalctl --user -b -g claude-usage
```

## License

GPL-2.0-or-later
