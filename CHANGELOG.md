# Changelog

## [1.0.0] unreleased

- One window with a card for each of 28 modules, 25 of them on by default: shadows and shadow edges, contact shadows, ambient occlusion and bounce light, reflections on paint, water and wet ground, fog, smoke and particles, the night sky and its stars, tonemap, bloom and colour grade, scenery detail and grass reach, and the Next Gen logo.
- Apply builds the game's files for exactly what is ticked, from the copies the program keeps of the game's own files, and installs them. Restore puts every file back as it was.
- The shader modules are prepared on the player's machine from the player's own `shader.pak`.
- When another mod or a game update has changed a file, Apply and Restore ask before they build on it, and the file can be left out.
- SnowRunner Shadows (`hid.dll`) installs beside another mod's `hid.dll`, which stays loaded.
- It finds the game through Steam, Epic Games and the Microsoft Store.
