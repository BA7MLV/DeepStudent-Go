import SwiftUI

struct SessionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""

    private var filteredSessions: [StudySession] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.sessions }
        return model.sessions.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.topic.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        List {
            if model.isLoading && model.sessions.isEmpty {
                ProgressView("Loading sessions…")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowSeparator(.hidden)
            } else if filteredSessions.isEmpty {
                EmptyStateView(
                    title: searchText.isEmpty ? "No sessions yet" : "No matching sessions",
                    message: searchText.isEmpty ? "Your study conversations will appear here." : "Try another topic or title.",
                    systemImage: searchText.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass"
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(filteredSessions) { session in
                    NavigationLink(value: session) {
                        SessionRowView(session: session)
                    }
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Sessions")
        .navigationDestination(for: StudySession.self) { session in
            SessionDetailView(session: session)
        }
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ConnectionPill(state: model.connectionState)
            }
        }
        .refreshable { await model.refresh() }
    }
}

struct SessionRowView: View {
    let session: StudySession

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(session.status.color.opacity(0.13))
                    .frame(width: 44, height: 44)
                Image(systemName: session.status == .active ? "sparkles" : "book.closed")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(session.status.color)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(session.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(session.lastActivity, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 5) {
                    StatusDot(status: session.status)
                    Text(session.preview)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if session.unreadCount > 0 {
                        Text("\(session.unreadCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(.blue, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }
}
