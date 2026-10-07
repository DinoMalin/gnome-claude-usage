#!/usr/bin/env bash
set -euo pipefail

uuid="claude-usage@dinomalin"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
script="$HOME/.local/bin/claude-usage-statusline"
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

for cmd in jq gsettings glib-compile-schemas; do
  if ! command -v "$cmd" >/dev/null; then
    echo "Missing dependency: $cmd" >&2
    exit 1
  fi
done

rm -rf "$ext_dir"
mkdir -p "$ext_dir"
cp -r "$repo_dir/$uuid/"* "$ext_dir/"
glib-compile-schemas "$ext_dir/schemas"
install -Dm755 "$repo_dir/claude-usage-statusline" "$script"
echo "Installed extension to $ext_dir"
echo "Installed status line script to $script"

mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' >"$settings"
current="$(jq -r '.statusLine.command // empty' "$settings")"
if [ -z "$current" ]; then
  tmp="$(mktemp)"
  jq --arg cmd "$script" '.statusLine = {type: "command", command: $cmd, refreshInterval: 60}' "$settings" >"$tmp"
  mv "$tmp" "$settings"
  echo "Configured the Claude Code status line in $settings"
elif [[ "$current" != *claude-usage-statusline* ]]; then
  echo "You already have a Claude Code status line ($current), left untouched."
  echo "See the README to feed it into claude-usage-statusline."
fi

if ! gnome-extensions enable "$uuid" 2>/dev/null; then
  enabled="$(gsettings get org.gnome.shell enabled-extensions)"
  if [[ "$enabled" != *"'$uuid'"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
      enabled="['$uuid']"
    else
      enabled="${enabled%]}, '$uuid']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$enabled"
  fi
fi

echo
echo "Done. Log out and back in to load the extension."
