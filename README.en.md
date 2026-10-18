<p align="center"><img src="assets/icon.png" width="120" height="120" alt="dsh-android-phone"></p>

<h1 align="center">dsh-android-phone</h1>

<p align="center"><b>Bring a real Android phone into DeepSeek Harness's sidebar</b></p>

<p align="center"><a href="README.en.md">English</a> · <a href="README.md">中文</a></p>

## Features

- With `dsh-better-sidebar` installed, the phone screen is **shown live** in a sidebar tab; without it the AI can **still operate the phone**
- **Sub-millisecond input**: tap, long-press, drag, wheel scroll, pinch zoom, PC keyboard passthrough
- **Screenshots / long screenshots** (scroll-and-stitch)
- The same capabilities are exposed to the model as tools — "AI operates the phone" and "user views the phone" share **one pipeline and one session**
- (still being designed) agents that operate the phone on their own, closing the IM–PC–PHONE loop

## Requirements

| Need | Notes |
| --- | --- |
| Windows 10/11 | Windows only for now |
| DSH | desktop profile, `>= 0.2.0-rc.2` |
| Node | ≥ 20 (zero npm dependencies at runtime: adb is called as a CLI, PNG codec ships in `src/core/png.js`) |
| Android phone | "Developer options → USB debugging" on, plugged in, tap "Always allow" on the RSA prompt; any USB mode works |
| Optional | `dsh-better-sidebar ^0.25.0` — needed only for the sidebar tab. Without it there is no live view in the sidebar, but **settings still work on DSH's "Plugins" page** and the model tools keep working |

## Install

Use DSH's built-in installer; no script to run:

1. DSH → **Settings → Plugins → Add plugin**
2. Enter the **local absolute path** of the plugin directory (e.g. `C:\Tools\dsh-android-phone`); once this repo is public you can also use the Git URL
3. Install (DSH's bundled pnpm handles dependencies and registration)
4. **Restart DSH**

Or via the CLI (equivalent, handy when an agent does the work):
`dsh plugin --profile desktop add "link:<absolute path to the plugin>"` — it sets up the dependency, the `node_modules` link and the `dsh.profile.bundles` registration in one go. If `dsh` is not on PATH, it is usually at `<DSH install dir>\resources\runtime\cli\bin\dsh.cmd`.

After installing, the plugin shows up on DSH's "Plugins" page (enable/disable and configure it there); with better-sidebar installed, a "Phone" tab appears in the sidebar too.

> **Not published to npm yet**, so installing "by package name" does not work — use a local path or the Git URL.
> Install/uninstall details: [Usage · Install & uninstall](docs/usage.md#安装与卸载) (Chinese).

### Let an agent install it

Paste this to the model (it needs to be able to run commands on this machine):

> Install the DSH plugin `dsh-android-phone` on this Windows machine. The plugin directory is `<absolute path to your clone>`.
> Do not click through the UI — install it with the CLI (equivalent to DSH "Settings → Plugins → Add plugin → local path"):
> 1. Find DSH's bundled CLI `dsh`; if it is not on PATH it is usually `<DSH install dir>\resources\runtime\cli\bin\dsh.cmd`.
> 2. Run `dsh plugin --profile desktop add "link:<absolute path to the plugin>"` (use the profile I am actually using; it may not be named `desktop`).
> 3. Restart DSH.
> When done, run `node scripts/doctor.mjs` in the plugin directory (zero dependencies, no `npm install` needed); it must be 10/10 green.
> If anything shows ❌, fix it per the hint (stale adb, phone not connected, profile not registered in `dsh.profile.bundles`).
> Finally tell me: which profile it went into, the doctor result, and whether "restart DSH" or "reload the sidebar" is needed. Do not modify the repository's code files.

## How it works

```
┌─ DSH host process (Node) ──────────────┐
│  session.js  single session / self-heal │      ┌─ phone ─┐
│  video.js    adb reverse + frame parser │ ───► │scrcpy-  │
│  control.js  control message encoder    │ ◄─── │server   │
│  longshot.js frame-by-frame stitching   │      └─────────┘
│  index.js    12 tools + 19 HTTP routes  │
└───────────────┬────────────────────────┘
                │ HTTP (video stream + control)
┌───────────────▼────────────────────────┐
│  DSH sidebar (browser)                  │
│  client.js  WebCodecs decode → canvas   │
└────────────────────────────────────────┘
```

## Documentation

The in-depth docs are currently **in Chinese**:

| Doc | Contents |
|---|---|
| [Usage](docs/usage.md) | install/uninstall details, sidebar gestures, quality presets, settings page, "Open app", session & ownership |
| [Tools & API](docs/tools.md) | the 12 `phone_*` tools, action semantics, 19 HTTP routes |
| [Internals](docs/protocol.md) | the three channels, coordinate space, five key design decisions, performance numbers |
| [Troubleshooting](docs/troubleshooting.md) | self-check, adb lookup order, common issues, cleaning up leftovers |

## Development

Coding conventions (hard rules, common pitfalls, what to check after a change) live in **[AGENTS.md](AGENTS.md)**; workflow in **[CONTRIBUTING.md](CONTRIBUTING.md)**. Both are in Chinese.

## Known limitations

- Windows only
- Non-ASCII text is sent over the control channel as UTF-8 (auto-split at ≤300 bytes); only the adb fallback path is ASCII-only
- Low frame rate on a static screen (5–6 fps): scrcpy's virtual display only produces frames when the content changes — this is expected
- Long screenshots may be slightly misaligned on infinite feeds, lazy-loaded content or countdowns
- On some devices `input swipe` triggers system gestures (the control-channel path is unaffected)

## Disclaimer

- This is a personal open-source project. It is **not affiliated with or endorsed by** JD, Taobao, Pinduoduo, Douyin, WeChat, QQ, Google (Android SDK platform-tools) or Genymobile (scrcpy).
- Use it only on devices **you own or are authorized to use**. Automating some apps may violate their terms of service and put your account at risk — **you bear the consequences**.
- App names, icons and trademarks belong to their respective owners; they are used here only for identification and display, with no claim of any rights.
- The software is provided "AS IS", without warranty of any kind (see [Apache-2.0](LICENSE), section 7).
- If you believe something in this repository infringes your rights, please open an Issue; it will be **removed or replaced promptly** once verified.

## Contributing

Issues and PRs are welcome. Please run `npm run ci` before submitting and fill in the test section of the PR template (screenshots for UI changes, sources for protocol-level changes). See [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese) for the full workflow and code conventions.

This project uses no CLA: submitting a PR under Apache-2.0 means you agree to license your contribution under the same license.

## License & acknowledgements

Code is licensed under the **Apache License 2.0**; see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

- [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0) — `vendor/scrcpy-server` is redistributed unmodified; the video-stream protocol and control channel were implemented independently from its public sources
- [QtScrcpy](https://github.com/barry-ran/QtScrcpy) (Apache-2.0) — reference for product interaction; no code copied
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools) (Google) — `vendor/platform-tools/` is redistributed unmodified, as a runtime dependency only
- Long-screenshot stitching was inspired by [SnowShot](https://github.com/mg-chao/snow-apps) (frame capture + motion estimation + incremental stitching + confidence-based frame rejection); implemented in pure JS without OpenCV
