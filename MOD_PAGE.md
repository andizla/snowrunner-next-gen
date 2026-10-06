# SnowRunner Next Gen

Graphics modules for SnowRunner, installed from one window: sharper shadows with straight edges, ground truth ambient occlusion and bounce light, reflections on paint, glass, water and wet ground, volumetric fog with sun shafts, more of the game's weather, the night sky with real stars, and a photo colour grade. Tick the modules you want and click Apply. Restore puts the game's own files back.

It works without ReShade or any other loader. The shaders go into the game's own shader cache, and SnowRunner Shadows is one small DLL next to the game.

## Before and after

Three slider pages in 4K, the game as it ships against the mod with every default module on:

- [A scout on a rock above a valley](https://imgico.com/c/BIvSQBx)
- [The same scout fording a river](https://imgico.com/c/Og5dB1H)
- [A crane truck on a mountain road in the snow](https://imgico.com/c/m0KtL6i)

The pictures were taken in photo mode with the time of day held still and the camera put back to the same spot for both. The other mods and the texture pack were the same on both sides, so what differs is this mod. In the mod pictures the foreground is darker where the moving cloud shadows of the Weather module pass.

## What is in it

Light and shadow: SnowRunner Shadows with a larger shadow texture if you want one, straight shadow edges with blended cascade seams, a blocker search for soft shadow ends, contact shadows, GTAO with a wide search, sky ambient, less fill light, and bounce light from sunlit snow, mud and paint.

Reflections and water: paint, glass and chrome mirror the scene, headlights show in them at night, water and wet ground mirror banks, trees and trucks, deeper water keeps its own colour, and river waves light up against a low sun.

Atmosphere and image: volumetric fog with a glow toward the sun and sun shafts, moving cloud shadows and more weather on every map, smoke that glows against the sun with a lit and a shaded side, sharper particles, the night sky from NASA's star map with brighter stars, a tonemap with more contrast, a bloom without haze, and the photo grade.

Scenery, off by default: scenery detail that pops in less, and grass drawn farther out.

The (?) on each card says what the module does, what to look for, and what it costs.

## Install

1. Close SnowRunner.
2. Unzip the folder anywhere and run SnowRunnerNextGen.exe. Nothing else needs to be installed.
3. The program finds the game through Steam, Epic Games or the Microsoft Store. If it does not, pick the game folder.
4. Pick the modules, then click Apply. The first Apply reads your game's own shaders and prepares the modules from them, which takes a minute or two.

Restore originals puts every file back as it was and takes SnowRunner Shadows out.

## Other mods and game updates

The program keeps a copy of each file before its first change and builds from those copies. When another mod or a game update has changed one of them since, Apply and Restore ask first: take the file as it is now as the original, or leave it out. A game update or the store's file check puts the game's own files back; run the program again and click Apply.

## Known

The fog's sun shafts are experimental: with a low sun they also show over the truck and other things close to the camera. A fix is planned for a later version.

## If something goes wrong

Every Apply and Restore is written to `install.log` in `%LOCALAPPDATA%\SnowRunnerNextGen`. After a stop or a note, Show the log in the result window opens that folder. Send the file along when you report a problem.

## Licence and credits

GNU General Public License v3.0. The source is on GitHub: https://github.com/andizla/snowrunner-next-gen

Ground truth ambient occlusion after Jimenez, Wu, Pesce and Jarabo, with the horizon integration of Intel's XeGTAO; the reflection pass after AMD FidelityFX SSSR; the contact shadows a modified copy of Bend Studio's screen-space shadows; the rebuilt shadow edges after Macedo and Apolinário and after Bondarev; the star map from NASA's Deep Star Maps 2020; the engine runs on Node.js. SnowRunner is a game by Saber Interactive; this project is not affiliated with Saber Interactive or Focus Entertainment.
