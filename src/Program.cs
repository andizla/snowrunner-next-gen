// SPDX-License-Identifier: GPL-3.0-only
// Entry point. Double click opens the window; a folder on the command line is the game folder to use.
// For the layout checks, without a screen:
//   SnowRunnerNextGen.exe --shot <png> [--scale 1.5] [--size <width>x<height>] [--game <folder>]
//   draws the window's content at that scaling into a picture. Without --size it is the window's first size; a width
//   of 0 keeps the first width, a height of 0 makes the picture as tall as all the cards. --help <module id> (or
//   installer) draws that (?) pop-up instead, as tall as its content. --status draws the window once the engine has
//   read what the game folder has installed; --progress apply <selection.json> or --progress restore runs the engine on
//   the game folder (it CHANGES that folder: tests point it at a copy) and draws the progress window when it is over
//   (exit code 3 when the engine did not finish). Nothing is shown on the screen. Exit code 0 = drawn, 2 = failed
//   (the reason in <png>.error.txt).
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SnowRunnerNextGen
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length >= 2 && args[0] == "--shot") return Shot(args);
            Application.Run(new MainForm(args.Length == 1 ? args[0] : null));
            return 0;
        }

        static int Shot(string[] args)
        {
            string png = Path.GetFullPath(args[1]);
            try
            {
                string game = null, help = null, progress = null, selection = null;
                float scale = 1f;
                int width = 0, height = -1;
                bool status = false;
                for (int i = 2; i < args.Length; i++)
                {
                    string a = args[i], next = i + 1 < args.Length ? args[i + 1] : null;
                    if (a == "--status") status = true;
                    else if (next == null) break;
                    else if (a == "--scale") { scale = float.Parse(next, CultureInfo.InvariantCulture); i++; }
                    else if (a == "--game") { game = next; i++; }
                    else if (a == "--help") { help = next; i++; }
                    else if (a == "--progress") { progress = next; i++; if (progress == "apply" && i + 1 < args.Length) selection = args[++i]; }
                    else if (a == "--size")
                    {
                        string[] wh = next.Split('x');
                        width = int.Parse(wh[0], CultureInfo.InvariantCulture);
                        height = int.Parse(wh[1], CultureInfo.InvariantCulture);
                        i++;
                    }
                }
                if (progress != null) return ProgressShot(png, scale, game, progress, selection);
                Look helpLook = null;   // the window makes its own; a pop-up borrows the window's
                try
                {
                    using (Form host = new Form())
                    {
                        host.AutoScaleMode = AutoScaleMode.None;
                        Control view;
                        Size start;
                        Func<int, int> fullHeight;
                        if (help == null)
                        {
                            MainView main;
                            using (Font body = Look.BaseFont(scale)) main = new MainView(body, game);
                            view = main;
                            start = main.StartSize;
                            fullHeight = main.FullHeight;
                            if (status)
                            {
                                host.Controls.Add(main);
                                main.Bounds = new Rectangle(0, 0, width > 0 ? width : start.Width, start.Height);
                                MakeHandles(main);
                                main.Start();
                                PumpUntil(delegate { return main.StatusKnown; }, 120);
                            }
                        }
                        else
                        {
                            using (Font body = Look.BaseFont(scale)) helpLook = new Look(body);
                            HelpPage page = new HelpPage(helpLook, TopicFor(help));
                            view = page;
                            start = new Size(page.StartWidth, 0);   // a pop-up opens as tall as its content
                            fullHeight = page.FullHeight;
                        }
                        host.Controls.Add(view);
                        if (width <= 0) width = start.Width;
                        if (height < 0) height = start.Height;
                        if (height == 0) height = fullHeight(width);
                        view.Bounds = new Rectangle(0, 0, width, height);
                        MakeHandles(view);
                        view.PerformLayout();
                        Application.DoEvents();
                        using (Bitmap picture = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                        {
                            view.DrawToBitmap(picture, new Rectangle(0, 0, width, height));
                            picture.Save(png, ImageFormat.Png);
                        }
                    }
                }
                finally
                {
                    if (helpLook != null) helpLook.Dispose();
                }
                return 0;
            }
            catch (Exception e)
            {
                File.WriteAllText(png + ".error.txt", e.ToString());
                return 2;
            }
        }

        // the engine run to its end in the progress window, never shown, and the window's content drawn
        static int ProgressShot(string png, float scale, string game, string what, string selection)
        {
            if (game == null) throw new ArgumentException("--progress needs --game <folder>");
            string[] engineArgs = what == "restore" ? new[] { "restore", "--game", game }
                : new[] { "apply", "--game", game, "--selection", selection ?? "" };
            Look look;
            using (Font body = Look.BaseFont(scale)) look = new Look(body);
            try
            {
                using (ProgressForm form = new ProgressForm(look, what == "restore" ? "Restoring the game's own files" : "Applying", engineArgs))
                {
                    MakeHandles(form);
                    form.PerformLayout();
                    form.Begin();
                    PumpUntil(delegate { return !form.Running; }, 1800);
                    PumpUntil(delegate { return false; }, 1);   // the last events settle
                    Size size = form.ClientSize;
                    using (Bitmap picture = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb))
                    {
                        foreach (Control part in form.Controls) part.DrawToBitmap(picture, part.Bounds);
                        picture.Save(png, ImageFormat.Png);
                    }
                    return form.Succeeded ? 0 : 3;
                }
            }
            finally { look.Dispose(); }
        }

        static void PumpUntil(Func<bool> done, int seconds)
        {
            DateTime end = DateTime.Now.AddSeconds(seconds);
            while (!done() && DateTime.Now < end) { Application.DoEvents(); System.Threading.Thread.Sleep(20); }
        }

        // the pop-up of a module id, or the installer's own ("installer")
        static HelpTopic TopicFor(string id)
        {
            if (id == "installer") return Help.InstallerTopic();
            foreach (Module m in Catalog.All()) if (m.Id == id) return Help.TopicFor(m);
            throw new ArgumentException("no module " + id);
        }

        // the host window is never shown, so WinForms makes no windows for the controls in it: make them here, or the
        // picture has nothing to print
        static void MakeHandles(Control control)
        {
            if (control.Handle == IntPtr.Zero) return;
            foreach (Control child in control.Controls) MakeHandles(child);
        }
    }

    // the few Windows calls the window needs; each one fails quietly on versions without it
    static class Native
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] static extern int SetWindowTheme(IntPtr window, string subApp, string idList);
        [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);

        const int DarkModeOld = 19, DarkMode = 20, BorderColor = 34, CaptionColor = 35, TextColor = 36;

        // a dark title bar (Windows 10 2004 and later) in these colours (Windows 11)
        public static void DarkWindow(IntPtr window, Color caption, Color text, Color border)
        {
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(window, DarkMode, ref on, 4) != 0) DwmSetWindowAttribute(window, DarkModeOld, ref on, 4);
                int c = ColorRef(caption), t = ColorRef(text), b = ColorRef(border);
                DwmSetWindowAttribute(window, CaptionColor, ref c, 4);
                DwmSetWindowAttribute(window, TextColor, ref t, 4);
                DwmSetWindowAttribute(window, BorderColor, ref b, 4);
            }
            catch (Exception) { }
        }

        // dark scroll bars (Windows 10 1809 and later)
        public static void DarkScrollBars(IntPtr window)
        {
            try { SetWindowTheme(window, "DarkMode_Explorer", null); }
            catch (Exception) { }
        }

        static int ColorRef(Color c) { return c.R | c.G << 8 | c.B << 16; }
    }
}
