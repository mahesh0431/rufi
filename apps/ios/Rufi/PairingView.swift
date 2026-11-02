import SwiftUI
import Vision
import VisionKit

/// The first screen: pair this iPhone with Rufi on the Mac, by its QR code
/// or its link pasted.
struct PairingView: View {
    let app: AppModel
    @State private var scanning = false
    @State private var problem: String?
    @State private var pairing = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image("Dog").resizable().scaledToFit().frame(width: 96, height: 96).clipShape(.rect(cornerRadius: 22))
            Text("Rufi").font(.largeTitle.bold())
            Text("Rufi keeps your health record on your Mac. Pair this iPhone to open it here.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            if let problem {
                Text(problem).multilineTextAlignment(.center).foregroundStyle(.red)
            }
            if pairing { ProgressView() }
            if Scanner.available {
                Button("Scan Code", systemImage: "qrcode.viewfinder") { scanning = true }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            }
            PasteButton(payloadType: String.self) { texts in
                guard let text = texts.first else { return }
                Task { await pair(text) }
            }
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            Text("On your Mac: Rufi › Settings › iPhone › Pair an iPhone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .disabled(pairing)
        .fullScreenCover(isPresented: $scanning) {
            ScannerView { text in
                scanning = false
                Task { await pair(text) }
            }
        }
    }

    private func pair(_ text: String) async {
        pairing = true
        problem = await app.pair(text)
        pairing = false
    }
}

/// Paired: whose record this iPhone opens, then the lock's setup.
struct PairedView: View {
    let app: AppModel
    let pairing: Pairing
    @State private var askingLock = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: askingLock ? "faceid" : "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
            if askingLock {
                Text("Lock Rufi with Face ID").font(.title.bold())
                Text("Rufi asks for Face ID, or your iPhone's passcode, when you open it and after a minute away.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                Spacer()
                Button("Lock Rufi", systemImage: "lock") {
                    Task {
                        await app.lock.turnOn()
                        app.finishSetup()
                    }
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                Button("Not Now") { app.finishSetup() }
                    .controlSize(.large)
                Text("You can change this in This iPhone.").font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Paired").font(.title.bold())
                Text("Paired with Rufi on **\(pairing.mac)**. This iPhone opens **\(pairing.person.name)**'s record.")
                    .multilineTextAlignment(.center)
                Spacer()
                Button("Continue", systemImage: "arrow.right") {
                    // No passcode on the iPhone: no lock to offer.
                    if Lock.canLock { askingLock = true } else { app.finishSetup() }
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                Text("Wrong person? Unpair on your Mac and pair again.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(24)
    }
}

/// Rufi is locked: nothing of the record behind it.
struct LockedView: View {
    let lock: Lock

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            ContentUnavailableView {
                Label("Rufi is locked", systemImage: "lock.fill")
            } description: {
                Text("Your record opens after Face ID, or your iPhone's passcode.")
            } actions: {
                Button("Unlock", systemImage: "faceid") { Task { await lock.unlock() } }
                    .buttonStyle(.glassProminent)
            }
        }
        .task { await lock.unlock() }
    }
}

/// The Mac unpaired this iPhone: one screen, no tabs.
struct UnpairedView: View {
    let app: AppModel

    var body: some View {
        ContentUnavailableView {
            Label("Unpaired", systemImage: "iphone.slash")
        } description: {
            Text("This iPhone was unpaired on your Mac. Pair again to open Rufi here.")
        } actions: {
            Button("Pair Again", systemImage: "qrcode") { app.pairAgain() }
                .buttonStyle(.glassProminent)
        }
    }
}

/// VisionKit's scanner, QR codes only.
enum Scanner {
    static var available: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }
}

struct ScannerView: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScannerCamera(found: found).ignoresSafeArea()
            Button("Close", systemImage: "xmark") { dismiss() }
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .padding()
        }
        .overlay(alignment: .bottom) {
            Text("Point at the code in Rufi on your Mac.")
                .padding()
                .glassEffect()
                .padding(.bottom, 32)
        }
    }
}

private struct ScannerCamera: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(found: found)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false

        init(found: @escaping (String) -> Void) {
            self.found = found
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            for case let .barcode(code) in items {
                guard !done, let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                found(text)
            }
        }
    }
}
