import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Section {
                Toggle("Use fixture runtime", isOn: $model.useFixtureRuntime)
                    .onChange(of: model.useFixtureRuntime) { _, _ in model.applyRuntimePreference() }
                if !model.useFixtureRuntime {
                    TextField("Runtime URL", text: $model.runtimeURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                }
            } header: {
                Text("Runtime")
            } footer: {
                Text("Fixtures keep the shell usable offline. The Go client uses /healthz, /readyz, POST /api/v1/runs, and the returned SSE events_url.")
            }

            Section("Diagnostics") {
                HStack {
                    Label("Connection", systemImage: "antenna.radiowaves.left.and.right")
                    Spacer()
                    ConnectionPill(state: model.connectionState)
                }
                Button("Check runtime") {
                    Task { await model.checkRuntime() }
                }
            }

            Section("Appearance") {
                Toggle("Reduce motion", isOn: $model.reduceMotion)
            }

            Section("About") {
                LabeledContent("Build", value: "iOS shell experiment")
                LabeledContent("Transport", value: "Go HTTP + SSE")
            }
        }
        .navigationTitle("Settings")
    }
}
