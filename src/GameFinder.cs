// SPDX-License-Identifier: GPL-3.0-only
// Finds shader.pak of every SnowRunner install it can: Steam (all library folders), Epic Games, the Xbox app
// (Microsoft Store, Game Pass). Every source is tried on its own, a failure in one never hides the others. (From the
// SnowRunner GTAO installer, with the game-folder helpers added.)
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace SnowRunnerNextGen
{
    static class GameFinder
    {
        const string SteamAppId = "1465360";
        // where a game folder keeps shader.pak (engine\ngen.js PAK_FOLDERS): Steam; Epic Games, the whole game one folder
        // down in en_us; the Xbox app's version, the game in <title>\Content with its paks under paks, seen from Content
        // and from the title's folder
        static readonly string[] PakTails = { @"preload\paks\client\shader.pak", @"en_us\preload\paks\client\shader.pak",
            @"paks\client\shader.pak", @"Content\paks\client\shader.pak", @"paks\shader.pak", @"Content\paks\shader.pak" };

        public static List<string> FindPaks()
        {
            List<string> roots = new List<string>();
            Try(delegate { Steam(roots); });
            Try(delegate { Epic(roots); });
            Try(delegate { MicrosoftStore(roots); });
            List<string> paks = new List<string>();
            foreach (string root in roots)
                foreach (string tail in PakTails)
                {
                    string p = Path.Combine(root, tail);
                    if (!File.Exists(p)) continue;
                    p = OnDisk(p);
                    if (!paks.Exists(delegate(string x) { return string.Equals(x, p, StringComparison.OrdinalIgnoreCase); })) paks.Add(p);
                }
            return paks;
        }

        // the path spelled the way the folders are named on disk (Steam's manifest can say SnowRunner for a Snowrunner
        // folder); the path as given when a part cannot be read
        public static string OnDisk(string path)
        {
            try
            {
                string full = Path.GetFullPath(path);
                string root = Path.GetPathRoot(full);
                string result = root.ToUpperInvariant();
                foreach (string part in full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string[] found = Directory.GetFileSystemEntries(result, part);
                    result = found.Length == 1 ? found[0] : Path.Combine(result, part);
                }
                return result;
            }
            catch (Exception) { return path; }
        }

        // the game folder of a shader.pak: the folder that holds preload (the one above en_us where the game is kept
        // there), or the folder that holds paks; for a pak anywhere else its own folder
        public static string FolderOf(string pak)
        {
            string[] tails = { @"\en_us\preload\paks\client\shader.pak", @"\preload\paks\client\shader.pak", @"\paks\client\shader.pak", @"\paks\shader.pak" };
            foreach (string tail in tails)
                if (pak.EndsWith(tail, StringComparison.OrdinalIgnoreCase)) return pak.Substring(0, pak.Length - tail.Length);
            return Path.GetDirectoryName(pak);
        }

        public static bool IsGame(string folder)
        {
            foreach (string tail in PakTails) if (File.Exists(Path.Combine(folder, tail))) return true;
            return File.Exists(Path.Combine(folder, "shader.pak"));
        }

        // the game folder of a file the user picked (SnowRunner.exe or shader.pak); null when no game is around it.
        // SnowRunner.exe lies in Sources\Bin, two folders down (Steam, Epic Games), or in the game's own folder (the
        // Xbox app's version)
        public static string FolderOfPick(string file)
        {
            string full = Path.GetFullPath(file);
            string name = Path.GetFileName(full);
            if (string.Equals(name, "shader.pak", StringComparison.OrdinalIgnoreCase))
            {
                string folder = FolderOf(full);
                return IsGame(folder) ? folder : null;
            }
            if (!string.Equals(name, "SnowRunner.exe", StringComparison.OrdinalIgnoreCase)) return null;
            DirectoryInfo bin = new DirectoryInfo(Path.GetDirectoryName(full));
            DirectoryInfo[] tries = { bin.Parent != null ? bin.Parent.Parent : null, bin, bin.Parent };
            foreach (DirectoryInfo d in tries) if (d != null && IsGame(d.FullName)) return d.FullName;
            return null;
        }

        static void Try(Action source)
        {
            try { source(); } catch (Exception) { }
        }

        static string RegistryString(RegistryKey hive, string key, string name)
        {
            using (RegistryKey k = hive.OpenSubKey(key)) return k == null ? null : k.GetValue(name) as string;
        }

        static void Steam(List<string> roots)
        {
            // the machine wide value spells the folder the way it is on disk, the per user one is all lower case
            string steam = RegistryString(Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath")
                ?? RegistryString(Registry.LocalMachine, @"SOFTWARE\Valve\Steam", "InstallPath")
                ?? RegistryString(Registry.CurrentUser, @"Software\Valve\Steam", "SteamPath");
            if (steam == null) return;
            steam = steam.Replace('/', '\\');
            List<string> libraries = new List<string>();
            libraries.Add(steam);
            string vdf = Path.Combine(steam, @"steamapps\libraryfolders.vdf");
            if (File.Exists(vdf))
                foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"([^\"]+)\""))
                    libraries.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
            foreach (string lib in libraries)
            {
                string manifest = Path.Combine(lib, @"steamapps\appmanifest_" + SteamAppId + ".acf");
                if (File.Exists(manifest))
                {
                    Match m = Regex.Match(File.ReadAllText(manifest), "\"installdir\"\\s+\"([^\"]+)\"");
                    if (m.Success) roots.Add(Path.Combine(lib, @"steamapps\common", m.Groups[1].Value));
                }
                roots.Add(Path.Combine(lib, @"steamapps\common\SnowRunner"));
            }
        }

        static void Epic(List<string> roots)
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Epic\EpicGamesLauncher\Data\Manifests");
            if (!Directory.Exists(dir)) return;
            foreach (string item in Directory.GetFiles(dir, "*.item"))
            {
                string text = File.ReadAllText(item);
                if (text.IndexOf("SnowRunner", StringComparison.OrdinalIgnoreCase) < 0) continue;
                Match m = Regex.Match(text, "\"InstallLocation\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) roots.Add(m.Groups[1].Value.Replace(@"\\", @"\").Replace('/', '\\'));
            }
        }

        static void MicrosoftStore(List<string> roots)
        {
            foreach (DriveInfo d in DriveInfo.GetDrives())
            {
                if (d.DriveType != DriveType.Fixed || !d.IsReady) continue;
                XboxTitles(d.RootDirectory.FullName, roots);
            }
        }

        // The Xbox app (Microsoft Store, Game Pass) keeps a game in <library>\<title>\Content. A drive it installs to
        // carries the file .GamingRoot with the library folder's name on that drive; XboxGames is the app's own choice.
        // Every title there with SnowRunner in its name is tried ("SnowRunner", "SnowRunner - Windows10").
        public static void XboxTitles(string drive, List<string> roots)
        {
            List<string> libraries = GamingRoot(Path.Combine(drive, ".GamingRoot"));
            if (!libraries.Exists(delegate(string x) { return string.Equals(x, "XboxGames", StringComparison.OrdinalIgnoreCase); })) libraries.Add("XboxGames");
            foreach (string name in libraries)
            {
                try
                {
                    string library = Path.Combine(drive, name);
                    if (!Directory.Exists(library)) continue;
                    foreach (string title in Directory.GetDirectories(library))
                        if (Path.GetFileName(title).IndexOf("SnowRunner", StringComparison.OrdinalIgnoreCase) >= 0) roots.Add(Path.Combine(title, "Content"));
                }
                catch (Exception) { }   // a library that cannot be listed
            }
        }

        // the library folders a .GamingRoot file names: "RGBX", a count, then that many names in UTF-16, each ended by
        // a zero, relative to the drive. A file that reads otherwise names none.
        public static List<string> GamingRoot(string file)
        {
            List<string> names = new List<string>();
            try
            {
                if (!File.Exists(file) || new FileInfo(file).Length > 4096) return names;
                byte[] b = File.ReadAllBytes(file);
                if (b.Length < 8 || b[0] != 'R' || b[1] != 'G' || b[2] != 'B' || b[3] != 'X') return names;
                int count = BitConverter.ToInt32(b, 4), at = 8;
                for (int i = 0; i < count && at + 1 < b.Length; i++)
                {
                    int end = at;
                    while (end + 1 < b.Length && (b[end] != 0 || b[end + 1] != 0)) end += 2;
                    string name = Encoding.Unicode.GetString(b, at, end - at).Trim('\\', '/', ' ');
                    at = end + 2;
                    if (name.Length == 0 || Path.IsPathRooted(name) || name.IndexOfAny(Path.GetInvalidPathChars()) >= 0) continue;
                    if (Array.IndexOf(name.Split('\\', '/'), "..") >= 0) continue;
                    names.Add(name);
                }
            }
            catch (Exception) { names.Clear(); }
            return names;
        }
    }
}
