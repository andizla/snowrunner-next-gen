// SPDX-License-Identifier: GPL-3.0-only
// The list of modules: one card per module, in sections, in as many columns as the width holds.
// A card shows a tick box, the title with its (?) mark, the category tag, the description, the option buttons and
// what it needs.
//   Mouse: a click on the card ticks or unticks it; a click on an option picks it and ticks the card; the (?) opens
//   the module's explanation.
//   Keyboard: Space ticks; Left and Right pick within an option row, Up and Down move between the rows; F1 or ?
//   opens the explanation.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class Card : Control
    {
        readonly Look look;
        public readonly Module Module;
        public readonly int[] Choice;       // per option set, the index of the picked button
        public string Needs;                // "Needs GTAO and SnowRunner Shadows", or null
        bool on, hot, pressed, infoHot, downInfo;
        int hotRow = -1, hotButton = -1, downRow = -1, downButton = -1, keyRow;

        public event EventHandler Toggled;    // the user ticked or unticked it
        public event EventHandler Picked;     // the user picked an option
        public event EventHandler InfoAsked;  // the user asked for the explanation: the (?), F1 or ?

        // the layout for the current width
        Rectangle box, title, info, tag, text, needs;
        Rectangle[] rowLabel = new Rectangle[0];
        Rectangle[][] buttons = new Rectangle[0][];

        public Card(Look look, Module module)
        {
            this.look = look;
            Module = module;
            Choice = new int[module.Options.Count];
            on = module.DefaultOn;
            for (int i = 0; i < Choice.Length; i++) Choice[i] = module.Options[i].Default;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Cursor = Cursors.Hand;
            Text = module.Title;
        }

        public bool On
        {
            get { return on; }
            set
            {
                if (on == value) return;
                on = value;
                Invalidate();
                AccessibilityNotifyClients(AccessibleEvents.StateChange, -1);
            }
        }

        public void Reset()
        {
            On = Module.DefaultOn;
            for (int i = 0; i < Choice.Length; i++) Choice[i] = Module.Options[i].Default;
            Invalidate();
        }

        public void ToggleByUser()
        {
            On = !on;
            if (Toggled != null) Toggled(this, EventArgs.Empty);
        }

        void PickByUser(int row, int index)
        {
            if (Choice[row] != index)
            {
                Choice[row] = index;
                Invalidate();
                if (Picked != null) Picked(this, EventArgs.Empty);
            }
            if (!on) ToggleByUser();
        }

        void AskInfo()
        {
            if (InfoAsked != null) InfoAsked(this, EventArgs.Empty);
        }

        // lays the card out for this width; gives its height
        public int Arrange(int width)
        {
            int pad = look.U(16), gap = look.U(12), size = look.U(20), inset = look.SegmentInset;
            int left = pad + size + gap;
            int inner = Math.Max(look.U(80), width - left - pad);

            Size tagText = Look.Measure(Module.Category, look.Tag);
            int tagW = tagText.Width + 2 * look.U(8), tagH = tagText.Height + 2 * look.U(3);
            int mark = look.U(20), markGap = look.U(8);
            int titleW = Math.Max(look.U(40), inner - tagW - gap - mark - markGap);
            int line = look.Title.Height;
            title = new Rectangle(left, pad, titleW, Math.Max(line, Look.Measure(Module.Title, look.Title, titleW, Look.Wrap).Height));
            int titleText = Math.Min(titleW, Look.Measure(Module.Title, look.Title).Width);
            info = new Rectangle(left + titleText + markGap, pad + (line - mark) / 2, mark, mark);   // right after the title
            box = new Rectangle(pad, pad + (line - size) / 2, size, size);
            tag = new Rectangle(width - pad - tagW, pad + (line - tagH) / 2, tagW, tagH);
            int y = title.Bottom + look.U(4);
            text = new Rectangle(left, y, inner, Look.Measure(Module.Description, look.Body, inner, Look.Wrap).Height);
            y = text.Bottom;

            int rows = Module.Options.Count;
            rowLabel = new Rectangle[rows];
            buttons = new Rectangle[rows][];
            int labelW = 0;
            foreach (OptionSet o in Module.Options) labelW = Math.Max(labelW, Look.Measure(o.Name, look.Small).Width);
            int buttonH = look.SegmentHeight;
            for (int r = 0; r < rows; r++)
            {
                OptionSet o = Module.Options[r];
                y += look.U(r == 0 ? 14 : 6);
                int[] widths = look.SegmentWidths(o.Labels);
                int total = 2 * inset;
                foreach (int w in widths) total += w;
                int x = left;
                if (labelW + gap + total <= inner)
                {
                    rowLabel[r] = new Rectangle(left, y, labelW, buttonH + 2 * inset);   // beside the buttons, centred on them
                    x = left + labelW + gap;
                }
                else
                {
                    int labelH = Look.Measure(o.Name, look.Small).Height;              // above them
                    rowLabel[r] = new Rectangle(left, y, inner, labelH);
                    y += labelH + look.U(4);
                }
                buttons[r] = new Rectangle[widths.Length];
                x += inset;
                for (int i = 0; i < widths.Length; i++)
                {
                    buttons[r][i] = new Rectangle(x, y + inset, widths[i], buttonH);
                    x += widths[i];
                }
                y += buttonH + 2 * inset;
            }
            needs = Rectangle.Empty;
            if (!string.IsNullOrEmpty(Needs))
            {
                y += look.U(rows > 0 ? 10 : 8);
                needs = new Rectangle(left, y, inner, Look.Measure(Needs, look.Small, inner, Look.Wrap).Height);
                y = needs.Bottom;
            }
            return y + pad;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Back);
            Look.Smooth(g);
            Rectangle r = ClientRectangle;
            float radius = look.F(10);
            Color fill = hot ? Theme.CardHot : Theme.Card;
            if (on) fill = Look.Mix(fill, Theme.Accent, 0.07f);
            Look.Fill(g, r, radius, fill);
            Look.Stroke(g, r, radius, on ? Look.Mix(Theme.Border, Theme.Accent, 0.6f) : Theme.Border, Math.Max(1f, look.F(1)));
            if (Focused && ShowFocusCues) Look.Stroke(g, Rectangle.Inflate(r, -look.U(3), -look.U(3)), radius - look.F(3), Theme.Accent, look.F(2));

            float boxRadius = look.F(5);
            if (on)
            {
                Look.Fill(g, box, boxRadius, Theme.Accent);
                using (Pen tick = new Pen(Theme.AccentText, look.F(2.2f)))
                {
                    tick.StartCap = LineCap.Round;
                    tick.EndCap = LineCap.Round;
                    tick.LineJoin = LineJoin.Round;
                    float s = box.Width;
                    g.DrawLines(tick, new[]
                    {
                        new PointF(box.X + s * 0.27f, box.Y + s * 0.53f), new PointF(box.X + s * 0.44f, box.Y + s * 0.70f),
                        new PointF(box.X + s * 0.75f, box.Y + s * 0.34f)
                    });
                }
            }
            else Look.Stroke(g, box, boxRadius, Theme.Muted, look.F(1.6f));

            Look.Text(g, Module.Title, look.Title, title, on ? Theme.Text : Look.Mix(Theme.Text, Theme.Muted, 0.3f), Look.Wrap);
            look.DrawMark(g, info, infoHot, fill);
            Color category = Theme.Category(Module.Category);
            Look.Fill(g, tag, tag.Height / 2f, Look.Mix(fill, category, 0.16f));
            Look.Text(g, Module.Category, look.Tag, tag, category, Look.Center);
            Look.Text(g, Module.Description, look.Body, text, on ? Look.Mix(Theme.Muted, Theme.Text, 0.35f) : Theme.Muted, Look.Wrap);

            Color track = Look.Mix(fill, Theme.Back, 0.6f);
            for (int row = 0; row < buttons.Length; row++)
            {
                OptionSet o = Module.Options[row];
                Look.Text(g, o.Name, look.Small, rowLabel[row], Theme.Muted, Look.Middle);
                look.DrawSegments(g, buttons[row], o.Labels, Choice[row], row == hotRow ? hotButton : -1, on, track,
                                  Focused && ShowFocusCues && row == keyRow);
            }
            if (!needs.IsEmpty) Look.Text(g, Needs, look.Small, needs, Theme.Muted, Look.Wrap);
        }

        bool ButtonAt(Point p, out int row, out int index)
        {
            for (row = 0; row < buttons.Length; row++)
                for (index = 0; index < buttons[row].Length; index++)
                    if (buttons[row][index].Contains(p)) return true;
            row = -1;
            index = -1;
            return false;
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hot = true; Invalidate(); }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hot = infoHot = false;
            hotRow = hotButton = -1;
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int row, index;
            ButtonAt(e.Location, out row, out index);
            bool overInfo = info.Contains(e.Location);
            if (row != hotRow || index != hotButton || overInfo != infoHot)
            {
                hotRow = row;
                hotButton = index;
                infoHot = overInfo;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            ScrollPanel list = Parent as ScrollPanel;
            if (list != null) list.HoldScroll = true;   // a click keeps the list where it is
            Focus();
            if (list != null) list.HoldScroll = false;
            pressed = true;
            downInfo = info.Contains(e.Location);
            ButtonAt(e.Location, out downRow, out downButton);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left || !pressed) return;
            pressed = false;
            if (!ClientRectangle.Contains(e.Location)) return;
            if (downInfo)
            {
                downInfo = false;
                if (info.Contains(e.Location)) AskInfo();
                return;
            }
            int row, index;
            ButtonAt(e.Location, out row, out index);
            if (row != downRow || index != downButton || info.Contains(e.Location)) return;   // pressed on one part, let go on another
            if (row >= 0) { keyRow = row; PickByUser(row, index); }
            else ToggleByUser();
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys k = keyData & Keys.KeyCode;
            if ((keyData & (Keys.Control | Keys.Alt)) == 0)
            {
                if (buttons.Length > 0 && (k == Keys.Left || k == Keys.Right)) return true;
                if (buttons.Length > 1 && (k == Keys.Up || k == Keys.Down)) return true;
            }
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Space) { e.Handled = true; ToggleByUser(); return; }
            if (e.KeyCode == Keys.F1) { e.Handled = true; AskInfo(); return; }
            if (buttons.Length == 0) return;
            keyRow = Math.Max(0, Math.Min(keyRow, buttons.Length - 1));
            int choice = Choice[keyRow];
            if (e.KeyCode == Keys.Up && keyRow > 0) { keyRow--; Invalidate(); }
            else if (e.KeyCode == Keys.Down && keyRow < buttons.Length - 1) { keyRow++; Invalidate(); }
            else if (e.KeyCode == Keys.Left && choice > 0) PickByUser(keyRow, choice - 1);
            else if (e.KeyCode == Keys.Right && choice < buttons[keyRow].Length - 1) PickByUser(keyRow, choice + 1);
            else return;
            e.Handled = true;
        }

        protected override void OnKeyPress(KeyPressEventArgs e)
        {
            base.OnKeyPress(e);
            if (e.KeyChar == '?') { e.Handled = true; AskInfo(); }
        }

        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

        protected override AccessibleObject CreateAccessibilityInstance() { return new CardAccessible(this); }

        // screen readers hear a tick box with the module's name and description
        class CardAccessible : ControlAccessibleObject
        {
            readonly Card card;
            public CardAccessible(Card card) : base(card) { this.card = card; }
            public override AccessibleRole Role { get { return AccessibleRole.CheckButton; } }
            public override AccessibleStates State
            {
                get { AccessibleStates s = base.State; if (card.On) s |= AccessibleStates.Checked; return s; }
            }
            public override string Name { get { return card.Module.Title; } }
            public override string Description { get { return card.Module.Description + " Press F1 for more."; } }
            public override string DefaultAction { get { return card.On ? "Untick" : "Tick"; } }
            public override void DoDefaultAction() { card.ToggleByUser(); }
        }
    }

    class CardList : ScrollPanel
    {
        class Section
        {
            public string Title;
            public int First, End;      // its cards: First .. End - 1
            public Rectangle Bounds;    // the heading, in content coordinates
        }

        readonly List<Card> cards = new List<Card>();
        readonly List<Section> sections = new List<Section>();

        public CardList(Look look) : base(look)
        {
            AutoScrollMargin = new Size(0, look.U(22));
        }

        public IList<Card> Cards { get { return cards; } }

        public void Add(Card card)
        {
            card.TabIndex = cards.Count;
            cards.Add(card);
            Controls.Add(card);
            if (sections.Count == 0 || sections[sections.Count - 1].Title != card.Module.Group)
            {
                Section s = new Section();
                s.Title = card.Module.Group;
                s.First = cards.Count - 1;
                sections.Add(s);
            }
            sections[sections.Count - 1].End = cards.Count;
        }

        public override int Arrange(int width, bool place)
        {
            int pad = look.U(22), gap = look.U(14);
            int inner = Math.Max(look.U(120), width - 2 * pad);
            int columns = Math.Max(1, (inner + gap) / (look.Body.Height * 25 + gap));
            int cardW = (inner - (columns - 1) * gap) / columns;
            Point scroll = AutoScrollPosition;
            int y = pad;
            foreach (Section s in sections)
            {
                if (s.First > 0) y += look.U(14);
                s.Bounds = new Rectangle(pad, y, inner, look.Heading.Height);
                y += look.Heading.Height + look.U(10);
                for (int row = s.First; row < s.End; row += columns)
                {
                    int end = Math.Min(s.End, row + columns), h = 0;
                    for (int i = row; i < end; i++) h = Math.Max(h, cards[i].Arrange(cardW));
                    if (place)
                        for (int i = row; i < end; i++)
                            cards[i].SetBounds(pad + (i - row) * (cardW + gap) + scroll.X, y + scroll.Y, cardW, h);
                    y += h + gap;
                }
                y -= gap;
            }
            return y + pad;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            // the count sits on the heading's baseline (Segoe UI: the baseline is 0.81 of the line height down)
            int drop = (int)Math.Round((look.Heading.Height - look.Small.Height) * 0.81f);
            foreach (Section s in sections)
            {
                Rectangle r = Shown(s.Bounds);
                if (!r.IntersectsWith(e.ClipRectangle)) continue;
                int on = 0;
                for (int i = s.First; i < s.End; i++) if (cards[i].On) on++;
                Look.Text(g, s.Title, look.Heading, r, Theme.Text, Look.Line);
                int x = r.X + Look.Measure(s.Title, look.Heading).Width + look.U(12);
                Rectangle count = new Rectangle(x, r.Y + drop, Math.Max(0, r.Right - x), look.Small.Height);
                Look.Text(g, on + " of " + (s.End - s.First) + " on", look.Small, count, Theme.Muted, Look.Line);
            }
        }
    }
}
