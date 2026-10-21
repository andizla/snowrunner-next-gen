Next Gen Graphics (SnowRunner Next Gen before October 2026): graphics modules for SnowRunner, in one window.

1. Close SnowRunner.
2. Unzip this folder anywhere and run SnowRunnerNextGen.exe. Nothing else needs to be installed. For the Skies card,
   unzip the sky pack (SnowRunnerNextGen_Skies.zip, a download of its own) into the same folder; without it the skies
   are left out.
3. Pick the modules, then Apply. Restore puts the files back as they were before Next Gen Graphics changed them.

The first Apply reads your game's own shaders and prepares the shader modules from them (a minute or two). The
originals of every file the program changes are kept in %LOCALAPPDATA%\SnowRunnerNextGen until you restore them.

The textures in this folder: the particle textures, the logos and two photo night skies are made from the game's
own, the star map is NASA's, and the skies and reflection cubes are made from CC0 photographs by Poly Haven. THIRD_PARTY_NOTICES.md has the details.

Other mods: when another mod (a texture pack, say) or a game update has changed one of those files since,
Apply and Restore ask first. If you take the file as it is now as the original, Next Gen Graphics writes its
changes over it, and Restore puts it back in that modded state, the other mod's changes included, not the game's own
file. Or leave it out: the file and its modules stay as they are.

When something goes wrong: every Apply and Restore is written to %LOCALAPPDATA%\SnowRunnerNextGen\install.log.
Send that file along when you report a problem.

Licence: GNU GPL version 3 (LICENSE). Third-party notices: THIRD_PARTY_NOTICES.md and licenses\.
