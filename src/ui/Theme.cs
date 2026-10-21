// SPDX-License-Identifier: GPL-3.0-only
// The window's colours: the greys of the in-game Next Gen menu (the overlay's style, snowrunner-gauges src\ng_overlay.cpp),
// the Next Gen logo's orange as the accent, one colour per category tag.
using System.Drawing;

namespace SnowRunnerNextGen
{
    static class Theme
    {
        public static readonly Color Back = Color.FromArgb(20, 20, 22);       // the menu's window
        public static readonly Color Bar = Color.FromArgb(28, 28, 31);        // its title bar
        public static readonly Color Card = Color.FromArgb(42, 42, 46);       // its fields
        public static readonly Color CardHot = Color.FromArgb(54, 54, 59);    // a field under the mouse
        public static readonly Color Border = Color.FromArgb(58, 58, 63);
        public static readonly Color Text = Color.FromArgb(236, 236, 236);
        public static readonly Color Muted = Color.FromArgb(142, 142, 147);
        public static readonly Color Accent = Color.FromArgb(254, 158, 32);       // the middle of the logo's NEXT GEN gradient
        public static readonly Color AccentText = Color.FromArgb(10, 14, 22);
        public static readonly Color LogoTop = Color.FromArgb(255, 203, 57);      // the gradient's top and bottom, as measured
        public static readonly Color LogoBottom = Color.FromArgb(236, 103, 19);   // on the logo picture
        public static readonly Color Good = Color.FromArgb(96, 204, 138);
        public static readonly Color Warn = Color.FromArgb(240, 208, 72);         // yellow, apart from the orange accent
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
                case "INTERFACE": return LogoBottom;
                default: return Muted;
            }
        }
    }
}
