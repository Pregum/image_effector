import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
    var started = false
    var finished = false
    var error: Error?

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        started = true
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        self.error = error
        finished = true
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        finished = true
    }
}

@main
struct RecordMacOSWindow {
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count >= 4, let seconds = Double(args[3]), seconds > 0 else {
            fputs("Usage: scripts/record-macos-window.swift APP_NAME OUTPUT.mp4 SECONDS\n", stderr)
            exit(2)
        }

        let appName = args[1]
        let outputURL = URL(fileURLWithPath: args[2])
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            fputs("Output already exists: \(outputURL.path)\n", stderr)
            exit(2)
        }

        var window: SCWindow?
        for _ in 0..<100 {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            window = content.windows.first(where: {
                $0.owningApplication?.applicationName.localizedCaseInsensitiveContains(appName) == true &&
                $0.frame.width > 100 && $0.frame.height > 100
            })
            if window != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let window else {
            fputs("No visible window found for \(appName)\n", stderr)
            exit(1)
        }

        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let width = max(2, Int(window.frame.width * scale) / 2 * 2)
        let height = max(2, Int(window.frame.height * scale) / 2 * 2)
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 6
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA

        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration, delegate: nil)
        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = outputURL
        recordingConfiguration.outputFileType = .mp4
        recordingConfiguration.videoCodecType = .h264
        let delegate = RecordingDelegate()
        let recordingOutput = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
        try stream.addRecordingOutput(recordingOutput)

        try await stream.startCapture()
        try await Task.sleep(for: .seconds(seconds))
        try await stream.stopCapture()
        for _ in 0..<50 where !delegate.finished {
            try await Task.sleep(for: .milliseconds(100))
        }

        if let error = delegate.error { throw error }
        guard delegate.started, FileManager.default.fileExists(atPath: outputURL.path) else {
            throw NSError(domain: "record-macos-window", code: 2, userInfo: [NSLocalizedDescriptionKey: "Recording did not start"])
        }
        print(outputURL.path)
    }
}
