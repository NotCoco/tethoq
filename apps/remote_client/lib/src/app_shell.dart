import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_theme.dart';
import 'desktop_wake_dialog.dart';
import 'models.dart';
import 'screens.dart';
import 'store.dart';
import 'transport.dart';

class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;
  final Set<int> _visitedTabs = <int>{0};
  RemoteAppStore? _store;
  String _selectedProviderId = 'codex';

  static const _destinations = <NavigationDestination>[
    NavigationDestination(
        icon: Icon(Icons.grid_view_outlined),
        selectedIcon: Icon(Icons.grid_view_rounded),
        label: 'Dashboard'),
    NavigationDestination(
        icon: Icon(Icons.chat_bubble_outline),
        selectedIcon: Icon(Icons.chat_bubble),
        label: 'Tasks'),
    NavigationDestination(
        icon: Icon(Icons.settings_outlined),
        selectedIcon: Icon(Icons.settings),
        label: 'Settings'),
  ];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.read(context);
    if (!identical(_store, store)) {
      _store?.removeListener(_handleStoreChange);
      _store = store;
      _selectedProviderId = store.selectedProviderId;
      store.addListener(_handleStoreChange);
    }
  }

  void _handleStoreChange() {
    final store = _store;
    if (store == null || _selectedProviderId == store.selectedProviderId)
      return;
    setState(() => _selectedProviderId = store.selectedProviderId);
  }

  @override
  void dispose() {
    _store?.removeListener(_handleStoreChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.read(context);
    final routeActive = TickerMode.valuesOf(context).enabled;
    _visitedTabs.add(_index);
    final visual = providerVisualThemeFor(_selectedProviderId);
    final wide = MediaQuery.sizeOf(context).width >= 760;
    final pages = <Widget>[
      DashboardScreen(
        onViewSessions: () => setState(() => _index = 1),
      ),
      const SessionsScreen(),
      const HostsScreen(),
    ];
    final content = IndexedStack(
      index: _index,
      children: pages.indexed
          .map((entry) => TickerMode(
                enabled: entry.$1 == _index,
                child: StoreScope(
                  store: store,
                  listenToChanges: routeActive && entry.$1 == _index,
                  child: _visitedTabs.contains(entry.$1)
                      ? entry.$2
                      : const SizedBox.shrink(),
                ),
              ))
          .toList(growable: false),
    );
    return Scaffold(
      body: wide
          ? Row(
              children: <Widget>[
                SafeArea(
                  right: false,
                  child: NavigationRail(
                    key: const Key('adaptive-navigation-rail'),
                    selectedIndex: _index,
                    onDestinationSelected: (value) =>
                        setState(() => _index = value),
                    labelType: NavigationRailLabelType.all,
                    groupAlignment: -0.75,
                    destinations: _destinations
                        .map((item) => NavigationRailDestination(
                              icon: item.icon,
                              selectedIcon: item.selectedIcon,
                              label: Text(
                                item.label,
                                style: const TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ))
                        .toList(growable: false),
                  ),
                ),
                VerticalDivider(
                    width: 1, color: visual.border.withValues(alpha: 0.6)),
                Expanded(child: content),
              ],
            )
          : content,
      bottomNavigationBar: wide
          ? null
          : SafeArea(
              top: false,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(
                    top:
                        BorderSide(color: visual.border.withValues(alpha: 0.5)),
                  ),
                ),
                child: NavigationBar(
                  height: 68,
                  indicatorColor: visual.accent.withValues(alpha: 0.10),
                  labelTextStyle:
                      WidgetStateProperty.resolveWith((states) => TextStyle(
                            fontSize: 13.5,
                            fontWeight: states.contains(WidgetState.selected)
                                ? FontWeight.w700
                                : FontWeight.w500,
                          )),
                  selectedIndex: _index,
                  onDestinationSelected: (value) =>
                      setState(() => _index = value),
                  destinations: _destinations,
                ),
              ),
            ),
    );
  }
}

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({
    required this.onViewSessions,
    super.key,
  });

  final VoidCallback onViewSessions;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final visual = providerVisualThemeFor(store.selectedProviderId);
    final providerSessions = store.sessions
        .where((session) =>
            session.parentSessionId == null &&
            (store.selectedProviderId == 'all' ||
                session.providerId == store.selectedProviderId))
        .toList()
      ..sort(
          (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
    final activeSession = _activeSession(providerSessions);
    final activeArtifact = activeSession?.state == 'working'
        ? store.latestReasoningArtifactFor(activeSession!.id)
        : null;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(0.75, -0.95),
          radius: 1.25,
          colors: <Color>[
            visual.surface.withValues(alpha: 0.62),
            visual.background,
          ],
        ),
      ),
      child: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 780),
            child: CustomScrollView(
              slivers: <Widget>[
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                  sliver: SliverToBoxAdapter(
                    child: _DashboardHeader(
                      store: store,
                      visual: visual,
                      onNewSession: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                              builder: (_) => const NewSessionScreen())),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
                  sliver: SliverToBoxAdapter(
                    child: _ActiveSessionCard(
                      session: activeSession,
                      activeArtifact: activeArtifact,
                      visual: visual,
                      onTap: activeSession == null
                          ? null
                          : () => _openSession(context, store, activeSession),
                    ),
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(12, 14, 12, 10),
                  sliver: SliverToBoxAdapter(
                    child: _RecentSessionsCard(
                      sessions: providerSessions.take(5).toList(),
                      activeSessionId: activeSession?.id,
                      unreadSessionIds: store.unreadSessionIds,
                      hasUnreadSessions: providerSessions
                          .any((session) => store.isSessionUnread(session.id)),
                      visual: visual,
                      onViewAll: onViewSessions,
                      onMarkAllRead: () =>
                          unawaited(store.markSessionsRead(providerSessions)),
                      onOpen: (session) =>
                          _openSession(context, store, session),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DashboardHeader extends StatelessWidget {
  const _DashboardHeader({
    required this.store,
    required this.visual,
    required this.onNewSession,
  });

  final RemoteAppStore store;
  final ProviderVisualTheme visual;
  final VoidCallback onNewSession;

  @override
  Widget build(BuildContext context) {
    final providerIds = <String>{
      'all',
      ...store.providers.map((item) => item.providerId),
    };
    final choiceIds = <String>[
      'all',
      ...store.providers.map((item) => item.providerId),
    ];
    final selected = providerIds.contains(store.selectedProviderId)
        ? store.selectedProviderId
        : store.providers.firstOrNull?.providerId;
    return Row(
      children: <Widget>[
        Expanded(
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: store.providers.isEmpty
                ? const Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'No agents found',
                      style: TextStyle(fontSize: 16),
                    ),
                  )
                : DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      key: const Key('dashboard-agent-picker'),
                      value: selected,
                      isExpanded: true,
                      borderRadius: BorderRadius.circular(14),
                      dropdownColor: visual.surfaceRaised,
                      icon: const Icon(Icons.keyboard_arrow_down_rounded),
                      selectedItemBuilder: (context) => choiceIds
                          .map((providerId) => _ProviderChoice(
                                providerId: providerId,
                                compact: true,
                              ))
                          .toList(),
                      items: choiceIds
                          .map((providerId) => DropdownMenuItem<String>(
                                value: providerId,
                                child: _ProviderChoice(providerId: providerId),
                              ))
                          .toList(),
                      onChanged: (value) {
                        if (value != null) store.selectProvider(value);
                      },
                    ),
                  ),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          key: const Key('dashboard-open-desktop'),
          constraints: const BoxConstraints.tightFor(width: 48, height: 48),
          tooltip: store.connectionState == BridgeConnectionState.online
              ? 'Open Tethoq on PC'
              : 'Bridge is offline',
          onPressed: store.connectionState == BridgeConnectionState.online
              ? () {
                  unawaited(HapticFeedback.selectionClick());
                  unawaited(showDesktopWakeDialog(context, store));
                }
              : null,
          icon: Stack(
            clipBehavior: Clip.none,
            children: <Widget>[
              const Icon(Icons.desktop_windows_outlined, size: 21),
              Positioned(
                right: -2,
                bottom: -2,
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: store.connectionState == BridgeConnectionState.online
                        ? const Color(0xff77da95)
                        : const Color(0xffffb061),
                    shape: BoxShape.circle,
                    border: Border.all(
                        color: Theme.of(context).scaffoldBackgroundColor,
                        width: 1.2),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 4),
        IconButton(
          key: const Key('dashboard-new-session'),
          constraints: const BoxConstraints.tightFor(width: 48, height: 48),
          tooltip: 'New task',
          onPressed: store.providers.any((provider) =>
                  provider.detected && provider.capabilities.createSession)
              ? onNewSession
              : null,
          icon: const Icon(Icons.add_rounded),
        ),
      ],
    );
  }
}

class _ProviderChoice extends StatelessWidget {
  const _ProviderChoice({required this.providerId, this.compact = false});

  final String providerId;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = providerVisualThemeFor(providerId);
    final iconSize = compact ? 34.0 : 40.0;
    return Row(
      children: <Widget>[
        SizedBox(
          width: iconSize,
          height: iconSize,
          child: Center(
            child: ProviderLogo(
              providerId: providerId,
              size: compact ? 29 : 28,
            ),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                providerId == 'all' ? 'All agents' : theme.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontSize: 16),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ActiveSessionCard extends StatelessWidget {
  const _ActiveSessionCard({
    required this.session,
    required this.activeArtifact,
    required this.visual,
    required this.onTap,
  });

  final RemoteSession? session;
  final String? activeArtifact;
  final ProviderVisualTheme visual;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final current = session;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        splashFactory: NoSplash.splashFactory,
        highlightColor: visual.accent.withValues(alpha: 0.20),
        overlayColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.pressed)) {
            return visual.accent.withValues(alpha: 0.22);
          }
          if (states.contains(WidgetState.hovered) ||
              states.contains(WidgetState.focused)) {
            return visual.accent.withValues(alpha: 0.08);
          }
          return null;
        }),
        onTap: onTap,
        child: Container(
          key: const Key('active-task-card'),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
          decoration: BoxDecoration(
            color: visual.surface.withValues(alpha: 0.42),
            borderRadius: BorderRadius.circular(14),
          ),
          child: current == null
              ? const SizedBox(
                  height: 40,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Nothing is running',
                      style: TextStyle(
                        color: Color(0xffaeb7c5),
                        fontSize: 15,
                      ),
                    ),
                  ),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        ProviderLogo(
                          providerId: current.providerId,
                          size: 27,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            current.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Color(0xffedf0f4),
                              fontSize: 17.5,
                              fontWeight: FontWeight.w600,
                              height: 1.2,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          _relativeTime(current.lastActivityAt),
                          maxLines: 1,
                          style: const TextStyle(
                            color: Color(0xffa7afbb),
                            fontSize: 12.5,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 9),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: current.state == 'working'
                              ? _ThinkingText(
                                  key: const Key('active-session-thinking'),
                                  text: activeArtifact ??
                                      '${providerVisualThemeFor(current.providerId).displayName} is working…',
                                  accent: visual.providerId == 'all'
                                      ? providerVisualThemeFor(
                                              current.providerId)
                                          .accent
                                      : visual.accent,
                                )
                              : Text(
                                  current.preview ??
                                      '${visual.displayName} is working on this task.',
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context)
                                      .textTheme
                                      .bodyMedium
                                      ?.copyWith(
                                        color: const Color(0xffc2c9d3),
                                        fontSize: 14.5,
                                        height: 1.35,
                                      ),
                                ),
                        ),
                        const SizedBox(width: 12),
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: current.state == 'working'
                              ? _ActivitySpinner(
                                  key: const Key('active-session-spinner'),
                                  size: 18,
                                  color: visual.providerId == 'all'
                                      ? providerVisualThemeFor(
                                              current.providerId)
                                          .accent
                                      : visual.accent,
                                )
                              : _StatusSignal(
                                  state: current.state,
                                  visual: visual.providerId == 'all'
                                      ? providerVisualThemeFor(
                                          current.providerId)
                                      : visual,
                                ),
                        ),
                      ],
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _RecentSessionsCard extends StatelessWidget {
  const _RecentSessionsCard({
    required this.sessions,
    required this.activeSessionId,
    required this.unreadSessionIds,
    required this.hasUnreadSessions,
    required this.visual,
    required this.onViewAll,
    required this.onMarkAllRead,
    required this.onOpen,
  });

  final List<RemoteSession> sessions;
  final String? activeSessionId;
  final Set<String> unreadSessionIds;
  final bool hasUnreadSessions;
  final ProviderVisualTheme visual;
  final VoidCallback onViewAll;
  final VoidCallback onMarkAllRead;
  final ValueChanged<RemoteSession> onOpen;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  'Recent tasks',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: const Color(0xffe4e8ed),
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ),
              TextButton(
                onPressed: onViewAll,
                style: TextButton.styleFrom(
                  foregroundColor: visual.accent,
                  minimumSize: const Size(72, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  textStyle: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text('View all'),
                    SizedBox(width: 2),
                    Icon(Icons.chevron_right, size: 15),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                key: const Key('recent-sessions-menu'),
                tooltip: 'Recent task options',
                padding: EdgeInsets.zero,
                constraints:
                    const BoxConstraints.tightFor(width: 44, height: 44),
                position: PopupMenuPosition.under,
                icon: Icon(Icons.more_horiz_rounded,
                    size: 18,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.58)),
                onSelected: (value) {
                  if (value == 'mark-read') onMarkAllRead();
                },
                itemBuilder: (context) => <PopupMenuEntry<String>>[
                  PopupMenuItem<String>(
                    value: 'mark-read',
                    height: 48,
                    enabled: hasUnreadSessions,
                    child: const Text('Mark all as read'),
                  ),
                ],
              ),
            ],
          ),
        ),
        if (sessions.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text('No recent tasks'),
          )
        else
          Column(
            children: sessions
                .map((session) => Material(
                      color: Colors.transparent,
                      child: InkWell(
                        key: ValueKey<String>('recent-session-${session.id}'),
                        splashFactory: NoSplash.splashFactory,
                        highlightColor: visual.accent.withValues(alpha: 0.20),
                        overlayColor: WidgetStateProperty.resolveWith((states) {
                          if (states.contains(WidgetState.pressed)) {
                            return visual.accent.withValues(alpha: 0.22);
                          }
                          if (states.contains(WidgetState.hovered)) {
                            return visual.accent.withValues(alpha: 0.08);
                          }
                          return null;
                        }),
                        onTap: () => onOpen(session),
                        child: Container(
                          constraints: const BoxConstraints(minHeight: 72),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 10),
                          decoration: BoxDecoration(
                            border: Border(
                              bottom: BorderSide(
                                  color: visual.border.withValues(alpha: 0.65)),
                            ),
                          ),
                          child: Row(
                            children: <Widget>[
                              SizedBox(
                                width: 32,
                                child: Center(
                                  child: ProviderLogo(
                                    providerId: session.providerId,
                                    size: 24,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 9),
                              Expanded(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    Row(
                                      children: <Widget>[
                                        Expanded(
                                          child: Text(
                                            session.title,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: Theme.of(context)
                                                .textTheme
                                                .bodyMedium
                                                ?.copyWith(
                                                  color:
                                                      const Color(0xffedf0f4),
                                                  fontSize: 15,
                                                  fontWeight: FontWeight.w600,
                                                ),
                                          ),
                                        ),
                                        if (unreadSessionIds
                                            .contains(session.id)) ...<Widget>[
                                          const SizedBox(width: 5),
                                          Container(
                                            key: ValueKey<String>(
                                                'unread-dot-${session.id}'),
                                            width: 7,
                                            height: 7,
                                            decoration: const BoxDecoration(
                                              color: Color(0xff4c9aff),
                                              shape: BoxShape.circle,
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                    const SizedBox(height: 3),
                                    Row(
                                      children: <Widget>[
                                        if (session.preview != null &&
                                            session.id != activeSessionId)
                                          Expanded(
                                            child: Text(
                                              session.preview!,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .bodySmall
                                                  ?.copyWith(
                                                    color:
                                                        const Color(0xffaeb7c5),
                                                    fontSize: 13,
                                                  ),
                                            ),
                                          )
                                        else
                                          const Spacer(),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                              if (store.childSessionsFor(session.id).isNotEmpty)
                                IconButton(
                                  key: ValueKey<String>(
                                      'recent-session-agents-${session.id}'),
                                  tooltip: 'Show delegated agents',
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(
                                      minWidth: 44, minHeight: 44),
                                  onPressed: () => _showRecentChildSessions(
                                    context,
                                    store,
                                    session,
                                    onOpen,
                                  ),
                                  icon: ExcludeSemantics(
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: <Widget>[
                                        Icon(
                                          Icons.groups_2_outlined,
                                          key: ValueKey<String>(
                                              'recent-session-agents-icon-${session.id}'),
                                          size: 18,
                                        ),
                                        const SizedBox(width: 3),
                                        Text(
                                          _compactChildSessionCount(store
                                              .childSessionsFor(session.id)
                                              .length),
                                          key: ValueKey<String>(
                                              'recent-session-agents-count-${session.id}'),
                                          maxLines: 1,
                                          softWrap: false,
                                          style: const TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w700,
                                            height: 1,
                                            letterSpacing: -0.15,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              SizedBox(
                                key: ValueKey<String>(
                                    'recent-session-time-${session.id}'),
                                width: 44,
                                child: Text(
                                  _relativeTime(session.lastActivityAt),
                                  maxLines: 1,
                                  textAlign: TextAlign.right,
                                  style: Theme.of(context)
                                      .textTheme
                                      .bodySmall
                                      ?.copyWith(
                                        color: const Color(0xffa7afbb),
                                        fontSize: 12.5,
                                      ),
                                ),
                              ),
                              const SizedBox(width: 4),
                              SizedBox(
                                key: ValueKey<String>(
                                    'recent-session-state-slot-${session.id}'),
                                width: 18,
                                child: Center(
                                  child: session.state == 'working'
                                      ? _ActivitySpinner(
                                          key: ValueKey<String>(
                                              'recent-session-spinner-${session.id}'),
                                          size: 13,
                                          color: visual.providerId == 'all'
                                              ? providerVisualThemeFor(
                                                      session.providerId)
                                                  .accent
                                              : visual.accent,
                                        )
                                      : session.state != 'offline' &&
                                              session.state != 'disconnected' &&
                                              _hasMeaningfulSessionStatus(
                                                  session.state)
                                          ? _StatusSignal(
                                              state: session.state,
                                              visual: visual.providerId == 'all'
                                                  ? providerVisualThemeFor(
                                                      session.providerId)
                                                  : visual,
                                            )
                                          : null,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ))
                .toList(),
          ),
      ],
    );
  }
}

String _compactChildSessionCount(int count) => count >= 1000 ? '1k+' : '$count';

Future<void> _showRecentChildSessions(
  BuildContext context,
  RemoteAppStore store,
  RemoteSession parent,
  ValueChanged<RemoteSession> onOpen,
) async {
  await showModalBottomSheet<void>(
    context: context,
    constraints: const BoxConstraints(maxWidth: 640),
    showDragHandle: true,
    builder: (sheetContext) {
      final children = store.childSessionsFor(parent.id);
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
              child: Text('Delegated agents',
                  style: Theme.of(sheetContext).textTheme.titleMedium),
            ),
            ...children.map((child) => ListTile(
                  leading: ProviderLogo(providerId: child.providerId, size: 28),
                  title: Text(child.agentNickname ?? child.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      )),
                  subtitle: Text(
                    providerVisualThemeFor(child.providerId).displayName,
                    style: const TextStyle(
                      color: Color(0xffaeb7c5),
                      fontSize: 13,
                    ),
                  ),
                  trailing: child.state == 'working'
                      ? _ActivitySpinner(
                          size: 14,
                          color:
                              providerVisualThemeFor(child.providerId).accent)
                      : _StatusSignal(
                          state: child.state,
                          visual: providerVisualThemeFor(child.providerId),
                        ),
                  onTap: () {
                    Navigator.pop(sheetContext);
                    onOpen(child);
                  },
                )),
            const SizedBox(height: 8),
          ],
        ),
      );
    },
  );
}

class _StatusSignal extends StatelessWidget {
  const _StatusSignal({
    required this.state,
    required this.visual,
  });

  final String state;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(state, visual);
    final label = _statusLabel(state);
    return Tooltip(
      message: label,
      waitDuration: const Duration(milliseconds: 350),
      child: Semantics(
        label: label,
        readOnly: true,
        child: ExcludeSemantics(
          child: Container(
            key: ValueKey<String>('status-signal-$state'),
            width: 9,
            height: 9,
            decoration: BoxDecoration(
              color: color,
              shape: BoxShape.circle,
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: color.withValues(alpha: 0.24),
                  blurRadius: 5,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ActivitySpinner extends StatefulWidget {
  const _ActivitySpinner({
    required this.size,
    required this.color,
    super.key,
  });

  final double size;
  final Color color;

  @override
  State<_ActivitySpinner> createState() => _ActivitySpinnerState();
}

class _ThinkingText extends StatefulWidget {
  const _ThinkingText({
    required this.text,
    required this.accent,
    super.key,
  });

  final String text;
  final Color accent;

  @override
  State<_ThinkingText> createState() => _ThinkingTextState();
}

class _ThinkingTextState extends State<_ThinkingText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1900),
    );
    unawaited(_controller.repeat());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const baseColor = Color(0xffaeb8c5);
    final style = Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: baseColor,
          height: 1.35,
        );
    final text = Text(
      widget.text,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: style,
    );

    if (MediaQuery.disableAnimationsOf(context)) return text;

    final edgeHighlight = Color.lerp(
      baseColor,
      widget.accent,
      0.30,
    )!;
    final centerHighlight = Color.lerp(
      Colors.white,
      widget.accent,
      0.20,
    )!;
    return AnimatedBuilder(
      animation: _controller,
      child: text,
      builder: (context, child) {
        final position = -2.0 + (_controller.value * 4.0);
        return ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment(position - 0.7, 0),
            end: Alignment(position + 0.7, 0),
            colors: <Color>[
              baseColor,
              baseColor,
              edgeHighlight,
              centerHighlight,
              edgeHighlight,
              baseColor,
              baseColor,
            ],
            stops: const <double>[0, 0.2, 0.38, 0.5, 0.62, 0.8, 1],
          ).createShader(bounds),
          child: child,
        );
      },
    );
  }
}

class _ActivitySpinnerState extends State<_ActivitySpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 780),
    );
    unawaited(_controller.repeat());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    return Semantics(
      label: 'Working',
      readOnly: true,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: widget.size,
          child: reducedMotion
              ? CustomPaint(
                  painter: _ActivitySpinnerPainter(
                      progress: 0.15, color: widget.color))
              : AnimatedBuilder(
                  animation: _controller,
                  builder: (context, child) => CustomPaint(
                    painter: _ActivitySpinnerPainter(
                      progress: _controller.value,
                      color: widget.color,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

class _ActivitySpinnerPainter extends CustomPainter {
  const _ActivitySpinnerPainter({
    required this.progress,
    required this.color,
  });

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final strokeWidth = math.max(1.4, size.shortestSide * 0.11);
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.shortestSide - strokeWidth) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);
    final start = progress * math.pi * 2 - math.pi / 2;
    const sweep = math.pi * 0.95;

    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..color = color.withValues(alpha: 0.16)
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth,
    );
    canvas.drawArc(
      rect,
      start,
      sweep,
      false,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = strokeWidth,
    );
    final headAngle = start + sweep;
    canvas.drawCircle(
      Offset(
        center.dx + math.cos(headAngle) * radius,
        center.dy + math.sin(headAngle) * radius,
      ),
      strokeWidth * 0.58,
      Paint()..color = color,
    );
  }

  @override
  bool shouldRepaint(_ActivitySpinnerPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.color != color;
}

class AgentsScreen extends StatelessWidget {
  const AgentsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Agents',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
        ),
      ),
      body: _CenteredPage(
        maxWidth: 780,
        child: store.providers.isEmpty
            ? const Center(
                child: Text(
                  'No agents found',
                  style: TextStyle(fontSize: 16),
                ),
              )
            : ListView.separated(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                itemCount: store.providers.length,
                separatorBuilder: (_, __) => Divider(
                  height: 1,
                  indent: 52,
                  color: Theme.of(context).dividerColor.withValues(alpha: 0.55),
                ),
                itemBuilder: (context, index) {
                  final provider = store.providers[index];
                  final providerVisual =
                      providerVisualThemeFor(provider.providerId);
                  final available = provider.detected &&
                      provider.state != 'offline' &&
                      provider.state != 'unavailable';
                  final availability = provider.detected
                      ? _statusLabel(provider.state)
                      : 'Not detected';
                  return Semantics(
                    label: '${provider.displayName}, $availability',
                    readOnly: true,
                    child: ExcludeSemantics(
                      child: Opacity(
                        opacity: available ? 1 : 0.52,
                        child: SizedBox(
                          key: ValueKey<String>(
                              'agent-row-${provider.providerId}'),
                          height: 68,
                          child: Row(
                            children: <Widget>[
                              SizedBox(
                                width: 40,
                                child: Center(
                                  child: ProviderLogo(
                                    providerId: provider.providerId,
                                    size: 30,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  provider.displayName,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium
                                      ?.copyWith(
                                        fontSize: 16.5,
                                        fontWeight: FontWeight.w600,
                                      ),
                                ),
                              ),
                              if (available)
                                _StatusSignal(
                                  state: provider.state,
                                  visual: providerVisual,
                                ),
                              const SizedBox(width: 8),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}

class _CenteredPage extends StatelessWidget {
  const _CenteredPage({required this.child, this.maxWidth = 840});

  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxWidth),
          child: SizedBox(width: double.infinity, child: child),
        ),
      );
}

RemoteSession? _activeSession(List<RemoteSession> sessions) {
  if (sessions.isEmpty) return null;
  return sessions.where((session) => session.state == 'working').firstOrNull ??
      sessions
          .where((session) =>
              session.state == 'needs_approval' ||
              session.state == 'needs_input')
          .firstOrNull;
}

final Expando<bool> _dashboardSessionRouteOpen =
    Expando<bool>('dashboard-session-route-open');

Future<void> _openSession(
    BuildContext context, RemoteAppStore store, RemoteSession session) async {
  final navigator = Navigator.of(context);
  if (_dashboardSessionRouteOpen[navigator] == true) return;
  _dashboardSessionRouteOpen[navigator] = true;
  try {
    unawaited(HapticFeedback.selectionClick());
    store.openSessionForView(session);
    if (context.mounted) {
      await navigator.push(sessionScreenRoute(session.id));
    }
  } finally {
    _dashboardSessionRouteOpen[navigator] = false;
  }
}

String _statusLabel(String state) {
  return switch (state) {
    'needs_approval' => 'Approval',
    'needs_input' => 'Input',
    'working' => 'Running',
    'idle' => 'Idle',
    'offline' || 'unavailable' => 'Offline',
    _ => state.isEmpty
        ? 'Unknown'
        : '${state[0].toUpperCase()}${state.substring(1)}',
  };
}

bool _hasMeaningfulSessionStatus(String state) =>
    state != 'idle' && state != 'unknown';

Color _statusColor(String state, ProviderVisualTheme visual) {
  return switch (state) {
    'online' => const Color(0xff78d795),
    'completed' => const Color(0xff78d795),
    'failed' => const Color(0xffff7469),
    'needs_approval' || 'needs_input' => const Color(0xffffb061),
    _ => visual.accent,
  };
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value.toLocal());
  if (difference.inSeconds < 60) return 'just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  if (difference.inDays == 1) return 'yesterday';
  return '${difference.inDays}d ago';
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
