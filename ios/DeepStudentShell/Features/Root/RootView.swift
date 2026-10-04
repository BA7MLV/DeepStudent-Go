import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                iPadShell
            } else {
                iPhoneShell
            }
        }
        .task { await model.bootstrap() }
    }

    private var iPhoneShell: some View {
        TabView(selection: $model.selectedSection) {
            NavigationStack {
                SessionsView()
            }
            .tabItem { Label(AppSection.sessions.title, systemImage: AppSection.sessions.systemImage) }
            .tag(AppSection.sessions)

            NavigationStack {
                StudyView()
            }
            .tabItem { Label(AppSection.study.title, systemImage: AppSection.study.systemImage) }
            .tag(AppSection.study)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label(AppSection.settings.title, systemImage: AppSection.settings.systemImage) }
            .tag(AppSection.settings)
        }
    }

    private var iPadShell: some View {
        NavigationSplitView {
            SidebarView(selection: $model.selectedSection)
        } detail: {
            NavigationStack {
                switch model.selectedSection {
                case .sessions: SessionsView()
                case .study: StudyView()
                case .settings: SettingsView()
                }
            }
        }
    }
}

struct SidebarView: View {
    @Binding var selection: AppSection
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List(selection: $selection) {
            Section {
                Label("DeepStudent", systemImage: "graduationcap.fill")
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .listRowBackground(Color.clear)
            }

            Section("Workspace") {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .tag(section)
                }
            }

            Section {
                ConnectionPill(state: model.connectionState)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("DeepStudent")
    }
}
