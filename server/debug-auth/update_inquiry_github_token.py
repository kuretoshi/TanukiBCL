"""Interactively replace the inquiry bridge's GitHub token without exposing it."""

import getpass
import os
from pathlib import Path
import re
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ENVIRONMENT_FILE = Path('/etc/tanuki-inquiry-bridge.env')
REPOSITORIES = ('kuretoshi/TanukiBCL', 'kuretoshi/BetterCrewLink_Net')


def validate_token(token):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', token):
        raise ValueError('GitHub token format is invalid.')


def check_issue_permission(token, repository):
    # An invalid title must fail validation without creating an Issue. GitHub
    # checks repository authorization first (403 for an unauthorized token).
    request = Request(f'https://api.github.com/repos/{repository}/issues',
                      data=b'{"title":null}', method='POST', headers={
                          'Accept': 'application/vnd.github+json',
                          'Authorization': 'Bearer ' + token,
                          'Content-Type': 'application/json',
                          'User-Agent': 'TanukiBCL-Inquiry-Bridge',
                          'X-GitHub-Api-Version': '2022-11-28',
                      })
    try:
        with urlopen(request, timeout=20):
            raise RuntimeError('Unexpected Issue creation; token was not changed.')
    except HTTPError as error:
        if error.code != 422:
            raise RuntimeError(f'Issues permission check failed for {repository} (HTTP {error.code}).') from error


def replace_token(path, token):
    validate_token(token)
    original = path.read_text(encoding='utf-8').splitlines(keepends=True)
    matching = [index for index, line in enumerate(original)
                if line.startswith('INQUIRY_GITHUB_TOKEN=')]
    if len(matching) != 1:
        raise RuntimeError('Expected exactly one GitHub token entry; file was not changed.')
    original[matching[0]] = f'INQUIRY_GITHUB_TOKEN={token}\n'
    staged_path = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix='.tanuki-inquiry-env-', delete=False) as staged:
            staged_path = Path(staged.name)
            os.chmod(staged.name, 0o600)
            staged.writelines(original)
        os.replace(staged_path, path)
    finally:
        if staged_path is not None and staged_path.exists():
            staged_path.unlink()


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run this command with sudo.')
    if not ENVIRONMENT_FILE.is_file():
        raise SystemExit('Inquiry bridge environment file was not found.')
    token = getpass.getpass('GitHub token for both repositories (hidden): ')
    validate_token(token)
    for repository in REPOSITORIES:
        check_issue_permission(token, repository)
        print(f'Issues permission confirmed: {repository}')
    replace_token(ENVIRONMENT_FILE, token)
    print('Token saved. Restart tanuki-debug-auth.service and tanuki-inquiry-discord.service.')


if __name__ == '__main__':
    main()
