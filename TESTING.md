# Testing Balader

Balader is built so that **anything in the app can be tested from a terminal**, by a person or by an AI agent, without clicking around. There are five layers; pick the cheapest one that answers your question.

| Layer | What it proves | Command | Network |
| --- | --- | --- | --- |
| 1. Rust unit & contract tests | Format tiers, yt-dlp arguments, progress parsing, errors, installer checksums, safe delivery, the command dispatcher | `npm run test:rust` | no |
| 2. CLI harness | The real engine on real links, exactly like the app | `npm run cli -- …` | yes |
| 3. UI unit tests | Formatting, card model, hand layout maths, mock backend | `npm run test:unit` | no |
| 4. End-to-end (Playwright) | The whole UI in WebKit (≈ macOS) and Chromium (≈ Windows): mock flows, visual tour, and the real engine over HTTP | `npm run test:e2e`, `test:shots`, `test:e2e:real` | real only |
| 5. Dev bridge | The *running desktop app*: read state, run actions, native screenshots | `npm run bridge -- …` | – |

`npm test` runs layers 1, 3 and 4 (mock) plus the TypeScript check. CI runs them on macOS and Windows.

## 1. Rust tests

```bash
cargo test                      # core + CLI (fast, no Tauri compile)
cargo test -p balader-core formats   # one module
npm run bindings                # regenerate src/api/bindings/*.ts from the Rust model
```

Highlights: `formats.rs` (real YouTube/TikTok/archive format shapes → tiers), `selector.rs` (every yt-dlp argument combination), `progress.rs` (yt-dlp output lines), `download.rs` (two-part progress weighting, playlist progress, delivery never overwrites), `core.rs` (every dispatcher command is routed).

## 2. The CLI harness (`balader`)

The CLI is the engine without pixels. Every subcommand accepts `--json`.

```bash
npm run cli -- engine status                   # what's installed, versions, JS runtime
npm run cli -- engine install                  # install missing tools (checksums verified)
npm run cli -- engine check                    # newest versions on the release servers
npm run cli -- probe <url>                     # tiers, picks, sizes, audio tracks
npm run cli -- download <url> --tier 720       # real download, live progress
npm run cli -- download <url> --audio mp3 --quality 192
npm run cli -- download <url> --from 1:00 --to 1:20.5   # the cut (add --fast-cut for keyframe cuts)
npm run cli -- download <url> --dry-run        # print the exact yt-dlp command
npm run cli -- call <command> '<json args>'    # ANY dispatcher command, same JSON as the UI
npm run cli -- commands                        # list them
```

Isolation flags (handy for tests): `--home <dir>` keeps settings/history/cache in one folder, `--engine-dir <dir>` shares an already installed engine, `--out-dir <dir>` changes where files land.

## 3. UI unit tests (Vitest)

```bash
npm run test:unit
```

`tests/unit/`: formatters, fan layout geometry, card model (which card sends which request), the store, and the mock backend's job lifecycle under fake timers.

## 4. End-to-end (Playwright)

```bash
npm run test:e2e        # app.spec.ts + cut.spec.ts on WebKit + Chromium, mock backend
npm run test:shots      # tests/e2e/shots.spec.ts → PNGs of every state
npm run test:e2e:real   # tests/e2e/real.spec.ts: web UI → balader serve → real downloads
```

- **Mock backend** (`src/api/mock/`): a deterministic simulator of the Rust core with the same commands, events and job stages. Link keywords pick scenarios: `bot`, `private`, `unsupported`, `live`, `offline`, `ratelimit`, `scrape`, `playlist`/`list=`, `tiktok`, `soundcloud`, `archive.org`, and `fail` (the download dies halfway). URL flags: `?engine=missing`, `?latency=ms`, `?seed=n`, `?timescale=n` (faster simulated time), `?freeze=1` (no animations, stable screenshots), `?history=empty`.
- **Visual tour**: `test:shots` writes `tests/e2e/.output/shots/*.png`: empty table, dealing mid-animation, video/audio hands, TikTok, SoundCloud, archive, playlist, scraped page, errors, downloads, jackpot, settings, engine room, first run, narrow window, and the cut (timeline, dragging with the frame card, typing, audio, SoundCloud, minimum window size, a cut in the pile).
- **Real mode**: starts `balader serve` with an isolated home and the shared engine, then runs real probes and downloads from the browser UI, and checks the files on disk (including the regression "grabbing the audio of a saved video never touches the video"), and measures real cuts with the engine's ffprobe (a 3.5 s video clip, a 15 s MP3).

### Helpers worth knowing (`tests/e2e/helpers.ts`)

- `openApp(page, { timescale, freeze, query })`, `dealUrl(page, url)`, `until(page, s => …)` polls the app snapshot.
- `clickCard(page, key)` / `hoverCard(page, key)` wait for the hand to stop moving (`handSettled`: the deal's springs and the picked card's pop, not the idle bob), move the pointer straight onto the card, aim well inside the part that shows, check the hand hovers that card, and click right there. The hand finds cards by where they rest and a click takes the hovered card, so what's lifted is what gets picked.
- The cut's storyboard sheets are painted by the mock on demand (`mock://storyboard/…`): golden-hour frames stamped with their own time, so a test can check that the right frame shows.

## The in-page test API: `window.__balader`

Available in every build (mock, HTTP and the desktop app):

```js
__balader.snapshot()                     // serialisable state: phase, cards, selection, jobs, engine, modal…
await __balader.until(s => s.phase === 'dealt', 10000)
await __balader.actions.deal('https://…')   // every app action: deal, select, grab, setMode, setContainer…
__balader.dom.click('grab')              // click by data-testid (every control has one)
__balader.fx.freeze(true)                // settle all animations; fx.timeScale(4); fx.reduced(true)
__balader.events()                       // last core events
__balader.sfxLog()                       // which sounds played
__balader.mock                           // mock controls: nextProbeError, setEngine('missing'), opened[], calls[]
```

The dev panel (`?dev=1`, or Ctrl+Shift+D outside the desktop app) gives one-click scenarios for all of the above.

## 5. The dev bridge (debug desktop app)

Debug builds of the desktop app listen on `127.0.0.1:<random port>` and write `dev-bridge.json` (port + token) to the app data folder. `scripts/bridge.mjs` wraps it:

```bash
npm run app                                   # start the debug app (or ./target/debug/balader-app)
npm run bridge -- health
npm run bridge -- state                       # the app's __balader.snapshot()
npm run bridge -- deal https://youtu.be/…     # deal like a user
npm run bridge -- click grab                  # click any data-testid
npm run bridge -- wait "s.jobs[0]?.status === 'done'" 120
npm run bridge -- eval "return document.title"
npm run bridge -- events 30                   # core events seen by the shell
npm run bridge -- snapshot out.png            # native WKWebView screenshot (macOS)
npm run bridge -- reload
```

The bridge only exists in debug builds, only listens on localhost, and every request needs the token.

## Recipes

- **"Does link X work?"** → `npm run cli -- probe X`, then `npm run cli -- download X --dry-run` to see the exact yt-dlp call.
- **"What does state Y look like?"** → mock URL + `?freeze=1`, or add a case to `shots.spec.ts`.
- **"Is it broken in the real app?"** → `npm run app`, then `npm run bridge -- deal X`, `wait`, `snapshot`.
- **New site-specific bug** → save `yt-dlp -J` output, add a test in `formats.rs`/`probe.rs` with the trimmed JSON.
