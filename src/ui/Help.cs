// SPDX-License-Identifier: GPL-3.0-only
// What the (?) pop-ups say: for each module a few short sections in plain words, and before/after pictures where
// there are some (files <stem>_before.jpg and <stem>_after.jpg in the help folder next to the exe; a pair whose files
// are missing is left out). The header's (?) explains the installer itself.
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class HelpSection
    {
        public string Heading, Text;
    }

    class ComparePair
    {
        public string Name;          // on its tab
        public string Stem;          // help\<Stem>_before.jpg, help\<Stem>_after.jpg
        public string Caption;       // under the picture
        public string BeforeLabel, AfterLabel;
        public string BeforeFile { get { return Path.Combine(Help.Folder, Stem + "_before.jpg"); } }
        public string AfterFile { get { return Path.Combine(Help.Folder, Stem + "_after.jpg"); } }
        public bool Present { get { return File.Exists(BeforeFile) && File.Exists(AfterFile); } }
    }

    class HelpEntry
    {
        public readonly List<HelpSection> Sections = new List<HelpSection>();
        public readonly List<ComparePair> Pictures = new List<ComparePair>();

        public HelpEntry Picture(string name, string stem, string caption, string beforeLabel, string afterLabel)
        {
            ComparePair p = new ComparePair();
            p.Name = name; p.Stem = stem; p.Caption = caption; p.BeforeLabel = beforeLabel; p.AfterLabel = afterLabel;
            Pictures.Add(p);
            return this;
        }
    }

    // what one pop-up shows
    class HelpTopic
    {
        public string Title, Category, Summary;
        public HelpEntry Entry;
    }

    static class Help
    {
        const string Does = "What it does", Notice = "What you will notice", Costs = "What it costs", Choices = "Options",
                     Know = "Good to know", Credits = "Credits";

        // next to this program's own file (also when its code is loaded by a test)
        public static string Folder { get { return Path.Combine(Path.GetDirectoryName(typeof(Help).Assembly.Location), "help"); } }

        public static HelpTopic TopicFor(Module m)
        {
            HelpTopic t = new HelpTopic();
            t.Title = m.Title;
            t.Category = m.Category;
            t.Summary = m.Description;
            HelpEntry e;
            t.Entry = entries.TryGetValue(m.Id, out e) ? e : new HelpEntry();
            return t;
        }

        public static HelpTopic InstallerTopic()
        {
            HelpTopic t = new HelpTopic();
            t.Title = "How it works";
            t.Summary = Header.AppName + " installs, changes and removes the graphics modules of this project, all from one window.";
            t.Entry = E(
                "Pick", "Each card is one module. Ticking a module that needs another ticks that one too, and unticking one unticks what needs it. The (?) on a card tells you what it does. Defaults picks the recommended set.",
                "Apply", "Builds the game's files for exactly what is ticked, from the game's original files, and installs them. To take a module out, untick it and apply again.",
                "Restore originals", "Puts the files back as they were before " + Header.AppName + " changed them and takes SnowRunner Shadows out.",
                "Backups", "Before the first change, shader.pak, shared.pak, initial.pak, boot.pak and gfx.pak are kept as they are in %LOCALAPPDATA%\\SnowRunnerNextGen, and every build starts from those copies.",
                "Other mods", "When another mod (a texture pack, say) or a game update has changed one of those files since, Apply and Restore ask first. Take it as it is now as the original, and " + Header.AppName + " writes its changes over it; Restore then puts it back in that modded state, the other mod's changes included, not the game's own file. Or leave it out: the file and its modules stay as they are.",
                "Before you start", "Close the game: its files cannot be changed while it runs.",
                "Comparing in the game", "With SnowRunner Shadows installed: F8 switches every shader effect off and on, F4 the contact shadows, F5 the ambient occlusion pass between half and full size, F6 the reflection pass, F10 the bounce light, and F11 GTAO against the game's SSAO.");
            return t;
        }

        // sections from heading, text, heading, text, ...
        static HelpEntry E(params string[] headingsAndTexts)
        {
            HelpEntry e = new HelpEntry();
            for (int i = 0; i + 1 < headingsAndTexts.Length; i += 2)
            {
                HelpSection s = new HelpSection();
                s.Heading = headingsAndTexts[i];
                s.Text = headingsAndTexts[i + 1];
                e.Sections.Add(s);
            }
            return e;
        }

        static readonly Dictionary<string, HelpEntry> entries = Build();

        static Dictionary<string, HelpEntry> Build()
        {
            Dictionary<string, HelpEntry> d = new Dictionary<string, HelpEntry>();

            d["shadows"] = E(
                Does, "The sun's shadows are drawn into one shadow texture before every frame. This add-on hands the scene's picture to the bounce light and the reflections, which is why they need it, and can make the shadow texture larger, up to 3.5 times in each direction, so every shadow is drawn with more pixels. It is one small file next to the game (hid.dll) and changes none of the game's own files.",
                Notice, "At 2x and above: finer shadow detail on trees, fences, cranes and trucks, also some way off.",
                Costs, "At 1x the shadow texture costs nothing extra. A larger one costs graphics time while the shadows are drawn, and video memory (a few hundred MB at 3.5x). Measured at 4K on an RTX 4080 with every other module on: 2x 43 fps, 3x 37 fps, 3.5x 33 fps, against 49 fps at the game's own size.",
                Choices, "Resolution: 1x keeps the game's own shadow texture, and Shadow edges keeps its edges straight; 2x, 3x and 3.5x draw it larger for finer detail, at the frame rates above.\nSelf-shadow fix: keeps the game's shadow bias in step with the larger texture, so steep rock faces do not shadow themselves in patches. Leave it on.",
                Know, "In the game, F8 switches every shader effect of this installer off and on again, for a quick comparison. The larger shadow texture stays.");

            d["edges"] = E(
                Does, "The sun's shadow texture has a limited number of texels, so the game draws the edge of a shadow as a staircase of them. Rebuilt edges follows each edge across the texels and draws the straight line they make, so edges come out straight and clean at any resolution, even at the game's own. The 16-tap filter, the earlier method, smooths the edges with 16 samples on an even grid instead.",
                Notice, "Straight, clean edges on the shadows of buildings, trucks, fences and cranes, without the stair pattern.",
                Costs, "Less than the 16-tap filter: about 0.7 ms per frame faster like for like, measured at 4K on an RTX 4080. Rebuilt edges at 1x ran at 64.8 fps where the 16-tap filter at 2x ran at 59.7.",
                Choices, "Method: rebuilt edges (the default) or the 16-tap filter, one or the other.\nCascade seams: the game draws sun shadows in steps of detail (cascades) that change at set distances, which can show as a line where the shadows turn coarser. Blended dithers the last few percent of each step into the next, so the line no longer shows. It comes with rebuilt edges only.",
                Know, "Round shadows can come out slightly angular, and very soft shadow ends keep a little of the stair pattern.",
                Credits, "The rebuilt edges follow revectorization-based shadow mapping by Macedo and Apolinário (2016) and shadow map silhouette revectorization by Bondarev (2014).");

            d["blocker"] = E(
                Does, "Real sun shadows are sharp where an object meets the ground and get softer the farther they fall from it. This looks up how far each shadowed point is from what blocks the sun, and softens the edge to match.",
                Notice, "Crisp contact shadows under tyres and posts, long tree shadows with soft ends.",
                Costs, "Small: one search of 16 samples where shadows fall.",
                Know, "Works together with Shadow edges, with either method.");

            d["contact"] = E(
                Does, "The sun's shadow texture is too coarse for small things: a door handle, a mirror or a stone casts no shadow of its own, and a wheel seems to float just above the ground. For every pixel this follows a short ray towards the sun through what is on screen and adds the shadow of whatever blocks it.",
                Notice, "Wheels and trucks sit on the ground, and small parts such as handles, mirrors and bolts cast their own shadows.",
                Costs, "Some graphics time: one more pass over the screen.",
                Know, "Needs SnowRunner Shadows, which runs the pass. Only what is on screen can cast these shadows. In the game, F4 switches it off and on.",
                Credits, "A modified copy of Bend Studio's screen-space shadows (Copyright 2023 Sony Interactive Entertainment, Apache License 2.0).");

            d["gtao"] = E(
                Does, "Ambient occlusion is the soft shadow where things meet: under a truck, between tyres, in corners. The game's own version is an old depth-only SSAO with a radius that covers the same share of the screen at any distance, which draws a dark outline along every edge and a grey film on flat ground. GTAO (ground truth ambient occlusion) looks along several directions around every pixel, finds how much of the sky the geometry nearby leaves open, and darkens by exactly that, within 1.5 metres in the world.",
                Notice, "No dark outlines along grilles, treads and railings, clean open ground, and soft shadow where things really close in: between twin tyres, inside the frame, where a wheel meets the ground. Thin things such as poles, cables and railings no longer carry a halo.",
                Costs, "More graphics time than the game's own pass at full size. At half size, the default, SnowRunner Shadows draws the pass at half the resolution, then blurs and scales it up: at 4K on an RTX 4080 that took the frame rate from 63.7 to 75.0 fps.",
                Choices, "Quality: half size (the default, much faster) or full size (the sharpest). Half size needs SnowRunner Shadows, which draws the pass; without it the pass runs at full size.",
                Know, "Ambient occlusion has to be on in the game's video settings. Bounce light is built on it. In the game, F11 switches between GTAO and the game's SSAO, and F5 between half and full size.",
                Credits, "Ground truth ambient occlusion by Jorge Jimenez, Xian-Chun Wu, Angelo Pesce and Adrian Jarabo (2016). The horizon integration follows Intel's XeGTAO by Filip Strugar and Steve Mccalla (MIT).")
                .Picture("Roll cage", "gtao_cage", "The dark outlines around the roll cage and along the roof are gone.", "Game's SSAO", "GTAO")
                .Picture("Garage", "gtao_garage", "The grille and the tyres lose the dark outline; the shadow stays where things close in.", "Game's SSAO", "GTAO")
                .Picture("Daylight", "gtao_day", "Rocks and the pipe without dark rims, and open ground without the grey film.", "Game's SSAO", "GTAO");

            d["aofar"] = E(
                Does, "GTAO looks, in several directions around every point, for what hides the sky within 1.5 metres. This lets the same search go on to 6 metres, and what it finds out there darkens only gently: half as much at 1.5 metres, nothing at 6. So the ground under a truck, the walls under a roof and the inside of a tree crown get a soft shade, while the contact shadows stay exactly as GTAO draws them.",
                Notice, "A soft pool of shade under trucks and trailers, shade under roofs and overhangs, a little more depth inside trees.",
                Costs, "Little: about 1 ms per frame at 4K (measured on an RTX 4080). Each pixel looks far out in one direction and shares what it finds with its neighbours.",
                Know, "Needs GTAO. In the game, F11 switches between GTAO (with this) and the game's own SSAO.");

            d["ambient"] = E(
                Does, "Shaded places are lit by one fill colour per map and time of day. This makes the fill light take the colour of the sky above: bluer under a clear sky, warmer toward a low sun. How bright it is stays the game's choice.",
                Notice, "Shade that matches the sky instead of a flat grey.",
                Costs, "Tiny: a few reads of the sky picture.");

            d["fill"] = E(
                Does, "Shade in the game is lit by a strong, even fill light: on many maps it is nearly as bright as the sun, so shaded sides, the insides of trees and trucks in shadow look flat and washed out. This turns that fill light down in the day, dusk and dawn light of every map, so shade gets the depth it has in a photo. Night, the garage and the menus keep theirs. Because less fill light darkens the whole picture, the game's eye adaptation would lift it all back up and sunlit parts would end up brighter than before; so the exposure of the same light is lowered with it, which keeps sunlit parts about where they were.",
                Notice, "Deeper shade under trees and on the shaded sides of trucks and rocks, more depth inside foliage, and sunlit parts that stand out more.",
                Costs, "None: it changes how much of the game's own fill light is used.",
                Choices, "Strength: how much of the fill light stays. 70 % is the default, 55 % gives deep shade, 85 % a light touch.",
                Know, "It changes initial.pak, together with Grass reach, which it keeps. Other mods that change initial.pak change the same file. Sky ambient still colours what fill light is left.");

            d["gi"] = E(
                Does, "Light bounces. Sunlit snow brightens the underside of a truck, and red paint tints the ground beside it. This adds that bounce at short range, up to about 1.5 metres, gathered from the scene's picture every frame.",
                Notice, "Less black under trucks and in wheel arches on bright days, and a faint spill of colour from paint and mud.",
                Costs, "Under 1 ms per frame at 4K (measured on an RTX 4080): it gathers light in the ambient occlusion pass and adds it to every lit material.",
                Know, "Needs GTAO, whose pass it works in, and SnowRunner Shadows, which hands it the scene's picture. In the game, F10 switches it off and on.");

            d["objrefl"] = E(
                Does, "The game's paint, glass and chrome reflect a ready-made picture of the sky, so trucks never mirror what is around them. This makes them reflect what is on screen: the road, the trees and other trucks.",
                Notice, "Paint and windows mirroring their surroundings, most at shallow angles, and chrome showing the ground.",
                Costs, "About 0.3 to 0.4 milliseconds per frame at 4K with the reflection pass.",
                Choices, "Method: the reflection pass traces the reflections of the whole screen in one go (in SnowRunner Shadows), blurs them by how rough each surface is and steadies them over frames; windows, and whatever the pass misses, fall back to the march. March only lets every material search the last frame on its own: the older method, kept as a choice.",
                Know, "Only what is on screen can be reflected, so what is behind the camera shows the sky picture as before. In the game, F6 switches the reflection pass off and on.",
                Credits, "The reflection pass follows AMD FidelityFX SSSR (MIT), with Morgan McGuire and Michael Mara's screen-space ray tracing, Eric Heitz's visible-normal sampling and Marco Salvi's variance clipping.");

            d["headglow"] = E(
                Does, "With Object reflections, a hood or roof whose reflection finds nothing on screen shows a picture of the sky. At night this adds the headlights' warm light to those reflections, where the mirrored ray crosses the headlight beam.",
                Notice, "At night, hoods and roofs pick up the glow of the truck's own lamps.",
                Costs, "None while the lamps are off. With two lamps on, at most 0.15 ms per frame at 4K if glossy paint filled the whole screen (measured on an RTX 4080), so far less in a real frame.",
                Know, "Needs Object reflections with the reflection pass.");

            d["water"] = E(
                Does, "Rivers, mud, lakes, seas and the puddles on the roads reflect what is on screen: banks, trees and trucks, not just the sky. The water's own colour gives way to the reflection at shallow angles, as with real water.",
                Notice, "Mirrored banks and trees in calm water, trucks in the road puddles.",
                Costs, "Small, and only where water is on screen.",
                Know, "Needs SnowRunner Shadows for the scene's picture. What is off screen falls back to the game's own reflection.");

            d["puddles"] = E(
                Does, "Wet ground in the game reflects only a ready-made picture of the sky. This lets it reflect what is really around it, trucks, trees and banks, from the scene SnowRunner Shadows hands over: sharp where the ground is glossy, blurred where it is rough, the way wet mud mirrors. Rough dry ground is left alone.",
                Notice, "Trucks and trees mirrored softly in wet mud and in shiny wet patches, most at shallow angles.",
                Costs, "Some frame rate where a lot of wet ground is on screen: each glossy pixel searches the scene.",
                Know, "Needs SnowRunner Shadows. The road puddles are water, which Water reflections covers. What is off screen falls back to the sky picture. In the game, F9 switches it off and on.");

            d["crestglow"] = E(
                Does, "Looking across water towards a low sun, light comes through the thin tops of the waves and glows in the water's colour: teal in clear water, brown in muddy. This adds that light to the rivers, strongest looking straight into the light, and only where the sun really reaches the water: it reads the game's own sun shadows, so water under trees stays dark.",
                Notice, "Glowing wave tops on rivers against a low sun.",
                Costs, "Small: one more look at the sun's shadow on river water.",
                Know, "The rivers whose shader knows where the sun's shadow falls (12 of the game's 20 river shaders); lakes and seas not yet. Needs Water reflections.");

            d["rivertint"] = E(
                Does, "Deep river water fades to a flat grey in the game. This tints it by its own colour as it gets deeper: teal in clear rivers, brown in muddy ones.",
                Costs, "Tiny.");

            d["glare"] = E(
                Does, "At night, headlights draw a long, very bright band across wet ground and puddles. This caps that highlight, so wet ground still shines, without the band.",
                Costs, "None.",
                Know, "Off by default for now: it was tuned before the reflections changed. Tick it if the band bothers you.");

            d["fog"] = E(
                Does, "The game draws its fog in steps that show as bands. This breaks the bands up, adds a glow toward the sun and lets the fog see the sun's shadows, so shafts of light show through trees and dust.",
                Notice, "Smooth fog and a bright haze toward the sun; with fog and a low sun behind trees, rays of light.",
                Costs, "Small.",
                Know, "The rays need fog and a low sun. On a clear day there is little to see.");

            d["smoke"] = E(
                Does, "Exhaust, smoke, dust and steam glow when the sun is behind them, the way real smoke lights up against the sun.",
                Notice, "Exhaust and dust clouds lighting up when you look toward a low sun.",
                Costs, "Tiny.");

            d["smokeshade"] = E(
                Does, "The game lights each smoke or dust puff as one flat colour. This gives the 80 lit puff sprites shape pixel by pixel: a lit side towards the sun, a shaded far side, lighter tops and slightly darker dense cores. The 110 sprites that fade where they cut into the ground or a truck now fade over twice the distance, so the hard line where a puff meets a surface is gone.",
                Notice, "Rounder, more solid exhaust and dust clouds, and no sharp edge where smoke meets the ground.",
                Costs, "Small: a few more instructions in the particle shaders.",
                Know, "Works with or without Smoke glow.");

            d["particles"] = E(
                Does, "Smoke, dust, spray, sparks, leaves and the other particles are drawn from small textures that the game stretches, so up close they look soft and blocky. This puts in the same textures at twice their size, upscaled from the game's own with NVIDIA's DLSS 5 Visual Enhancer, inside boot.pak next to the photo grade.",
                Notice, "Crisper exhaust, dust clouds and spray near the camera, with the same colours and shapes.",
                Costs, "Video memory for the larger textures. The installer is 114 MB larger for the set.",
                Know, "It changes boot.pak, together with Photo grade and Night sky, which it keeps. Other mods that change boot.pak, such as a texture pack, are kept too: Apply asks before it builds on them.");

            d["sky"] = E(
                Does, "The game's night sky is a small texture whose stars are one texel each. This puts NASA's star map in its place, with four times the pixels: the real sky's stars as fine points, and the glow of the Milky Way. Scandinavia, Kola and Quebec have a photo for a night sky, with the northern lights in it. There the same stars are painted into the photo.",
                Notice, "A night sky full of fine stars, with the Milky Way across it.",
                Costs, "Video memory for the larger sky textures. The installer is 65 MB larger for the set.",
                Know, "It changes boot.pak, together with Photo grade and Sharper smoke and particles, which it keeps, and it sets the levels its photo skies need in initial.pak. The new stars are finer than the game's and come out dim at the game's own level. Brighter stars is set for them.",
                Credits, "The star map is made from Deep Star Maps 2020. Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.");

            d["stars"] = E(
                Does, "The night sky draws its stars as one layer, at a low level set per region. This raises that level at night, dusk and dawn in every region where the stars are their own layer, so they stand out against the dark sky.",
                Notice, "A night sky with clearly visible stars.",
                Costs, "None: it changes how bright the game draws a layer it draws anyway.",
                Choices, "Brightness: three or two times the game's level.",
                Know, "It changes initial.pak, together with Grass reach and Fill light, which it keeps. Three times is the level set for Night sky's star map, whose fine stars come out dim at the game's own level. With the game's own star texture the stars simply come out that much brighter. The regions whose night sky is a photo are not changed by this: with Night sky their photos carry the stars at a fixed level.");

            d["tonemap"] = E(
                Does, "Tonemapping turns the scene's light into the colours of your screen. This uses a curve with stronger contrast that keeps the game's mid-grey where it was, and lightens the bloom.",
                Notice, "Deeper shadows and richer colour, less of a washed-out look.",
                Costs, "None to speak of.");

            d["bloom"] = E(
                Does, "Bloom makes bright things glow. The game's bloom starts early, so bright snow and sky spread a haze over the picture. This gives it a soft threshold: only really bright things glow.",
                Notice, "Clear snowy views without the milky haze; lamps and the sun still glow.",
                Costs, "None to speak of.");

            d["grade"] = E(
                Does, "The game finishes every picture with a colour grade for the time of day. This builds a photographic grade into it: greens, autumn leaves and the violet haze lose some of their loudness, and whites land a little lower instead of glaring. How much of each colour goes was measured against DLSS 5 shots of the same scenes. Greys stay grey, and the game's own grade stays underneath.",
                Notice, "Foliage and hills in the calmer colours of a photo, a haze that reads grey-blue rather than lavender, less glare on white paint and snow.",
                Costs, "None: the game grades the picture anyway.",
                Choices, "Strength: 100 % is the measured grade, 50 % half of it.",
                Know, "It changes the four colour tables that the day, dusk and dawn light use (a few night scenes share them), inside boot.pak, where Sharper smoke and particles and Night sky go too; the garage, the map and the darkest night table keep theirs. Best together with Fill light, which does the shade: this one does the colour. When another mod has added its files to boot.pak (a texture pack, say), Apply asks before it builds on them, and they stay in (see How it works, Other mods).");

            d["scenery"] = E(
                Does, "Rocks, trees and bushes switch to simpler models close to you (some rocks at 10 metres), and the switch shows as shapes and shadows that flip while you drive. This moves the first switch out to at least 40 metres and the later ones to 70, 110 and 160.",
                Notice, "Far less popping on rocks and trees.",
                Costs, "More detailed models drawn farther out: some frame rate in dense forest.",
                Choices, "Set: nature changes rocks, trees and bushes (351 models). All meshes changes every model that has detail steps (1626), which makes shared.pak larger than 2 GB; the game loads it fine.",
                Know, "A game update or a Steam file check puts the original shared.pak back. Apply again afterwards.");

            d["grass"] = E(
                Does, "Most grass fades out about 30 metres from the camera. This draws it farther: three or two times the game's distances.",
                Costs, "Frame rate in grassy areas: at 3x about nine times as much grass is drawn.",
                Choices, "Reach: 3x or 2x the game's fade distances.",
                Know, "It changes initial.pak, a file that other mods change too.");

            d["logos"] = E(
                Does, "Adds NEXT GEN under the game's logo wherever the interface shows it: on the title screen, the first loading screen, the main menu, the pause menu and the map.",
                Notice, "The mod's name under the SnowRunner logo, so you can tell at a glance that it is installed.",
                Costs, "Nothing in the game. The first Apply keeps a copy of gfx.pak, several hundred MB, so that Restore can put it back.",
                Know, "It changes gfx.pak, the file of the interface. The title screen, the first loading screen and the main menu have a picture of their own for the logo, and those are replaced whole. On the pause menu and the map the logo shares a sheet with other pictures: there only the logo changes, so an interface mod's sheet keeps everything else, and a sheet with another layout is left as it is.");

            return d;
        }
    }
}
