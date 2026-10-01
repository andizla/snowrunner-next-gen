// SPDX-License-Identifier: GPL-3.0-only
// Finds shader.pak of every SnowRunner install it can: Steam (all library folders), Epic Games, Microsoft Store.
// Every source is tried on its own, a failure in one never hides the others. (From the SnowRunner GTAO installer,
// with the game-folder helpers added.)
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace SnowRunnerNextGen
{
    static class GameFinder
    {
        const string SteamAppId = "1465360";
        static readonly string[] PakTails = { @"preload\paks\client\shader.pak", @"en_us\preload\paks\client\shader.pak" };

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

        // the game folder of a shader.pak
        public static string FolderOf(string pak)
        {
            string[] tails = { @"\en_us\preload\paks\client\shader.pak", @"\preload\paks\client\shader.pak" };
            foreach (string tail in tails)
                if (pak.EndsWith(tail, StringComparison.OrdinalIgnoreCase)) return pak.Substring(0, pak.Length - tail.Length);
            return Path.GetDirectoryName(pak);
        }

        public static bool IsGame(string folder)
        {
            foreach (string tail in PakTails) if (File.Exists(Path.Combine(folder, tail))) return true;
            return false;
        }

        // the game folder of a file the user picked (SnowRunner.exe in Sources\Bin, or shader.pak); null when it is neither
        public static string FolderOfPick(string file)
        {
            string full = Path.GetFullPath(file);
            string name = Path.GetFileName(full);
            string folder = null;
            if (string.Equals(name, "shader.pak", StringComparison.OrdinalIgnoreCase)) folder = FolderOf(full);
            else if (string.Equals(name, "SnowRunner.exe", StringComparison.OrdinalIgnoreCase))
            {
                DirectoryInfo bin = new DirectoryInfo(Path.GetDirectoryName(full));
                if (bin.Parent != null && bin.Parent.Parent != null) folder = bin.Parent.Parent.FullName;
            }
            return folder != null && IsGame(folder) ? folder : null;
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
                roots.Add(Path.Combine(d.RootDirectory.FullName, @"XboxGames\SnowRunner\Content"));
            }
        }
    }
}
