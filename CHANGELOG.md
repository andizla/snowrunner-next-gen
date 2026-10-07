# Changelog

## [1.0.2] 2026-10-08

- Bounce light is off by default and marked experimental: on snow and ice it comes out too strong and blue, in tracks, ruts and along drifts. Its strength of four now stops where a surface reaches 0.6 of the scene's ambient light, which eases the glow and does not cure it. An install made with 1.0.0 or 1.0.1 keeps the card ticked: untick Bounce light and click Apply.
- Volumetric fog is off by default. Its sun shafts have their own switch on the card, Sun shafts, also off: they stay experimental and show over the truck and other things close to the camera. An install made with 1.0.0 or 1.0.1 has the fog with the shafts: Apply takes the shafts out unless the switch is on, and unticking the card takes the fog out.
- Water reflections follow the waves farther out. At 3840 x 2160, from a camera 3 m over the water, the reflection lets go of the waves between about 40 and 130 m. In 1.0.1 that was 7 to 27 m.
- GTAO without the Bounce light card is drawn at half size too, as it already was with the card. In a test scene the frame took 10.24 ms, down from 12.56 ms.
- SnowRunner Shadows makes the smaller levels of its scene copy itself. With a ReShade add-on that changes the game's texture formats those levels stayed empty, and the bounce light lost most of its reach.
- SnowRunner Shadows: after a change of resolution the half-size and depth textures of the old size are released (about 57 MB at 3840 x 2160 stayed each time). The last four sizes are kept and used again when one comes back.
- SnowRunner Shadows: closing the game cannot wait on one of the DLL's locks any more. That could have left the game in the task list without a window. It was not seen in testing.
- SnowRunner Shadows: the reflection pass no longer times itself and writes a line to `SnowRunnerShadows.log` every 10 seconds. `SSRTiming=1` in `SnowRunnerShadows.ini` brings that back.
- Scenery detail has two new rows, both off by default. Shown far away: plants, or everything, no longer vanish at a set distance. Small shadows: plants, or everything, that cast no shadow or lose it a few metres away get one. Both are tested on the game's files and have not been looked at in the game yet.
- Scenery detail: restoring `shared.pak` no longer ends in "does not match the backup" for an install whose note is an older one without the original's hash.
- Xbox app (Game Pass) version: the installer knows its folder layout, with `SnowRunner.exe` next to the paks. It asks to be run as administrator when Windows refuses a pak there, and it notes that SnowRunner Shadows is untested on that version. This is built from a player's description and tested on a stand-in folder only, not on a real install.
- A game folder that was moved or renamed after an install: the installer finds the originals it kept for it.
- Another mod's `hid.dll`: Apply writes SnowRunner Shadows before it renames the other mod's file, and Restore gives a `hid_chain.dll` its own name back also when our `hid.dll` is already gone.
- The window remembers a game folder you picked.
- After an update the status lists the parts an older version built, and the bar says "Apply to update the game to this version".

## [1.0.1] 2026-10-07

- Water reflections: the dotted pattern on far water at flat angles is gone. Far from the camera the reflected ray no longer follows waves that are too small for the screen. The reflection there keeps a ripple, as the game's own reflection has, and the change from near to far is spread over a stretch of water.
- Water reflections show the scene at its own brightness. In 1.0.0 a reflected bank or truck came out about twice as bright as it is under a bright sky.
- The reflection no longer fades out in a band down the left and right edges of the screen, and it dims at the water's outline as the game's own reflection does.
- Lakes: trucks, piers and rocks standing in the water get their mirror image at every resolution. The game's own reflection pass finds them at 1920 x 1080 and loses them at higher resolutions.
- Epic Games version: the game sits in an `en_us` folder there, and SnowRunner Shadows was left out with the note "No Sources\Bin with SnowRunner.exe in this game folder". The installer now looks for `SnowRunner.exe` beside the game's `preload` folder. The check for a running game used the same wrong path.
- The folder above `en_us` and `en_us` itself are one install now, however the game was found or picked: an install made by picking `SnowRunner.exe` carries over.
- A log: every Apply and Restore is written to `install.log` in `%LOCALAPPDATA%\SnowRunnerNextGen`. After a stop or a note, Show the log in the result window opens that folder.
- A copy the unzip program left incomplete says so, names the missing files and asks to unzip again.
- The download is a zip with standard folder paths. The 1.0.0 zip had Windows-style paths, which Linux archive programs unpacked into one flat folder. The 1.0.0 download was replaced on 2026-10-06 with a repacked one.
- Not in this version: the fix for the fog's sun shafts showing over things close to the camera. It moves to a later version.

## [1.0.0] 2026-10-05

- One window with a card for each of 29 modules, 26 of them on by default: shadows and shadow edges, contact shadows, ambient occlusion and bounce light, reflections on paint, water and wet ground, fog, weather, smoke and particles, the night sky and its stars, tonemap, bloom and colour grade, scenery detail and grass reach, and the Next Gen logo.
- Apply builds the game's files for exactly what is ticked, from the copies the program keeps of the game's own files, and installs them. Restore puts every file back as it was.
- The shader modules are prepared on the player's machine from the player's own `shader.pak`.
- When another mod or a game update has changed a file, Apply and Restore ask before they build on it, and the file can be left out.
- When the kept originals are lost while the game still has the changed files, Apply and Restore change nothing and ask for the store's file check first.
- SnowRunner Shadows (`hid.dll`) installs beside another mod's `hid.dll`, which stays loaded.
- It finds the game through Steam, Epic Games and the Microsoft Store.
- Known: the volumetric fog's sun shafts are experimental. The fog is drawn without the scene's depth, so with a low sun the shafts also show over the truck and other things close to the camera. A fix is planned for 1.0.1.
