// SPDX-License-Identifier: GPL-3.0-only
// The window's own buttons, the header (name, game folder) and the bar at the bottom (choices, count, Apply). All
// drawn by hand in the window's colours and laid out from their text: Arrange(width) places the parts and gives the height.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    enum ButtonStyle { Primary, Secondary, Ghost, Link, Round }   // Round: the (?) mark

    class FlatButton : Control
    {
        readonly Look look;
        readonly ButtonStyle style;
        bool hot, down;

        public FlatButton(Look look, string text, ButtonStyle style)
        {
            this.look = look;
            this.style = style;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
            Text = text;
            Font = style == ButtonStyle.Primary ? look.Strong : look.Body;
            TabStop = true;
            Cursor = Cursors.Hand;
            AccessibleRole = AccessibleRole.PushButton;
            Size = GetPreferredSize(Size.Empty);
        }

        public override Size GetPreferredSize(Size proposed)
        {
            if (style == ButtonStyle.Round) { int d = look.Body.Height + look.U(10); return new Size(d, d); }
            int pad = look.U(style == ButtonStyle.Link ? 8 : 16);
            int width = Look.Measure(Text, Font).Width + 2 * pad;
            if (style == ButtonStyle.Primary) width = Math.Max(width, look.U(128));
            return new Size(width, look.Body.Height + look.U(16));
        }

        public void Fit() { Size = GetPreferredSize(Size.Empty); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Bar);
            Look.Smooth(g);
            Rectangle r = ClientRectangle;
            float radius = look.F(8);
            Color text;
            if (style == ButtonStyle.Round)
            {
                Color back = Parent != null ? Parent.BackColor : Theme.Bar;
                look.DrawMark(g, Rectangle.Inflate(r, -look.U(4), -look.U(4)), hot || down || (Focused && ShowFocusCues), back);
                return;
            }
            if (style == ButtonStyle.Primary)
            {
                Color fill = !Enabled ? Theme.Border : down ? Look.Mix(Theme.Accent, Color.Black, 0.18f) : hot ? Look.Mix(Theme.Accent, Color.White, 0.14f) : Theme.Accent;
                Look.Fill(g, r, radius, fill);
                text = Enabled ? Theme.AccentText : Theme.Muted;
            }
            else if (style == ButtonStyle.Secondary)
            {
                Look.Fill(g, r, radius, down ? Theme.Border : hot ? Theme.CardHot : Theme.Card);
                Look.Stroke(g, r, radius, Theme.Border, Math.Max(1f, look.F(1)));
                text = Enabled ? Theme.Text : Theme.Muted;
            }
            else
            {
                if (down || hot) Look.Fill(g, r, radius, down ? Theme.Border : Theme.CardHot);
                text = !Enabled ? Theme.Muted : style == ButtonStyle.Link ? Theme.Accent : Theme.Text;
            }
            if (Focused && ShowFocusCues) Look.Stroke(g, r, radius, style == ButtonStyle.Primary ? Theme.Text : Theme.Accent, look.F(2));
            Look.Text(g, Text, Font, r, text, Look.Center);
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hot = true; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hot = false; Invalidate(); }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            Focus();
            down = true;
            Invalidate();
        }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); if (down) { down = false; Invalidate(); } }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { e.Handled = true; OnClick(EventArgs.Empty); }
        }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
    }

    // The top of the window: a small emblem, the name and a line on what it does; on the right the game folder and a
    // button to change it. Narrow windows put the folder under the name.
    class Header : Control
    {
        public const string AppName = "SnowRunner Next Gen";
        const string Subtitle = "Graphics modules for SnowRunner. Tick what you want, then press Apply.";
        const string FolderLabel = "GAME FOLDER";
        const string NotFound = "SnowRunner was not found";

        readonly Look look;
        public readonly FlatButton Change, Info;   // Info: the (?) with how the installer works
        string folder, shownPath, status;           // status: what the game has installed, under the folder
        Color statusColor = Theme.Muted;
        Rectangle emblem, title, subtitle, label, path, statusRect;

        public void Say(string text, Color color)
        {
            status = text;
            statusColor = color;
            if (Parent != null) Parent.PerformLayout();
            Invalidate();
        }

        // the folder shortened in the middle to fit: C:\Program Files (x86)\Steam\...\Snowrunner. (Windows' own path
        // ellipsis cuts the end off instead when a path is only a little too long.)
        static string FitPath(string full, Font font, int width)
        {
            if (Look.Measure(full, font).Width <= width) return full;
            string[] parts = full.Split('\\');
            string last = parts[parts.Length - 1];
            for (int keep = parts.Length - 2; keep >= 1; keep--)
            {
                string shorter = string.Join("\\", parts, 0, keep) + "\\\u2026\\" + last;
                if (Look.Measure(shorter, font).Width <= width) return shorter;
            }
            return "\u2026\\" + last;
        }

        public Header(Look look)
        {
            this.look = look;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bar;
            SuspendLayout();   // no layout before both buttons are there
            Change = new FlatButton(look, "Find…", ButtonStyle.Link);
            Controls.Add(Change);
            Info = new FlatButton(look, "?", ButtonStyle.Round);
            Info.AccessibleName = "How it works";
            Controls.Add(Info);
            ResumeLayout(false);
        }

        // the game folder, or null when none was found
        public string Folder
        {
            get { return folder; }
            set
            {
                folder = value;
                Change.Text = value == null ? "Find…" : "Change…";
                Change.Fit();
                if (Parent != null) Parent.PerformLayout();
                Invalidate();
            }
        }

        bool arranging;   // moving the button asks for a layout of this control: not inside Arrange

        public int Arrange(int width)
        {
            arranging = true;
            try { return ArrangeFor(width); }
            finally { arranging = false; }
        }

        int ArrangeFor(int width)
        {
            int padX = look.U(24), padY = look.U(18), gap = look.U(24);
            int right = width - padX - Info.Width - look.U(16);   // the (?) sits at the far right, everything else before it
            int inner = Math.Max(look.U(100), right - padX);
            int size = look.U(44);
            int textX = padX + size + look.U(14);

            Size labelSize = Look.Measure(FolderLabel, look.Tag);
            Size pathSize = Look.Measure(folder ?? NotFound, look.Body);
            Size statusSize = status == null ? Size.Empty : Look.Measure(status, look.Small);
            int folderW = Math.Max(Math.Max(labelSize.Width, pathSize.Width + look.U(6) + Change.Width), statusSize.Width + look.U(2));
            bool stacked = inner - Math.Min(folderW, inner * 45 / 100) - gap - (textX - padX) < look.Body.Height * 22;
            if (stacked) folderW = Math.Min(folderW, right - textX);
            else folderW = Math.Min(folderW, inner * 45 / 100);
            int statusH = status == null ? 0 : Look.Measure(status, look.Small, folderW, Look.Wrap).Height;   // wraps when long
            int folderH = labelSize.Height + look.U(2) + Change.Height + (status == null ? 0 : look.U(2) + statusH);

            int textW = stacked ? right - textX : right - folderW - gap - textX;
            title = new Rectangle(textX, padY, textW, look.Head.Height);
            subtitle = new Rectangle(textX, title.Bottom + look.U(2), textW, Look.Measure(Subtitle, look.Body, textW, Look.Wrap).Height);
            int block = subtitle.Bottom - padY;
            emblem = new Rectangle(padX, padY + Math.Max(0, (block - size) / 2), size, size);

            int fx, fy;
            if (stacked) { fx = textX; fy = subtitle.Bottom + look.U(14); }
            else { fx = right - folderW; fy = padY + Math.Max(0, (block - folderH) / 2); }
            Info.Location = new Point(width - padX - Info.Width, padY + Math.Max(0, (block - Info.Height) / 2));
            label = new Rectangle(fx, fy, folderW, labelSize.Height);
            int room = Math.Max(0, folderW - look.U(6) - Change.Width);
            shownPath = folder == null ? NotFound : FitPath(folder, look.Body, room);
            int pathW = Math.Min(Look.Measure(shownPath, look.Body).Width, room) + look.U(2);   // the last glyph can reach past its advance
            path = new Rectangle(fx, label.Bottom + look.U(2), pathW, Change.Height);
            Change.Location = new Point(path.Right, path.Y);   // the link's own padding is the gap after the path
            statusRect = status == null ? Rectangle.Empty : new Rectangle(fx, path.Bottom + look.U(2), folderW, statusH);

            int folderBottom = status == null ? path.Bottom : statusRect.Bottom;
            int bottom = stacked ? folderBottom : Math.Max(subtitle.Bottom, folderBottom);
            return bottom + padY;
        }

        protected override void OnLayout(LayoutEventArgs e) { if (!arranging) Arrange(Width); base.OnLayout(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bar);
            Look.Smooth(g);
            DrawEmblem(g, emblem);
            Look.Text(g, AppName, look.Head, title, Theme.Text, Look.Middle);
            Look.Text(g, Subtitle, look.Body, subtitle, Theme.Muted, Look.Wrap);
            Look.Text(g, FolderLabel, look.Tag, label, Theme.Muted, Look.Line);
            Look.Text(g, shownPath, look.Body, path, folder != null ? Theme.Text : Theme.Warn, Look.Middle);
            if (status != null) Look.Text(g, status, look.Small, statusRect, statusColor, Look.Wrap);
            using (Pen line = new Pen(Theme.Border)) g.DrawLine(line, 0, Height - 1, Width, Height - 1);
        }

        // the window's icon: the emblem at this size
        public static Icon EmblemIcon(int size)
        {
            using (Bitmap picture = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(picture))
                {
                    g.Clear(Color.Transparent);
                    Look.Smooth(g);
                    DrawEmblem(g, new Rectangle(0, 0, size, size));
                }
                IntPtr handle = picture.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); }
                finally { Native.DestroyIcon(handle); }
            }
        }

        // a snowy peak on an ice-blue tile
        static void DrawEmblem(Graphics g, Rectangle r)
        {
            if (r.Width <= 0) return;
            RectangleF wide = new RectangleF(r.X - 1, r.Y - 1, r.Width + 2, r.Height + 2);   // no seam where the gradient starts
            using (GraphicsPath tile = Look.Rounded(r, r.Width * 0.26f))
            using (LinearGradientBrush b = new LinearGradientBrush(wide, Theme.Accent, Theme.Category("REFLECTIONS"), 45f))
                g.FillPath(b, tile);
            float x = r.X, y = r.Y, s = r.Width;
            PointF[] mountain =
            {
                new PointF(x + s * 0.12f, y + s * 0.78f), new PointF(x + s * 0.42f, y + s * 0.28f), new PointF(x + s * 0.57f, y + s * 0.52f),
                new PointF(x + s * 0.67f, y + s * 0.40f), new PointF(x + s * 0.88f, y + s * 0.78f)
            };
            using (SolidBrush dark = new SolidBrush(Theme.AccentText)) g.FillPolygon(dark, mountain);
            PointF[] snow =
            {
                new PointF(x + s * 0.42f, y + s * 0.28f), new PointF(x + s * 0.491f, y + s * 0.40f), new PointF(x + s * 0.455f, y + s * 0.38f),
                new PointF(x + s * 0.425f, y + s * 0.415f), new PointF(x + s * 0.395f, y + s * 0.38f), new PointF(x + s * 0.348f, y + s * 0.40f)
            };
            using (SolidBrush white = new SolidBrush(Theme.Text)) g.FillPolygon(white, snow);
        }
    }

    // The bottom of the window: Select all, Clear, Defaults and a note (the count, or what else a tick changed) on the
    // left; Restore originals and Apply on the right. Narrow windows put Restore and Apply on a second row.
    class ActionBar : Control
    {
        readonly Look look;
        public readonly FlatButton All, None, Defaults, Restore, Apply;
        string note = "";
        Color noteColor = Theme.Muted;
        Rectangle noteRect;

        public ActionBar(Look look)
        {
            this.look = look;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bar;
            SuspendLayout();   // no layout before every button is there
            All = Add("Select all", ButtonStyle.Ghost);
            None = Add("Clear", ButtonStyle.Ghost);
            Defaults = Add("Defaults", ButtonStyle.Ghost);
            Restore = Add("Restore originals", ButtonStyle.Secondary);
            Apply = Add("Apply", ButtonStyle.Primary);
            ResumeLayout(false);
        }

        FlatButton Add(string text, ButtonStyle style)
        {
            FlatButton b = new FlatButton(look, text, style);
            Controls.Add(b);
            return b;
        }

        public void Say(string text, Color color)
        {
            note = text;
            noteColor = color;
            Invalidate();
        }

        bool arranging;   // moving the buttons asks for a layout of this control: not inside Arrange

        public int Arrange(int width)
        {
            arranging = true;
            try { return ArrangeFor(width); }
            finally { arranging = false; }
        }

        int ArrangeFor(int width)
        {
            int padX = look.U(20), padY = look.U(12), gap = look.U(4), wide = look.U(16), pair = look.U(10);
            int h = Apply.Height;
            All.Location = new Point(padX, padY);
            None.Location = new Point(All.Right + gap, padY);
            Defaults.Location = new Point(None.Right + gap, padY);
            int x = Defaults.Right + wide;
            int rightW = Restore.Width + pair + Apply.Width;
            int y = padY;
            if (x + look.Body.Height * 9 + wide + rightW + padX <= width)
                noteRect = new Rectangle(x, padY, width - padX - rightW - wide - x, h);
            else
            {
                noteRect = new Rectangle(x, padY, Math.Max(0, width - padX - x), h);
                y = padY + h + look.U(8);
            }
            Apply.Location = new Point(width - padX - Apply.Width, y);
            Restore.Location = new Point(Apply.Left - pair - Restore.Width, y);
            return y + h + padY;
        }

        protected override void OnLayout(LayoutEventArgs e) { if (!arranging) Arrange(Width); base.OnLayout(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bar);
            using (Pen line = new Pen(Theme.Border)) g.DrawLine(line, 0, 0, Width, 0);
            Look.Text(g, note, look.Body, noteRect, noteColor, Look.Middle);
        }
    }

    // A scrolling area in the window's colours: dark scroll bars, about five lines of text per wheel notch (the panel's
    // own step is a fixed 120 pixels, small at high scaling), and a click can focus a child without scrolling it into
    // view (HoldScroll). Subclasses lay out in Arrange(width, place): content coordinates, placed at the scroll offset.
    class ScrollPanel : Panel
    {
        protected readonly Look look;
        public bool HoldScroll;
        bool arranging;

        public ScrollPanel(Look look)
        {
            this.look = look;
            SuspendLayout();   // the subclass is not built yet: no Arrange from here
            AutoScroll = true;
            BackColor = Theme.Back;
            DoubleBuffered = true;
            ResizeRedraw = true;
            ResumeLayout(false);
        }

        // lays the content out for this width, placing the children when place is set; gives the height of it all
        public virtual int Arrange(int width, bool place) { return 0; }

        // a rectangle of the content, where it is on screen now
        protected Rectangle Shown(Rectangle r)
        {
            r.Offset(AutoScrollPosition);
            return r;
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Native.DarkScrollBars(Handle); }

        protected override Point ScrollToControl(Control active) { return HoldScroll ? DisplayRectangle.Location : base.ScrollToControl(active); }

        protected override void OnLayout(LayoutEventArgs e)
        {
            if (!arranging)
            {
                arranging = true;
                try { Arrange(ClientSize.Width, true); }
                finally { arranging = false; }
            }
            base.OnLayout(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            int lines = SystemInformation.MouseWheelScrollLines;
            if (lines <= 0 || !VerticalScroll.Visible) { base.OnMouseWheel(e); return; }
            int step = (int)Math.Round(e.Delta / 120f * lines * look.Body.Height * 1.6f);
            int max = Math.Max(0, DisplayRectangle.Height - ClientSize.Height);
            int y = Math.Max(0, Math.Min(max, -AutoScrollPosition.Y - step));
            AutoScrollPosition = new Point(-AutoScrollPosition.X, y);
            HandledMouseEventArgs handled = e as HandledMouseEventArgs;
            if (handled != null) handled.Handled = true;
        }
    }
}
