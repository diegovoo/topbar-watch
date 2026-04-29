# Topbar Watch

Topbar Watch is a small GNOME Shell extension that shows text from watched files in the top bar.

It is useful for lightweight status output from scripts, sync tools, build jobs, timers, or any process that can write a short line of text to a file.

## Features

- Shows one or more status items in the GNOME top bar.
- Watches files and updates automatically when their contents change.

## Configuration

Open the preferences window from GNOME Extensions, Extension Manager, or by clicking the extension in the top bar.

Each status item has:

- `ID`: a unique name for the item.
- `Watched file path`: the text file the extension should display.
- `Separator`: text shown before the item.
- `Left margin` and `Right margin`: spacing around the item in pixels.

User settings are saved to:

```text
~/.config/topbar-watch/status-items.json
```

The `status-items.json` file included in this repository is only the default example used when no user configuration exists yet.

## Example

Create a watched file:

```bash
mkdir -p "$XDG_RUNTIME_DIR/topbar-watch"
echo "Build passed" > "$XDG_RUNTIME_DIR/topbar-watch/build-status.txt"
```

Clear the item from the top bar:

```bash
printf "" > "$XDG_RUNTIME_DIR/topbar-watch/build-status.txt"
```

## Manual Install

Clone or copy this repository to your local GNOME Shell extensions directory:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r topbar-watch ~/.local/share/gnome-shell/extensions/topbar-watch@diegovoo.github.io
```

Then reload GNOME Shell or log out and back in, and enable the extension:

```bash
gnome-extensions enable topbar-watch@diegovoo.github.io
```
