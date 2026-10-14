#!/usr/bin/env bash
set -euo pipefail

umask 077
read -rsp 'TanukiBCL GitHub token (Issues write): ' github_token_tanuki
printf '\n'
read -rsp 'BetterCrewLink_Net GitHub token (Issues write): ' github_token_net
printf '\n'
read -rsp 'Discord Bot token: ' discord_token
printf '\n'

if [[ ! "$github_token_tanuki" =~ ^[A-Za-z0-9_-]+$ || ! "$github_token_net" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo 'Invalid GitHub token format.' >&2
  exit 1
fi
if [[ ! "$discord_token" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo 'Invalid Discord token format.' >&2
  exit 1
fi

temporary_file=$(mktemp)
trap 'rm -f -- "$temporary_file"' EXIT
printf 'INQUIRY_GITHUB_REPO_TANUKI=kuretoshi/TanukiBCL\nINQUIRY_GITHUB_REPO_NET=kuretoshi/BetterCrewLink_Net\nINQUIRY_GITHUB_TOKEN=%s\nINQUIRY_GITHUB_TOKEN_NET=%s\nINQUIRY_DISCORD_BOT_TOKEN=%s\nINQUIRY_PUBLIC_BASE=https://debug-auth.kuretoshi.work\n' \
  "$github_token_tanuki" "$github_token_net" "$discord_token" > "$temporary_file"
unset github_token_tanuki github_token_net discord_token

sudo install -o root -g root -m 600 "$temporary_file" /etc/tanuki-inquiry-bridge.env
sudo systemctl restart tanuki-debug-auth.service
sudo systemctl enable --now tanuki-inquiry-discord.service
printf 'Bridge credentials installed; service status: '
systemctl is-active tanuki-inquiry-discord.service
