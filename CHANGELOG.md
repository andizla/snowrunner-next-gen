# Changelog

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
