// DshInput — a tiny zero-dependency macOS input helper for the
// dsh-computer-control plugin.
//
// It posts Quartz (CoreGraphics) events so the agent can move the real mouse,
// click, drag, scroll, press keys and type arbitrary Unicode text (bypassing
// the input method, which matters for CJK).
//
// Build:  swiftc -O -o bin/dsh-input native/DshInput.swift
// Usage:  dsh-input <command> [args...]        (see `usage()`)
// Output: one JSON object on stdout on success; a message on stderr + exit 1 on failure.

import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

// MARK: - small helpers

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write(Data("failed to encode JSON\n".utf8))
        exit(1)
    }
    print(text)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func number(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let i = value as? Int { return Double(i) }
    if let s = value as? String { return Double(s) }
    return nil
}

func sleepMs(_ ms: Double) {
    if ms <= 0 { return }
    usleep(useconds_t(ms * 1000))
}

// MARK: - key table

/// US-layout virtual key codes, by lowercase name.
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "=": 24,
    "9": 25, "7": 26, "minus": 27, "-": 27, "8": 28, "0": 29,
    "rightbracket": 30, "]": 30, "o": 31, "u": 32, "leftbracket": 33, "[": 33,
    "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38,
    "quote": 39, "'": 39, "k": 40, "semicolon": 41, ";": 41, "backslash": 42, "\\": 42,
    "comma": 43, ",": 43, "slash": 44, "/": 44, "n": 45, "m": 46, "period": 47, ".": 47,
    "tab": 48, "space": 49, "grave": 50, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
    "fn": 63,
    "f17": 64, "keypaddecimal": 65, "keypadmultiply": 67, "keypadplus": 69,
    "keypadclear": 71, "keypaddivide": 75, "keypadenter": 76, "keypadminus": 78,
    "f18": 79, "f19": 80, "keypadequals": 81, "keypad0": 82, "keypad1": 83,
    "keypad2": 84, "keypad3": 85, "keypad4": 86, "keypad5": 87, "keypad6": 88,
    "keypad7": 89, "keypad8": 91, "keypad9": 92,
    "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111,
    "f15": 113, "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117,
    "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "iso_section": 10, "jis_yen": 93, "jis_underscore": 94
]

let flagNames: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand,
    "shift": .maskShift,
    "alt": .maskAlternate, "option": .maskAlternate,
    "ctrl": .maskControl, "control": .maskControl,
    "fn": .maskSecondaryFn, "capslock": .maskAlphaShift
]

/// Left-hand virtual key codes for the modifiers, so a chord can hold them down
/// for real. Setting only the event's `flags` is not enough for every app
/// (Chrome ignores cmd+A sent that way).
let flagKeyCodes: [String: CGKeyCode] = [
    "cmd": 55, "command": 55,
    "shift": 56,
    "alt": 58, "option": 58,
    "ctrl": 59, "control": 59,
    "fn": 63
]

func keyCode(for name: String) -> CGKeyCode? {
    let trimmed = name.trimmingCharacters(in: .whitespaces).lowercased()
    if let code = keyCodes[trimmed] { return code }
    if let raw = UInt16(trimmed) { return CGKeyCode(raw) }
    return nil
}

func eventSource() -> CGEventSource? {
    CGEventSource(stateID: .hidSystemState)
}

// MARK: - mouse

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType) {
    switch name.lowercased() {
    case "right":
        return (.right, .rightMouseDown, .rightMouseUp)
    case "middle", "center":
        return (.center, .otherMouseDown, .otherMouseUp)
    default:
        return (.left, .leftMouseDown, .leftMouseUp)
    }
}

func postMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: eventSource(), mouseType: type,
                             mouseCursorPosition: point, mouseButton: button) else {
        fail("could not create mouse event")
    }
    if clickState > 1 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
    event.post(tap: .cghidEventTap)
}

func currentPoint() -> CGPoint {
    guard let event = CGEvent(source: nil) else { return .zero }
    return event.location
}

// MARK: - typing

/// Type arbitrary text by setting the Unicode payload of a keyboard event.
/// One character per event: the HID event buffer is small, and clipping the
/// payload makes the event fall back to its virtual keycode (typing "a").
/// Surrogate pairs are sent together so emoji survive.
func typeText(_ text: String, delayMs: Double) {
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        let lead = units[index]
        let isSurrogateLead = lead >= 0xD800 && lead <= 0xDBFF
        let length = isSurrogateLead && index + 1 < units.count ? 2 : 1
        var chunk = Array(units[index..<min(index + length, units.count)])
        guard let down = CGEvent(keyboardEventSource: eventSource(), virtualKey: 0, keyDown: true) else {
            fail("could not create keyboard event")
        }
        chunk.withUnsafeMutableBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap)
        index += length
        sleepMs(delayMs)
    }
}

func pressKey(_ code: CGKeyCode, flags: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: eventSource(), virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: eventSource(), virtualKey: code, keyDown: false) else {
        fail("could not create keyboard event")
    }
    if flags != [] {
        down.flags = flags
        up.flags = flags
    }
    down.post(tap: .cghidEventTap)
    sleepMs(12)
    up.post(tap: .cghidEventTap)
}

/// Press one raw key down or up, carrying the given modifier flags.
func postKeyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: eventSource(), virtualKey: code, keyDown: down) else {
        fail("could not create keyboard event")
    }
    if flags != [] { event.flags = flags }
    event.post(tap: .cghidEventTap)
}

/// Hold the modifiers down, tap the key, then release the modifiers.
func pressChord(keyCode: CGKeyCode, modifierKeyCodes: [CGKeyCode], flags: CGEventFlags) {
    for modifier in modifierKeyCodes { postKeyEvent(modifier, down: true, flags: flags); sleepMs(8) }
    sleepMs(10)
    postKeyEvent(keyCode, down: true, flags: flags)
    sleepMs(14)
    postKeyEvent(keyCode, down: false, flags: flags)
    sleepMs(8)
    for modifier in modifierKeyCodes.reversed() { postKeyEvent(modifier, down: false, flags: []); sleepMs(8) }
}

/// Parse `cmd+shift+4` or a list of names into (flags, modifier key codes, final key).
func parseChord(_ parts: [String]) -> (CGEventFlags, [CGKeyCode], CGKeyCode, String) {
    var flags: CGEventFlags = []
    var modifierKeyCodes: [CGKeyCode] = []
    var keyName: String?
    for raw in parts {
        let part = raw.trimmingCharacters(in: .whitespaces)
        if part.isEmpty { continue }
        let lower = part.lowercased()
        if let flag = flagNames[lower] {
            flags.insert(flag)
            if let code = flagKeyCodes[lower] { modifierKeyCodes.append(code) }
            continue
        }
        keyName = part
    }
    guard let name = keyName else { fail("no key in chord: \(parts.joined(separator: "+"))") }
    guard let code = keyCode(for: name) else { fail("unknown key name: \(name)") }
    return (flags, modifierKeyCodes, code, name)
}

// MARK: - window list

func windowList() -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [[String: Any]] = []
    for window in raw {
        let owner = window[kCGWindowOwnerName as String] as? String ?? ""
        let name = window[kCGWindowName as String] as? String ?? ""
        let id = window[kCGWindowNumber as String] as? Int ?? 0
        let layer = window[kCGWindowLayer as String] as? Int ?? 0
        var entry: [String: Any] = ["id": id, "app": owner, "title": name, "layer": layer]
        if let boundsDict = window[kCGWindowBounds as String] as? [String: Any] {
            entry["x"] = number(boundsDict["X"]) ?? 0
            entry["y"] = number(boundsDict["Y"]) ?? 0
            entry["width"] = number(boundsDict["Width"]) ?? 0
            entry["height"] = number(boundsDict["Height"]) ?? 0
        }
        if let pid = window[kCGWindowOwnerPID as String] as? Int { entry["pid"] = pid }
        out.append(entry)
    }
    return out
}

// MARK: - screens

func screenList() -> [[String: Any]] {
    var out: [[String: Any]] = []
    var index = 0
    for screen in NSScreen.screens {
        index += 1
        let frame = screen.frame
        out.append([
            "index": index,
            "x": Double(frame.origin.x),
            "y": Double(frame.origin.y),
            "width": Double(frame.width),
            "height": Double(frame.height),
            "scale": Double(screen.backingScaleFactor),
            "pixelsWide": Double(screen.frame.width * screen.backingScaleFactor),
            "pixelsHigh": Double(screen.frame.height * screen.backingScaleFactor)
        ])
    }
    return out
}

// MARK: - argument parsing

var arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first?.lowercased() else {
    fail("usage: dsh-input <check|screens|windows|pos|move|click|drag|scroll|type|key|chord> [args]")
}
arguments.removeFirst()

func flagValue(_ name: String) -> String? {
    if let index = arguments.firstIndex(of: name), index + 1 < arguments.count {
        return arguments[index + 1]
    }
    return nil
}

func hasFlag(_ name: String) -> Bool { arguments.contains(name) }

func positional() -> [String] {
    var out: [String] = []
    var skipNext = false
    for (index, value) in arguments.enumerated() {
        if skipNext { skipNext = false; continue }
        if value.hasPrefix("--") {
            if index + 1 < arguments.count && !arguments[index + 1].hasPrefix("--") { skipNext = true }
            continue
        }
        out.append(value)
    }
    return out
}

switch command {
case "request":
    // Ask macOS for the two TCC grants this helper needs. The dialogs name the
    // responsible application; the user approves them once in System Settings.
    let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    let capture = CGRequestScreenCaptureAccess()
    emit(["accessibility": trusted, "screenRecording": capture])

case "check":
    emit([
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "screens": screenList()
    ])

case "screens":
    emit(["screens": screenList(), "main": ["width": Double(CGDisplayBounds(CGMainDisplayID()).width),
                                            "height": Double(CGDisplayBounds(CGMainDisplayID()).height)]])

case "windows":
    emit(["windows": windowList()])

case "pos":
    let point = currentPoint()
    emit(["x": Double(point.x), "y": Double(point.y)])

case "move":
    let values = positional()
    guard values.count >= 2, let x = number(values[0]), let y = number(values[1]) else {
        fail("move needs x y")
    }
    let point = CGPoint(x: x, y: y)
    CGWarpMouseCursorPosition(point)
    postMouse(.mouseMoved, point, .left)
    emit(["x": x, "y": y])

case "click":
    let values = positional()
    var point = currentPoint()
    if values.count >= 2, let x = number(values[0]), let y = number(values[1]) {
        point = CGPoint(x: x, y: y)
    }
    let buttonName = flagValue("--button") ?? "left"
    let count = Int(flagValue("--count") ?? "1") ?? 1
    let (button, downType, upType) = mouseButton(buttonName)
    CGWarpMouseCursorPosition(point)
    postMouse(.mouseMoved, point, button)
    sleepMs(20)
    for click in 1...max(1, count) {
        postMouse(downType, point, button, clickState: Int64(click))
        sleepMs(20)
        postMouse(upType, point, button, clickState: Int64(click))
        if click < count { sleepMs(40) }
    }
    emit(["x": Double(point.x), "y": Double(point.y), "button": buttonName, "count": count])

case "drag":
    let values = positional()
    guard values.count >= 4,
          let x1 = number(values[0]), let y1 = number(values[1]),
          let x2 = number(values[2]), let y2 = number(values[3]) else {
        fail("drag needs x1 y1 x2 y2")
    }
    let buttonName = flagValue("--button") ?? "left"
    let durationMs = number(flagValue("--duration-ms") ?? "260") ?? 260
    let (button, downType, upType) = mouseButton(buttonName)
    let dragType: CGEventType = button == .left ? .leftMouseDragged : (button == .right ? .rightMouseDragged : .otherMouseDragged)
    let start = CGPoint(x: x1, y: y1)
    let end = CGPoint(x: x2, y: y2)
    CGWarpMouseCursorPosition(start)
    postMouse(.mouseMoved, start, button)
    sleepMs(30)
    postMouse(downType, start, button)
    let steps = max(6, Int(durationMs / 16))
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let point = CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)
        postMouse(dragType, point, button)
        sleepMs(durationMs / Double(steps))
    }
    postMouse(upType, end, button)
    emit(["from": ["x": x1, "y": y1], "to": ["x": x2, "y": y2], "durationMs": durationMs])

case "scroll":
    let values = positional()
    guard values.count >= 2, let dx = number(values[0]), let dy = number(values[1]) else {
        fail("scroll needs dx dy")
    }
    guard let event = CGEvent(scrollWheelEvent2Source: eventSource(), units: .pixel,
                              wheelCount: 2, wheel1: Int32(max(-100000, min(100000, dy.rounded()))),
                              wheel2: Int32(max(-100000, min(100000, dx.rounded()))), wheel3: 0) else {
        fail("could not create scroll event")
    }
    event.post(tap: .cghidEventTap)
    emit(["dx": dx, "dy": dy])

case "type":
    // `--b64` avoids every quoting problem the caller would otherwise have with
    // newlines, quotes and leading dashes.
    let text: String
    if let encoded = flagValue("--b64") {
        guard let data = Data(base64Encoded: encoded), let decoded = String(data: data, encoding: .utf8) else {
            fail("--b64 is not valid base64-encoded UTF-8")
        }
        text = decoded
    } else {
        text = positional().joined(separator: " ")
    }
    let delay = number(flagValue("--delay-ms") ?? "9") ?? 9
    typeText(text, delayMs: delay)
    emit(["typed": text.count, "delayMs": delay])

case "key":
    let values = positional()
    guard let name = values.first else { fail("key needs a key name") }
    guard let code = keyCode(for: name) else { fail("unknown key name: \(name)") }
    let repeatCount = Int(flagValue("--repeat") ?? "1") ?? 1
    let delay = number(flagValue("--delay-ms") ?? "12") ?? 12
    for index in 0..<max(1, repeatCount) {
        if index > 0 { sleepMs(delay) }
        pressKey(code, flags: [])
    }
    emit(["key": name, "count": repeatCount])

case "chord":
    let values = positional()
    guard !values.isEmpty else { fail("chord needs e.g. cmd+shift+4") }
    let tokens = values.joined(separator: " ").split(separator: "+").map(String.init)
    if tokens.count == 1, let only = tokens.first, keyCodes[only.lowercased()] == nil {
        fail("chord needs at least one modifier and one key: \(values.joined(separator: " "))")
    }
    let (flags, modifierKeyCodes, code, name) = parseChord(tokens)
    pressChord(keyCode: code, modifierKeyCodes: modifierKeyCodes, flags: flags)
    emit(["chord": values.joined(separator: " "), "key": name, "modifiers": modifierKeyCodes.count])

default:
    fail("unknown command: \(command)")
}
