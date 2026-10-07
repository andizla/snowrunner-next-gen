// SPDX-License-Identifier: GPL-3.0-only
// Runs the engine (engine\ngen.js next to the exe, with the node.exe beside it or the one installed) and hands its
// events to the window, one JSON object per line (see ngen.js): status reads what a game folder has installed;
// apply and restore change the game, reporting as they go. The work runs on a worker thread; every event reaches the
// window's thread.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    class EngineEvent
    {
        public string Type, Text, Code;           // step, log, warn, status, done, error
        public Dictionary<string, object> Data;   // the whole object
    }

    // what a game folder has now, from the engine's status
    class GameStatus
    {
        public bool Running;
        public string Shader = "unknown";         // stock, ours, changed, unknown
        public readonly List<string> Modules = new List<string>();
        public string Dll = "none";               // none, ours, foreign, nobin
        public bool DllCurrent;
        public string Factor, SlopeBias;
        public string AoHalf;                     // the DLL draws the ambient occlusion pass at half size: "1", or full: "0"
        public string Scenery = "vanilla";        // vanilla, nature, all, changed, missing
        public string SceneryHide = "off", SceneryShadows = "off";   // the set's two extras: off, plants, all
        public string Grass = "vanilla";          // vanilla, ours, changed, missing
        public string GrassFactor;
        public string Fill = "vanilla";           // the fill light, the other part of initial.pak: the same states
        public string FillFactor;
        public string Grade = "vanilla";          // the photo grade in boot.pak: vanilla, ours, changed, missing
        public string GradeStrength;
        public string Particles = "vanilla";      // the sharper particle sprites, also in boot.pak: the same states
        public string Stars = "vanilla";          // brighter stars, the third part of initial.pak: the same states
        public string StarsFactor;
        public string Weather = "vanilla";        // the weather, the fourth part of initial.pak: the same states
        public string WeatherParts;               // its parts as a comma list (shadows, showers, evening, horizon, far)
        public string Sky = "vanilla";            // the night sky, the third part of boot.pak: the same states
        public string Logos = "vanilla";          // the Next Gen logos in gfx.pak: the same states
        public readonly List<string> Orphaned = new List<string>();   // paks that hold our changes while their kept originals are gone
        public readonly List<string> Outdated = new List<string>();   // installed parts this installer carries in another build: Apply updates them

        public bool AnythingOurs
        {
            get
            {
                return Shader == "ours" || Dll == "ours" || Scenery == "nature" || Scenery == "all" || Grass == "ours" || Fill == "ours" || Stars == "ours" || Weather == "ours"
                    || Grade == "ours" || Particles == "ours" || Sky == "ours" || Logos == "ours";
            }
        }

        public static GameStatus From(Dictionary<string, object> d)
        {
            GameStatus s = new GameStatus();
            s.Running = d.ContainsKey("running") && d["running"] is bool && (bool)d["running"];
            Dictionary<string, object> shader = Part(d, "shader"), dll = Part(d, "dll"), grass = Part(d, "grass"), fill = Part(d, "fill"), grade = Part(d, "grade");
            s.Shader = Text(shader, "state") ?? "unknown";
            IEnumerable modules = shader != null && shader.ContainsKey("modules") ? shader["modules"] as IEnumerable : null;
            if (modules != null) foreach (object m in modules) if (m != null) s.Modules.Add(m.ToString());
            s.Dll = Text(dll, "state") ?? "none";
            s.DllCurrent = dll != null && dll.ContainsKey("current") && dll["current"] is bool && (bool)dll["current"];
            s.Factor = Text(dll, "factor");
            s.SlopeBias = Text(dll, "slopeBias");
            s.AoHalf = Text(dll, "aoHalf");
            s.Scenery = d.ContainsKey("scenery") && d["scenery"] != null ? d["scenery"].ToString() : "missing";
            s.SceneryHide = d.ContainsKey("sceneryHide") && d["sceneryHide"] != null ? d["sceneryHide"].ToString() : "off";
            s.SceneryShadows = d.ContainsKey("sceneryShadows") && d["sceneryShadows"] != null ? d["sceneryShadows"].ToString() : "off";
            s.Grass = Text(grass, "state") ?? "missing";
            s.GrassFactor = Text(grass, "factor");
            s.Fill = Text(fill, "state") ?? "missing";
            s.FillFactor = Text(fill, "factor");
            s.Grade = Text(grade, "state") ?? "missing";
            s.GradeStrength = Text(grade, "strength");
            s.Particles = Text(Part(d, "particles"), "state") ?? "missing";
            Dictionary<string, object> stars = Part(d, "stars");
            s.Stars = Text(stars, "state") ?? "missing";
            s.StarsFactor = Text(stars, "factor");
            Dictionary<string, object> weather = Part(d, "weather");
            s.Weather = Text(weather, "state") ?? "missing";
            s.WeatherParts = Text(weather, "parts");
            s.Sky = Text(Part(d, "sky"), "state") ?? "missing";
            s.Logos = Text(Part(d, "logos"), "state") ?? "missing";
            IEnumerable orphaned = d.ContainsKey("orphaned") ? d["orphaned"] as IEnumerable : null;
            if (orphaned != null && !(orphaned is string)) foreach (object f in orphaned) if (f != null) s.Orphaned.Add(f.ToString());
            IEnumerable outdated = d.ContainsKey("outdated") ? d["outdated"] as IEnumerable : null;
            if (outdated != null && !(outdated is string)) foreach (object p in outdated) if (p != null) s.Outdated.Add(p.ToString());
            return s;
        }

        static Dictionary<string, object> Part(Dictionary<string, object> d, string key)
        {
            return d.ContainsKey(key) ? d[key] as Dictionary<string, object> : null;
        }

        static string Text(Dictionary<string, object> d, string key)
        {
            return d != null && d.ContainsKey(key) && d[key] != null ? Convert.ToString(d[key], System.Globalization.CultureInfo.InvariantCulture) : null;
        }
    }

    static class Engine
    {
        // next to this program's own file (also when its code is loaded by a test)
        static string Folder { get { return Path.Combine(Path.GetDirectoryName(typeof(Engine).Assembly.Location), "engine"); } }
        static string Script { get { return Path.Combine(Folder, "ngen.js"); } }

        // node.exe: the one shipped next to the engine, else the one on PATH, else the one Node.js installs
        static string Node()
        {
            string shipped = Path.Combine(Folder, "node.exe");
            if (File.Exists(shipped)) return shipped;
            foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                string d = dir.Trim().Trim('"');
                if (d.Length == 0) continue;
                try { string p = Path.Combine(d, "node.exe"); if (File.Exists(p)) return p; }
                catch (ArgumentException) { }
            }
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            return File.Exists(installed) ? installed : null;
        }

        // why the engine cannot run, or null. A file missing next to the program is an unzip that went wrong (a program
        // that does not know the zip's folder paths, or one file taken away by a virus scanner)
        public static string Missing()
        {
            const string again = " Unzip the download again (right click the zip, Extract All) and start the program from the new folder.";
            if (!File.Exists(Script)) return "The install engine is missing: engine\\ngen.js should be next to the program." + again;
            if (Node() == null) return "Node.js is missing: engine\\node.exe should be next to the program." + again;
            return null;
        }

        // the engine's log (engine\ngen.js writes install.log beside its state folders), or null while there is none
        public static string LogFile()
        {
            string file = LogPath();
            return File.Exists(file) ? file : null;
        }

        // where the engine keeps its state folders and its log (engine\ngen.js stateRoot)
        static string StateRoot()
        {
            string root = Environment.GetEnvironmentVariable("NGEN_STATE_ROOT");
            if (!string.IsNullOrEmpty(root)) return root;
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            return Path.Combine(string.IsNullOrEmpty(local) ? Path.GetTempPath() : local, "SnowRunnerNextGen");
        }

        static string LogPath() { return Path.Combine(StateRoot(), "install.log"); }

        // The game folder the player picked last, kept beside the log (last_game.txt): the next start opens on it
        // instead of the first install found. Null when none was picked or it is no game folder any more.
        public static string RememberedGame()
        {
            try
            {
                string file = Path.Combine(StateRoot(), "last_game.txt");
                if (!File.Exists(file)) return null;
                string folder = File.ReadAllText(file, Encoding.UTF8).Trim();
                return folder.Length > 0 && Directory.Exists(folder) && GameFinder.IsGame(folder) ? folder : null;
            }
            catch (Exception) { return null; }
        }

        public static void RememberGame(string folder)
        {
            try
            {
                Directory.CreateDirectory(StateRoot());
                File.WriteAllText(Path.Combine(StateRoot(), "last_game.txt"), folder + "\r\n", new UTF8Encoding(false));
            }
            catch (Exception) { }   // the next start looks for the game again
        }

        // the log's file shown in its folder, ready to be sent
        public static void ShowLog()
        {
            string file = LogFile();
            if (file == null) return;
            try { Process.Start("explorer.exe", "/select,\"" + file + "\""); }
            catch (Exception) { }   // no Explorer to show it in
        }

        // a line of the window's own in that log: what the engine could not write itself
        static void Log(string text)
        {
            try
            {
                string file = LogPath(), at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                StringBuilder lines = new StringBuilder();
                foreach (string l in text.Replace("\r", "").Split('\n')) lines.Append(at).Append("  ").Append(l).Append("\r\n");
                File.AppendAllText(file, lines.ToString(), new UTF8Encoding(false));
            }
            catch (Exception) { }   // the log is an extra
        }

        // the selection for apply, as the engine's JSON, in a file of its own
        public static string WriteSelection(Dictionary<string, object> selection)
        {
            string file = Path.Combine(Path.GetTempPath(), "SnowRunnerNextGen-selection.json");
            File.WriteAllText(file, new JavaScriptSerializer().Serialize(selection), new UTF8Encoding(false));
            return file;
        }

        // runs ngen.js with these arguments; each event reaches onEvent on the owner's thread, then onExit gets the exit
        // code. A crash without an error event of its own becomes one.
        public static void Run(Control owner, string[] args, Action<EngineEvent> onEvent, Action<int> onExit)
        {
            Thread worker = new Thread(delegate()
            {
                int code = -1;
                bool ended = false;
                StringBuilder errors = new StringBuilder();
                try
                {
                    StringBuilder line = new StringBuilder(Quote(Script));
                    foreach (string a in args) line.Append(' ').Append(Quote(a));
                    ProcessStartInfo info = new ProcessStartInfo(Node(), line.ToString());
                    info.UseShellExecute = false;
                    info.CreateNoWindow = true;
                    info.RedirectStandardOutput = true;
                    info.RedirectStandardError = true;
                    info.StandardOutputEncoding = Encoding.UTF8;
                    info.StandardErrorEncoding = Encoding.UTF8;
                    using (Process p = Process.Start(info))
                    {
                        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (errors) errors.AppendLine(e.Data); };
                        p.BeginErrorReadLine();
                        for (string text; (text = p.StandardOutput.ReadLine()) != null;)
                        {
                            EngineEvent ev = Parse(text);
                            if (ev == null) continue;
                            if (ev.Type == "done" || ev.Type == "error") ended = true;
                            Post(owner, onEvent, ev);
                        }
                        p.WaitForExit();
                        code = p.ExitCode;
                    }
                }
                catch (Exception e) { lock (errors) errors.AppendLine(e.Message); }
                if (!ended && code != 0)
                {
                    EngineEvent crash = new EngineEvent();
                    crash.Type = "error";
                    crash.Code = "failed";
                    string said;
                    lock (errors) said = errors.ToString().Trim();
                    Log("the engine stopped without a word of its own, exit code " + code + (said.Length > 0 ? "\n" + said : ""));
                    crash.Text = "The engine stopped" + (said.Length > 0 ? ": " + LastLines(said, 3) : ".");
                    Post(owner, onEvent, crash);
                }
                try { owner.BeginInvoke((MethodInvoker)delegate { onExit(code); }); }
                catch (InvalidOperationException) { }   // the window is gone
            });
            worker.IsBackground = true;
            worker.Start();
        }

        static void Post(Control owner, Action<EngineEvent> onEvent, EngineEvent ev)
        {
            try { owner.BeginInvoke((MethodInvoker)delegate { onEvent(ev); }); }
            catch (InvalidOperationException) { }
        }

        static EngineEvent Parse(string line)
        {
            if (string.IsNullOrEmpty(line) || line[0] != '{') return null;
            Dictionary<string, object> d;
            try { d = new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
            if (d == null) return null;
            EngineEvent ev = new EngineEvent();
            ev.Data = d;
            ev.Type = d.ContainsKey("type") ? Convert.ToString(d["type"]) : "";
            ev.Text = d.ContainsKey("text") ? Convert.ToString(d["text"]) : "";
            ev.Code = d.ContainsKey("code") ? Convert.ToString(d["code"]) : null;
            return ev;
        }

        static string LastLines(string text, int n)
        {
            string[] lines = text.Replace("\r", "").Split('\n');
            int from = Math.Max(0, lines.Length - n);
            return string.Join(" ", lines, from, lines.Length - from).Trim();
        }

        // one argument for the command line, the way Windows programs split it again
        static string Quote(string arg)
        {
            StringBuilder b = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { b.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
                b.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return b.Append('\\', slashes * 2).Append('"').ToString();
        }
    }
}
