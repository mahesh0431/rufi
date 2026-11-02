import BackgroundTasks
import SwiftUI
import UIKit
import UserNotifications

@main
struct RufiApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var shield = Shield()
    @Environment(\.scenePhase) private var phase

    private var app: AppModel { delegate.app }

    var body: some Scene {
        WindowGroup {
            RootView(app: app)
                .onChange(of: phase, initial: true) { _, now in
                    app.active = now == .active
                    app.lock.phase(now)
                    shield.show(now != .active || app.lock.locked, app: app)
                    if now == .background { refreshAway() }
                    if now == .active { Task { await app.refresh() } }
                }
                .onChange(of: app.lock.locked) { _, locked in
                    shield.show(phase != .active || locked, app: app)
                }
        }
        // When iOS allows, Rufi refreshes its reminders in the background.
        .backgroundTask(.appRefresh(Reminders.task)) {
            await AppDelegate.refreshInBackground()
        }
    }

    /// Going to the background: a short refresh, and the next background one asked for.
    private func refreshAway() {
        let app = app
        let task = UIApplication.shared.beginBackgroundTask(withName: "Reminders")
        Task {
            await app.refresh()
            UIApplication.shared.endBackgroundTask(task)
        }
        Task { await AppDelegate.askForRefresh() }
    }
}

/// The app's delegate: the one app model, and what a tapped reminder opens.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let app = AppModel()
    private static weak var shared: AppDelegate?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Self.shared = self
        // Before launching ends, so a tap that opened Rufi is heard.
        UNUserNotificationCenter.current().delegate = self
        SystemCenter.register()
        return true
    }

    /// A reminder while Rufi is open shows as it would outside.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A reminder tapped: Rufi opens at Medicines, after the lock. Taken or
    /// Skipped on it: logged, with Rufi closed too.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            app.openMedicines()
        } else if let state = UnsentLog.State(rawValue: response.actionIdentifier) {
            await app.log(state, notice: response.notification)
        }
    }

    /// The background refresh: the reminders, then the next one asked for.
    static func refreshInBackground() async {
        await shared?.app.refresh()
        await askForRefresh()
    }

    /// Asks iOS for a background refresh in a few hours. iOS may refuse
    /// (Background App Refresh off): opening Rufi still refreshes.
    static func askForRefresh() async {
        let request = BGAppRefreshTaskRequest(identifier: Reminders.task)
        request.earliestBeginDate = .now.addingTimeInterval(4 * 60 * 60)
        try? await BGTaskScheduler.shared.submitTaskRequest(request)
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
