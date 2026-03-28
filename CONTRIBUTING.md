# Contributing to kaillera-next

Thanks for your interest in contributing! This project is open to contributions of all kinds — code, bug reports, testing, gamepad profiles, and ideas.

## Getting started

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip for dependency management
- Redis
- [Tailscale](https://tailscale.com) (for HTTPS dev — required by browsers for SharedArrayBuffer)
- [just](https://github.com/casey/just) (command runner)

### Setup

```bash
# Install dependencies
just setup

# Generate HTTPS certs (one-time, requires Tailscale)
just certs

# Start dev server
just dev
```

See [README.md](README.md) for full setup details including Tailscale configuration.

## Ways to contribute

### Bug reports

Found something broken? [Open an issue](https://github.com/kwilson21/kaillera-next/issues/new) with:
- What you were doing
- What happened vs. what you expected
- Browser + OS + device (especially mobile)
- Console errors if any

### Testing

The most valuable contribution right now is just **using the app** and reporting what's confusing, broken, or missing. Try it on different devices, browsers, and network conditions.

### Gamepad testing

If you have a controller that doesn't work well or has wrong mappings, open an issue with:
- Controller name (as shown in the overlay)
- Browser + OS
- What's wrong (buttons swapped, analog drift, etc.)

### Code contributions

1. Fork the repo
2. Create a branch (`git checkout -b my-fix`)
3. Make your changes
4. Run the pre-commit hooks (`pre-commit run --all-files`)
5. Open a PR with a clear description of what you changed and why

#### Code style

- **Python:** Formatted by ruff, type hints encouraged
- **JavaScript:** Modern ECMAScript (const/let, arrow functions, async/await, optional chaining). No ES modules — the frontend uses IIFEs + window globals for EmulatorJS interop.
- **HTML/CSS:** Formatted by prettier

Pre-commit hooks handle formatting automatically.

### Ideas and suggestions

Have an idea for a feature? Open an issue tagged with your suggestion. Even rough ideas are welcome — we can figure out scope together.

## Project structure

```
server/     Python signaling server (FastAPI + Socket.IO)
web/        Static frontend (HTML + JS)
build/      WASM core build system (Docker + C patches)
tests/      E2E tests (pytest + Playwright)
docs/       Roadmap and design specs
```

The server handles room management and WebRTC signaling. Once peers connect, game data flows directly between browsers via WebRTC — the server is idle during gameplay.

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 License](LICENSE).
