import SwiftUI

@main
struct RufiApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView(app: app)
                // Whenever Rufi isn't active, a plain cover, so the app
                // switcher's still shows nothing.
                .overlay {
                    if phase != .active { Color(.systemBackground).ignoresSafeArea() }
                }
                .onChange(of: phase) { _, now in
                    if now == .background { app.lock.left() }
                    if now == .active { app.lock.cameBack() }
                }
        }
    }
}

struct RootView: View {
    let app: AppModel

    var body: some View {
        switch app.stage {
        case .pairing:
            PairingView(app: app)
        case let .paired(pairing):
            PairedView(app: app, pairing: pairing)
        case .unpaired:
            UnpairedView(app: app)
        case let .open(shell):
            // The screens stay in memory behind the lock, so a half-typed
            // message is still there after unlocking.
            ShellView(shell: shell, app: app)
                .overlay {
                    if app.lock.locked { LockedView(lock: app.lock) }
                }
        }
    }
}
