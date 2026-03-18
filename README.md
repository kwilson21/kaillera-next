# kaillera-next

A modern, cross-platform reimagining of Kaillera netplay. Play retro games online
with friends — starting with SSB64 on Mupen64Plus — through a clean relay server and
a desktop launcher that anyone can build a frontend against.

## Goals

- Cross-platform (macOS, Linux, Windows)
- Works with Mupen64Plus out of the box
- Self-hostable relay servers
- Open frontend protocol — build your own client
- 4 players + spectators, KREC replay recording

## Structure

```
kaillera-next/
├── server/       # Python matchmaking + relay server (FastAPI + asyncio)
├── launcher/     # Desktop launcher (Python + pywebview)
└── protocol/     # Frontend WebSocket protocol spec (v2)
```

See [CLAUDE.md](CLAUDE.md) for architecture details and development notes.

## Status

Early development — v1 targets a working two-player SSB64 session via relay.

## License

GPL-3.0
