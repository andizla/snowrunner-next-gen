// SPDX-License-Identifier: GPL-3.0-only
// The window's fonts and measures, all taken from one body font. Unit is one pixel at 100 % scaling (the body font's
// line height over 18, the height of a 10 pt Segoe UI line at 96 dpi), so every gap, radius and button grows with the
// text. The fonts are made in pixels: what is measured on the screen is what a picture of the window draws.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    sealed class Look : IDisposable
    {
        public readonly Font Body, Strong, Small, Tag, Mark, Title, Heading, Head;
        public readonly float Unit;

        public const TextFormatFlags Wrap = TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
        public const TextFormatFlags Line = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis;
        public const TextFormatFlags Middle = Line | TextFormatFlags.VerticalCenter;
        public const TextFormatFlags Center = Middle | TextFormatFlags.HorizontalCenter;

        // The body font: the system's message font (9 pt Segoe UI, larger when the user made text bigger) at 10/9 of
        // its size. scale 0 = the screen's own scaling; otherwise the scaling to draw at (1 = 100 %), for pictures.
        public static Font BaseFont(float scale)
        {
            float dpi = scale * 96f;
            if (scale <= 0) using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) dpi = g.DpiY;
            using (Font system = SystemFonts.MessageBoxFont)
                return new Font(system.FontFamily.Name, system.SizeInPoints * 10f / 9f * dpi / 72f, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        public Look(Font body)
        {
            string family = body.FontFamily.Name;
            float size = body.Size;
            Body = new Font(family, size, FontStyle.Regular, body.Unit);
            Strong = new Font(family, size, FontStyle.Bold, body.Unit);
            Small = new Font(family, size * 0.9f, FontStyle.Regular, body.Unit);
            Tag = new Font(family, size * 0.74f, FontStyle.Bold, body.Unit);
            Mark = new Font(family, size * 0.86f, FontStyle.Bold, body.Unit);
            Title = Semibold(body, 1.12f);
            Heading = Semibold(body, 1.3f);
            Head = Semibold(body, 1.85f);
            Unit = Body.Height / 18f;
        }

        // Segoe UI Semibold where Windows has it (7 and later), bold otherwise
        static Font Semibold(Font body, float size)
        {
            Font f = new Font("Segoe UI Semibold", body.Size * size, FontStyle.Regular, body.Unit);
            if (f.Name == "Segoe UI Semibold") return f;
            f.Dispose();
            return new Font(body.FontFamily.Name, body.Size * size, FontStyle.Bold, body.Unit);
        }

        // n pixels at 100 %, in pixels at this scaling (at least 1 for anything above 0)
        public int U(float n) { return n <= 0 ? 0 : Math.Max(1, (int)Math.Round(n * Unit)); }
        public float F(float n) { return n * Unit; }

        // Text is measured on a bitmap, not the screen: the controls draw into memory bitmaps (double buffering), where
        // glyphs come out a little narrower than a screen measure says, which left an empty line under some wrapped
        // text. Measured on a bitmap, the lines match what is drawn at every width tried (100, 200 and 225 %).
        static Bitmap measureBitmap;
        static Graphics measureGraphics;

        static Graphics MeasureSurface
        {
            get
            {
                if (measureGraphics == null)
                {
                    measureBitmap = new Bitmap(1, 1, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    measureGraphics = Graphics.FromImage(measureBitmap);
                }
                return measureGraphics;
            }
        }

        public static Size Measure(string text, Font font)
        {
            if (string.IsNullOrEmpty(text)) return new Size(0, font.Height);
            return TextRenderer.MeasureText(MeasureSurface, text, font, new Size(int.MaxValue, int.MaxValue), Line);
        }

        public static Size Measure(string text, Font font, int width, TextFormatFlags flags)
        {
            if (string.IsNullOrEmpty(text)) return new Size(0, 0);
            return TextRenderer.MeasureText(MeasureSurface, text, font, new Size(Math.Max(1, width), int.MaxValue), flags);
        }

        public static void Text(Graphics g, string text, Font font, Rectangle r, Color color, TextFormatFlags flags)
        {
            if (!string.IsNullOrEmpty(text) && r.Width > 0 && r.Height > 0) TextRenderer.DrawText(g, text, font, r, color, flags);
        }

        // anti-aliased shapes whose edges fall on pixel edges
        public static void Smooth(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.Half;
        }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            GraphicsPath p = new GraphicsPath();
            float d = Math.Min(2 * radius, Math.Min(r.Width, r.Height));
            if (d < 1) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void Fill(Graphics g, Rectangle r, float radius, Color color)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (GraphicsPath p = Rounded(r, radius))
            using (SolidBrush b = new SolidBrush(color))
                g.FillPath(b, p);
        }

        // a line of this width just inside r
        public static void Stroke(Graphics g, Rectangle r, float radius, Color color, float width)
        {
            if (r.Width <= width || r.Height <= width) return;
            RectangleF inner = new RectangleF(r.X + width / 2, r.Y + width / 2, r.Width - width, r.Height - width);
            using (GraphicsPath p = Rounded(inner, Math.Max(0, radius - width / 2)))
            using (Pen pen = new Pen(color, width))
                g.DrawPath(pen, p);
        }

        // Option buttons: widths for these labels, and the row drawn on a recessed track (the picked one filled, in the
        // accent when active; the hovered one lit; a ring when it has the keyboard)
        public int[] SegmentWidths(string[] labels)
        {
            int[] widths = new int[labels.Length];
            for (int i = 0; i < labels.Length; i++) widths[i] = Measure(labels[i], Body).Width + 2 * U(12);
            return widths;
        }

        public int SegmentHeight { get { return Body.Height + U(10); } }
        public int SegmentInset { get { return U(3); } }

        public void DrawSegments(Graphics g, Rectangle[] buttons, string[] labels, int picked, int hot, bool active, Color track, bool ring)
        {
            if (buttons.Length == 0) return;
            int inset = SegmentInset;
            Rectangle all = Rectangle.FromLTRB(buttons[0].Left - inset, buttons[0].Top - inset, buttons[buttons.Length - 1].Right + inset, buttons[0].Bottom + inset);
            Fill(g, all, F(8), track);
            if (ring) Stroke(g, all, F(8), Theme.Accent, F(1.5f));
            for (int i = 0; i < buttons.Length; i++)
            {
                bool chosen = picked == i;
                if (chosen) Fill(g, buttons[i], F(6), active ? Theme.Accent : Theme.Border);
                else if (hot == i) Fill(g, buttons[i], F(6), Mix(track, Theme.Text, 0.1f));
                Text(g, labels[i], Body, buttons[i], chosen ? (active ? Theme.AccentText : Theme.Text) : Theme.Muted, Center);
            }
        }

        // the (?) mark: a ring with a question mark, lit when hovered
        public void DrawMark(Graphics g, Rectangle r, bool hot, Color back)
        {
            float w = Math.Max(1f, F(1.3f));
            if (hot) using (SolidBrush b = new SolidBrush(Mix(back, Theme.Accent, 0.2f))) g.FillEllipse(b, r.X, r.Y, r.Width, r.Height);
            using (Pen p = new Pen(hot ? Theme.Accent : Mix(Theme.Border, Theme.Muted, 0.45f), w))
                g.DrawEllipse(p, r.X + w / 2, r.Y + w / 2, r.Width - w, r.Height - w);
            Text(g, "?", Mark, r, hot ? Theme.Accent : Theme.Muted, Center);
        }

        // a + (b - a) * t, opaque
        public static Color Mix(Color a, Color b, float t)
        {
            return Color.FromArgb(
                (int)Math.Round(a.R + (b.R - a.R) * t),
                (int)Math.Round(a.G + (b.G - a.G) * t),
                (int)Math.Round(a.B + (b.B - a.B) * t));
        }

        // "A", "A and B", "A, B and C"
        public static string JoinAnd(System.Collections.Generic.IList<string> items)
        {
            if (items.Count == 0) return "";
            if (items.Count == 1) return items[0];
            string[] head = new string[items.Count - 1];
            for (int i = 0; i < head.Length; i++) head[i] = items[i];
            return string.Join(", ", head) + " and " + items[items.Count - 1];
        }

        public void Dispose()
        {
            Body.Dispose(); Strong.Dispose(); Small.Dispose(); Tag.Dispose(); Mark.Dispose(); Title.Dispose(); Heading.Dispose(); Head.Dispose();
        }
    }
}
