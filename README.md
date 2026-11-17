<span><img src="assets/icon/icon32.svg" height="32"></span>
<span>&nbsp;&nbsp;</span>
<span><img src="doc/title.svg" height="32"></span>

---

![Cover](doc/cover.svg)

---

A PIXEL-STYLE FALLING-BLOCK PUZZLE GAME FEATURING TETROMINOES

THIS GAME IS **NOT A TETRIS IMPLEMENTATION**; IT HAS ITS OWN ROTATION SYSTEM, SPIN DETECTION RULES, WALL-KICK TABLES, CONTROLS, TERMINOLOGY, AND MORE. IT DOES NOT USE THE SRS ROTATION SYSTEM AND DOES **NOT COMPLY** WITH THE TETRIS GUIDELINE.

## Desktop

Run with LÖVE 11.5:

```sh
love .
```

The existing Windows / `.love` packaging command remains available:

```sh
sh scripts/build.sh 0.1.3
```

That script requires its own Windows packaging tools and clears the entire `build` directory. Run the Web build afterwards if you need both outputs.

## Web (desktop browsers)

The Web edition reuses the Lua game through [love.js](https://github.com/Davidobot/love.js), pinned to npm package **11.4.1** (its bundled engine reports LÖVE 11.4 / Lua 5.1). It uses compatibility mode with 128 MiB initial WASM memory, so static hosting does not need SharedArrayBuffer or COOP/COEP headers. No backend is required.

Install a current Node.js (22 or later), pnpm and the `zip` command, then:

```sh
pnpm install --frozen-lockfile
pnpm build:web
pnpm serve:web
```

Open <http://127.0.0.1:8000> and click **开始游戏**. To use another local port:

```sh
pnpm serve:web --port 8080
```

The build writes `build/web/`, including HTML, JavaScript, WASM, packed game data, a downloadable `.love` archive and license notices. It does not invoke or require the Windows build tools. Upload the **complete contents of `build/web/`** to a static HTTP(S) host; relative URLs also support a subdirectory such as `/pixmino/`. Serve `.wasm` as `application/wasm` and `.mjs` as JavaScript. Opening the HTML directly through `file://` is unsupported. The preview server binds to localhost and is intended for development.

### Controls and skins

Click the game canvas to give it keyboard focus and enable/resume sound. Use arrow keys to navigate menus, Enter to confirm, and Esc to go back or pause. The default gameplay keys are:

| Action | Key |
| --- | --- |
| Move | Left / Right |
| Rotate counterclockwise / clockwise / 180° | Z / X / A |
| Hold | C |
| Hard drop | Space |
| Soft drop / drop to bottom | Down / Up |
| Fullscreen | F4 while the game is focused, or the page button |

Keys can be rebound in the game's input settings. Leaving the game canvas pauses an active game; resume explicitly from its pause menu. Browser-reserved shortcuts may not be bindable. The Web edition targets desktop keyboards and does not provide touch controls.

All four built-in Lua skins (`3d`, `block`, `checker`, `gap`) are bundled and loaded through the existing LÖVE virtual filesystem. The skin selection is saved with other settings. Browser access to native user scripts and custom skins/languages/modes in the desktop configuration directory is unavailable; Web hides the user-script setting and never loads nativefs/FFI. Desktop custom content support is unchanged.

### Saves and audio

Settings and records keep their existing JSON format and are stored locally in **IndexedDB** for the current browser and origin (scheme, host and port). Settings are written shortly after menu operations and immediately on language selection, returning from settings, or losing focus. Record updates are written immediately. The page serializes filesystem sync requests and displays their status; wait for **存档已同步到此浏览器** before closing or reloading.

These are local saves, not cloud sync. Clearing site data removes them, changing the origin uses different storage, and private browsing or browser storage limits can prevent persistence. If initial storage loading fails, the page offers retry or explicitly temporary play; temporary play never flushes defaults over an existing browser save. Failed writes/syncs are reported, and syncs retry. Closing immediately or terminating the browser before a save finishes can still lose recent changes.

Browsers require user interaction before sound can play. Click the canvas again if sound is suspended. love.js compatibility mode has upstream audio limitations; timing and output quality can differ from native LÖVE.

### Validation

```sh
# Build/runtime/storage tests plus both Lua implementations:
# requires zip, unzip, Lua 5.1 (lua5.1) and LuaJIT (luajit).
pnpm test:web

# Real native LÖVE rendering/gameplay smoke, with isolated temporary saves:
# requires LÖVE; Linux uses SDL's offscreen video driver.
pnpm test:love

# Real Chromium and Firefox checks; download test browsers once:
pnpm exec playwright install chromium firefox
pnpm test:browser
```

The browser suite builds a separate `build/web-smoke/` test artifact and serves both test and release pages under subdirectories on a temporary localhost port. It checks language persistence across reload, starts gameplay, and runs the actual Lua/rendering smoke across all four languages, four skins and six built-in modes, basic piece operations, pause and save round trips. Results/screenshots go to `build/browser-results/`. **Deploy only `build/web/`, never the test artifact.** Build alone needs neither Lua interpreters, LÖVE nor the test browsers.

The build applies narrowly matched patches to the pinned love.js runtime for storage initialization/error recovery and audio-context access. Upgrading love.js requires reviewing those source hooks; mismatches fail the build. Runtime sources and notices are available in the [upstream repository](https://github.com/Davidobot/love.js) and generated Web directory.
