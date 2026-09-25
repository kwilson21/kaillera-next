#!/usr/bin/env python3
"""Create the kaillera-next VPS on Hetzner Cloud, behind a Cloudflare Tunnel.

Standard library only. Every credential comes from environment variables and
is never printed:

  HCLOUD_TOKEN            Hetzner Cloud project API token (Read & Write)
  CLOUDFLARE_API_TOKEN    Cloudflare token: Account > Cloudflare Tunnel: Edit
                          (+ Zone > DNS: Edit for --dns)
  CLOUDFLARE_ACCOUNT_ID
  CF_TURN_KEY_ID          optional: Cloudflare Realtime TURN key; without it
  CF_TURN_API_TOKEN       players behind strict NATs can't connect

  python deploy/vps/deploy.py up        # tunnel + firewall + server
  python deploy/vps/deploy.py status    # server state, tunnel connections
  python deploy/vps/deploy.py dns       # point the hostname at the tunnel
                                        # (DNS change: only with the owner's OK)
  python deploy/vps/deploy.py tunnel --service http://127.0.0.1:27890
                                        # the home tunnel (kaillera-next-home),
                                        # for deploy/home; no HCLOUD_TOKEN needed
  python deploy/vps/deploy.py dns --tunnel kaillera-next-home
                                        # point the hostname at the home tunnel

The server has no SSH and no open inbound port. It updates itself from the
repo's main branch every 5 minutes (deploy/vps/kn-update.sh).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "kaillera-next"
# The home setup gets its own tunnel, so re-routing one never points the
# other's connector at an origin it can't reach.
HOME_TUNNEL = "kaillera-next-home"
HCLOUD = "https://api.hetzner.cloud/v1"
CF = "https://api.cloudflare.com/client/v4"
# Tunnel tokens, TURN ids and API tokens are all within this set; anything
# else would need quoting in the env file, so refuse it instead.
SAFE_VALUE = re.compile(r"^[A-Za-z0-9._=+/-]*$")


def env(name: str, required: bool = True) -> str:
    val = os.environ.get(name, "").strip()
    if required and not val:
        sys.exit(f"missing environment variable {name}")
    return val


def call(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        # Error bodies from both APIs carry messages, not credentials.
        sys.exit(
            f"{method} {url.split('?')[0]} -> HTTP {e.code}: {e.read()[:500].decode(errors='replace')}"
        )
    return json.loads(raw) if raw else {}


def hc(method: str, path: str, body: dict | None = None) -> dict:
    return call(method, HCLOUD + path, env("HCLOUD_TOKEN"), body)


def cf(method: str, path: str, body: dict | None = None) -> dict:
    out = call(method, CF + path, env("CLOUDFLARE_API_TOKEN"), body)
    if not out.get("success", True):
        sys.exit(f"Cloudflare {method} {path}: {out.get('errors')}")
    return out.get("result")


def acct() -> str:
    return f"/accounts/{env('CLOUDFLARE_ACCOUNT_ID')}"


def find_tunnels(name: str) -> list[dict]:
    return cf("GET", f"{acct()}/cfd_tunnel?name={name}&is_deleted=false") or []


def tunnel(
    hostname: str, service: str = "http://app:27888", name: str = NAME
) -> tuple[str, str]:
    """Find or create the tunnel, route hostname -> service. Returns (id, token)."""
    found = find_tunnels(name)
    if found:
        tid = found[0]["id"]
        print(f"tunnel: using existing {name} ({tid})")
    else:
        tid = cf(
            "POST", f"{acct()}/cfd_tunnel", {"name": name, "config_src": "cloudflare"}
        )["id"]
        print(f"tunnel: created {name} ({tid})")
    ingress = [
        {"hostname": hostname, "service": service},
        {"service": "http_status:404"},
    ]
    cf(
        "PUT",
        f"{acct()}/cfd_tunnel/{tid}/configurations",
        {"config": {"ingress": ingress}},
    )
    token = cf("GET", f"{acct()}/cfd_tunnel/{tid}/token")
    return tid, token


def render_cloud_init(values: dict[str, str]) -> str:
    text = (HERE / "cloud-init.yaml").read_text()
    for key, val in values.items():
        if not SAFE_VALUE.match(val):
            sys.exit(f"{key} has characters the env file can't hold unquoted")
        text = text.replace(f"@@{key}@@", val)
    left = re.findall(r"@@(\w+)@@", text)
    if left:
        sys.exit(f"cloud-init placeholders left unfilled: {left}")
    return text


def firewall_id() -> int:
    found = hc("GET", f"/firewalls?name={NAME}")["firewalls"]
    if found:
        return found[0]["id"]
    # No rules: all inbound traffic is dropped. Outbound stays open, which is
    # all cloudflared, git and docker need.
    fw = hc("POST", "/firewalls", {"name": NAME, "rules": []})["firewall"]
    print(f"firewall: created {NAME} (no inbound rules)")
    return fw["id"]


def cmd_up(args: argparse.Namespace) -> None:
    if hc("GET", f"/servers?name={NAME}")["servers"]:
        sys.exit(
            f"server {NAME} already exists; it updates itself from {args.branch}. See `status`."
        )
    turn_id, turn_token = env("CF_TURN_KEY_ID", False), env("CF_TURN_API_TOKEN", False)
    if not (turn_id and turn_token):
        print(
            "warning: CF_TURN_KEY_ID / CF_TURN_API_TOKEN not set; deploying without TURN"
        )
    _, tunnel_token = tunnel(args.hostname)
    user_data = render_cloud_init(
        {
            "TUNNEL_TOKEN": tunnel_token,
            "CF_TURN_KEY_ID": turn_id,
            "CF_TURN_API_TOKEN": turn_token,
            "KN_HOSTNAME": args.hostname,
            "KN_BRANCH": args.branch,
        }
    )
    body = {
        "name": NAME,
        "server_type": args.type,
        "location": args.location,
        "image": "ubuntu-24.04",
        "user_data": user_data,
        "firewalls": [{"firewall": firewall_id()}],
        "public_net": {"enable_ipv4": True, "enable_ipv6": True},
        "labels": {"app": NAME},
    }
    server = hc("POST", "/servers", body)["server"]
    print(
        f"server: created {NAME} id={server['id']} type={args.type} location={args.location}"
    )
    print(
        "first boot takes ~5 minutes (Docker install + image build); then run `status`."
    )


def cmd_tunnel(args: argparse.Namespace) -> None:
    # The token is never printed: the machine running cloudflared gets it from
    # the Cloudflare dashboard (deploy/home/README.md).
    name = args.tunnel or HOME_TUNNEL
    tid, _ = tunnel(args.hostname, args.service, name)
    print(f"tunnel: {name}: {args.hostname} -> {args.service} ({tid}); DNS unchanged")


def cmd_status(args: argparse.Namespace) -> None:
    if not env("HCLOUD_TOKEN", False):
        print("server: not checked (no HCLOUD_TOKEN)")
        servers = None
    else:
        servers = hc("GET", f"/servers?name={NAME}")["servers"]
    if servers == []:
        print(f"server: no server named {NAME}")
    for s in servers or []:
        print(
            f"server: {s['name']} {s['status']} {s['server_type']['name']} {s['datacenter']['name']}"
        )
    for t in find_tunnels(NAME) + find_tunnels(HOME_TUNNEL):
        print(
            f"tunnel: {t['name']} status={t.get('status')} connections={len(t.get('connections') or [])}"
        )


def cmd_dns(args: argparse.Namespace) -> None:
    host = args.hostname
    zone_name = ".".join(host.split(".")[-2:])
    zones = cf("GET", f"/zones?name={zone_name}")
    if not zones:
        sys.exit(f"zone {zone_name} not found for this token")
    zid = zones[0]["id"]
    tunnels = find_tunnels(args.tunnel or NAME)
    if not tunnels:
        sys.exit("no tunnel yet; run `up` first")
    target = f"{tunnels[0]['id']}.cfargotunnel.com"
    # A Worker custom domain on the same hostname owns its DNS record; it has
    # to be detached (in the dashboard, or `wrangler` without the route)
    # before the tunnel record can exist. Don't remove it from here.
    domains = cf("GET", f"{acct()}/workers/domains?hostname={host}") or []
    if domains:
        sys.exit(
            f"{host} is still a Worker custom domain ({domains[0].get('service')}); detach it first"
        )
    records = cf("GET", f"/zones/{zid}/dns_records?name={host}") or []
    record = {
        "type": "CNAME",
        "name": host,
        "content": target,
        "proxied": True,
        "comment": NAME,
    }
    if records:
        if len(records) > 1 or records[0]["type"] != "CNAME":
            sys.exit(
                f"{host} has other DNS records {[r['type'] for r in records]}; resolve by hand"
            )
        existing = records[0]
        # Only replace a record this script made (a previous tunnel of ours);
        # a CNAME for some other service is left for a human to decide.
        if existing.get("comment") != NAME or not existing["content"].endswith(
            ".cfargotunnel.com"
        ):
            sys.exit(
                f"{host} is a CNAME to {existing['content']} not made by this script; resolve by hand"
            )
        if existing["content"] == target and existing.get("proxied") is True:
            print(f"dns: {host} already -> {target}")
            return
        cf("PUT", f"/zones/{zid}/dns_records/{existing['id']}", record)
        print(f"dns: {host} CNAME updated -> {target} (proxied)")
    else:
        cf("POST", f"/zones/{zid}/dns_records", record)
        print(f"dns: {host} CNAME created -> {target} (proxied)")


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("command", choices=["up", "status", "dns", "tunnel"])
    p.add_argument("--hostname", default="kaillera-next.thesuperhuman.us")
    p.add_argument(
        "--branch", default="main", help="branch the server deploys and follows"
    )
    p.add_argument(
        "--location",
        default="ash",
        help="Hetzner location (ash, hil, nbg1, fsn1, hel1, ...)",
    )
    p.add_argument(
        "--type", default="cpx21", help="Hetzner server type (cpx21: 3 vCPU, 4 GB)"
    )
    p.add_argument(
        "--tunnel",
        help=f"tunnel name (default {NAME}; {HOME_TUNNEL} for the tunnel command)",
    )
    p.add_argument(
        "--service",
        default="http://app:27888",
        help="origin the tunnel forwards to (tunnel command)",
    )
    args = p.parse_args()
    commands = {
        "up": cmd_up,
        "status": cmd_status,
        "dns": cmd_dns,
        "tunnel": cmd_tunnel,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
