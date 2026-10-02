# SnowRunner Next Gen

Graphics modules for SnowRunner, installed from one window.

Each card in the window is one module: sharper shadows, ambient occlusion, bounce light, reflections on paint and water, fog, smoke, colour, the night sky. Tick what you want and click Apply. The program builds the game's files on your machine, from your own game files, and installs them. Restore puts the files back as they were.

It works without ReShade or any other loader. The shaders go into the game's own shader cache, and SnowRunner Shadows is one small DLL next to the game.

## Modules

Light and shadow

- SnowRunner Shadows: hands the reflections and the bounce light the image they need, and can draw the sun's shadow texture at 2, 3 or 3.5 times the size.
- Shadow edges: straight shadow edges rebuilt from the shadow texture, with no texel stairs at any resolution, and blended cascade seams. A 16-tap filter is the other choice.
- Blocker search: shadows sharp at the contact and softer the farther they fall from what casts them.
- Contact shadows: fine sun shadows traced on screen where things touch or overlap.
- GTAO: ground truth ambient occlusion in place of the game's SSAO, at half or full size.
- Wide occlusion: soft shade under trucks, roofs and tree crowns, out to 6 metres.
- Sky ambient: the fill light takes the sky's colour.
- Fill light: less of the flat light that fills in shade.
- Bounce light: sunlit snow, mud and paint light up what stands next to them.

Reflections and water

- Object reflections: paint, glass and chrome mirror the scene around them.
- Headlights in reflections: at night, paint that finds nothing to reflect shows the light of the headlights.
- Water reflections: banks, trees and trucks mirrored in rivers, lakes, seas and puddles.
- Wet ground reflections: wet mud and glossy ground mirror the scene.
- River depth colour: deeper water tints teal or brown from its own colour.
- Sun glow through waves: river waves light up against a low sun.
- Headlight glare cap: tamer headlight shine on wet ground. Off by default.

Atmosphere and image

- Volumetric fog: no banding, a glow toward the sun, and sun shafts through trees and dust.
- Smoke glow: smoke glows when the sun is behind it.
- Smoke shape and softer edges: puffs get a lit and a shaded side and fade softly where they meet the ground.
- Sharper smoke and particles: the particle textures at twice their size.
- Night sky: NASA's star map in place of the game's star texture, and its stars in the photo night skies of Scandinavia, Kola and Quebec.
- Brighter stars: the stars of the night sky drawn brighter.
- Tonemap: stronger contrast and a lighter bloom.
- Bloom soft cut: no haze from bright snow and sky.
- Photo grade: colour closer to a photo.

Scenery, both off by default

- Scenery detail: scenery keeps its full detail farther out.
- Grass reach: grass drawn farther out.

Interface

- Next Gen logo: NEXT GEN under the game's logo on the title screen, the first loading screen, the main menu, the pause menu and the map.

The (?) on each card says what the module does, what to look for, and what it costs.

## Install

1. Close SnowRunner.
2. Unzip the folder anywhere and run `SnowRunnerNextGen.exe`. Nothing else needs to be installed.
3. The program finds the game through Steam, Epic Games or the Microsoft Store. If it does not, pick the game folder.
4. Pick the modules, then click Apply.

The first Apply reads your game's own shaders and prepares the shader modules from them, which takes a minute or two.

## Restore

Click Restore originals. Every file goes back to what it was before SnowRunner Next Gen changed it, and SnowRunner Shadows comes out.

## Other mods and game updates

The program keeps a copy of each file before its first change and builds from those copies. When another mod or a game update has changed one of those files since, Apply and Restore ask first:

- Take it as the original: the program writes its changes over the file as it is now, and Restore puts that state back later, the other mod's changes included.
- Leave it out: the file and its modules stay as they are, and the rest is applied.

A game update or the store's file check replaces the game's files with the originals. Run the program again and click Apply.

## What it changes

In the game folder: `shader.pak` (the shader modules), `shared.pak` (scenery detail), `initial.pak` (grass reach, fill light, stars), `boot.pak` (photo grade, particles, night sky) and `gfx.pak` (the logo) under `preload\paks\client`, and `hid.dll` with its `SnowRunnerShadows.ini` in `Sources\Bin`. Another mod's `hid.dll` stays loaded as `hid_chain.dll`.

The kept originals live in `%LOCALAPPDATA%\SnowRunnerNextGen`. Every new file is written next to the old one, read back and checked before it takes the old one's place. The program refuses to write while the game runs.

## Build

Windows 10 or 11. The window builds with the C# compiler that ships with Windows. The tools run on Node.js 22.2 or newer, and the package carries a copy of its `node.exe`. The shaders need `fxc.exe` from the Windows SDK, and SnowRunner Shadows needs Visual Studio 2022 with the C++ tools.

```
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1
```

`build.ps1` builds the window and compiles the shaders in `engine\replacements` (`engine\tools\build_shaders.js`). Every compiled shader is checked against the list of tested builds, `engine\replacements\shaders.sha256`, and a difference stops the build. `package.ps1` then puts the package together in `out\package\SnowRunnerNextGen` from the `engine` folder: the tools, the compiled shaders and the texture sets. With `-Zip` it also writes `out\SnowRunnerNextGen.zip`, the download of a release.

SnowRunner Shadows is in `dll`: `dll\build.bat` builds `dll\out\hid.dll`, and `dll\test\run_all.ps1` tests it. The package takes the DLL from `assets\engine\hid.dll` and wants the build named in `assets\engine\hid.dll.sha256`, the one the modules were tested with. A rebuild never has that hash, because the linker stamps the time into the file: copy the new DLL there and put its SHA-256 into the `.sha256` file.

The tests run on copies and never touch the game folder: `test\run_tests.ps1` draws the window at four scales and checks the tick rules, `test\engine_test.ps1` runs the engine on a copy of the game made from original paks (`-Originals` names their folder), and `test\package_test.ps1` runs the same against the packaged engine and fails when it reaches any file outside the package.

## Licence and credits

GNU General Public License v3.0 (GPL-3.0-only), see `LICENSE`. Third party notices are in `THIRD_PARTY_NOTICES.md`.

- Ground truth ambient occlusion by Jorge Jimenez, Xian-Chun Wu, Angelo Pesce and Adrian Jarabo (2016); the horizon integration follows Intel's XeGTAO by Filip Strugar and Steve Mccalla.
- The reflection pass follows AMD FidelityFX SSSR, with Eric Heitz's visible normal sampling.
- The contact shadows are a modified copy of Bend Studio's screen-space shadows.
- The rebuilt shadow edges follow revectorization-based shadow mapping by Macedo and Apolinário (2016) and shadow map silhouette revectorization by Bondarev (2014).
- The night sky's star map is made from Deep Star Maps 2020 by NASA's Scientific Visualization Studio.
- The package runs its engine on Node.js.

SnowRunner is a game by Saber Interactive. This project is not affiliated with Saber Interactive or Focus Entertainment.

The repository holds none of the game's files as they ship: the installer makes the patched shaders on the player's machine, from the player's own game. What is made from the game's own material is listed in `THIRD_PARTY_NOTICES.md`: the particle, logo and photo sky textures, and the tonemap shader. It remains Saber Interactive's and is here only for use with the game.
