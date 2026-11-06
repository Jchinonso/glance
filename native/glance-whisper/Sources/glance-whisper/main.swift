// glance-whisper: Glance's speech helper. Runs Whisper (WhisperKit, Core ML) and
// talks JSON lines: one request per line on stdin, one reply or event per line on
// stdout. Logs go to stderr.
//
//   glance-whisper --models <dir> [--variant <name>]
//
//   {"op":"download"}  -> {"event":"download","received":n,"total":n,"fraction":f}...
//                         then {"event":"downloaded"} or {"event":"error","message":s}
//   {"op":"load"}      -> {"event":"loading"} then {"event":"ready","loadMs":n}
//                         or {"event":"error","message":s}
//   {"op":"transcribe","id":s,"path":s,"prompt":s}
//                      -> {"id":s,"text":s,"ms":n} or {"id":s,"error":s}
//   {"op":"quit"} or EOF -> exit
//
// Requests are handled one at a time, in order.

import CoreML
import Foundation
import WhisperKit

let defaultVariant = "openai_whisper-large-v3-v20240930_turbo_632MB"
let modelRepo = "argmaxinc/whisperkit-coreml"
let tokenizerRepo = "openai/whisper-large-v3"
let completeMarker = ".glance-complete"

// MARK: - Output

// WhisperKit's bundled Hub/Tokenizers code can print() to stdout. Keep the protocol
// clean: move the real stdout to a private descriptor and point fd 1 at stderr.
let protocolFD = dup(STDOUT_FILENO)
dup2(STDERR_FILENO, STDOUT_FILENO)
let protocolOut = FileHandle(fileDescriptor: protocolFD, closeOnDealloc: false)
let outLock = NSLock()

func send(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    data.append(0x0A)
    outLock.lock()
    defer { outLock.unlock() }
    protocolOut.write(data)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data(("glance-whisper: " + message + "\n").utf8))
}

func describe(_ error: Error) -> String {
    let text = String(describing: error)
    return text.isEmpty ? error.localizedDescription : text
}

// MARK: - Arguments

var modelsDir: URL?
var variant = defaultVariant
do {
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
        switch arg {
        case "--models": if let v = args.next() { modelsDir = URL(fileURLWithPath: v, isDirectory: true) }
        case "--variant": if let v = args.next(), !v.isEmpty { variant = v }
        default: log("ignoring argument \(arg)")
        }
    }
}
guard let modelsDir else {
    log("usage: glance-whisper --models <dir> [--variant <name>]")
    exit(2)
}

// WhisperKit's layout under the download base: models/<repo>/<variant>
let hub = HubApiWrapper(downloadBase: modelsDir)
let variantFolder = hub.localRepoLocation(.init(id: modelRepo)).appendingPathComponent(variant, isDirectory: true)
let tokenizerFolder = hub.localRepoLocation(.init(id: tokenizerRepo))

func isDownloaded() -> Bool {
    let fm = FileManager.default
    return fm.fileExists(atPath: variantFolder.appendingPathComponent(completeMarker).path)
        && fm.fileExists(atPath: tokenizerFolder.appendingPathComponent("tokenizer.json").path)
}

// MARK: - Download

struct RemoteFile: Decodable {
    let type: String
    let path: String
    let size: Int64?
}

/// Lists the variant's files with their sizes so progress can be reported in bytes.
func listVariantFiles() async throws -> [RemoteFile] {
    var components = URLComponents(string: "https://huggingface.co/api/models/\(modelRepo)/tree/main/\(variant)")!
    components.queryItems = [URLQueryItem(name: "recursive", value: "true")]
    let (data, response) = try await URLSession.shared.data(from: components.url!)
    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
        throw NSError(domain: "glance-whisper", code: http.statusCode,
                      userInfo: [NSLocalizedDescriptionKey: "model list HTTP \(http.statusCode)"])
    }
    let files = try JSONDecoder().decode([RemoteFile].self, from: data).filter { $0.type == "file" }
    if files.isEmpty { throw NSError(domain: "glance-whisper", code: 1, userInfo: [NSLocalizedDescriptionKey: "model \(variant) not found"]) }
    return files
}

final class ProgressReporter: @unchecked Sendable {
    let total: Int64
    private var lastSent = Date.distantPast
    private var lastFraction = -1.0
    private let lock = NSLock()
    init(total: Int64) { self.total = total }

    func report(_ received: Int64, force: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        let fraction = total > 0 ? min(1, Double(received) / Double(total)) : 0
        let now = Date()
        guard force || (now.timeIntervalSince(lastSent) >= 0.25 && fraction > lastFraction) else { return }
        lastSent = now
        lastFraction = fraction
        send(["event": "download", "received": received, "total": total, "fraction": fraction])
    }
}

func download() async {
    if isDownloaded() {
        send(["event": "downloaded"])
        return
    }
    do {
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        let files = try await listVariantFiles()
        let tokenizerBytes: Int64 = 2_800_000 // tokenizer.json and friends, roughly
        let total = files.reduce(Int64(0)) { $0 + ($1.size ?? 0) } + tokenizerBytes
        let reporter = ProgressReporter(total: total)
        var done: Int64 = 0
        reporter.report(0, force: true)
        // Biggest files last so the bar moves early; each file is resumable and is
        // skipped when it is already complete on disk.
        let repo = HubApiWrapper.Repo(id: modelRepo)
        for file in files.sorted(by: { ($0.size ?? 0) < ($1.size ?? 0) }) {
            let size = file.size ?? 0
            let base = done
            _ = try await hub.snapshot(from: repo, matching: [file.path]) { progress in
                reporter.report(base + Int64(Double(size) * min(1, progress.fractionCompleted)))
            }
            done += size
            reporter.report(done)
        }
        // The tokenizer comes from the original OpenAI repo. Loading it once downloads it
        // into the same folder, so loading the model later needs no network.
        _ = try await ModelUtilities.loadTokenizer(for: .largev3, tokenizerFolder: modelsDir)
        done += tokenizerBytes
        reporter.report(done, force: true)
        try Data().write(to: variantFolder.appendingPathComponent(completeMarker))
        send(["event": "downloaded"])
    } catch {
        log("download failed: \(describe(error))")
        send(["event": "error", "message": describe(error)])
    }
}

// MARK: - Load

var whisper: WhisperKit?

func load() async {
    if whisper != nil {
        send(["event": "ready", "loadMs": 0])
        return
    }
    guard isDownloaded() else {
        send(["event": "error", "message": "model not downloaded"])
        return
    }
    send(["event": "loading"])
    let start = Date()
    do {
        // Encoder and decoder on the Neural Engine (CPU as Core ML's fallback). The tiny
        // mel spectrogram runs on the CPU, so nothing here depends on the GPU.
        let compute = ModelComputeOptions(
            melCompute: .cpuOnly,
            audioEncoderCompute: .cpuAndNeuralEngine,
            textDecoderCompute: .cpuAndNeuralEngine
        )
        let config = WhisperKitConfig(
            modelFolder: variantFolder.path,
            tokenizerFolder: modelsDir,
            computeOptions: compute,
            verbose: false,
            logLevel: .error,
            prewarm: true, // the first load specializes for this Mac's Neural Engine, one model at a time
            load: true,
            download: false
        )
        whisper = try await WhisperKit(config)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        log("loaded in \(ms) ms")
        send(["event": "ready", "loadMs": ms])
    } catch {
        whisper = nil
        log("load failed: \(describe(error))")
        send(["event": "error", "message": describe(error)])
    }
}

// MARK: - Transcribe

func transcribe(id: String, path: String, prompt: String) async {
    guard let whisper, let tokenizer = whisper.tokenizer else {
        send(["id": id, "error": "model not loaded"])
        return
    }
    let start = Date()
    var options = DecodingOptions(
        task: .transcribe,
        language: "en",
        usePrefillPrompt: true,
        detectLanguage: false,
        skipSpecialTokens: true,
        withoutTimestamps: true,
        suppressBlank: true
    )
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
        options.promptTokens = tokenizer.encode(text: " " + trimmed)
            .filter { $0 < tokenizer.specialTokens.specialTokenBegin }
    }
    do {
        let results = try await whisper.transcribe(audioPath: path, decodeOptions: options)
        let text = results.map(\.text).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let t = results.first?.timings {
            let ms = { (s: TimeInterval) in Int(s * 1000) }
            log("timings mel=\(ms(t.logmels))ms encode=\(ms(t.encoding))ms decode=\(ms(t.decodingLoop))ms tokens=\(Int(t.totalDecodingLoops)) fallbacks=\(ms(t.decodingFallback))ms")
        }
        send(["id": id, "text": text, "ms": Int(Date().timeIntervalSince(start) * 1000)])
    } catch {
        log("transcribe failed: \(describe(error))")
        send(["id": id, "error": describe(error)])
    }
}

// MARK: - Main loop

func handle(_ line: String) async -> Bool {
    guard let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let op = request["op"] as? String else {
        if !line.trimmingCharacters(in: .whitespaces).isEmpty { log("bad request: \(line.prefix(200))") }
        return true
    }
    switch op {
    case "download": await download()
    case "load": await load()
    case "transcribe":
        let id = request["id"].map { "\($0)" } ?? ""
        guard let path = request["path"] as? String else {
            send(["id": id, "error": "missing path"])
            break
        }
        await transcribe(id: id, path: path, prompt: request["prompt"] as? String ?? "")
    case "quit": return false
    default:
        if let id = request["id"] { send(["id": "\(id)", "error": "unknown op \(op)"]) }
        else { send(["event": "error", "message": "unknown op \(op)"]) }
    }
    return true
}

signal(SIGPIPE, SIG_IGN)
log("variant \(variant), models \(modelsDir.path)")

Task {
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            if !(await handle(line)) { break }
        }
    } catch {
        log("stdin: \(describe(error))")
    }
    exit(0)
}
dispatchMain()
