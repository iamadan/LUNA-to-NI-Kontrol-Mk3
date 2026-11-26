// S88Bridge — CoreMIDI <-> WebSocket bridge for the "LUNA -> NI Kontrol Mk3" LUNA Add On.
//
// Why this exists: LUNA hosts add-on pages in a WKWebView, and Apple's WebKit does not
// implement the Web MIDI API (navigator.requestMIDIAccess is undefined, with no feature
// flag to turn it on). A page inside LUNA therefore cannot touch MIDI at all. This
// helper owns the CoreMIDI side and hands it to the page over a loopback WebSocket.
//
// It is deliberately dumb: it opens every MIDI source, tags each message with the port
// it came from, and sends whatever bytes the page asks it to. All protocol knowledge
// lives in index.html, where it can be edited without recompiling.
//
// Build:  swiftc -O -o s88-bridge S88Bridge.swift
// Run:    ./s88-bridge                 (serves ws://127.0.0.1:17888)
//         ./s88-bridge --list          (print MIDI ports and exit)
//         ./s88-bridge --monitor       (print every incoming MIDI message)

import Foundation
import CoreMIDI
import Network
import AppKit

let PROTOCOL_VERSION = 1

// MARK: - CLI

var wsPort: UInt16 = 17888
var listOnly = false
var monitor = false
var followLuna = false

let LUNA_BUNDLE_ID = "com.uaudio.luna"
func lunaIsRunning() -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: LUNA_BUNDLE_ID).isEmpty
}
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--port", "-p":
            guard let v = it.next(), let n = UInt16(v) else { FileHandle.standardError.write("--port needs a number\n".data(using: .utf8)!); exit(2) }
            wsPort = n
        case "--list", "-l": listOnly = true
        case "--monitor", "-m": monitor = true
        case "--follow-luna", "-f": followLuna = true
        case "--help", "-h":
            print("""
            s88-bridge — CoreMIDI to WebSocket bridge

              --port, -p <n>   listen on 127.0.0.1:<n>  (default 17888)
              --list,  -l      print MIDI ports and exit
              --monitor, -m    also print every MIDI message and page connection
              --follow-luna, -f  wait for LUNA to start, and exit when it quits
              --help,  -h      this text
            """)
            exit(0)
        default:
            FileHandle.standardError.write("unknown argument: \(a)\n".data(using: .utf8)!); exit(2)
        }
    }
}

// MARK: - CoreMIDI helpers

func stringProp(_ obj: MIDIObjectRef, _ key: CFString) -> String? {
    var out: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(obj, key, &out) == noErr, let s = out?.takeRetainedValue() else { return nil }
    return s as String
}

/// "Kontrol S88 MK3 DAW" — device and port together, which is what a user recognises.
func endpointName(_ ep: MIDIEndpointRef) -> String {
    if let d = stringProp(ep, kMIDIPropertyDisplayName), !d.isEmpty { return d }
    let port = stringProp(ep, kMIDIPropertyName) ?? "?"
    var device = MIDIEntityRef()
    if MIDIEndpointGetEntity(ep, &device) == noErr {
        var dev = MIDIDeviceRef()
        if MIDIEntityGetDevice(device, &dev) == noErr, let dn = stringProp(dev, kMIDIPropertyName), dn != port {
            return "\(dn) \(port)"
        }
    }
    return port
}

func sources() -> [MIDIEndpointRef] { (0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) } }
func destinations() -> [MIDIEndpointRef] { (0..<MIDIGetNumberOfDestinations()).map { MIDIGetDestination($0) } }

// MARK: - Bridge state (everything below touches it only on `q`)

let q = DispatchQueue(label: "s88.bridge")

var client = MIDIClientRef()
var inPort = MIDIPortRef()
var outPort = MIDIPortRef()
var connected: [MIDIEndpointRef: String] = [:]   // sources we are listening to
var clients: [ObjectIdentifier: NWConnection] = [:]
var defaultOut: String? = nil                    // destination name chosen by the page

/// Only the most recently connected page may send.
///
/// Two pages driving one keyboard corrupts the display rather than merely doubling it:
/// each believes it owns all eight strips, so a page with no session blanks the strips a
/// page with a session has just drawn, and the keyboard shows whichever arrived last. That
/// is indistinguishable from a broken add-on. A stale window — a reopened add-on, a
/// forgotten browser tab — is the common cause, and the newest page is the one the user is
/// looking at, so it wins and the others are told to be quiet.
var outputOwner: ObjectIdentifier? = nil

func jsonLine(_ obj: [String: Any]) -> Data? {
    (try? JSONSerialization.data(withJSONObject: obj, options: []))
}

func broadcast(_ obj: [String: Any]) {
    guard let data = jsonLine(obj) else { return }
    for c in clients.values { sendText(c, data) }
}

func portsMessage() -> [String: Any] {
    [
        "t": "ports",
        "inputs": sources().map(endpointName),
        "outputs": destinations().map(endpointName),
        "out": defaultOut as Any? ?? NSNull(),
    ]
}

// MARK: - MIDI in

func handleIncoming(_ ep: MIDIEndpointRef, _ bytes: [UInt8]) {
    guard !bytes.isEmpty else { return }
    let name = connected[ep] ?? endpointName(ep)
    if monitor {
        let hex = bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
        print("IN  <- \(name)  \(hex)")
        fflush(stdout)
    }
    broadcast(["t": "midi", "d": bytes.map { Int($0) }, "src": name])
}

/// CoreMIDI hands over whole packets, and one packet routinely holds several MIDI
/// messages — a fast encoder produces exactly that. It also splits a long SysEx across
/// packets, and controllers may use running status. So the byte stream from each
/// endpoint goes through a real parser and the page receives one message per message.
struct MidiParser {
    private var runningStatus: UInt8 = 0    // channel-voice status that data bytes inherit
    private var curStatus: UInt8 = 0        // status of the message being assembled
    private var data: [UInt8] = []
    private var sysex: [UInt8] = []
    private var inSysex = false

    static func dataBytes(for status: UInt8) -> Int {
        switch status & 0xF0 {
        case 0x80, 0x90, 0xA0, 0xB0, 0xE0: return 2
        case 0xC0, 0xD0: return 1
        default: break
        }
        switch status {
        case 0xF1, 0xF3: return 1
        case 0xF2: return 2
        default: return 0
        }
    }

    mutating func feed(_ bytes: [UInt8], emit: ([UInt8]) -> Void) {
        for b in bytes { feedOne(b, emit: emit) }
    }

    private mutating func feedOne(_ b: UInt8, emit: ([UInt8]) -> Void) {
        if b >= 0xF8 { emit([b]); return }        // realtime: stands alone, interleaves anywhere

        if inSysex {
            if b == 0xF7 {
                sysex.append(b); emit(sysex); sysex = []; inSysex = false; return
            }
            if b < 0x80 {
                sysex.append(b)
                if sysex.count > 65536 { sysex = []; inSysex = false }   // runaway: drop it
                return
            }
            sysex = []; inSysex = false           // a status byte aborts the SysEx
        }

        if b >= 0x80 {
            data = []
            if b == 0xF0 { inSysex = true; sysex = [0xF0]; curStatus = 0; runningStatus = 0; return }
            if b == 0xF7 { curStatus = 0; return }                       // stray EOX
            if b >= 0xF1 && b <= 0xF6 {
                runningStatus = 0                                        // system common clears it
                if MidiParser.dataBytes(for: b) == 0 { emit([b]); curStatus = 0 } else { curStatus = b }
                return
            }
            curStatus = b; runningStatus = b                             // channel voice
            return
        }

        // data byte
        if curStatus == 0 { curStatus = runningStatus }
        guard curStatus != 0 else { return }                             // stray data, no status yet
        data.append(b)
        let need = MidiParser.dataBytes(for: curStatus)
        if data.count >= need {
            emit([curStatus] + data)
            data = []
            // Channel messages keep running status; system common does not.
            curStatus = curStatus < 0xF0 ? curStatus : 0
        }
    }
}

var parsers: [MIDIEndpointRef: MidiParser] = [:]

func ingest(_ ep: MIDIEndpointRef, _ packet: [UInt8]) {
    var parser = parsers[ep] ?? MidiParser()
    parser.feed(packet) { handleIncoming(ep, $0) }
    parsers[ep] = parser
}

func connectAllSources() {
    let live = sources()
    let liveSet = Set(live)
    for (ep, _) in connected where !liveSet.contains(ep) {
        MIDIPortDisconnectSource(inPort, ep)
        connected[ep] = nil
        parsers[ep] = nil
    }
    for ep in live where connected[ep] == nil {
        let name = endpointName(ep)
        if MIDIPortConnectSource(inPort, ep, UnsafeMutableRawPointer(bitPattern: UInt(ep))) == noErr {
            connected[ep] = name
            if monitor { print("+ listening: \(name)"); fflush(stdout) }
        }
    }
}

// MARK: - MIDI out

/// An in-flight MIDISendSysex request. CoreMIDI advances `request.data` as it sends, so
/// the completion handler must free the ORIGINAL buffer, not whatever `data` points at by
/// then. The job is handed to CoreMIDI through `completionRefCon` and reclaimed here.
final class SysexJob {
    let buffer: UnsafeMutablePointer<UInt8>
    let request: UnsafeMutablePointer<MIDISysexSendRequest>
    let count: Int

    init(bytes: [UInt8], destination: MIDIEndpointRef) {
        count = bytes.count
        buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
        buffer.initialize(from: bytes, count: bytes.count)
        request = UnsafeMutablePointer<MIDISysexSendRequest>.allocate(capacity: 1)
        request.initialize(to: MIDISysexSendRequest(
            destination: destination,
            data: UnsafePointer(buffer),
            bytesToSend: UInt32(bytes.count),
            complete: false,
            reserved: (0, 0, 0),
            completionProc: { req in
                guard let refcon = req.pointee.completionRefCon else { return }
                Unmanaged<SysexJob>.fromOpaque(refcon).takeRetainedValue().dispose()
            },
            completionRefCon: nil))
    }

    func send() -> OSStatus {
        request.pointee.completionRefCon = Unmanaged.passRetained(self).toOpaque()
        let err = MIDISendSysex(request)
        if err != noErr {
            // Nothing will call the completion handler, so balance the retain here.
            Unmanaged<SysexJob>.fromOpaque(request.pointee.completionRefCon!).release()
            dispose()
        }
        return err
    }

    func dispose() {
        buffer.deinitialize(count: count)
        buffer.deallocate()
        request.deinitialize(count: 1)
        request.deallocate()
    }
}

func sendBytes(_ bytes: [UInt8], to portName: String?) -> String? {
    guard let want = portName ?? defaultOut else { return "no output port selected" }
    // Logged here rather than at the call site so that everything leaving the bridge is
    // visible, including the goodbye the bridge itself sends when LUNA quits.
    if monitor {
        let hex = bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
        print("OUT -> \(want)  \(hex)")
        fflush(stdout)
    }
    guard let ep = destinations().first(where: { endpointName($0) == want }) else {
        return "output port not found: \(want)"
    }
    guard !bytes.isEmpty else { return nil }

    // A packet list carries anything that fits, SysEx included, and is synchronous —
    // far simpler than managing an async send. Only oversized SysEx needs MIDISendSysex.
    if bytes.count <= 1024 {
        var storage = [UInt8](repeating: 0, count: 1024 + MemoryLayout<MIDIPacketList>.size)
        var failed: String? = nil
        storage.withUnsafeMutableBytes { raw in
            let list = raw.baseAddress!.assumingMemoryBound(to: MIDIPacketList.self)
            var pkt = MIDIPacketListInit(list)
            pkt = MIDIPacketListAdd(list, raw.count, pkt, 0, bytes.count, bytes)
            let err = MIDISend(outPort, ep, list)
            if err != noErr { failed = "MIDISend failed: \(err)" }
            _ = pkt
        }
        return failed
    }

    guard bytes.first == 0xF0 else { return "message too long for one packet" }
    let err = SysexJob(bytes: bytes, destination: ep).send()
    return err == noErr ? nil : "MIDISendSysex failed: \(err)"
}

// MARK: - WebSocket

func sendText(_ conn: NWConnection, _ data: Data) {
    let meta = NWProtocolWebSocket.Metadata(opcode: .text)
    let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
    conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
}

func sendJSON(_ conn: NWConnection, _ obj: [String: Any]) {
    guard let d = jsonLine(obj) else { return }
    sendText(conn, d)
}

func receive(_ conn: NWConnection) {
    conn.receiveMessage { data, context, _, error in
        if let error = error {
            q.async {
                if clients.removeValue(forKey: ObjectIdentifier(conn)) != nil {
                    if outputOwner == ObjectIdentifier(conn) { outputOwner = clients.keys.first }
                    print("- page disconnected (\(clients.count) left)"); fflush(stdout)
                }
            }
            _ = error
            return
        }
        if let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
           meta.opcode == .close {
            q.async {
                if clients.removeValue(forKey: ObjectIdentifier(conn)) != nil {
                    if outputOwner == ObjectIdentifier(conn) { outputOwner = clients.keys.first }
                    print("- page disconnected (\(clients.count) left)"); fflush(stdout)
                }
            }
            conn.cancel()
            return
        }
        if let data = data, !data.isEmpty {
            q.async { handleClientMessage(conn, data) }
        }
        receive(conn)
    }
}

func handleClientMessage(_ conn: NWConnection, _ data: Data) {
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let t = obj["t"] as? String else { return }
    switch t {
    case "list":
        sendJSON(conn, portsMessage())
    case "out":
        // Only announce a real change: a client that re-sends on every `ports` message
        // would otherwise loop with the broadcast forever.
        let name = obj["name"] as? String
        if name != defaultOut {
            defaultOut = name
            broadcast(portsMessage())
        } else {
            sendJSON(conn, portsMessage())
        }
    case "send":
        guard outputOwner == nil || outputOwner == ObjectIdentifier(conn) else {
            sendJSON(conn, ["t": "superseded",
                            "msg": "another LUNA -> NI Kontrol Mk3 window has the keyboard; close this one"])
            return
        }
        guard let raw = obj["d"] as? [Int] else { return }
        let bytes = raw.map { UInt8(truncatingIfNeeded: $0) }
        if let err = sendBytes(bytes, to: obj["to"] as? String) {
            if monitor { print("OUT !! \(err)"); fflush(stdout) }
            sendJSON(conn, ["t": "error", "msg": err])
        }
    default:
        break
    }
}

// MARK: - Start up

// In follow mode the bridge is the keyboard's only claim on the DAW port while LUNA is up,
// and nothing at all while LUNA is down: it waits here rather than holding CoreMIDI open.
if followLuna && !listOnly {
    if !lunaIsRunning() {
        print("Waiting for LUNA to start…")
        fflush(stdout)
        while !lunaIsRunning() { Thread.sleep(forTimeInterval: 1.0) }
    }
    print("LUNA is running.")
    fflush(stdout)
}

var status = MIDIClientCreateWithBlock("S88 Bridge" as CFString, &client) { notification in
    // Devices come and go; re-scan and tell the page.
    if notification.pointee.messageID == .msgSetupChanged {
        q.async {
            connectAllSources()
            broadcast(portsMessage())
        }
    }
}
guard status == noErr else {
    FileHandle.standardError.write("MIDIClientCreate failed: \(status)\n".data(using: .utf8)!)
    exit(1)
}

status = MIDIInputPortCreateWithBlock(client, "in" as CFString, &inPort) { pktList, srcRefCon in
    let ep = MIDIEndpointRef(UInt(bitPattern: srcRefCon.map { Int(bitPattern: $0) } ?? 0))
    var packets: [[UInt8]] = []
    for packet in pktList.unsafeSequence() {
        let len = Int(packet.pointee.length)
        guard len > 0 else { continue }
        withUnsafeBytes(of: packet.pointee.data) { raw in
            packets.append(Array(raw.prefix(min(len, raw.count))))
        }
    }
    guard !packets.isEmpty else { return }
    q.async { for p in packets { ingest(ep, p) } }
}
guard status == noErr else {
    FileHandle.standardError.write("MIDIInputPortCreate failed: \(status)\n".data(using: .utf8)!)
    exit(1)
}
status = MIDIOutputPortCreate(client, "out" as CFString, &outPort)
guard status == noErr else {
    FileHandle.standardError.write("MIDIOutputPortCreate failed: \(status)\n".data(using: .utf8)!)
    exit(1)
}

if listOnly {
    let ins = sources(), outs = destinations()
    print("MIDI inputs (\(ins.count)):")
    for e in ins { print("  \(endpointName(e))") }
    print("MIDI outputs (\(outs.count)):")
    for e in outs { print("  \(endpointName(e))") }
    if ins.isEmpty && outs.isEmpty {
        print("\nNo MIDI ports at all. Connect the keyboard by USB and run this again.")
    }
    exit(0)
}

q.sync { connectAllSources() }

let params = NWParameters.tcp
let wsOptions = NWProtocolWebSocket.Options()
wsOptions.autoReplyPing = true
params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: wsPort)!)
params.allowLocalEndpointReuse = true

let listener: NWListener
do {
    listener = try NWListener(using: params)
} catch {
    FileHandle.standardError.write("cannot listen on 127.0.0.1:\(wsPort): \(error)\n".data(using: .utf8)!)
    exit(1)
}

listener.stateUpdateHandler = { state in
    switch state {
    case .ready:
        // Already on `q`: reading `connected` directly is correct here, and a q.sync
        // would deadlock the queue the listener runs on.
        print("s88-bridge listening on ws://127.0.0.1:\(wsPort)  (\(connected.count) MIDI inputs)")
        fflush(stdout)
    case .failed(let e):
        FileHandle.standardError.write("listener failed: \(e)\n".data(using: .utf8)!)
        exit(1)
    default: break
    }
}

listener.newConnectionHandler = { conn in
    conn.stateUpdateHandler = { state in
        switch state {
        case .ready:
            q.async {
                clients[ObjectIdentifier(conn)] = conn
                outputOwner = ObjectIdentifier(conn)
                print("+ page connected (\(clients.count) now, newest owns the output)"); fflush(stdout)
                sendJSON(conn, ["t": "hello", "v": PROTOCOL_VERSION, "pid": Int(getpid())])
                sendJSON(conn, portsMessage())
            }
        case .failed, .cancelled:
            q.async {
                if clients.removeValue(forKey: ObjectIdentifier(conn)) != nil {
                    if outputOwner == ObjectIdentifier(conn) { outputOwner = clients.keys.first }
                    print("- page disconnected (\(clients.count) left)"); fflush(stdout)
                }
            }
        default: break
        }
    }
    conn.start(queue: q)
    receive(conn)
}

listener.start(queue: q)

// A device plugged in after start-up must be picked up. CoreMIDI delivers its
// notifications through the creating thread's run loop, so the main thread runs a real
// CFRunLoop here rather than dispatchMain(). The timer is a backstop: a missed
// notification would otherwise leave the keyboard invisible until a restart.
let rescan = Timer(timeInterval: 2.0, repeats: true) { _ in
    q.async {
        let before = connected.count
        connectAllSources()
        if connected.count != before { broadcast(portsMessage()) }
    }

    guard followLuna, !lunaIsRunning() else { return }

    // LUNA has quit, so the add-on page went with it. Give its own goodbye a moment to
    // reach us, then make sure the keyboard is released either way: without it the Mk3
    // stays in deep-integration mode showing a mixer nobody is driving, and Komplete
    // Kontrol cannot take the screens back. Three bytes of protocol is a fair price for
    // not stranding the hardware.
    print("LUNA has quit; releasing the keyboard and exiting.")
    fflush(stdout)
    Thread.sleep(forTimeInterval: 0.4)
    q.sync {
        if let out = defaultOut {
            _ = sendBytes([0xBF, 0x02, 0x01], to: out)   // NIHIA goodbye
        }
    }
    Thread.sleep(forTimeInterval: 0.2)
    exit(0)
}
RunLoop.main.add(rescan, forMode: .common)
RunLoop.main.run()
