import SwiftUI

struct StatusDot: View {
    let status: SessionStatus

    var body: some View {
        Circle()
            .fill(status.color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(status.label)
    }
}

struct ConnectionPill: View {
    let state: RuntimeConnectionState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(state.color)
                .frame(width: 7, height: 7)
            Text(state.label)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        }
    }
}

extension SessionStatus {
    var color: Color {
        switch self {
        case .active: return .green
        case .waiting: return .orange
        case .completed: return .secondary
        case .draft: return .blue
        }
    }
}

extension RuntimeConnectionState {
    var label: String {
        switch self {
        case .unknown: return "Not checked"
        case .checking: return "Checking"
        case .ready: return "Ready"
        case .unavailable: return "Offline"
        }
    }

    var color: Color {
        switch self {
        case .unknown: return .secondary
        case .checking: return .orange
        case .ready: return .green
        case .unavailable: return .red
        }
    }
}
