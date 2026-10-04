// SPDX-License-Identifier: GPL-3.0-only
// What the window offers: one card per module, in category order. Id is what the engine takes (the fidelity bundle's
// module names; "shadows" = SnowRunner Shadows, the hid.dll; "scenery" and "grass" = the LOD and grass patches; "fill"
// and "stars" = the fill light and the star levels, the other parts of initial.pak; "grade", "particles" and "sky" =
// the photo grade, the particle textures and the night sky in boot.pak; "logos" = the logos in gfx.pak). A card
// may carry option sets (buttons on the card; the first value of each is shown first). Requires: the cards a card needs
// ticked (ticking it ticks them, unticking one of them unticks it).
using System.Collections.Generic;

namespace SnowRunnerNextGen
{
    class OptionSet
    {
        public string Name;         // shown in front of the buttons
        public string[] Labels;     // the buttons
        public string[] Keys;       // what the engine gets for each
        public int Default;
        public OptionSet(string name, string[] labels, string[] keys, int def) { Name = name; Labels = labels; Keys = keys; Default = def; }
    }

    class Module
    {
        public string Id, Title, Category, Group, Description;
        public bool DefaultOn;
        public string[] Requires = new string[0];
        public List<OptionSet> Options = new List<OptionSet>();
    }

    static class Catalog
    {
        static Module M(string id, string category, string title, bool on, string description, params string[] requires)
        {
            Module m = new Module();
            m.Id = id; m.Category = category; m.Title = title; m.DefaultOn = on; m.Description = description; m.Requires = requires;
            m.Group = GroupOf(category);
            return m;
        }

        // the list's sections
        static string GroupOf(string category)
        {
            switch (category)
            {
                case "SHADOWS": case "LIGHT": return "Light and shadow";
                case "REFLECTIONS": case "WATER": return "Reflections and water";
                case "ATMOSPHERE": case "IMAGE": return "Atmosphere and image";
                case "INTERFACE": return "Interface";
                default: return "Scenery";
            }
        }

        public static List<Module> All()
        {
            List<Module> list = new List<Module>();
            Module shadows = M("shadows", "SHADOWS", "SnowRunner Shadows", true,
                "Hands the reflections and the bounce light the image they need, and can draw the sun's shadow texture at a " +
                "higher resolution for finer shadow detail: 1x keeps the game's own size.");
            // 1x keeps the game's own shadow size, which the rebuilt shadow edges make enough
            shadows.Options.Add(new OptionSet("Resolution", new[] { "1x", "2x", "3x", "3.5x" }, new[] { "1", "2", "3", "3.5" }, 0));
            shadows.Options.Add(new OptionSet("Self-shadow fix", new[] { "on", "off" }, new[] { "1", "0" }, 0));
            list.Add(shadows);
            // the sun shadow filter: the rebuilt edges (revec) or the 16-tap filter (crisp), one or the other
            Module edges = M("edges", "SHADOWS", "Shadow edges", true, "Rebuilt straight shadow edges, with no texel stairs, at any resolution.");
            edges.Options.Add(new OptionSet("Method", new[] { "rebuilt edges", "16-tap filter" }, new[] { "revec", "crisp" }, 0));
            // the cascade seam dither (module seam): with the rebuilt edges only
            edges.Options.Add(new OptionSet("Cascade seams", new[] { "blended", "off" }, new[] { "seam", "off" }, 0));
            list.Add(edges);
            list.Add(M("blocker", "SHADOWS", "Blocker search", true, "Shadows sharp at the contact and softer the farther they fall from what casts them."));
            list.Add(M("contact", "SHADOWS", "Contact shadows", true,
                "Fine sun shadows traced on screen where things touch or overlap, in detail the shadow texture is too coarse to hold.",
                "shadows"));

            Module gtao = M("gtao", "LIGHT", "GTAO", true,
                "Ground-truth ambient occlusion instead of the game's SSAO: soft contact shadows in corners, under trucks and in wheel arches.");
            // AOHalf in SnowRunner Shadows' ini: the pass at half size (the default) or full size
            gtao.Options.Add(new OptionSet("Quality", new[] { "half size", "full size" }, new[] { "half", "full" }, 0));
            list.Add(gtao);
            list.Add(M("aofar", "LIGHT", "Wide occlusion", true,
                "GTAO's search reaches on to 6 metres, gently: soft shade under trucks, roofs and tree crowns, with the contact shadows unchanged.",
                "gtao"));
            list.Add(M("ambient", "LIGHT", "Sky ambient", true, "The fill light takes the sky's colour instead of a flat grey."));
            Module fill = M("fill", "LIGHT", "Fill light", true,
                "Less of the flat light that fills in shade: shaded sides, the insides of trees and trucks in shadow get darker, while sunlit parts and the sky stay as they are.");
            fill.Options.Add(new OptionSet("Strength", new[] { "70 %", "55 %", "85 %" }, new[] { "0.7", "0.55", "0.85" }, 0));
            list.Add(fill);
            list.Add(M("gi", "LIGHT", "Bounce light", true,
                "Sunlit snow, mud and paint light up what stands next to them, in their colour: under trucks, in wheel arches, at the feet of walls.",
                "gtao", "shadows"));

            Module refl = M("objrefl", "REFLECTIONS", "Object reflections", true,
                "Paint, glass and chrome mirror the scene around them instead of a painted sky.", "shadows");
            refl.Options.Add(new OptionSet("Method", new[] { "reflection pass", "march only" }, new[] { "sssr", "reflections" }, 0));
            list.Add(refl);
            // a build of the reflection pass's reader, so the march-only method goes without it
            list.Add(M("headglow", "REFLECTIONS", "Headlights in reflections", true,
                "At night, paint that finds nothing on screen to reflect shows the warm light of the headlights.", "objrefl"));
            list.Add(M("water", "WATER", "Water reflections", true,
                "Banks, trees and trucks mirrored in rivers, mud, lakes, seas and puddles, not just the sky; the water's colour gives way to the reflection at shallow angles.",
                "shadows"));
            list.Add(M("puddles", "REFLECTIONS", "Wet ground reflections", true,
                "Wet mud and glossy ground mirror the scene around them: sharp in shiny patches, soft on rough mud.", "shadows"));
            list.Add(M("rivertint", "WATER", "River depth colour", true, "Deeper water tints teal or brown from its own colour instead of fading grey."));
            list.Add(M("crestglow", "WATER", "Sun glow through waves", true,
                "River waves between you and a low sun light up in the water's own colour, wherever the sun really reaches them.", "water"));
            list.Add(M("glare", "WATER", "Headlight glare cap", false, "Tamer headlight shine on wet ground and puddles, with no long bright band across them."));

            list.Add(M("fog", "ATMOSPHERE", "Volumetric fog", true, "No banding, a glow toward the sun, and sun shafts through trees and dust."));
            // the weather, the fourth part of initial.pak: five parts, each its own row; the key of a row that is on is the
            // part's name, and the selection joins them into the tool's comma list
            Module weather = M("weather", "ATMOSPHERE", "Weather", true,
                "More of the game's own weather: moving cloud shadows on every map, showers that swell and ease, drizzle at dusk and night, horizon clouds, rain drawn farther out, fireflies at night and pollen by day.");
            weather.Options.Add(new OptionSet("Cloud shadows", new[] { "on", "off" }, new[] { "shadows", "" }, 0));
            weather.Options.Add(new OptionSet("Showers", new[] { "swell and ease", "as they are" }, new[] { "showers", "" }, 0));
            weather.Options.Add(new OptionSet("Evening drizzle", new[] { "on", "off" }, new[] { "evening", "" }, 0));
            weather.Options.Add(new OptionSet("Horizon clouds", new[] { "on", "off" }, new[] { "horizon", "" }, 0));
            weather.Options.Add(new OptionSet("Far rain and snow", new[] { "on", "off" }, new[] { "far", "" }, 0));
            weather.Options.Add(new OptionSet("Fireflies", new[] { "on", "off" }, new[] { "fireflies", "" }, 0));
            weather.Options.Add(new OptionSet("Pollen", new[] { "on", "off" }, new[] { "pollen", "" }, 0));
            list.Add(weather);
            list.Add(M("smoke", "ATMOSPHERE", "Smoke glow", true, "Exhaust and other smoke glows when the sun is behind it."));
            list.Add(M("smokeshade", "ATMOSPHERE", "Smoke shape and softer edges", true,
                "Smoke and dust puffs get a lit side and a shaded side, and sprites fade more softly where they meet the ground."));
            // the particle sprites at twice the size, into boot.pak beside the photo grade
            list.Add(M("particles", "ATMOSPHERE", "Sharper smoke and particles", true,
                "The game's smoke, dust, spray and spark textures at twice their size, so particles stay crisp up close."));

            // the star map and the photo night skies with its stars painted in, into boot.pak beside the grade and the particles
            list.Add(M("sky", "ATMOSPHERE", "Night sky", true,
                "NASA's star map in place of the game's star texture: the real sky's stars as fine points, with the glow of the Milky Way."));
            // the night sky's star layer times a factor, the third part of initial.pak
            Module stars = M("stars", "ATMOSPHERE", "Brighter stars", true, "The stars of the night sky drawn brighter, so they stand out against the dark.");
            stars.Options.Add(new OptionSet("Brightness", new[] { "3x", "2x" }, new[] { "3", "2" }, 0));
            list.Add(stars);

            list.Add(M("tonemap", "IMAGE", "Tonemap", true, "Stronger contrast and a lighter bloom."));
            list.Add(M("bloom", "IMAGE", "Bloom soft cut", true, "No haze from bright snow and sky."));
            Module grade = M("grade", "IMAGE", "Photo grade", true,
                "Colour closer to a photo: greens, autumn leaves and the violet haze less loud, whites a little lower. Built into the game's own colour grading.");
            grade.Options.Add(new OptionSet("Strength", new[] { "100 %", "50 %" }, new[] { "1", "0.5" }, 0));
            list.Add(grade);

            Module scenery = M("scenery", "SCENERY", "Scenery detail", false,
                "Scenery keeps its full detail farther out, so less pops in while you drive. All meshes makes shared.pak larger than 2 GB.");
            scenery.Options.Add(new OptionSet("Set", new[] { "nature", "all meshes" }, new[] { "nature", "all" }, 0));
            list.Add(scenery);
            Module grass = M("grass", "SCENERY", "Grass reach", false, "Grass drawn farther out. Costs frame rate in grassy areas.");
            grass.Options.Add(new OptionSet("Reach", new[] { "3x", "2x" }, new[] { "3", "2" }, 0));
            list.Add(grass);

            // NEXT GEN under the game's logo, in gfx.pak
            list.Add(M("logos", "INTERFACE", "Next Gen logo", true,
                "NEXT GEN under the game's logo on the title screen, the first loading screen, the main menu, the pause menu and the map."));
            return list;
        }
    }
}
