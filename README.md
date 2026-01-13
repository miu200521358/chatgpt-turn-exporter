# ChatGPT Turn Exporter (PNG) - Firefox for Android Only

Export selected ChatGPT turns (user + assistant) into a viewer tab as 1-turn-per-PNG. Save images manually from the viewer tab.

## Usage

1. Open ChatGPT in Firefox for Android.
2. Tap "Select" in the floating panel to show checkboxes.
3. Check the turns you want.
4. Tap "Export".
5. In the viewer tab, long-press an image or use the "Save" link.

## Options

- Profiles: theme color, width, padding, scale
- Mask: one word per line, case-insensitive toggle

## USB install (personal use)

1. Build an XPI (e.g. `web-ext build -s .`).
2. Transfer the `.xpi` to the device via USB.
3. Use Firefox for Android's debug menu "Install add-on from file".
4. Some environments require AMO unlisted signing.
