# Perch client

Perch gives the Perch iOS app a mailbox to coding agents on your computers. It
is agent-agnostic: the relay only stores and forwards messages, and this client
supplies the adapter. Claude Code is the adapter included today; other agents can
be added without changing the relay.

The phone and each computer exchange messages through a small relay; message
bodies are end-to-end encrypted, so the relay stores and forwards sealed
envelopes it cannot read.

This repository contains the laptop client. The relay is in the
`chalone0808/perch-relay` repository. The iOS app is not in this repository.

The client code is at the repository root; its tests are in `test/`.

The client needs [Bun](https://bun.sh) and, for the current adapter, [Claude
Code](https://claude.com/claude-code) on `PATH`.

## Agents

Claude Code is the only agent adapter included today. The relay and the phone
side are agent-agnostic; adding another agent means adding a client adapter, not
changing the relay.

## Client

Install on every computer that runs your agent (Claude Code today).

### One-command setup

```sh
curl -fsSL https://raw.githubusercontent.com/chalone0808/perch/main/setup.sh \
  | bash -s -- --server https://api.example.com --code <code>
```

It installs Bun (asking where to put it if Bun is absent), clones the repository
to `~/.perch/app`, installs a `perch` command under `<prefix>/bin`, adds the PATH
lines to your shell rc (printed at the end; open a new shell or source it), and
pairs with the one-time code. Without `--code`, it prints the pair command.
Options: `--prefix`, `--source PATH`, `--repo URL`, `--branch BRANCH`.

### Manual setup

```sh
git clone <repository-url> ~/.perch/app
alias perch='bun "$HOME/.perch/app/perch.ts"'   # add to ~/.zshrc or ~/.bashrc
```

Pair with a code from the phone or the relay:

```sh
perch pair https://api.example.com <code>
```

This writes `~/.perch/config.json`. Then start Claude Code through Perch (the
current adapter):

```sh
perch claude [your usual claude flags]
```

`perch claude` writes `~/.perch/hooks.json` and launches Claude with it; it
does not modify your global Claude settings. The phone can then follow the
session and answer permission prompts.

### Client commands

```sh
perch status                     # relay, key, direct, watcher state
perch version                    # client and relay versions
perch direct on|off|status       # direct LAN/Tailscale transport
perch away|home                  # pause or resume phone notifications
perch restart                    # reload the watcher
perch update                     # git pull this client checkout and reload
perch send <session> <text>      # inject a phone message locally
```

Config and state live in `~/.perch` (`config.json`, keys, hooks, socket). Do not
edit `config.json` by hand; re-pairing rewrites it.

## Updating

`perch update` pulls this client checkout and reloads the watcher. The relay is
a separate install with its own repository; update it by rerunning the relay's
`setup.sh` on the server (or `git pull` and restart `perch-relay` for a manual
checkout). Updating one does not update the other.

## Versions

The client reports its `version` and wire `protocol` at startup:

```sh
perch version
```

That prints the running watcher's version and, when paired, the relay's
`GET /v1/version` response. The phone also sees each computer's version through
the normal relay sync and warns when a computer's protocol is too old for the
app.

## Security

- `~/.perch` holds the pairing keys and config; keep it private.
- Revoke a lost computer from the phone, or from the relay with `revoke`.
- The relay never sees message bodies; it stores sealed envelopes and routing
  metadata only.

## Tests

```sh
bun test test/
```

## License

BSD 3-Clause. See `LICENSE`.
