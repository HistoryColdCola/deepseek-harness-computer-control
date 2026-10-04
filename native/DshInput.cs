// DshInput.cs -- Windows input / capture helper for the dsh-computer-control
// plugin. It is the Windows counterpart of native/DshInput.swift and emits the
// same JSON shapes, so the Node layer stays platform neutral.
//
// CLI:    dsh-input.exe <command> [args...]
// Output: exactly one JSON object on stdout and exit 0 on success; one short
//         human-readable line on stderr and exit 1 on failure.
// Build:  scripts/build-helper.ps1, using the .NET Framework 4.x csc.exe that
//         ships with Windows. This file is deliberately C# 5 only (no string
//         interpolation, no expression-bodied members, no out-var, ...).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class DshInput
{
    // ------------------------------------------------------------- constants

    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int DWMWA_CLOAKED = 14;
    const int MONITORINFOF_PRIMARY = 0x00000001;
    const int MDT_EFFECTIVE_DPI = 0;

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    // Absolute coordinates are meaningless outside the primary monitor, so the
    // move has to be normalised over the whole virtual desktop.
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    const int SW_RESTORE = 9;
    const uint WM_CLOSE = 0x0010;
    const uint PW_RENDERFULLCONTENT = 0x00000002;
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;

    // Virtual key codes, named for the key table below.
    const int VK_BACK = 0x08;
    const int VK_TAB = 0x09;
    const int VK_RETURN = 0x0D;
    const int VK_CAPITAL = 0x14;
    const int VK_ESCAPE = 0x1B;
    const int VK_SPACE = 0x20;
    const int VK_PRIOR = 0x21;
    const int VK_NEXT = 0x22;
    const int VK_END = 0x23;
    const int VK_HOME = 0x24;
    const int VK_LEFT = 0x25;
    const int VK_UP = 0x26;
    const int VK_RIGHT = 0x27;
    const int VK_DOWN = 0x28;
    const int VK_INSERT = 0x2D;
    const int VK_DELETE = 0x2E;
    const int VK_LWIN = 0x5B;
    const int VK_LSHIFT = 0xA0;
    const int VK_LCONTROL = 0xA2;
    const int VK_LMENU = 0xA4;

    const int WHEEL_LIMIT = 100000;
    const int MAX_CAPTURE_EDGE = 32768;

    // --------------------------------------------------------------- structs

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    // MOUSEINPUT is the largest member, so it also fixes the union size (32
    // bytes on x64, 24 on x86) and therefore sizeof(INPUT) = 40 / 28.
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    // ------------------------------------------------------------- delegates

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprcMonitor, IntPtr dwData);

    // ------------------------------------------------------------- pinvokes

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("kernel32.dll")]
    static extern bool SetConsoleOutputCP(uint wCodePageID);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    [DllImport("shcore.dll")]
    static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("user32.dll")]
    static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalFree(IntPtr hMem);

    // ---------------------------------------------------------------- errors

    sealed class DshError : Exception
    {
        public DshError(string message) : base(message) { }
    }

    static DshError Failure(string message)
    {
        return new DshError(message);
    }

    // ----------------------------------------------------------- json output

    static void Emit(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    /** JSON string literal: quote, backslash and every control char < 0x20. */
    static string Q(string value)
    {
        string text = value == null ? "" : value;
        StringBuilder sb = new StringBuilder(text.Length + 2);
        sb.Append('"');
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static string Num(long value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    static string Num(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) return "0";
        return value.ToString("R", CultureInfo.InvariantCulture);
    }

    static string Describe(Exception error)
    {
        string message = error == null ? "" : error.Message;
        if (message == null) message = "";
        StringBuilder sb = new StringBuilder(message.Length);
        for (int i = 0; i < message.Length; i++)
        {
            char c = message[i];
            sb.Append(c == '\r' || c == '\n' || c == '\t' ? ' ' : c);
        }
        string line = sb.ToString().Trim();
        if (line.Length == 0) line = "unknown failure";
        if (line.Length > 400) line = line.Substring(0, 400);
        return line;
    }

    // -------------------------------------------------------- argument tools

    static string FlagValue(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == name) return args[i + 1];
        }
        return null;
    }

    static bool HasFlag(string[] args, string name)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == name) return true;
        }
        return false;
    }

    /** Values that are not flags and not the value of a flag, in order. */
    static string[] Positional(string[] args)
    {
        List<string> values = new List<string>();
        bool skipNext = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (skipNext)
            {
                skipNext = false;
                continue;
            }
            string value = args[i];
            if (value.StartsWith("--", StringComparison.Ordinal))
            {
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) skipNext = true;
                continue;
            }
            values.Add(value);
        }
        return values.ToArray();
    }

    static bool ParseDouble(string value, out double parsed)
    {
        parsed = 0;
        if (value == null) return false;
        return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed);
    }

    static int ParseInt(string value, string what)
    {
        double parsed;
        if (!ParseDouble(value, out parsed) || double.IsNaN(parsed) || double.IsInfinity(parsed))
        {
            throw Failure(what + " is not a number: " + (value == null ? "" : value));
        }
        if (parsed < (double)int.MinValue || parsed > (double)int.MaxValue)
        {
            throw Failure(what + " is out of range: " + value);
        }
        return (int)Math.Round(parsed, MidpointRounding.AwayFromZero);
    }

    static long ParseLong(string value, string what)
    {
        long parsed;
        if (value == null || !long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
        {
            throw Failure(what + " is not an integer: " + (value == null ? "" : value));
        }
        return parsed;
    }

    static string StripExe(string name)
    {
        string trimmed = name.Trim();
        if (trimmed.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return trimmed.Substring(0, trimmed.Length - 4);
        return trimmed;
    }

    static bool ContainsText(string haystack, string needle)
    {
        if (haystack == null || needle == null || needle.Length == 0) return false;
        return haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    // ------------------------------------------------------------ input core

    static void SendInputs(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)inputs.Length)
        {
            // Win32 does not report UIPI blocking through GetLastError, so the
            // hint names the likely causes instead of guessing one.
            string hint = sent == 0
                ? " (no event reached the target: the focused window is probably elevated while this process is not " +
                  "(User Interface Privilege Isolation), or the session is locked)"
                : "";
            throw Failure("SendInput injected " + sent + " of " + inputs.Length +
                " events (Win32 error " + Marshal.GetLastWin32Error() + ")" + hint);
        }
    }

    /** Absolute coordinates are normalised to 0..65535 over the virtual screen. */
    static int NormalizeCoordinate(int value, int origin, int span)
    {
        if (span <= 1) return 0;
        double scaled = ((double)value - (double)origin) * 65535.0 / ((double)span - 1.0);
        if (scaled < 0.0) scaled = 0.0;
        if (scaled > 65535.0) scaled = 65535.0;
        return (int)Math.Round(scaled, MidpointRounding.AwayFromZero);
    }

    static void MoveCursor(int x, int y)
    {
        int virtualX = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int virtualY = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (virtualWidth <= 0 || virtualHeight <= 0) throw Failure("could not measure the virtual screen");

        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = NormalizeCoordinate(x, virtualX, virtualWidth);
        input.u.mi.dy = NormalizeCoordinate(y, virtualY, virtualHeight);
        input.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInputs(new INPUT[] { input });
    }

    static void PressMouse(uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        SendInputs(new INPUT[] { input });
    }

    static void MouseButtonFlags(string button, out uint down, out uint up)
    {
        switch (button)
        {
            case "left":
                down = MOUSEEVENTF_LEFTDOWN;
                up = MOUSEEVENTF_LEFTUP;
                return;
            case "right":
                down = MOUSEEVENTF_RIGHTDOWN;
                up = MOUSEEVENTF_RIGHTUP;
                return;
            case "middle":
                down = MOUSEEVENTF_MIDDLEDOWN;
                up = MOUSEEVENTF_MIDDLEUP;
                return;
            default:
                throw Failure("unknown mouse button: " + button + " (use left, right or middle)");
        }
    }

    static bool IsExtendedKey(int vk)
    {
        switch (vk)
        {
            case VK_PRIOR:
            case VK_NEXT:
            case VK_END:
            case VK_HOME:
            case VK_LEFT:
            case VK_UP:
            case VK_RIGHT:
            case VK_DOWN:
            case VK_INSERT:
            case VK_DELETE:
                return true;
            default:
                return false;
        }
    }

    static void SendKeyEvent(int vk, bool down, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
        input.u.ki.dwFlags = (down ? 0u : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0u);
        SendInputs(new INPUT[] { input });
    }

    static void TapKey(int vk)
    {
        bool extended = IsExtendedKey(vk);
        SendKeyEvent(vk, true, extended);
        SendKeyEvent(vk, false, extended);
    }

    /**
     * Type arbitrary text through KEYEVENTF_UNICODE, which bypasses the input
     * method (so CJK and emoji arrive literally). One SendInput call carries up
     * to 64 characters; a non-zero per-character delay forces one character per
     * call, because a whole array is injected before the call returns.
     */
    static void TypeText(string text, int delayMs)
    {
        int index = 0;
        while (index < text.Length)
        {
            int chunk = delayMs > 0 ? 1 : 64;
            if (chunk > text.Length - index) chunk = text.Length - index;

            INPUT[] inputs = new INPUT[chunk * 2];
            for (int i = 0; i < chunk; i++)
            {
                ushort codeUnit = (ushort)text[index + i];
                inputs[i * 2].type = INPUT_KEYBOARD;
                inputs[i * 2].u.ki.wVk = 0;
                inputs[i * 2].u.ki.wScan = codeUnit;
                inputs[i * 2].u.ki.dwFlags = KEYEVENTF_UNICODE;
                inputs[i * 2 + 1].type = INPUT_KEYBOARD;
                inputs[i * 2 + 1].u.ki.wVk = 0;
                inputs[i * 2 + 1].u.ki.wScan = codeUnit;
                inputs[i * 2 + 1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            }
            SendInputs(inputs);
            index += chunk;
            if (delayMs > 0) Thread.Sleep(delayMs);
        }
    }

    // -------------------------------------------------------------- key table

    static readonly Dictionary<string, int> KeyNames = BuildKeyNames();

    static Dictionary<string, int> BuildKeyNames()
    {
        Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (char c = 'a'; c <= 'z'; c++) map[c.ToString()] = 0x41 + (c - 'a');
        for (char c = '0'; c <= '9'; c++) map[c.ToString()] = 0x30 + (c - '0');
        map["return"] = VK_RETURN;
        map["enter"] = VK_RETURN;
        map["tab"] = VK_TAB;
        map["space"] = VK_SPACE;
        map["escape"] = VK_ESCAPE;
        map["esc"] = VK_ESCAPE;
        map["backspace"] = VK_BACK;
        map["delete"] = VK_BACK;
        map["forwarddelete"] = VK_DELETE;
        map["left"] = VK_LEFT;
        map["arrowleft"] = VK_LEFT;
        map["right"] = VK_RIGHT;
        map["arrowright"] = VK_RIGHT;
        map["up"] = VK_UP;
        map["arrowup"] = VK_UP;
        map["down"] = VK_DOWN;
        map["arrowdown"] = VK_DOWN;
        map["home"] = VK_HOME;
        map["end"] = VK_END;
        map["pageup"] = VK_PRIOR;
        map["pagedown"] = VK_NEXT;
        map["insert"] = VK_INSERT;
        for (int i = 1; i <= 12; i++) map["f" + i] = 0x70 + (i - 1);
        map["cmd"] = VK_LWIN;
        map["command"] = VK_LWIN;
        map["win"] = VK_LWIN;
        map["shift"] = VK_LSHIFT;
        map["alt"] = VK_LMENU;
        map["option"] = VK_LMENU;
        map["ctrl"] = VK_LCONTROL;
        map["control"] = VK_LCONTROL;
        map["capslock"] = VK_CAPITAL;
        map["minus"] = 0xBD;
        map["equal"] = 0xBB;
        map["comma"] = 0xBC;
        map["period"] = 0xBE;
        map["slash"] = 0xBF;
        map["backslash"] = 0xDC;
        map["semicolon"] = 0xBA;
        map["quote"] = 0xDE;
        map["leftbracket"] = 0xDB;
        map["rightbracket"] = 0xDD;
        map["grave"] = 0xC0;
        return map;
    }

    /** Named key first, then a raw decimal virtual-key code. */
    static int LookupKey(string name)
    {
        string trimmed = name == null ? "" : name.Trim();
        int code;
        if (KeyNames.TryGetValue(trimmed, out code)) return code;

        ushort raw;
        if (ushort.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out raw)) return raw;

        throw Failure("unknown key name: " + (name == null ? "" : name));
    }

    /** Left-hand modifier virtual key for a chord token, or 0 when not one. */
    static int ModifierKey(string token)
    {
        string name = token == null ? "" : token.Trim().ToLowerInvariant();
        switch (name)
        {
            case "cmd":
            case "command":
            case "win":
                return VK_LWIN;
            case "shift":
                return VK_LSHIFT;
            case "alt":
            case "option":
                return VK_LMENU;
            case "ctrl":
            case "control":
                return VK_LCONTROL;
            default:
                return 0;
        }
    }

    static void PressChord(int vk, List<int> modifiers)
    {
        for (int i = 0; i < modifiers.Count; i++)
        {
            SendKeyEvent(modifiers[i], true, false);
            Thread.Sleep(8);
        }
        Thread.Sleep(10);
        bool extended = IsExtendedKey(vk);
        SendKeyEvent(vk, true, extended);
        Thread.Sleep(14);
        SendKeyEvent(vk, false, extended);
        Thread.Sleep(8);
        for (int i = modifiers.Count - 1; i >= 0; i--)
        {
            SendKeyEvent(modifiers[i], false, false);
            Thread.Sleep(8);
        }
    }

    // ------------------------------------------------------------- monitoring

    sealed class MonitorInfo
    {
        public RECT Bounds;
        public bool Primary;
        public double Scale;
    }

    static double MonitorScale(IntPtr monitor)
    {
        try
        {
            uint dpiX;
            uint dpiY;
            if (GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out dpiX, out dpiY) == 0 && dpiX > 0) return dpiX / 96.0;
        }
        catch (DllNotFoundException)
        {
            return 1.0; // shcore.dll predates Windows 8.1
        }
        catch (EntryPointNotFoundException)
        {
            return 1.0;
        }
        return 1.0;
    }

    static int CompareMonitors(MonitorInfo a, MonitorInfo b)
    {
        if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
        if (a.Bounds.Left != b.Bounds.Left) return a.Bounds.Left < b.Bounds.Left ? -1 : 1;
        if (a.Bounds.Top != b.Bounds.Top) return a.Bounds.Top < b.Bounds.Top ? -1 : 1;
        return 0;
    }

    /** Every monitor, primary first, then left-to-right and top-to-bottom. */
    static List<MonitorInfo> GetMonitors()
    {
        List<MonitorInfo> monitors = new List<MonitorInfo>();
        MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(hMonitor, ref info))
            {
                MonitorInfo monitor = new MonitorInfo();
                monitor.Bounds = info.rcMonitor;
                monitor.Primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
                monitor.Scale = MonitorScale(hMonitor);
                monitors.Add(monitor);
            }
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) throw Failure("could not enumerate displays");
        if (monitors.Count == 0) throw Failure("no displays found");
        monitors.Sort(CompareMonitors);
        return monitors;
    }

    static string MonitorsJson(List<MonitorInfo> monitors)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append('[');
        for (int i = 0; i < monitors.Count; i++)
        {
            MonitorInfo monitor = monitors[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"index\":").Append(Num(i + 1));
            sb.Append(",\"x\":").Append(Num(monitor.Bounds.Left));
            sb.Append(",\"y\":").Append(Num(monitor.Bounds.Top));
            sb.Append(",\"width\":").Append(Num(monitor.Bounds.Width));
            sb.Append(",\"height\":").Append(Num(monitor.Bounds.Height));
            sb.Append(",\"scale\":").Append(Num(monitor.Scale));
            sb.Append(",\"pixelsWide\":").Append(Num(monitor.Bounds.Width));
            sb.Append(",\"pixelsHigh\":").Append(Num(monitor.Bounds.Height));
            sb.Append('}');
        }
        sb.Append(']');
        return sb.ToString();
    }

    // --------------------------------------------------------------- windows

    sealed class WindowInfo
    {
        public IntPtr Hwnd;
        public long Id;
        public string App = "";
        public string Title = "";
        public long Pid;
        public RECT Bounds;
        public bool Minimized;
    }

    static string ProcessName(uint pid)
    {
        try
        {
            using (Process process = Process.GetProcessById((int)pid))
            {
                return process.ProcessName;
            }
        }
        catch (ArgumentException)
        {
            return "";
        }
        catch (InvalidOperationException)
        {
            return "";
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return "";
        }
    }

    static string WindowTitle(IntPtr hwnd)
    {
        int length = GetWindowTextLength(hwnd);
        if (length <= 0) return "";
        StringBuilder buffer = new StringBuilder(length + 1);
        if (GetWindowText(hwnd, buffer, buffer.Capacity) <= 0) return "";
        return buffer.ToString();
    }

    static bool IsCloaked(IntPtr hwnd)
    {
        try
        {
            int cloaked;
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) != 0) return false;
            return cloaked != 0;
        }
        catch (DllNotFoundException)
        {
            return false;
        }
        catch (EntryPointNotFoundException)
        {
            return false;
        }
    }

    /** Visible, non-cloaked, non-tool top-level windows with a non-empty rect. */
    static List<WindowInfo> EnumerateWindows(bool titledOnly)
    {
        List<WindowInfo> windows = new List<WindowInfo>();
        EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hwnd)) return true;

            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) return true;
            if (rect.Width <= 0 || rect.Height <= 0) return true;

            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;
            if (IsCloaked(hwnd)) return true;

            string title = WindowTitle(hwnd);
            if (titledOnly && title.Length == 0) return true;

            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);

            WindowInfo window = new WindowInfo();
            window.Hwnd = hwnd;
            window.Id = hwnd.ToInt64();
            window.App = ProcessName(pid);
            window.Title = title;
            window.Pid = pid;
            window.Bounds = rect;
            window.Minimized = IsIconic(hwnd);
            windows.Add(window);
            return true;
        };
        if (!EnumWindows(callback, IntPtr.Zero)) throw Failure("could not enumerate windows");
        return windows;
    }

    static bool AppMatches(string processName, string query)
    {
        if (processName.Length == 0) return false;
        string wanted = StripExe(query);
        if (wanted.Length == 0) return false;
        if (string.Equals(processName, wanted, StringComparison.OrdinalIgnoreCase)) return true;
        return processName.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /** --app / --pid / --title, preferring a window that has a real title. */
    static WindowInfo FindWindow(string[] args)
    {
        string appName = FlagValue(args, "--app");
        string titlePart = FlagValue(args, "--title");
        string pidValue = FlagValue(args, "--pid");
        if (appName == null && titlePart == null && pidValue == null)
        {
            throw Failure("needs --app NAME, --pid N or --title T");
        }

        long pid = pidValue == null ? -1 : ParseLong(pidValue, "--pid");
        List<WindowInfo> windows = EnumerateWindows(false);
        WindowInfo best = null;
        for (int i = 0; i < windows.Count; i++)
        {
            WindowInfo window = windows[i];
            bool matches;
            if (pidValue != null) matches = window.Pid == pid;
            else if (appName != null) matches = AppMatches(window.App, appName) || ContainsText(window.Title, appName);
            else matches = ContainsText(window.Title, titlePart);
            if (!matches) continue;
            if (best == null || (best.Title.Length == 0 && window.Title.Length > 0)) best = window;
        }
        if (best == null) throw Failure("no window matched " + (appName != null ? appName : (titlePart != null ? titlePart : pidValue)));
        return best;
    }

    // ------------------------------------------------------------- clipboard

    static bool OpenClipboardWithRetry()
    {
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(20);
        }
        return false;
    }

    static string ReadClipboardText()
    {
        if (!OpenClipboardWithRetry()) throw Failure("could not open the clipboard (another process keeps it locked)");
        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "";
            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return "";
            IntPtr locked = GlobalLock(handle);
            if (locked == IntPtr.Zero) throw Failure("could not lock the clipboard data");
            try
            {
                string text = Marshal.PtrToStringUni(locked);
                return text == null ? "" : text;
            }
            finally
            {
                // GlobalUnlock reports false once the lock count drops to zero;
                // that is the normal case here and not an error.
                GlobalUnlock(handle);
            }
        }
        finally
        {
            CloseClipboard();
        }
    }

    static void WriteClipboardText(string text)
    {
        int bytes = (text.Length + 1) * 2;
        IntPtr handle = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((ulong)bytes));
        if (handle == IntPtr.Zero) throw Failure("could not allocate clipboard memory");

        bool opened = false;
        bool handedOff = false;
        IntPtr locked = IntPtr.Zero;
        try
        {
            locked = GlobalLock(handle);
            if (locked == IntPtr.Zero) throw Failure("could not lock the clipboard memory");
            byte[] buffer = Encoding.Unicode.GetBytes(text + "\0");
            Marshal.Copy(buffer, 0, locked, buffer.Length);
            GlobalUnlock(handle);
            locked = IntPtr.Zero;

            opened = OpenClipboardWithRetry();
            if (!opened) throw Failure("could not open the clipboard (another process keeps it locked)");
            if (!EmptyClipboard()) throw Failure("could not empty the clipboard");
            if (SetClipboardData(CF_UNICODETEXT, handle) == IntPtr.Zero) throw Failure("could not set the clipboard data");
            // The system owns the block from here on; freeing it would corrupt it.
            handedOff = true;
        }
        finally
        {
            if (opened) CloseClipboard();
            if (locked != IntPtr.Zero) GlobalUnlock(handle);
            if (!handedOff) GlobalFree(handle);
        }
    }

    // -------------------------------------------------------------- commands

    static void CommandCheck()
    {
        List<MonitorInfo> monitors = GetMonitors();
        Emit("{\"platform\":\"win32\",\"accessibility\":true,\"screenRecording\":true,\"screens\":" +
            MonitorsJson(monitors) + "}");
    }

    static void CommandScreens()
    {
        List<MonitorInfo> monitors = GetMonitors();
        MonitorInfo primary = monitors[0];
        for (int i = 0; i < monitors.Count; i++)
        {
            if (monitors[i].Primary)
            {
                primary = monitors[i];
                break;
            }
        }
        Emit("{\"screens\":" + MonitorsJson(monitors) + ",\"main\":{\"width\":" + Num(primary.Bounds.Width) +
            ",\"height\":" + Num(primary.Bounds.Height) + "}}");
    }

    static void CommandWindows()
    {
        List<WindowInfo> windows = EnumerateWindows(true);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"windows\":[");
        bool first = true;
        for (int i = 0; i < windows.Count; i++)
        {
            WindowInfo window = windows[i];
            // CGWindowList's on-screen filter drops minimised windows on macOS;
            // Windows parks them at (-32000,-32000), so skip them here too.
            if (window.Minimized) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"id\":").Append(Num(window.Id));
            sb.Append(",\"app\":").Append(Q(window.App));
            sb.Append(",\"title\":").Append(Q(window.Title));
            sb.Append(",\"layer\":0");
            sb.Append(",\"x\":").Append(Num(window.Bounds.Left));
            sb.Append(",\"y\":").Append(Num(window.Bounds.Top));
            sb.Append(",\"width\":").Append(Num(window.Bounds.Width));
            sb.Append(",\"height\":").Append(Num(window.Bounds.Height));
            sb.Append(",\"pid\":").Append(Num(window.Pid));
            sb.Append('}');
        }
        sb.Append("]}");
        Emit(sb.ToString());
    }

    static void CommandPos()
    {
        POINT point;
        if (!GetCursorPos(out point)) throw Failure("could not read the cursor position");
        Emit("{\"x\":" + Num(point.X) + ",\"y\":" + Num(point.Y) + "}");
    }

    static void CommandMove(string[] args)
    {
        string[] values = Positional(args);
        if (values.Length < 2) throw Failure("move needs x y");
        int x = ParseInt(values[0], "x");
        int y = ParseInt(values[1], "y");
        MoveCursor(x, y);
        Emit("{\"x\":" + Num(x) + ",\"y\":" + Num(y) + "}");
    }

    static void CommandClick(string[] args)
    {
        string[] values = Positional(args);
        string button = (FlagValue(args, "--button") ?? "left").Trim().ToLowerInvariant();
        int count = 1;
        string countValue = FlagValue(args, "--count");
        if (countValue != null) count = ParseInt(countValue, "--count");
        if (count < 1) throw Failure("--count must be at least 1");

        int x;
        int y;
        if (values.Length == 0)
        {
            POINT current;
            if (!GetCursorPos(out current)) throw Failure("could not read the cursor position");
            x = current.X;
            y = current.Y;
        }
        else if (values.Length >= 2)
        {
            x = ParseInt(values[0], "x");
            y = ParseInt(values[1], "y");
            MoveCursor(x, y);
            Thread.Sleep(20); // let the pointer settle before the button events
        }
        else
        {
            throw Failure("click needs x y, or no coordinates to click in place");
        }

        uint down;
        uint up;
        MouseButtonFlags(button, out down, out up);
        for (int index = 0; index < count; index++)
        {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags = down;
            inputs[1].type = INPUT_MOUSE;
            inputs[1].u.mi.dwFlags = up;
            SendInputs(inputs);
            if (index + 1 < count) Thread.Sleep(40); // keeps multi-clicks inside the double-click time
        }
        Emit("{\"x\":" + Num(x) + ",\"y\":" + Num(y) + ",\"button\":" + Q(button) + ",\"count\":" + Num(count) + "}");
    }

    static void CommandDrag(string[] args)
    {
        string[] values = Positional(args);
        if (values.Length < 4) throw Failure("drag needs x1 y1 x2 y2");
        int x1 = ParseInt(values[0], "x1");
        int y1 = ParseInt(values[1], "y1");
        int x2 = ParseInt(values[2], "x2");
        int y2 = ParseInt(values[3], "y2");
        string button = (FlagValue(args, "--button") ?? "left").Trim().ToLowerInvariant();
        int duration = 260;
        string durationValue = FlagValue(args, "--duration-ms");
        if (durationValue != null) duration = ParseInt(durationValue, "--duration-ms");
        if (duration < 0) throw Failure("--duration-ms must not be negative");

        uint down;
        uint up;
        MouseButtonFlags(button, out down, out up);

        MoveCursor(x1, y1);
        Thread.Sleep(30);
        PressMouse(down);

        int steps = Math.Max(6, duration / 16);
        for (int step = 1; step <= steps; step++)
        {
            double t = (double)step / (double)steps;
            // Interpolate in double: the int subtraction could overflow.
            int x = (int)Math.Round((double)x1 + ((double)x2 - (double)x1) * t, MidpointRounding.AwayFromZero);
            int y = (int)Math.Round((double)y1 + ((double)y2 - (double)y1) * t, MidpointRounding.AwayFromZero);
            MoveCursor(x, y);
            if (duration > 0) Thread.Sleep(duration / steps);
        }
        MoveCursor(x2, y2);
        PressMouse(up);
        Emit("{\"from\":{\"x\":" + Num(x1) + ",\"y\":" + Num(y1) + "},\"to\":{\"x\":" + Num(x2) + ",\"y\":" + Num(y2) +
            "},\"durationMs\":" + Num(duration) + "}");
    }

    static int ClampWheel(int delta)
    {
        if (delta > WHEEL_LIMIT) return WHEEL_LIMIT;
        if (delta < -WHEEL_LIMIT) return -WHEEL_LIMIT;
        return delta;
    }

    static INPUT WheelInput(uint flags, int delta)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.mouseData = delta;
        input.u.mi.dwFlags = flags;
        return input;
    }

    static void CommandScroll(string[] args)
    {
        string[] values = Positional(args);
        if (values.Length < 2) throw Failure("scroll needs dx dy");
        int dx = ParseInt(values[0], "dx");
        int dy = ParseInt(values[1], "dy");

        // A positive wheel delta scrolls up / left, matching the macOS helper.
        List<INPUT> inputs = new List<INPUT>();
        if (dy != 0) inputs.Add(WheelInput(MOUSEEVENTF_WHEEL, ClampWheel(dy)));
        if (dx != 0) inputs.Add(WheelInput(MOUSEEVENTF_HWHEEL, ClampWheel(dx)));
        SendInputs(inputs.ToArray());
        Emit("{\"dx\":" + Num(dx) + ",\"dy\":" + Num(dy) + "}");
    }

    static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    static string DecodeBase64(string encoded)
    {
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException)
        {
            throw Failure("--b64 is not valid base64");
        }
        try
        {
            return StrictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw Failure("--b64 is not valid base64-encoded UTF-8");
        }
    }

    static void CommandType(string[] args)
    {
        int delay = 9;
        string delayValue = FlagValue(args, "--delay-ms");
        if (delayValue != null) delay = ParseInt(delayValue, "--delay-ms");
        if (delay < 0) throw Failure("--delay-ms must not be negative");

        string encoded = FlagValue(args, "--b64");
        string text = encoded != null ? DecodeBase64(encoded) : string.Join(" ", Positional(args));
        TypeText(text, delay);
        Emit("{\"typed\":" + Num(text.Length) + ",\"delayMs\":" + Num(delay) + "}");
    }

    static void CommandKey(string[] args)
    {
        string[] values = Positional(args);
        if (values.Length == 0) throw Failure("key needs a key name");
        string name = values[0];
        int vk = LookupKey(name);

        int count = 1;
        string repeatValue = FlagValue(args, "--repeat");
        if (repeatValue != null) count = ParseInt(repeatValue, "--repeat");
        if (count < 1) count = 1;

        int delay = 12;
        string delayValue = FlagValue(args, "--delay-ms");
        if (delayValue != null) delay = ParseInt(delayValue, "--delay-ms");
        if (delay < 0) throw Failure("--delay-ms must not be negative");

        for (int index = 0; index < count; index++)
        {
            if (index > 0 && delay > 0) Thread.Sleep(delay);
            TapKey(vk);
        }
        Emit("{\"key\":" + Q(name) + ",\"count\":" + Num(count) + "}");
    }

    static void CommandChord(string[] args)
    {
        string[] values = Positional(args);
        if (values.Length == 0) throw Failure("chord needs e.g. cmd+shift+4");

        // Accept both "cmd+shift+4" and "cmd shift 4".
        List<string> tokens = new List<string>();
        for (int i = 0; i < values.Length; i++)
        {
            string[] parts = values[i].Split('+');
            for (int j = 0; j < parts.Length; j++)
            {
                string part = parts[j].Trim();
                if (part.Length > 0) tokens.Add(part);
            }
        }
        if (tokens.Count == 0) throw Failure("chord needs e.g. cmd+shift+4");

        string original = string.Join(" ", values);
        List<int> modifiers = new List<int>();
        string keyToken = null;
        for (int i = 0; i < tokens.Count; i++)
        {
            int modifier = ModifierKey(tokens[i]);
            if (modifier != 0)
            {
                modifiers.Add(modifier);
                continue;
            }
            keyToken = tokens[i];
        }
        if (keyToken == null) throw Failure("no key in chord: " + original);
        if (modifiers.Count == 0) throw Failure("chord needs at least one modifier and one key: " + original);

        int vk = LookupKey(keyToken);
        PressChord(vk, modifiers);
        Emit("{\"chord\":" + Q(original) + ",\"key\":" + Q(keyToken) + ",\"modifiers\":" + Num(modifiers.Count) + "}");
    }

    static void CommandForeground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) throw Failure("there is no foreground window");
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        Emit("{\"app\":" + Q(ProcessName(pid)) + ",\"title\":" + Q(WindowTitle(hwnd)) + ",\"pid\":" + Num((long)pid) + "}");
    }

    static void CommandActivate(string[] args)
    {
        WindowInfo target = FindWindow(args);
        if (IsIconic(target.Hwnd)) ShowWindow(target.Hwnd, SW_RESTORE);

        // AttachThreadInput lets this thread set the foreground window even when
        // the shell's foreground lock would otherwise refuse the request.
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = 0;
        if (foreground != IntPtr.Zero) foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(target.Hwnd, out ignored);
        bool attached = false;
        if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
        {
            attached = AttachThreadInput(foregroundThread, targetThread, true);
        }
        try
        {
            BringWindowToTop(target.Hwnd);
            SetForegroundWindow(target.Hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(foregroundThread, targetThread, false);
        }
        Emit("{\"app\":" + Q(target.App) + ",\"activated\":true}");
    }

    static void CommandClose(string[] args)
    {
        WindowInfo target = FindWindow(args);
        if (HasFlag(args, "--force"))
        {
            try
            {
                using (Process process = Process.GetProcessById((int)target.Pid))
                {
                    process.Kill();
                }
            }
            catch (Exception error)
            {
                throw Failure("could not kill pid " + target.Pid + ": " + error.Message);
            }
        }
        else
        {
            if (!PostMessage(target.Hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero))
            {
                throw Failure("could not post WM_CLOSE to window " + target.Id);
            }
        }
        Emit("{\"closed\":true}");
    }

    static int CompareByApp(WindowInfo a, WindowInfo b)
    {
        int byName = string.Compare(a.App, b.App, StringComparison.OrdinalIgnoreCase);
        if (byName != 0) return byName;
        if (a.Pid < b.Pid) return -1;
        if (a.Pid > b.Pid) return 1;
        return 0;
    }

    static void CommandList()
    {
        List<WindowInfo> windows = EnumerateWindows(true);
        List<WindowInfo> entries = new List<WindowInfo>();
        Dictionary<long, bool> seen = new Dictionary<long, bool>();
        for (int i = 0; i < windows.Count; i++)
        {
            WindowInfo window = windows[i];
            if (seen.ContainsKey(window.Pid)) continue; // one entry per process
            seen[window.Pid] = true;
            entries.Add(window);
        }
        entries.Sort(CompareByApp);

        StringBuilder sb = new StringBuilder();
        sb.Append("{\"apps\":[");
        for (int i = 0; i < entries.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"name\":").Append(Q(entries[i].App));
            sb.Append(",\"pid\":").Append(Num(entries[i].Pid));
            sb.Append(",\"title\":").Append(Q(entries[i].Title));
            sb.Append('}');
        }
        sb.Append("]}");
        Emit(sb.ToString());
    }

    static void CommandNotify(string[] args)
    {
        string title = FlagValue(args, "--title");
        string text = FlagValue(args, "--text");
        if (title == null) title = "DSH";
        if (text == null) text = "";

        // NotifyIcon needs a running message pump, so pump one for ~4s.
        using (NotifyIcon icon = new NotifyIcon())
        {
            icon.Icon = SystemIcons.Information;
            icon.Text = title.Length > 63 ? title.Substring(0, 63) : title;
            icon.Visible = true;
            icon.ShowBalloonTip(4000, title, text, ToolTipIcon.Info);
            for (int waited = 0; waited < 4000; waited += 50)
            {
                Application.DoEvents();
                Thread.Sleep(50);
            }
            icon.Visible = false;
        }
        Emit("{\"notified\":true}");
    }

    // ------------------------------------------------------------ screenshot

    static string Timestamp()
    {
        int pid = 0;
        using (Process self = Process.GetCurrentProcess())
        {
            pid = self.Id;
        }
        return DateTime.Now.ToString("yyyyMMdd-HHmmssfff", CultureInfo.InvariantCulture) + "-" +
            pid.ToString(CultureInfo.InvariantCulture);
    }

    static void EnsureDirectory(string path)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (directory != null && directory.Length > 0 && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    /** True when both names resolve to the same file. */
    static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }

    static RECT ParseRegion(string value)
    {
        string[] parts = value.Split(',');
        if (parts.Length != 4) throw Failure("--region needs x,y,width,height");
        int x = ParseInt(parts[0].Trim(), "region x");
        int y = ParseInt(parts[1].Trim(), "region y");
        int width = ParseInt(parts[2].Trim(), "region width");
        int height = ParseInt(parts[3].Trim(), "region height");
        if (width <= 0 || height <= 0) throw Failure("--region width and height must be positive");

        long right = (long)x + (long)width;
        long bottom = (long)y + (long)height;
        if (right > int.MaxValue || right < int.MinValue || bottom > int.MaxValue || bottom < int.MinValue)
        {
            throw Failure("--region is out of range");
        }
        RECT rect = new RECT();
        rect.Left = x;
        rect.Top = y;
        rect.Right = (int)right;
        rect.Bottom = (int)bottom;
        return rect;
    }

    static RECT WindowRectFor(IntPtr hwnd)
    {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) throw Failure("could not read the window rect");
        // Windows parks a minimised window at (-32000, -32000); no real monitor
        // sits there, and capturing it would otherwise produce a black image.
        if (rect.Left <= -32000 || rect.Top <= -32000)
        {
            throw Failure("the window is minimised; restore it first (computer_app action=activate), then capture again");
        }
        if (rect.Width <= 0 || rect.Height <= 0) throw Failure("the window has an empty rect");
        return rect;
    }

    static Bitmap Capture(RECT rect, IntPtr windowHandle)
    {
        Bitmap bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        try
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                bool printed = false;
                if (windowHandle != IntPtr.Zero)
                {
                    // PW_RENDERFULLCONTENT (2) is what captures DirectComposition
                    // windows such as Chrome and UWP apps.
                    IntPtr hdc = graphics.GetHdc();
                    try
                    {
                        printed = PrintWindow(windowHandle, hdc, PW_RENDERFULLCONTENT);
                    }
                    finally
                    {
                        graphics.ReleaseHdc(hdc);
                    }
                }
                if (!printed)
                {
                    graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height),
                        CopyPixelOperation.SourceCopy);
                }
            }
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    static void WritePreview(Bitmap source, string path, int maxEdge)
    {
        int longest = Math.Max(source.Width, source.Height);
        EnsureDirectory(path);
        if (maxEdge <= 0 || longest <= maxEdge)
        {
            // Nothing to shrink: still honour --preview with a full-size copy.
            source.Save(path, ImageFormat.Png);
            return;
        }
        double ratio = (double)maxEdge / (double)longest;
        int width = Math.Max(1, (int)Math.Round(source.Width * ratio, MidpointRounding.AwayFromZero));
        int height = Math.Max(1, (int)Math.Round(source.Height * ratio, MidpointRounding.AwayFromZero));
        using (Bitmap preview = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            using (Graphics graphics = Graphics.FromImage(preview))
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.DrawImage(source, new Rectangle(0, 0, width, height));
            }
            preview.Save(path, ImageFormat.Png);
        }
    }

    static void CommandScreenshot(string[] args)
    {
        string target = FlagValue(args, "--target");
        if (target == null) target = "screen";
        target = target.Trim().ToLowerInvariant();

        string outPath = FlagValue(args, "--out");
        if (outPath == null)
        {
            outPath = Path.Combine(Path.GetTempPath(), "dsh-input-shot-" + Timestamp() + ".png");
        }
        string previewPath = FlagValue(args, "--preview");
        int maxEdge = 1600;
        string maxEdgeValue = FlagValue(args, "--max-edge");
        if (maxEdgeValue != null)
        {
            maxEdge = ParseInt(maxEdgeValue, "--max-edge");
            if (maxEdge < 0) throw Failure("--max-edge must not be negative");
        }

        IntPtr windowHandle = IntPtr.Zero;
        RECT rect;
        if (target == "screen")
        {
            // Plain "screen" is the primary display, the way `screencapture`
            // without -D behaves: the primary monitor's origin is (0,0) in
            // virtual-screen coordinates, so image pixels line up with the
            // coordinates the input commands accept. --display picks another.
            List<MonitorInfo> monitors = GetMonitors();
            int display = 1;
            string displayValue = FlagValue(args, "--display");
            if (displayValue != null)
            {
                display = ParseInt(displayValue, "--display");
                if (display < 1 || display > monitors.Count)
                {
                    throw Failure("--display " + display + " is out of range (1.." + monitors.Count + ")");
                }
            }
            rect = monitors[display - 1].Bounds;
        }
        else if (target == "region")
        {
            string regionValue = FlagValue(args, "--region");
            if (regionValue == null) throw Failure("--target region needs --region x,y,width,height");
            rect = ParseRegion(regionValue);
        }
        else if (target == "window")
        {
            string windowValue = FlagValue(args, "--window");
            if (windowValue == null) throw Failure("--target window needs --window ID");
            windowHandle = new IntPtr(ParseLong(windowValue, "--window"));
            if (!IsWindow(windowHandle)) throw Failure("no window with id " + windowValue);
            rect = WindowRectFor(windowHandle);
        }
        else
        {
            throw Failure("unknown --target: " + target);
        }

        if (rect.Width <= 0 || rect.Height <= 0) throw Failure("the capture area is empty");
        if (rect.Width > MAX_CAPTURE_EDGE || rect.Height > MAX_CAPTURE_EDGE)
        {
            throw Failure("the capture area is too large: " + rect.Width + "x" + rect.Height);
        }

        int width = 0;
        int height = 0;
        using (Bitmap bitmap = Capture(rect, windowHandle))
        {
            EnsureDirectory(outPath);
            bitmap.Save(outPath, ImageFormat.Png);
            width = bitmap.Width;
            height = bitmap.Height;
            if (previewPath != null && !SamePath(outPath, previewPath)) WritePreview(bitmap, previewPath, maxEdge);
        }

        Emit("{\"path\":" + Q(Path.GetFullPath(outPath)) +
            ",\"width\":" + Num(width) +
            ",\"height\":" + Num(height) +
            ",\"frame\":{\"x\":" + Num(rect.Left) + ",\"y\":" + Num(rect.Top) + "}}");
    }

    // ------------------------------------------------------------------ main

    static readonly string Usage =
        "usage: dsh-input.exe <check|screens|windows|pos|move|click|drag|scroll|type|key|chord|" +
        "screenshot|clipboard-get|clipboard-set|foreground|activate|close|list|notify> [args]";

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            // UTF-8 stdout without a BOM: the Node parent parses stdout as UTF-8.
            // SetConsoleOutputCP and SetProcessDPIAware "fail" on a redirected
            // stream or an already-aware process; neither case is an error.
            SetConsoleOutputCP(65001);
            Console.OutputEncoding = new UTF8Encoding(false);
            // Physical pixels everywhere, so coordinates, window rects and
            // screenshots all agree on a scaled display.
            SetProcessDPIAware();

            if (args.Length == 0) throw Failure(Usage);

            string command = args[0].ToLowerInvariant();
            string[] rest = new string[args.Length - 1];
            Array.Copy(args, 1, rest, 0, rest.Length);

            switch (command)
            {
                case "check":
                    CommandCheck();
                    break;
                case "screens":
                    CommandScreens();
                    break;
                case "windows":
                    CommandWindows();
                    break;
                case "pos":
                    CommandPos();
                    break;
                case "move":
                    CommandMove(rest);
                    break;
                case "click":
                    CommandClick(rest);
                    break;
                case "drag":
                    CommandDrag(rest);
                    break;
                case "scroll":
                    CommandScroll(rest);
                    break;
                case "type":
                    CommandType(rest);
                    break;
                case "key":
                    CommandKey(rest);
                    break;
                case "chord":
                    CommandChord(rest);
                    break;
                case "screenshot":
                    CommandScreenshot(rest);
                    break;
                case "clipboard-get":
                    Emit("{\"text\":" + Q(ReadClipboardText()) + "}");
                    break;
                case "clipboard-set":
                    CommandClipboardSet(rest);
                    break;
                case "foreground":
                    CommandForeground();
                    break;
                case "activate":
                    CommandActivate(rest);
                    break;
                case "close":
                    CommandClose(rest);
                    break;
                case "list":
                    CommandList();
                    break;
                case "notify":
                    CommandNotify(rest);
                    break;
                default:
                    throw Failure("unknown command: " + args[0]);
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(Describe(error));
            return 1;
        }
    }

    static void CommandClipboardSet(string[] args)
    {
        string encoded = FlagValue(args, "--b64");
        if (encoded == null) throw Failure("clipboard-set needs --b64 <BASE64>");
        string text = DecodeBase64(encoded);
        WriteClipboardText(text);
        Emit("{\"length\":" + Num(text.Length) + "}");
    }
}
