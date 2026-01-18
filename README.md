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

## 実機デバッグ

1. Firefox で USB デバッグを有効化
   - 設定 > Firefoxについて > ビルド番号を7回タップ > 開発者向けオプション > USBデバッグを有効化
2. Windows 側で下記コマンド

```
web-ext run --target=firefox-android --android-device 57191FDCH005BG --adb-remove-old-artifacts
```

## 提出

1. XPIをビルド

```
cd chatgpt-turn-exporter
web-ext build
```

2. AMOに未掲載で提出
   - https://addons.mozilla.org/developers/

3. 審査通過後、XPIをダウンロード

4. Firefox for AndroidでXPIをインストール
   - デバッグメニュー > ファイルからアドオンをインストール