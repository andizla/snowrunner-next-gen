// SPDX-License-Identifier: GPL-3.0-only
// The window: the header, the list of cards and the bar. The view is the whole content, so a picture of it can be
// drawn at any size and scaling without a screen (Program --shot, which never starts the engine). Ticks follow what
// the modules need: ticking a card ticks what it needs, unticking one unticks what needs it, and the bar says what
// else changed. Once shown, the view asks the engine what the game folder has installed: the header says it, and the
// cards show it (on a game with nothing of ours yet they keep the recommended set). Apply installs the ticked set,
// Restore originals puts the game's own files back, both in the progress window.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class MainView : UserControl
    {
        readonly Look look;
        readonly Header header;
        readonly CardList list;
        readonly ActionBar bar;
        readonly Dictionary<string, Card> byId = new Dictionary<string, Card>();
        readonly Timer noteTimer = new Timer();
        GameStatus installed;     // what the game folder has, once read
        bool started;             // the window is up and may run the engine
        bool statusKnown;         // the last status read is over (read, failed or not possible)

        public bool StatusKnown { get { return statusKnown; } }

        public MainView(Font body, string gameFolder)
        {
            look = new Look(body);
            SuspendLayout();
            AutoScaleMode = AutoScaleMode.None;
            Font = look.Body;
            BackColor = Theme.Back;
            ForeColor = Theme.Text;

            list = new CardList(look);
            list.Dock = DockStyle.Fill;
            list.TabIndex = 1;
            header = new Header(look);
            header.Dock = DockStyle.Top;
            header.TabIndex = 0;
            bar = new ActionBar(look);
            bar.Dock = DockStyle.Bottom;
            bar.TabIndex = 2;
            Controls.Add(list);     // the filling one first: docking works from the last control back
            Controls.Add(header);
            Controls.Add(bar);

            foreach (Module m in Catalog.All())
            {
                Card card = new Card(look, m);
                card.Toggled += delegate { Toggled(card); };
                card.Picked += delegate { Changed(null); };
                card.InfoAsked += delegate { ShowHelp(Help.TopicFor(card.Module)); };
                list.Add(card);
                byId[m.Id] = card;
            }
            foreach (Card card in list.Cards) card.Needs = NeedsLine(card.Module);

            bar.All.Click += delegate { SetAll(true); };
            bar.None.Click += delegate { SetAll(false); };
            bar.Defaults.Click += delegate { foreach (Card card in list.Cards) card.Reset(); Changed(null); };
            bar.Restore.Click += delegate { Restore(); };
            bar.Apply.Click += delegate { Apply(); };
            header.Change.Click += delegate { PickGame(); };
            header.Info.Click += delegate { ShowHelp(Help.InstallerTopic()); };
            noteTimer.Interval = 6000;
            noteTimer.Tick += delegate { noteTimer.Stop(); ShowCount(); };

            header.Folder = gameFolder != null && GameFinder.IsGame(gameFolder) ? GameFinder.OnDisk(gameFolder) : FindGame();
            ShowCount();
            ResumeLayout(false);
        }

        public Look Look { get { return look; } }

        // the window's first size: two columns of cards and most of a section in view
        public Size StartSize
        {
            get { int em = look.Body.Height; return new Size(em * 62, em * 44); }
        }

        // the height that shows every card without scrolling, at this width
        public int FullHeight(int width) { return header.Arrange(width) + list.Arrange(width, false) + bar.Arrange(width); }

        public void FocusFirstCard()
        {
            if (list.Cards.Count == 0) return;
            list.HoldScroll = true;
            list.Cards[0].Focus();
            list.HoldScroll = false;
        }

        // the window is shown: read what the game folder has installed
        public void Start()
        {
            started = true;
            RefreshStatus();
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            int width = ClientSize.Width;
            if (width > 0)
            {
                header.Height = header.Arrange(width);
                bar.Height = bar.Arrange(width);
            }
            base.OnLayout(e);
        }

        string NeedsLine(Module m)
        {
            List<string> names = new List<string>();
            foreach (string id in m.Requires)
            {
                Card need;
                if (byId.TryGetValue(id, out need)) names.Add(need.Module.Title);
            }
            return names.Count == 0 ? null : "Needs " + Look.JoinAnd(names);
        }

        void Toggled(Card card)
        {
            List<string> changed = new List<string>();
            if (card.On) TickNeeds(card, changed);
            else UntickUsers(card, changed);
            if (changed.Count == 0) { Changed(null); return; }
            string them = changed.Count == 1 ? "it" : "them";
            Changed(card.On
                ? card.Module.Title + " needs " + Look.JoinAnd(changed) + ": ticked " + them + " too."
                : Look.JoinAnd(changed) + (changed.Count == 1 ? " needs " : " need ") + card.Module.Title + ": unticked " + them + " too.");
        }

        void TickNeeds(Card card, List<string> changed)
        {
            foreach (string id in card.Module.Requires)
            {
                Card need;
                if (!byId.TryGetValue(id, out need) || need.On) continue;
                need.On = true;
                changed.Add(need.Module.Title);
                TickNeeds(need, changed);
            }
        }

        void UntickUsers(Card card, List<string> changed)
        {
            foreach (Card user in list.Cards)
            {
                if (!user.On || Array.IndexOf(user.Module.Requires, card.Module.Id) < 0) continue;
                user.On = false;
                changed.Add(user.Module.Title);
                UntickUsers(user, changed);
            }
        }

        void SetAll(bool on)
        {
            foreach (Card card in list.Cards) card.On = on;
            Changed(null);
        }

        // after any change: the section counts; the bar shows the note for a while, or the count
        void Changed(string note)
        {
            list.Invalidate();
            noteTimer.Stop();
            if (note == null) { ShowCount(); return; }
            bar.Say(note, Theme.Accent);
            noteTimer.Start();
        }

        void ShowCount()
        {
            int on = 0;
            foreach (Card card in list.Cards) if (card.On) on++;
            string text = on + " of " + list.Cards.Count + " selected";
            if (installed != null && !Problem(installed))
                text += SameAsInstalled() ? "  ·  as installed" : "  ·  Apply to change the game";
            bar.Say(text, Theme.Muted);
            bool can = header.Folder != null && Engine.Missing() == null;
            bar.Apply.Enabled = can;
            bar.Restore.Enabled = can;
        }

        // ---- the engine

        void RefreshStatus()
        {
            installed = null;
            statusKnown = false;
            string folder = header.Folder;
            string missing = Engine.Missing();
            if (!started || folder == null) { header.Say(null, Theme.Muted); ShowCount(); statusKnown = true; return; }
            if (missing != null) { header.Say(missing, Theme.Warn); ShowCount(); statusKnown = true; return; }
            header.Say("Checking what is installed…", Theme.Muted);
            GameStatus got = null;
            string error = null;
            Engine.Run(this, new[] { "status", "--game", folder },
                delegate(EngineEvent e)
                {
                    if (e.Type == "status") got = GameStatus.From(e.Data);
                    else if (e.Type == "error") error = e.Text;
                },
                delegate(int code)
                {
                    if (folder != header.Folder) return;   // another folder was picked meanwhile
                    statusKnown = true;
                    if (got == null) { header.Say("Could not read what is installed: " + (error ?? "the engine stopped"), Theme.Warn); ShowCount(); return; }
                    installed = got;
                    if (got.AnythingOurs) Mirror(got);
                    header.Say(Describe(got), got.Running || Problem(got) ? Theme.Warn : Theme.Muted);
                    Changed(null);
                });
        }

        // the cards as the game has it
        void Mirror(GameStatus s)
        {
            foreach (Card card in list.Cards)
            {
                switch (card.Module.Id)
                {
                    case "shadows":
                        card.On = s.Dll == "ours";
                        if (card.On) { Pick(card, 0, s.Factor); Pick(card, 1, s.SlopeBias); }
                        break;
                    case "objrefl":
                        bool pass = s.Modules.Contains("sssr"), march = s.Modules.Contains("reflections");
                        card.On = pass || march;
                        if (card.On) Pick(card, 0, pass ? "sssr" : "reflections");
                        break;
                    case "edges":
                        bool revec = s.Modules.Contains("revec"), crisp = s.Modules.Contains("crisp");
                        card.On = revec || crisp;
                        if (card.On) Pick(card, 0, revec ? "revec" : "crisp");
                        if (revec) Pick(card, 1, s.Modules.Contains("seam") ? "seam" : "off");
                        break;
                    case "gtao":
                        if (s.Shader == "ours" || s.Shader == "stock") card.On = s.Modules.Contains("gtao");
                        if (s.Dll == "ours") Pick(card, 0, s.AoHalf == "0" ? "full" : "half");   // the DLL's own default: half
                        break;
                    case "scenery":
                        card.On = s.Scenery == "nature" || s.Scenery == "all";
                        if (card.On) Pick(card, 0, s.Scenery);
                        break;
                    case "grass":
                        card.On = s.Grass == "ours";
                        if (card.On) Pick(card, 0, s.GrassFactor);
                        break;
                    case "fill":
                        card.On = s.Fill == "ours";
                        if (card.On) Pick(card, 0, s.FillFactor);
                        break;
                    case "grade":
                        card.On = s.Grade == "ours";
                        if (card.On) Pick(card, 0, s.GradeStrength);
                        break;
                    case "particles":
                        card.On = s.Particles == "ours";
                        break;
                    case "stars":
                        card.On = s.Stars == "ours";
                        if (card.On) Pick(card, 0, s.StarsFactor);
                        break;
                    case "sky":
                        card.On = s.Sky == "ours";
                        break;
                    case "logos":
                        card.On = s.Logos == "ours";
                        break;
                    default:
                        if (s.Shader == "ours" || s.Shader == "stock") card.On = s.Modules.Contains(card.Module.Id);
                        break;
                }
            }
        }

        // picks the option button whose engine key is this value ("3.0" and "3" are the same)
        static void Pick(Card card, int row, string value)
        {
            if (value == null || row >= card.Choice.Length) return;
            string[] keys = card.Module.Options[row].Keys;
            for (int i = 0; i < keys.Length; i++)
                if (Same(keys[i], value)) { card.Choice[row] = i; card.Invalidate(); return; }
        }

        static bool Same(string a, string b)
        {
            double x, y;
            if (double.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out x) && double.TryParse(b, NumberStyles.Float, CultureInfo.InvariantCulture, out y)) return x == y;
            return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        static string Key(Card card, int row) { return card.Module.Options[row].Keys[card.Choice[row]]; }

        // the ticked set as the engine takes it (see engine\ngen.js)
        Dictionary<string, object> Selection()
        {
            List<object> shader = new List<object>();
            object shadows = null, scenery = null, grass = null, fill = null, grade = null, particles = null, stars = null, sky = null, logos = null;
            foreach (Card card in list.Cards)
            {
                if (!card.On) continue;
                switch (card.Module.Id)
                {
                    case "shadows":
                        Dictionary<string, object> dll = new Dictionary<string, object>();
                        dll["factor"] = Key(card, 0);
                        dll["slopeBias"] = Key(card, 1);
                        Card ao;   // GTAO's quality: SnowRunner Shadows draws its pass at half size (AOHalf=1) or full size
                        dll["aoHalf"] = byId.TryGetValue("gtao", out ao) && ao.On && Key(ao, 0) == "half" ? "1" : "0";
                        shadows = dll;
                        break;
                    case "objrefl": shader.Add(Key(card, 0)); break;   // sssr (the reflection pass) or reflections (the march)
                    case "edges":                                      // revec (the rebuilt edges) or crisp (the 16-tap filter)
                        shader.Add(Key(card, 0));
                        if (Key(card, 0) == "revec" && Key(card, 1) == "seam") shader.Add("seam");   // the seam dither needs revec
                        break;
                    case "scenery": scenery = Key(card, 0); break;
                    case "grass": grass = Key(card, 0); break;
                    case "fill": fill = Key(card, 0); break;
                    case "grade": grade = Key(card, 0); break;
                    case "particles": particles = "1"; break;
                    case "headglow":   // a build of the reflection pass's reader: sent only with that method
                        Card refl;
                        if (byId.TryGetValue("objrefl", out refl) && refl.On && Key(refl, 0) == "sssr") shader.Add("headglow");
                        break;
                    case "stars": stars = Key(card, 0); break;
                    case "sky": sky = "1"; break;
                    case "logos": logos = "1"; break;
                    default: shader.Add(card.Module.Id); break;
                }
            }
            Dictionary<string, object> selection = new Dictionary<string, object>();
            selection["shader"] = shader;
            selection["shadows"] = shadows;
            selection["scenery"] = scenery;
            selection["grass"] = grass;
            selection["fill"] = fill;
            selection["grade"] = grade;
            selection["particles"] = particles;
            selection["stars"] = stars;
            selection["sky"] = sky;
            selection["logos"] = logos;
            return selection;
        }

        // whether the ticks are exactly what the game has
        bool SameAsInstalled()
        {
            Dictionary<string, object> sel = Selection();
            List<string> shader = new List<string>();
            foreach (object m in (List<object>)sel["shader"]) shader.Add((string)m);
            Dictionary<string, object> dll = sel["shadows"] as Dictionary<string, object>;
            string mine = Signature(shader, dll == null ? null : (string)dll["factor"], dll == null ? null : (string)dll["slopeBias"], dll == null ? null : (string)dll["aoHalf"],
                (string)sel["scenery"], (string)sel["grass"], (string)sel["fill"], (string)sel["grade"], (string)sel["particles"], (string)sel["stars"], (string)sel["sky"], (string)sel["logos"]);
            GameStatus s = installed;
            string theirs = Signature(s.Shader == "ours" ? s.Modules : new List<string>(), s.Dll == "ours" ? s.Factor : null, s.Dll == "ours" ? s.SlopeBias : null, s.Dll == "ours" ? s.AoHalf : null,
                s.Scenery == "nature" || s.Scenery == "all" ? s.Scenery : null, s.Grass == "ours" ? s.GrassFactor : null, s.Fill == "ours" ? s.FillFactor : null,
                s.Grade == "ours" ? s.GradeStrength : null, s.Particles == "ours" ? "1" : null, s.Stars == "ours" ? s.StarsFactor : null, s.Sky == "ours" ? "1" : null, s.Logos == "ours" ? "1" : null);
            return mine == theirs;
        }

        static string Signature(List<string> shader, string factor, string slopeBias, string aoHalf, string scenery, string grass, string fill, string grade, string particles, string stars,
            string sky, string logos)
        {
            List<string> sorted = new List<string>(shader);
            sorted.Sort(StringComparer.Ordinal);
            return string.Join(",", sorted.ToArray()) + "|" + (factor == null ? "-" : Number(factor) + "/" + slopeBias + "/" + (aoHalf ?? "1")) + "|" + (scenery ?? "-") + "|" + (grass == null ? "-" : Number(grass))
                + "|" + (fill == null ? "-" : Number(fill)) + "|" + (grade == null ? "-" : Number(grade)) + "|" + (particles ?? "-") + "|" + (stars == null ? "-" : Number(stars))
                + "|" + (sky ?? "-") + "|" + (logos ?? "-");
        }

        static string Number(string s)
        {
            double v;
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v.ToString(CultureInfo.InvariantCulture) : s;
        }

        // a part that is neither ours nor the original: a game update, a Steam file check, another mod
        static bool Problem(GameStatus s)
        {
            return s.Shader == "changed" || s.Shader == "unknown" || s.Scenery == "changed" || s.Grass == "changed" || s.Grade == "changed" || s.Logos == "changed"
                || s.Orphaned.Count > 0;
        }

        static string Describe(GameStatus s)
        {
            if (s.Running) return "SnowRunner is running: close it before you apply.";
            // paks that hold our changes while the originals kept for them are gone: nothing can be built on them or restored
            if (s.Orphaned.Count > 0)
                return Look.JoinAnd(s.Orphaned) + (s.Orphaned.Count == 1 ? " still holds" : " still hold") + " SnowRunner Next Gen's changes, but the kept " +
                    (s.Orphaned.Count == 1 ? "original is" : "originals are") + " gone. Have the store check the game's files (in Steam: Properties, Installed Files, Verify integrity of game files), then apply again.";
            List<string> parts = new List<string>();
            if (s.Shader == "ours") parts.Add(s.Modules.Count + (s.Modules.Count == 1 ? " shader module" : " shader modules"));
            if (s.Dll == "ours") parts.Add("Shadows " + Number(s.Factor) + "x" + (s.DllCurrent ? "" : " (another build)"));
            if (s.Scenery == "nature") parts.Add("nature detail");
            else if (s.Scenery == "all") parts.Add("all meshes");
            if (s.Grass == "ours") parts.Add("grass " + Number(s.GrassFactor) + "x");
            double fillFactor, gradeStrength;
            if (s.Fill == "ours" && double.TryParse(s.FillFactor, NumberStyles.Float, CultureInfo.InvariantCulture, out fillFactor))
                parts.Add("fill light " + Math.Round(fillFactor * 100).ToString(CultureInfo.InvariantCulture) + " %");
            if (s.Grade == "ours" && double.TryParse(s.GradeStrength, NumberStyles.Float, CultureInfo.InvariantCulture, out gradeStrength))
                parts.Add("photo grade " + Math.Round(gradeStrength * 100).ToString(CultureInfo.InvariantCulture) + " %");
            if (s.Particles == "ours") parts.Add("sharper particles");
            if (s.Sky == "ours") parts.Add("night sky");
            if (s.Stars == "ours") parts.Add("stars " + Number(s.StarsFactor) + "x");
            if (s.Logos == "ours") parts.Add("logo");
            List<string> notes = new List<string>();
            // files another mod or a game update changed since their originals were kept: Apply asks before it builds on them
            List<string> changed = new List<string>();
            if (s.Shader == "changed" || s.Shader == "unknown") changed.Add("shader.pak");
            if (s.Scenery == "changed") changed.Add("shared.pak");
            if (s.Grass == "changed") changed.Add("initial.pak");
            if (s.Grade == "changed") changed.Add("boot.pak");
            if (s.Logos == "changed") changed.Add("gfx.pak");
            if (changed.Count > 0)
                notes.Add(Look.JoinAnd(changed) + (changed.Count == 1 ? " has" : " have") + " changes from another mod or a game update: Apply asks before it builds on " + (changed.Count == 1 ? "it" : "them"));
            if (s.Dll == "foreign") notes.Add("another mod's hid.dll is in Bin");
            string text = parts.Count == 0 ? "Installed: nothing yet, the game's own files" : "Installed: " + string.Join("  ·  ", parts.ToArray());
            return notes.Count == 0 ? text : text + ". Note: " + string.Join("; ", notes.ToArray());
        }

        void Apply()
        {
            if (header.Folder == null || Engine.Missing() != null) return;
            string file = Engine.WriteSelection(Selection());
            RunEngine("Applying", new[] { "apply", "--game", header.Folder, "--selection", file });
        }

        void Restore()
        {
            if (header.Folder == null || Engine.Missing() != null) return;
            if (MessageBox.Show(FindForm(), "Put the game's own files back?" + Environment.NewLine + Environment.NewLine +
                    "This takes every module of this installer out of " + header.Folder + ", SnowRunner Shadows too.",
                    Header.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            RunEngine("Restoring the game's own files", new[] { "restore", "--game", header.Folder });
        }

        void RunEngine(string title, string[] args)
        {
            using (ProgressForm progress = new ProgressForm(look, title, args)) progress.ShowDialog(FindForm());
            RefreshStatus();
        }

        // ---- help and the game folder

        void ShowHelp(HelpTopic topic)
        {
            using (HelpForm help = new HelpForm(look, topic)) help.ShowDialog(FindForm());
        }

        static string FindGame()
        {
            foreach (string pak in GameFinder.FindPaks()) return GameFinder.FolderOf(pak);
            return null;
        }

        void PickGame()
        {
            using (OpenFileDialog d = new OpenFileDialog())
            {
                d.Title = "Find SnowRunner: pick SnowRunner.exe (in Sources\\Bin) or shader.pak (in preload\\paks\\client)";
                d.Filter = "SnowRunner.exe or shader.pak|SnowRunner.exe;shader.pak";
                d.CheckFileExists = true;
                if (header.Folder != null) d.InitialDirectory = header.Folder;
                if (d.ShowDialog(FindForm()) != DialogResult.OK) return;
                string folder = GameFinder.FolderOfPick(d.FileName);
                if (folder != null) { header.Folder = folder; RefreshStatus(); return; }
                MessageBox.Show(FindForm(), "No SnowRunner around this file:" + Environment.NewLine + d.FileName + Environment.NewLine + Environment.NewLine +
                    "Pick SnowRunner.exe in the game's Sources\\Bin folder, or shader.pak in its preload\\paks\\client folder.",
                    Header.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) noteTimer.Dispose();
            base.Dispose(disposing);
            if (disposing) look.Dispose();   // after the controls that draw with its fonts
        }
    }

    class MainForm : Form
    {
        readonly MainView view;

        public MainForm(string gameFolder)
        {
            Text = Header.AppName;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Back;
            using (Font body = Look.BaseFont(0)) view = new MainView(body, gameFolder);
            Font = view.Look.Body;
            view.Dock = DockStyle.Fill;
            Controls.Add(view);
            Icon = Header.EmblemIcon(view.Look.U(32));
            int em = view.Look.Body.Height;
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            Size start = view.StartSize;
            ClientSize = new Size(Math.Min(start.Width, work.Width * 92 / 100), Math.Min(start.Height, work.Height * 92 / 100));
            MinimumSize = SizeFromClientSize(new Size(Math.Min(em * 30, work.Width), Math.Min(em * 24, work.Height)));
            StartPosition = FormStartPosition.CenterScreen;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.DarkWindow(Handle, Theme.Bar, Theme.Text, Theme.Border);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            view.FocusFirstCard();
            view.Start();
        }
    }
}
