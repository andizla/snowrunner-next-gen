// SPDX-License-Identifier: GPL-3.0-only
// The engine at work: each stage as it begins (ticked off when the next one starts), the tools' lines under it,
// warnings and the result, and a moving bar while it runs. When the engine asks whether files another mod or a game
// update changed may be taken as they are now as the originals, the answer is a button here: the engine runs again
// with --adopt, or with --leave to leave those files and their parts out. It cannot be closed while the engine is
// writing.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class ProgressForm : Form
    {
        readonly Look look;
        readonly List<string> args;
        readonly ProgressHead head;
        readonly ProgressLog log;
        readonly ProgressFoot foot;
        readonly Timer clock = new Timer();
        DateTime started;
        bool running, adopted, left;
        EngineEvent lastError;
        public bool Succeeded;   // the engine said done
        public bool Running { get { return running; } }
        public void Begin() { Start(); }   // for a picture of it, without showing it (Program --shot --progress)

        public ProgressForm(Look look, string title, string[] args)
        {
            this.look = look;
            this.args = new List<string>(args);
            Text = title;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Back;
            Font = look.Body;
            FormBorderStyle = FormBorderStyle.Sizable;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            ShowIcon = false;
            StartPosition = FormStartPosition.CenterParent;

            head = new ProgressHead(look, title);
            head.Dock = DockStyle.Top;
            log = new ProgressLog(look);
            log.Dock = DockStyle.Fill;
            foot = new ProgressFoot(look);
            foot.Dock = DockStyle.Bottom;
            Controls.Add(log);      // the filling one first: docking works from the last control back
            Controls.Add(head);
            Controls.Add(foot);
            foot.Close.Click += delegate { if (!running) Close(); };
            foot.Adopt.Click += delegate { if (running) return; adopted = true; foot.Adopt.Visible = foot.LeaveOut.Visible = false; foot.PerformLayout(); Start(); };
            foot.LeaveOut.Click += delegate { if (running) return; left = true; foot.Adopt.Visible = foot.LeaveOut.Visible = false; foot.PerformLayout(); Start(); };

            int em = look.Body.Height;
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            ClientSize = new Size(Math.Min(em * 46, work.Width * 90 / 100), Math.Min(em * 28, work.Height * 90 / 100));
            MinimumSize = SizeFromClientSize(new Size(Math.Min(em * 26, work.Width), Math.Min(em * 16, work.Height)));
            clock.Interval = 50;
            clock.Tick += delegate
            {
                head.Tick();
                TimeSpan t = DateTime.Now - started;
                foot.Say(string.Format("{0}:{1:00}", (int)t.TotalMinutes, t.Seconds));
            };
            Shown += delegate { Start(); };
        }

        void Start()
        {
            running = true;
            lastError = null;
            Succeeded = false;
            started = DateTime.Now;
            foot.Close.Enabled = false;
            foot.Close.Text = "Working…";
            foot.Close.Fit();
            foot.PerformLayout();
            head.Begin();
            clock.Start();
            List<string> run = new List<string>(args);
            if (adopted) run.Add("--adopt");
            if (left) run.Add("--leave");
            Engine.Run(this, run.ToArray(), OnEvent, OnExit);
        }

        void OnEvent(EngineEvent e)
        {
            switch (e.Type)
            {
                case "step": log.Add(ProgressLog.Kind.Step, e.Text); head.Say(e.Text, Theme.Text); break;
                case "log": log.Add(ProgressLog.Kind.Log, e.Text); break;
                case "warn": log.Add(ProgressLog.Kind.Warn, e.Text); break;
                case "done": log.Add(ProgressLog.Kind.Done, e.Text); head.Say(e.Text, Theme.Good); Succeeded = true; break;
                case "error": lastError = e; log.Add(ProgressLog.Kind.Error, e.Text); head.Say("Not finished: nothing was left half written", Theme.Bad); break;
            }
        }

        void OnExit(int code)
        {
            running = false;
            clock.Stop();
            head.End(Succeeded);
            TimeSpan t = DateTime.Now - started;
            foot.Say(string.Format("{0} in {1}:{2:00}", Succeeded ? "Done" : "Stopped", (int)t.TotalMinutes, t.Seconds));
            bool ask = !Succeeded && !adopted && !left && lastError != null && lastError.Code != null && lastError.Code.StartsWith("adopt-");
            if (ask)
            {
                // the files the engine named (see engine\ngen.js, adopt-files)
                List<string> files = new List<string>();
                object[] named = lastError.Data != null && lastError.Data.ContainsKey("files") ? lastError.Data["files"] as object[] : null;
                if (named != null) foreach (object f in named) files.Add(Convert.ToString(f));
                bool one = files.Count <= 1;
                head.Say(files.Count == 1 ? "Take " + files[0] + " as it is now as the original?"
                    : files.Count > 1 ? "Take these " + files.Count + " files as they are now as the originals?"
                    : "Take the current file as the game's original?", Theme.Warn);
                foot.Adopt.Text = one ? "Take it as the original" : "Take them as the originals";
                foot.LeaveOut.Text = one ? "Leave it out" : "Leave them out";
                foot.Adopt.Fit();
                foot.LeaveOut.Fit();
            }
            foot.Adopt.Visible = ask;
            foot.LeaveOut.Visible = ask;
            foot.Close.Text = ask ? "Cancel" : "Close";
            foot.Close.Fit();
            foot.Close.Enabled = true;
            foot.PerformLayout();
            (ask ? foot.Adopt : foot.Close).Focus();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.DarkWindow(Handle, Theme.Bar, Theme.Text, Theme.Border);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (running) e.Cancel = true;   // the engine is writing the game's files
            base.OnFormClosing(e);
        }

        protected override bool ProcessDialogKey(Keys keyData)
        {
            if (keyData == Keys.Escape) { if (!running) Close(); return true; }
            return base.ProcessDialogKey(keyData);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) clock.Dispose();
            base.Dispose(disposing);
        }
    }

    // the title, what is happening now, and a bar that moves while the engine works (green when done, red when not)
    class ProgressHead : Control
    {
        readonly Look look;
        readonly string title;
        string state = "Starting…";
        Color stateColor = Theme.Muted;
        bool moving;
        Color barColor = Theme.Accent;
        float phase;
        Rectangle titleRect, stateRect, barRect;

        public ProgressHead(Look look, string title)
        {
            this.look = look;
            this.title = title;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bar;
        }

        public void Say(string text, Color color) { state = text; stateColor = color; PerformLayout(); Invalidate(); }
        public void Begin() { moving = true; barColor = Theme.Accent; Invalidate(); }
        public void End(bool ok) { moving = false; barColor = ok ? Theme.Good : Theme.Bad; Invalidate(); }
        public void Tick() { phase = (phase + 0.012f) % 1f; Invalidate(barRect); }

        protected override void OnLayout(LayoutEventArgs e)
        {
            int padX = look.U(24), padY = look.U(18), inner = Math.Max(look.U(60), Width - 2 * padX);
            titleRect = new Rectangle(padX, padY, inner, look.Heading.Height);
            stateRect = new Rectangle(padX, titleRect.Bottom + look.U(4), inner, Look.Measure(state, look.Body, inner, Look.Wrap).Height);
            int h = stateRect.Bottom + padY + look.U(4);
            barRect = new Rectangle(0, h - look.U(4), Width, look.U(4));
            if (Height != h) Height = h;
            base.OnLayout(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bar);
            Look.Text(g, title, look.Heading, titleRect, Theme.Text, Look.Line);
            Look.Text(g, state, look.Body, stateRect, stateColor, Look.Wrap);
            using (SolidBrush track = new SolidBrush(Theme.Border)) g.FillRectangle(track, barRect);
            using (SolidBrush fill = new SolidBrush(barColor))
            {
                if (!moving) g.FillRectangle(fill, barRect);
                else
                {
                    // a segment a third of the width, sliding across and wrapping round
                    int w = Math.Max(1, barRect.Width / 3), x = (int)(phase * (barRect.Width + w)) - w;
                    g.FillRectangle(fill, new Rectangle(barRect.X + x, barRect.Y, w, barRect.Height));
                }
            }
        }
    }

    // the stages and lines, newest at the bottom, scrolled along
    class ProgressLog : ScrollPanel
    {
        public enum Kind { Step, Log, Warn, Error, Done }

        class Entry
        {
            public Kind Kind;
            public string Text;
            public bool Finished, Failed;   // a stage: ticked off, or where it stopped
            public Rectangle Icon, Bounds;  // content coordinates
        }

        readonly List<Entry> entries = new List<Entry>();

        public ProgressLog(Look look) : base(look) { }

        Entry CurrentStep()
        {
            for (int i = entries.Count - 1; i >= 0; i--) if (entries[i].Kind == Kind.Step) return entries[i].Finished || entries[i].Failed ? null : entries[i];
            return null;
        }

        public void Add(Kind kind, string text)
        {
            Entry open = CurrentStep();
            if (open != null && kind != Kind.Log && kind != Kind.Warn)
            {
                if (kind == Kind.Error) open.Failed = true; else open.Finished = true;
            }
            Entry e = new Entry();
            e.Kind = kind;
            e.Text = text;
            entries.Add(e);
            PerformLayout();
            Invalidate();
        }

        // the newest line stays in view, until the user scrolls up to read
        bool follow = true;

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            if (!follow) return;
            int bottom = Math.Max(0, DisplayRectangle.Height - ClientSize.Height);
            if (-AutoScrollPosition.Y != bottom) AutoScrollPosition = new Point(0, bottom);
        }

        bool AtBottom { get { return -AutoScrollPosition.Y >= DisplayRectangle.Height - ClientSize.Height - look.U(4); } }

        protected override void OnMouseWheel(MouseEventArgs e) { base.OnMouseWheel(e); follow = AtBottom; }
        protected override void OnScroll(ScrollEventArgs se) { base.OnScroll(se); follow = AtBottom; }

        public override int Arrange(int width, bool place)
        {
            int pad = look.U(24), icon = look.U(16), gap = look.U(10);
            int inner = Math.Max(look.U(60), width - 2 * pad - icon - gap);
            int y = pad;
            foreach (Entry e in entries)
            {
                Font font = FontOf(e.Kind);
                if (e.Kind == Kind.Step && y > pad) y += look.U(10);
                int textH = Math.Max(font.Height, Look.Measure(e.Text, font, inner, Look.Wrap).Height);
                e.Bounds = new Rectangle(pad + icon + gap, y, inner, textH);
                e.Icon = new Rectangle(pad, y + (font.Height - icon) / 2, icon, icon);
                y += textH + look.U(e.Kind == Kind.Log ? 2 : 6);
            }
            int height = y + pad;
            if (place) AutoScrollMinSize = new Size(0, height);
            return height;
        }

        Font FontOf(Kind kind)
        {
            switch (kind)
            {
                case Kind.Step: case Kind.Done: return look.Strong;
                case Kind.Log: return look.Small;
                default: return look.Body;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            Look.Smooth(g);
            foreach (Entry en in entries)
            {
                Rectangle text = Shown(en.Bounds), icon = Shown(en.Icon);
                if (!Rectangle.Union(text, icon).IntersectsWith(e.ClipRectangle)) continue;
                Color color = Theme.Text;
                switch (en.Kind)
                {
                    case Kind.Step:
                        if (en.Failed) Badge(g, icon, Theme.Bad, "x");
                        else if (en.Finished) Badge(g, icon, Theme.Good, "tick");
                        else Badge(g, Rectangle.Inflate(icon, -look.U(3), -look.U(3)), Theme.Accent, null);
                        break;
                    case Kind.Log: color = Theme.Muted; break;
                    case Kind.Warn: Badge(g, icon, Theme.Warn, "!"); color = Look.Mix(Theme.Warn, Theme.Text, 0.35f); break;
                    case Kind.Error: Badge(g, icon, Theme.Bad, "x"); color = Look.Mix(Theme.Bad, Theme.Text, 0.3f); break;
                    case Kind.Done: Badge(g, icon, Theme.Good, "tick"); color = Theme.Good; break;
                }
                Look.Text(g, en.Text, FontOf(en.Kind), text, color, Look.Wrap);
            }
        }

        // a filled circle with a tick, a cross, a mark, or nothing
        void Badge(Graphics g, Rectangle r, Color color, string mark)
        {
            using (SolidBrush b = new SolidBrush(color)) g.FillEllipse(b, r);
            if (mark == null) return;
            float s = r.Width;
            using (Pen p = new Pen(Theme.AccentText, Math.Max(1.5f, look.F(1.8f))))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                p.LineJoin = LineJoin.Round;
                if (mark == "tick")
                    g.DrawLines(p, new[] { new PointF(r.X + s * 0.28f, r.Y + s * 0.52f), new PointF(r.X + s * 0.44f, r.Y + s * 0.68f), new PointF(r.X + s * 0.73f, r.Y + s * 0.36f) });
                else if (mark == "x")
                {
                    g.DrawLine(p, r.X + s * 0.33f, r.Y + s * 0.33f, r.X + s * 0.67f, r.Y + s * 0.67f);
                    g.DrawLine(p, r.X + s * 0.67f, r.Y + s * 0.33f, r.X + s * 0.33f, r.Y + s * 0.67f);
                }
                else
                {
                    g.DrawLine(p, r.X + s * 0.5f, r.Y + s * 0.26f, r.X + s * 0.5f, r.Y + s * 0.58f);
                    g.DrawLine(p, r.X + s * 0.5f, r.Y + s * 0.74f, r.X + s * 0.5f, r.Y + s * 0.75f);
                }
            }
        }
    }

    // the time taken on the left; Take it as the original and Leave it out (when asked) and Close on the right
    class ProgressFoot : Control
    {
        readonly Look look;
        public readonly FlatButton Adopt, LeaveOut, Close;
        string note = "";

        public ProgressFoot(Look look)
        {
            this.look = look;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bar;
            SuspendLayout();
            Adopt = new FlatButton(look, "Take it as the original", ButtonStyle.Primary);
            Adopt.Visible = false;
            LeaveOut = new FlatButton(look, "Leave it out", ButtonStyle.Secondary);
            LeaveOut.Visible = false;
            Close = new FlatButton(look, "Close", ButtonStyle.Secondary);
            Controls.Add(Adopt);
            Controls.Add(LeaveOut);
            Controls.Add(Close);
            ResumeLayout(false);
            Height = Close.Height + 2 * look.U(12);
        }

        public void Say(string text) { note = text; Invalidate(); }

        protected override void OnLayout(LayoutEventArgs e)
        {
            int padX = look.U(20), padY = look.U(12), gap = look.U(10);
            Close.Location = new Point(Width - padX - Close.Width, padY);
            LeaveOut.Location = new Point(Close.Left - gap - LeaveOut.Width, padY);
            Adopt.Location = new Point((LeaveOut.Visible ? LeaveOut.Left : Close.Left) - gap - Adopt.Width, padY);
            base.OnLayout(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bar);
            using (Pen line = new Pen(Theme.Border)) g.DrawLine(line, 0, 0, Width, 0);
            int padX = look.U(20);
            Rectangle r = new Rectangle(padX, look.U(12), Math.Max(0, (Adopt.Visible ? Adopt.Left : Close.Left) - 2 * padX), Close.Height);
            Look.Text(g, note, look.Body, r, Theme.Muted, Look.Middle);
        }
    }
}
