// SPDX-License-Identifier: GPL-3.0-only
// The (?) pop-up: a module's explanation in a few short sections, with before/after pictures when the help folder has
// them. Drag across a picture (or Left and Right when it has the keyboard) to move the divider; the tabs above it, or
// the keys 1 to 9, switch pictures. Esc or Close shuts it. HelpPage is the whole content, so a picture of it can be
// drawn without a screen (Program --shot ... --help <module>).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class HelpForm : Form
    {
        public HelpForm(Look look, HelpTopic topic)
        {
            Text = topic.Title;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Back;
            Font = look.Body;
            FormBorderStyle = FormBorderStyle.Sizable;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            ShowIcon = false;
            StartPosition = FormStartPosition.CenterParent;
            HelpPage page = new HelpPage(look, topic);
            page.Dock = DockStyle.Fill;
            page.Bar.CloseButton.Click += delegate { Close(); };
            Controls.Add(page);
            int em = look.Body.Height;
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            int width = Math.Min(page.StartWidth, work.Width * 90 / 100);
            int height = Math.Min(page.FullHeight(width), work.Height * 90 / 100);
            ClientSize = new Size(width, height);
            MinimumSize = SizeFromClientSize(new Size(Math.Min(em * 24, work.Width), Math.Min(em * 16, work.Height)));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.DarkWindow(Handle, Theme.Back, Theme.Text, Theme.Border);
        }

        protected override bool ProcessDialogKey(Keys keyData)
        {
            if (keyData == Keys.Escape) { Close(); return true; }
            return base.ProcessDialogKey(keyData);
        }
    }

    class HelpPage : UserControl
    {
        readonly Look look;
        public readonly HelpView View;
        public readonly HelpBar Bar;

        public HelpPage(Look look, HelpTopic topic)
        {
            this.look = look;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Back;
            Font = look.Body;
            View = new HelpView(look, topic);
            View.Dock = DockStyle.Fill;
            Bar = new HelpBar(look);
            Bar.Dock = DockStyle.Bottom;
            Controls.Add(View);     // the filling one first: docking works from the last control back
            Controls.Add(Bar);
        }

        // the pop-up's first width, and the height that shows all of it at a width
        public int StartWidth { get { return look.Body.Height * 50; } }
        public int FullHeight(int width) { return View.Arrange(width, false) + Bar.Height; }
    }

    class HelpBar : Control
    {
        readonly Look look;
        public readonly FlatButton CloseButton;

        public HelpBar(Look look)
        {
            this.look = look;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bar;
            CloseButton = new FlatButton(look, "Close", ButtonStyle.Secondary);
            Controls.Add(CloseButton);
            Height = CloseButton.Height + 2 * look.U(12);
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            CloseButton.Location = new Point(Width - look.U(20) - CloseButton.Width, look.U(12));
            base.OnLayout(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Bar);
            using (Pen line = new Pen(Theme.Border)) e.Graphics.DrawLine(line, 0, 0, Width, 0);
        }
    }

    // the title with its tag, the one-line summary, the pictures (tabs, comparison, caption) and the sections
    class HelpView : ScrollPanel
    {
        readonly HelpTopic topic;
        readonly List<ComparePair> pairs = new List<ComparePair>();   // those whose files are there
        readonly string[] tabNames;
        readonly CompareView compare;
        int shown = -1, tabHot = -1;
        Rectangle titleRect, tagRect, summaryRect, captionRect;
        Rectangle[] tabs = new Rectangle[0];
        readonly List<Rectangle> headings = new List<Rectangle>(), texts = new List<Rectangle>();

        public HelpView(Look look, HelpTopic topic) : base(look)
        {
            SuspendLayout();   // no Arrange before the first picture is loaded
            this.topic = topic;
            foreach (ComparePair p in topic.Entry.Pictures) if (p.Present) pairs.Add(p);
            tabNames = new string[pairs.Count];
            for (int i = 0; i < pairs.Count; i++) tabNames[i] = pairs[i].Name;
            if (pairs.Count > 0)
            {
                compare = new CompareView(look);
                compare.NumberKey = delegate(int n) { if (n < pairs.Count) ShowPair(n); };
                Controls.Add(compare);
                ShowPair(0);
            }
            ResumeLayout(false);
        }

        void ShowPair(int i)
        {
            if (i == shown) return;
            shown = i;
            compare.Load(pairs[i]);
            PerformLayout();
            Invalidate();
        }

        public override int Arrange(int width, bool place)
        {
            if (topic == null || (compare != null && shown < 0)) return 0;   // still being built
            int pad = look.U(26);
            int inner = Math.Max(look.U(100), width - 2 * pad);
            Point scroll = AutoScrollPosition;
            int y = pad;

            titleRect = new Rectangle(pad, y, Math.Min(Look.Measure(topic.Title, look.Heading).Width + look.U(2), inner), look.Heading.Height);
            tagRect = Rectangle.Empty;
            if (topic.Category != null)
            {
                Size c = Look.Measure(topic.Category, look.Tag);
                int h = c.Height + 2 * look.U(3);
                tagRect = new Rectangle(titleRect.Right + look.U(12), y + (look.Heading.Height - h) / 2, c.Width + 2 * look.U(8), h);
            }
            y = titleRect.Bottom + look.U(4);
            summaryRect = new Rectangle(pad, y, inner, Look.Measure(topic.Summary, look.Body, inner, Look.Wrap).Height);
            y = summaryRect.Bottom;

            if (compare != null)
            {
                y += look.U(18);
                tabs = new Rectangle[0];
                if (pairs.Count > 1)
                {
                    int[] widths = look.SegmentWidths(tabNames);
                    int inset = look.SegmentInset, x = pad + inset;
                    tabs = new Rectangle[widths.Length];
                    for (int i = 0; i < widths.Length; i++)
                    {
                        tabs[i] = new Rectangle(x, y + inset, widths[i], look.SegmentHeight);
                        x += widths[i];
                    }
                    y += look.SegmentHeight + 2 * inset + look.U(10);
                }
                Size image = compare.ImageSize;
                int imageH = (int)Math.Round(inner * (double)image.Height / Math.Max(1, image.Width));
                if (place) compare.SetBounds(pad + scroll.X, y + scroll.Y, inner, imageH);
                y += imageH + look.U(8);
                captionRect = new Rectangle(pad, y, inner, Look.Measure(pairs[shown].Caption, look.Small, inner, Look.Wrap).Height);
                y = captionRect.Bottom;
            }

            headings.Clear();
            texts.Clear();
            foreach (HelpSection s in topic.Entry.Sections)
            {
                y += look.U(20);
                Rectangle heading = new Rectangle(pad, y, inner, look.Title.Height);
                headings.Add(heading);
                y = heading.Bottom + look.U(4);
                Rectangle text = new Rectangle(pad, y, inner, Look.Measure(s.Text, look.Body, inner, Look.Wrap).Height);
                texts.Add(text);
                y = text.Bottom;
            }
            int height = y + pad;
            if (place) AutoScrollMinSize = new Size(0, height);   // the text below the picture scrolls too
            return height;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            Look.Smooth(g);
            Look.Text(g, topic.Title, look.Heading, Shown(titleRect), Theme.Text, Look.Line);
            if (!tagRect.IsEmpty)
            {
                Color c = Theme.Category(topic.Category);
                Rectangle r = Shown(tagRect);
                Look.Fill(g, r, r.Height / 2f, Look.Mix(Theme.Back, c, 0.16f));
                Look.Text(g, topic.Category, look.Tag, r, c, Look.Center);
            }
            Look.Text(g, topic.Summary, look.Body, Shown(summaryRect), Theme.Muted, Look.Wrap);
            if (compare != null)
            {
                if (tabs.Length > 1)
                {
                    Rectangle[] onScreen = new Rectangle[tabs.Length];
                    for (int i = 0; i < tabs.Length; i++) onScreen[i] = Shown(tabs[i]);
                    look.DrawSegments(g, onScreen, tabNames, shown, tabHot, true, Theme.Card, false);
                }
                Look.Text(g, pairs[shown].Caption, look.Small, Shown(captionRect), Theme.Muted, Look.Wrap);
            }
            Color body = Look.Mix(Theme.Muted, Theme.Text, 0.45f);
            for (int i = 0; i < headings.Count; i++)
            {
                Look.Text(g, topic.Entry.Sections[i].Heading, look.Title, Shown(headings[i]), Theme.Text, Look.Line);
                Look.Text(g, topic.Entry.Sections[i].Text, look.Body, Shown(texts[i]), body, Look.Wrap);
            }
        }

        int TabAt(Point p)
        {
            for (int i = 0; i < tabs.Length; i++) if (Shown(tabs[i]).Contains(p)) return i;
            return -1;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int t = TabAt(e.Location);
            if (t == tabHot) return;
            tabHot = t;
            Cursor = t >= 0 ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (tabHot < 0) return;
            tabHot = -1;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            int t = TabAt(e.Location);
            if (t >= 0) ShowPair(t);
        }
    }

    // one before/after pair: the after picture, the before picture up to the divider, a label in each top corner
    class CompareView : Control
    {
        readonly Look look;
        Bitmap before, after, beforeFit, afterFit;   // the files, and both scaled to the control
        string beforeLabel = "Before", afterLabel = "After";
        float split = 0.5f;
        bool dragging;
        public Action<int> NumberKey;                // 1 to 9 pressed: 0 to 8

        public CompareView(Look look)
        {
            this.look = look;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Cursor = Cursors.SizeWE;
            AccessibleRole = AccessibleRole.Graphic;
        }

        public Size ImageSize { get { return after != null ? after.Size : new Size(16, 9); } }

        public void Load(ComparePair pair)
        {
            Release();
            before = Read(pair.BeforeFile);
            after = Read(pair.AfterFile);
            beforeLabel = pair.BeforeLabel ?? "Before";
            afterLabel = pair.AfterLabel ?? "After";
            AccessibleName = pair.Name + ": " + beforeLabel + " on the left, " + afterLabel + " on the right";
            split = 0.5f;
            Fit();
            Invalidate();
        }

        // a copy, so the file is not held open
        static Bitmap Read(string file)
        {
            using (FileStream s = File.OpenRead(file))
            using (Image image = Image.FromStream(s))
                return new Bitmap(image);
        }

        void Fit()
        {
            if (beforeFit != null) { beforeFit.Dispose(); beforeFit = null; }
            if (afterFit != null) { afterFit.Dispose(); afterFit = null; }
            if (before == null || after == null || Width <= 0 || Height <= 0) return;
            beforeFit = Scaled(before, Width, Height);
            afterFit = Scaled(after, Width, Height);
        }

        static Bitmap Scaled(Image source, int width, int height)
        {
            Bitmap b = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(b))
            using (ImageAttributes edges = new ImageAttributes())
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                edges.SetWrapMode(WrapMode.TileFlipXY);   // no dark seam along the edges
                g.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, edges);
            }
            return b;
        }

        void Release()
        {
            Bitmap[] all = { before, after, beforeFit, afterFit };
            foreach (Bitmap b in all) if (b != null) b.Dispose();
            before = after = beforeFit = afterFit = null;
        }

        protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); Fit(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Color back = Parent != null ? Parent.BackColor : Theme.Back;
            g.Clear(back);
            if (afterFit == null) return;
            int x = (int)Math.Round(split * Width);
            g.DrawImageUnscaled(afterFit, 0, 0);
            if (x > 0) g.DrawImage(beforeFit, new Rectangle(0, 0, x, Height), new Rectangle(0, 0, x, Height), GraphicsUnit.Pixel);
            Look.Smooth(g);
            DrawLabel(g, beforeLabel, true);
            DrawLabel(g, afterLabel, false);

            // the divider, and a handle with two arrows in its middle
            float line = Math.Max(2f, look.F(2));
            using (SolidBrush white = new SolidBrush(Theme.Text))
            {
                g.FillRectangle(white, x - line / 2, 0, line, Height);
                float r = look.F(15);
                g.FillEllipse(white, x - r, Height / 2f - r, 2 * r, 2 * r);
                using (Pen arrow = new Pen(Theme.AccentText, look.F(2)))
                {
                    arrow.StartCap = LineCap.Round;
                    arrow.EndCap = LineCap.Round;
                    arrow.LineJoin = LineJoin.Round;
                    float cy = Height / 2f, a = r * 0.32f, gap = r * 0.18f;
                    g.DrawLines(arrow, new[] { new PointF(x - gap, cy - a), new PointF(x - gap - a, cy), new PointF(x - gap, cy + a) });
                    g.DrawLines(arrow, new[] { new PointF(x + gap, cy - a), new PointF(x + gap + a, cy), new PointF(x + gap, cy + a) });
                }
            }

            // round the corners into the page
            using (GraphicsPath corners = new GraphicsPath())
            using (GraphicsPath inside = Look.Rounded(new RectangleF(0, 0, Width, Height), look.F(10)))
            using (SolidBrush page = new SolidBrush(back))
            {
                corners.FillMode = FillMode.Alternate;
                corners.AddRectangle(new RectangleF(-1, -1, Width + 2, Height + 2));
                corners.AddPath(inside, false);
                g.FillPath(page, corners);
            }
            if (Focused && ShowFocusCues) Look.Stroke(g, ClientRectangle, look.F(10), Theme.Accent, look.F(2));
        }

        void DrawLabel(Graphics g, string text, bool left)
        {
            if (string.IsNullOrEmpty(text)) return;
            string upper = text.ToUpperInvariant();
            Size t = Look.Measure(upper, look.Tag);
            int h = t.Height + 2 * look.U(4), w = t.Width + 2 * look.U(10), m = look.U(12);
            Rectangle r = new Rectangle(left ? m : Width - m - w, m, w, h);
            Look.Fill(g, r, h / 2f, Color.FromArgb(200, Theme.Back));
            Look.Text(g, upper, look.Tag, r, Theme.Text, Look.Center);
        }

        void SetSplit(float s)
        {
            s = Math.Max(0f, Math.Min(1f, s));
            if (s == split) return;
            split = s;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            ScrollPanel page = Parent as ScrollPanel;
            if (page != null) page.HoldScroll = true;
            Focus();
            if (page != null) page.HoldScroll = false;
            dragging = true;
            Capture = true;
            SetSplit(e.X / (float)Math.Max(1, Width));
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging) SetSplit(e.X / (float)Math.Max(1, Width));
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            dragging = false;
            Capture = false;
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys k = keyData & Keys.KeyCode;
            return k == Keys.Left || k == Keys.Right || k == Keys.Home || k == Keys.End || base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Left) SetSplit(split - 0.05f);
            else if (e.KeyCode == Keys.Right) SetSplit(split + 0.05f);
            else if (e.KeyCode == Keys.Home) SetSplit(0f);
            else if (e.KeyCode == Keys.End) SetSplit(1f);
            else if (e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D9 && NumberKey != null) NumberKey((int)(e.KeyCode - Keys.D1));
            else return;
            e.Handled = true;
        }

        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) Release();
            base.Dispose(disposing);
        }
    }
}
