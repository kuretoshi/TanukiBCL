"""Post a published GitHub release to X using OAuth 1.0a."""

import json
import os
import re
import sys

def release_summary(body):
    bullets = []
    for line in body.splitlines():
        if line.strip().startswith("<!--"):
            break
        match = re.match(r"^\s*[-*]\s+(.+)", line)
        if match:
            text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", match.group(1))
            text = re.sub(r"[*`_]", "", text).strip()
            if text:
                bullets.append(f"・{text}")
        if len(bullets) == 2:
            break
    return "\n".join(bullets)


def post_text(release, product):
    tag = release["tag_name"]
    url = release["html_url"]
    heading = f"📢 {product} {tag} を公開しました"
    suffix = f"\n\n{url}"
    summary = release_summary(release.get("body") or "")
    # X can count some Unicode characters as two units. Leave ample room for
    # the shortened release URL (23 units) and the full post's punctuation.
    available = 120 - len(heading) - 4
    if available < 0:
        raise ValueError("Release title and URL are too long for an X post")
    if len(summary) > available:
        summary = summary[: available - 1].rstrip() + "…"
    return heading + (f"\n\n{summary}" if summary else "") + suffix


def main():
    import requests
    from requests_oauthlib import OAuth1

    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event_file:
        release = json.load(event_file).get("release")
    if not release or release.get("draft"):
        sys.exit("This workflow requires a published release event.")

    names = (
        "X_API_KEY",
        "X_API_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_TOKEN_SECRET",
    )
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        sys.exit(f"Missing GitHub Secrets: {', '.join(missing)}")

    auth = OAuth1(
        os.environ["X_API_KEY"],
        os.environ["X_API_SECRET"],
        os.environ["X_ACCESS_TOKEN"],
        os.environ["X_ACCESS_TOKEN_SECRET"],
    )
    content = post_text(release, os.environ["X_PRODUCT_NAME"])
    response = requests.post(
        "https://api.x.com/2/tweets",
        json={"text": content},
        auth=auth,
        timeout=20,
    )
    if response.status_code != 201:
        sys.exit(f"X rejected release post (HTTP {response.status_code}): {response.text[:500]}")
    post_id = response.json().get("data", {}).get("id")
    print(f"Posted release {release['tag_name']} to X: https://x.com/i/web/status/{post_id}")


if __name__ == "__main__":
    main()
