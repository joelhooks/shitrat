# Hunk Diff Viewer

Hunk is the default Git difftool for ShitRat work.

## System config

```bash
git config --global diff.tool hunk
git config --global difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
git config --global difftool.prompt false
```

## Repo-local config

This repo also mirrors the same config locally:

```bash
git config diff.tool hunk
git config difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
git config difftool.prompt false
```

## Usage

```bash
git difftool
git difftool --staged
git difftool main...HEAD
```

Agent rule: do not launch interactive `hunk diff` or `git difftool` unless Joel asks for an interactive viewer. When a Hunk window is already running, agents should use `hunk session ...` commands to inspect, navigate, reload, and comment.
