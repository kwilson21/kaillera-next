# HMAC TURN Credential Changes for kaillera-next

## File: server/src/api/app.py

### 1. Add imports after `import re` (line 37):

```python
import time
import base64
```

### 2. Replace the entire `ice_servers` function with:

```python
    @app.get("/ice-servers")
    def ice_servers(request: Request) -> list:
        if not check_ip(_client_ip(request), "ice-servers"):
            raise HTTPException(status_code=429, detail="Rate limited")

        # Public STUN servers (free, no auth needed)
        stun_servers = [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": "stun:stun1.l.google.com:19302"},
        ]

        # Verify request is from an active room participant
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not token or not room_id or room_id not in rooms or not verify_upload_token(room_id, token):
            return stun_servers

        # Check for legacy static ICE_SERVERS (backwards compatible)
        legacy = os.environ.get("ICE_SERVERS")
        if legacy:
            try:
                return json.loads(legacy)
            except json.JSONDecodeError:
                log.warning("ICE_SERVERS env var contains invalid JSON")

        # Generate HMAC time-limited TURN credentials
        turn_secret = os.environ.get("TURN_SECRET", "")
        turn_urls_raw = os.environ.get("TURN_SERVERS", "")
        if not turn_secret or not turn_urls_raw:
            return stun_servers

        # Credentials expire in 24 hours (username = expiry:random_id)
        expiry = int(time.time()) + 86400
        username = f"{expiry}:{room_id}"
        mac = hmac.new(turn_secret.encode(), username.encode(), hashlib.sha1)
        credential = base64.b64encode(mac.digest()).decode()

        # Build TURN server entries from comma-separated TURN_SERVERS env
        turn_entries = []
        for url in turn_urls_raw.split(","):
            url = url.strip()
            if url:
                turn_entries.append({
                    "urls": url,
                    "username": username,
                    "credential": credential,
                })

        return stun_servers + turn_entries
```

## Env vars (already set on the swarm service):
- `TURN_SECRET=85df965c20486ff3215a7b2ffad3984fb07ac195bb8bb4c60646953dde93678b`
- `TURN_SERVERS=turn:turn.thesuperhuman.us:3478,turn:turn.thesuperhuman.us:3478?transport=tcp,turns:turn.thesuperhuman.us:5349?transport=tcp`
- `ICE_SERVERS` has been removed

## Coturn is already updated to use-auth-secret with the matching secret.
