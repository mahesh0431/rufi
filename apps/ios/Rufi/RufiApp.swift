import SwiftUI

@main
struct RufiApp: App {
    @State private var app = AppModel()
    @State private var shield = Shield()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView(app: app)
                .onChange(of: phase, initial: true) { _, now in
                    app.active = now == .active
                    app.lock.phase(now)
                    shield.show(now != .active || app.lock.locked, app: app)
                }
                .onChange(of: app.lock.locked) { _, locked in
                    shield.show(phase != .active || locked, app: app)
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
            // The screens stay in memory behind the lock (Shield.swift), so
            // a half-typed message is still there after unlocking.
            ShellView(shell: shell, app: app)
        }
    }
}
