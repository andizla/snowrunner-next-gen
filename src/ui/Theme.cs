// SPDX-License-Identifier: GPL-3.0-only
// The window's colours. Own palette: dark slate, an ice-blue accent, one colour per category tag.
using System.Drawing;

namespace SnowRunnerNextGen
{
    static class Theme
    {
        public static readonly Color Back = Color.FromArgb(17, 19, 25);
        public static readonly Color Bar = Color.FromArgb(24, 27, 36);
        public static readonly Color Card = Color.FromArgb(31, 35, 47);
        public static readonly Color CardHot = Color.FromArgb(38, 43, 58);
        public static readonly Color Border = Color.FromArgb(52, 58, 76);
        public static readonly Color Text = Color.FromArgb(232, 236, 244);
        public static readonly Color Muted = Color.FromArgb(142, 150, 172);
        public static readonly Color Accent = Color.FromArgb(92, 178, 255);
        public static readonly Color AccentText = Color.FromArgb(10, 14, 22);
        public static readonly Color Good = Color.FromArgb(96, 204, 138);
        public static readonly Color Warn = Color.FromArgb(232, 176, 70);
        public static readonly Color Bad = Color.FromArgb(232, 96, 96);

        public static Color Category(string name)
        {
            switch (name)
            {
                case "LIGHT": return Color.FromArgb(247, 196, 88);
                case "SHADOWS": return Color.FromArgb(160, 140, 255);
                case "REFLECTIONS": return Color.FromArgb(110, 214, 226);
                case "WATER": return Color.FromArgb(84, 164, 255);
                case "ATMOSPHERE": return Color.FromArgb(206, 208, 220);
                case "IMAGE": return Color.FromArgb(240, 132, 172);
                case "SCENERY": return Color.FromArgb(124, 204, 112);
                default: return Muted;
            }
        }
    }
}
