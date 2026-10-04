import SwiftUI

@main
struct DeepStudentShellApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(.blue)
        }
    }
}
