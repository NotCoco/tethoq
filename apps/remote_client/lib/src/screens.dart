import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:image/image.dart' as image_lib;
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_theme.dart';
import 'desktop_wake_dialog.dart';
import 'dictation.dart';
import 'json.dart';
import 'models.dart';
import 'security.dart';
import 'store.dart';
import 'transport.dart';

class StoreScope extends InheritedNotifier<RemoteAppStore> {
  const StoreScope(
      {required RemoteAppStore store, required super.child, super.key})
      : super(notifier: store);

  static RemoteAppStore of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<StoreScope>();
    if (scope?.notifier == null) throw StateError('StoreScope is missing');
    return scope!.notifier!;
  }

  static RemoteAppStore read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<StoreScope>();
    if (scope?.notifier == null) throw StateError('StoreScope is missing');
    return scope!.notifier!;
  }
}

Route<void> sessionScreenRoute(String sessionId) => PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 85),
      reverseTransitionDuration: const Duration(milliseconds: 75),
      pageBuilder: (_, __, ___) => SessionScreen(sessionId: sessionId),
      transitionsBuilder: (_, animation, __, child) {
        final curved =
            CurvedAnimation(parent: animation, curve: Curves.easeOut);
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween<double>(begin: .992, end: 1).animate(curved),
            child: child,
          ),
        );
      },
    );

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key});

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  bool _submitting = false;
  String? _scanError;

  Future<void> _showPairingHelp() => showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        showDragHandle: true,
        builder: (sheetContext) => Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('Show a connection code on your computer',
                      style: Theme.of(sheetContext).textTheme.titleLarge),
                  const SizedBox(height: 10),
                  const Text(
                    'Tethoq connects once and uses the coding tools already '
                    'available on that computer.',
                  ),
                  const SizedBox(height: 20),
                  Text('Development setup',
                      style: Theme.of(sheetContext).textTheme.labelLarge),
                  const SizedBox(height: 8),
                  const Text(
                    'In the Tethoq project folder, run this command and leave '
                    'it open:',
                  ),
                  const SizedBox(height: 12),
                  const Divider(height: 1),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 14),
                    child: SelectableText(
                      'npm run phone:pair',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Divider(height: 1),
                  const SizedBox(height: 14),
                  const Text(
                    'Scan the code opened in your browser. If the browser does '
                    'not open, use the fallback code shown in the terminal.',
                  ),
                ],
              ),
            ),
          ),
        ),
      );

  Future<void> _scanAndPair(RemoteAppStore store) async {
    final result = await Navigator.of(context).push<ScannedPairingData>(
        MaterialPageRoute(builder: (_) => const PairingQrScannerScreen()));
    if (result == null || !mounted) return;
    PairingPayload payload;
    try {
      payload = PairingPayload.fromJson(jsonDecode(result.payloadText));
    } on Object {
      setState(() => _scanError =
          'That code is out of date. Create a new Tethoq connection code and scan it again.');
      return;
    }
    if (payload.shortCode == null || payload.shortCode!.isEmpty) {
      setState(() => _scanError =
          'That code is out of date. Create a new Tethoq connection code and scan it again.');
      return;
    }
    setState(() {
      _scanError = null;
      _submitting = true;
    });
    try {
      await store.pair(
        payloadText: result.payloadText,
        confirmedShortCode: payload.shortCode!,
        directUrl: result.directUrl,
      );
    } on Object {
      // The store exposes the actionable error below the scan button.
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final nested = Navigator.canPop(context);
    return Scaffold(
      appBar: nested ? AppBar(title: const Text('Connect computer')) : null,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            padding: EdgeInsets.symmetric(
                horizontal: MediaQuery.sizeOf(context).width < 600 ? 20 : 32,
                vertical: 24),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                  minHeight:
                      (constraints.maxHeight - 48).clamp(0, double.infinity)),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 620),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      if (!nested)
                        Text('Connect to your computer',
                            style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: 6),
                      Text(
                          'Scan the connection code created by Tethoq on your computer.',
                          style:
                              Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: .68),
                                  )),
                      const SizedBox(height: 16),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 190),
                          child: FilledButton.icon(
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(0, 52),
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 22),
                            ),
                            onPressed:
                                _submitting ? null : () => _scanAndPair(store),
                            icon: _submitting
                                ? const SizedBox.square(
                                    dimension: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2))
                                : const Icon(Icons.qr_code_scanner),
                            label: Text(
                                _submitting ? 'Connecting…' : 'Scan QR code'),
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          style: TextButton.styleFrom(
                            foregroundColor: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .58),
                          ),
                          onPressed: _showPairingHelp,
                          icon: const Icon(Icons.help_outline, size: 18),
                          label: const Text('Where do I find the code?'),
                        ),
                      ),
                      if (_scanError != null ||
                          store.error != null) ...<Widget>[
                        const SizedBox(height: 16),
                        Text(_scanError ?? store.error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class PairingQrScannerScreen extends StatefulWidget {
  const PairingQrScannerScreen({super.key});

  @override
  State<PairingQrScannerScreen> createState() => _PairingQrScannerScreenState();
}

class _PairingQrScannerScreenState extends State<PairingQrScannerScreen>
    with WidgetsBindingObserver {
  final MobileScannerController _controller = MobileScannerController(
    formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _returning = false;
  bool _resumeWhenForegrounded = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.detached:
        return;
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        _resumeWhenForegrounded =
            _resumeWhenForegrounded || _controller.value.isRunning;
        unawaited(_controller.stop());
      case AppLifecycleState.resumed:
        if (_resumeWhenForegrounded && !_returning) {
          _resumeWhenForegrounded = false;
          unawaited(_restartScanner());
        }
    }
  }

  Future<void> _restartScanner() async {
    try {
      await _controller.start();
    } on Object {
      if (mounted) {
        setState(() => _error =
            'The camera could not restart. Leave this screen and try again.');
      }
    }
  }

  Future<void> _handleCodexRemoteLink(String value) async {
    _returning = true;
    final wasRunning = _controller.value.isRunning;
    try {
      await _controller.stop();
    } on Object {
      // The dialog still prevents duplicate detections if the camera stop fails.
    }
    if (!mounted) return;

    final openInChatGpt = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('This connects the ChatGPT app, not Tethoq'),
        content: const Text(
          'Open it with ChatGPT for Codex Remote, or continue scanning for a '
          'Tethoq connection code.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Continue scanning'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Open in ChatGPT'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    setState(() {
      _returning = false;
      _error = null;
    });
    if (wasRunning) await _restartScanner();

    if (openInChatGpt == true) {
      try {
        final opened = await launchUrl(
          Uri.parse(value),
          mode: LaunchMode.externalApplication,
        );
        if (!opened && mounted) {
          setState(() =>
              _error = 'ChatGPT could not open. You can continue scanning.');
        }
      } on Object {
        if (mounted) {
          setState(() =>
              _error = 'ChatGPT could not open. You can continue scanning.');
        }
      }
    }
  }

  Future<void> _handleCapture(BarcodeCapture capture) async {
    if (_returning) return;
    final value = capture.barcodes
        .map((barcode) => barcode.rawValue)
        .whereType<String>()
        .firstOrNull;
    if (value == null) return;
    if (isOfficialCodexRemotePairingLink(value)) {
      await _handleCodexRemoteLink(value);
      return;
    }
    try {
      final result = ScannedPairingData.parse(value);
      _returning = true;
      await _controller.stop();
      if (mounted) Navigator.of(context).pop(result);
    } on FormatException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } on Object {
      if (mounted) {
        setState(() => _error = 'That is not a Tethoq connection code.');
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Scan QR code'),
          actions: <Widget>[
            IconButton(
              tooltip: 'Toggle flashlight',
              onPressed: _controller.toggleTorch,
              icon: const Icon(Icons.flashlight_on_outlined),
            ),
          ],
        ),
        body: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            MobileScanner(
              controller: _controller,
              onDetect: _handleCapture,
              errorBuilder: (_, __) => const Center(
                child: Padding(
                  padding: EdgeInsets.all(28),
                  child: Text(
                    'Allow camera access, then scan the Tethoq QR code.',
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
            ),
            IgnorePointer(
              child: Center(
                child: Container(
                  width: 270,
                  height: 270,
                  decoration: BoxDecoration(
                    border: Border.all(
                        color: Theme.of(context).colorScheme.primary, width: 3),
                    borderRadius: BorderRadius.circular(18),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 20,
              right: 20,
              bottom: MediaQuery.viewPaddingOf(context).bottom + 24,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface.withAlpha(235),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(
                    _error ??
                        'Hold the phone steady with the QR inside the frame.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _error == null
                          ? null
                          : Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
}

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key});

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  final _search = TextEditingController();
  bool _searchOpen = false;

  Future<void> _showFilters(RemoteAppStore store) async {
    final statuses = <(String?, String)>[
      (null, 'Any status'),
      ('working', 'Working'),
      ('needs_input', 'Needs input'),
      ('needs_approval', 'Needs approval'),
      ('idle', 'Idle'),
      ('completed', 'Completed'),
      ('failed', 'Failed'),
      ('disconnected', 'Disconnected'),
    ];
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: .86,
        child: StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            final usableProviders =
                store.providers.where(store.isProviderUsableForTasks).toList();
            void toggleProvider(String providerId) {
              store.toggleTaskProviderFilter(providerId);
              setSheetState(() {});
            }

            return ListView(
              key: const Key('task-filter-sheet'),
              padding: const EdgeInsets.only(bottom: 18),
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 2, 20, 8),
                  child: Text('Filter tasks',
                      style: Theme.of(sheetContext).textTheme.titleLarge),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 12, 2),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text('Agent',
                            style:
                                Theme.of(sheetContext).textTheme.labelMedium),
                      ),
                      if (store.hasProviderFilters)
                        TextButton(
                          key: const Key('clear-task-agent-filters'),
                          onPressed: () {
                            store.clearTaskProviderFilters();
                            setSheetState(() {});
                          },
                          child: const Text('Clear'),
                        ),
                    ],
                  ),
                ),
                ListTile(
                  key: const Key('task-filter-all-agents'),
                  leading: const Icon(Icons.all_inclusive_rounded, size: 22),
                  title: const Text('All agents'),
                  selected: !store.hasProviderFilters,
                  trailing: !store.hasProviderFilters
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () {
                    store.clearTaskProviderFilters();
                    Navigator.pop(sheetContext);
                  },
                ),
                _TaskProviderFilterTile(
                  key: const Key('task-filter-available-agents'),
                  filterId: availableAgentsTaskFilter,
                  title: 'Available agents',
                  leading: const Icon(Icons.done_all_rounded, size: 22),
                  selected: store
                      .taskProviderFilterSelected(availableAgentsTaskFilter),
                  enabled: usableProviders.isNotEmpty,
                  onSelect: () {
                    store.setTaskProviderFilter(availableAgentsTaskFilter);
                    Navigator.pop(sheetContext);
                  },
                  onToggle: () => toggleProvider(availableAgentsTaskFilter),
                ),
                ...store.providers.map((provider) {
                  final enabled = store.isProviderUsableForTasks(provider);
                  return _TaskProviderFilterTile(
                    key: ValueKey<String>(
                        'task-filter-agent-${provider.providerId}'),
                    filterId: provider.providerId,
                    title: provider.displayName,
                    leading:
                        ProviderLogo(providerId: provider.providerId, size: 22),
                    selected:
                        store.taskProviderFilterSelected(provider.providerId),
                    enabled: enabled,
                    onSelect: () {
                      store.setTaskProviderFilter(provider.providerId);
                      Navigator.pop(sheetContext);
                    },
                    onToggle: () => toggleProvider(provider.providerId),
                  );
                }),
                const Divider(height: 18),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                  child: Text('Status',
                      style: Theme.of(sheetContext).textTheme.labelMedium),
                ),
                ...statuses.map((entry) => ListTile(
                      title: Text(entry.$2),
                      trailing: store.stateFilter == entry.$1
                          ? const Icon(Icons.check_rounded)
                          : null,
                      onTap: () {
                        store.setTaskStateFilter(entry.$1);
                        Navigator.pop(sheetContext);
                      },
                    )),
              ],
            );
          },
        ),
      ),
    );
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final sessions = store.visibleSessions;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tasks'),
        actions: <Widget>[
          IconButton(
            key: const Key('task-search-toggle'),
            tooltip: _searchOpen ? 'Close task search' : 'Search tasks',
            onPressed: () {
              if (_searchOpen) {
                _search.clear();
                store.setTaskSearch('');
              }
              setState(() => _searchOpen = !_searchOpen);
            },
            icon:
                Icon(_searchOpen ? Icons.close_rounded : Icons.search_rounded),
          ),
          IconButton(
            key: const Key('task-filter-toggle'),
            tooltip: store.hasProviderFilters || store.stateFilter != null
                ? 'Task filters active'
                : 'Filter tasks',
            onPressed: () => unawaited(_showFilters(store)),
            icon: Badge(
              isLabelVisible:
                  store.hasProviderFilters || store.stateFilter != null,
              smallSize: 7,
              child: const Icon(Icons.tune_rounded),
            ),
          ),
          IconButton(
            key: const Key('new-task'),
            tooltip: 'New task',
            onPressed: store.providers.any((provider) =>
                    provider.detected && provider.capabilities.createSession)
                ? () => Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => const NewSessionScreen()))
                : null,
            icon: const Icon(Icons.add_rounded, size: 27),
          ),
        ],
      ),
      body: _AdaptivePage(
          maxWidth: 860,
          child: Column(
            children: <Widget>[
              _ConnectionBanner(
                  state: store.connectionState, error: store.error),
              if (_searchOpen)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
                  child: TextField(
                    key: const Key('session-search'),
                    controller: _search,
                    autofocus: true,
                    onChanged: store.setTaskSearch,
                    decoration: const InputDecoration(
                      hintText: 'Search tasks',
                      prefixIcon: Icon(Icons.search_rounded),
                      isDense: true,
                    ),
                  ),
                ),
              Expanded(
                child: sessions.isEmpty
                    ? const Center(child: Text('No tasks found'))
                    : RefreshIndicator(
                        onRefresh: store.refresh,
                        child: ListView.separated(
                          padding: const EdgeInsets.only(bottom: 24),
                          itemCount: sessions.length,
                          separatorBuilder: (_, __) => const Divider(
                              height: 1, indent: 54, endIndent: 12),
                          itemBuilder: (context, index) =>
                              _SessionTile(session: sessions[index]),
                        ),
                      ),
              ),
            ],
          )),
    );
  }
}

class _TaskProviderFilterTile extends StatelessWidget {
  const _TaskProviderFilterTile({
    required this.filterId,
    required this.title,
    required this.leading,
    required this.selected,
    required this.enabled,
    required this.onSelect,
    required this.onToggle,
    super.key,
  });

  final String filterId;
  final String title;
  final Widget leading;
  final bool selected;
  final bool enabled;
  final VoidCallback onSelect;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return Opacity(
      opacity: enabled ? 1 : .34,
      child: ListTile(
        enabled: enabled,
        selected: selected,
        leading: leading,
        title: Text(
          title,
          style: TextStyle(
            color: onSurface.withValues(alpha: enabled ? .96 : .58),
            fontWeight: enabled ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
        trailing: Semantics(
          container: true,
          button: true,
          checked: selected,
          enabled: enabled,
          label: '${selected ? 'Remove' : 'Add'} $title '
              '${selected ? 'from' : 'to'} custom filter',
          onTap: enabled ? onToggle : null,
          child: ExcludeSemantics(
            child: SizedBox.square(
              key: ValueKey<String>('task-filter-checkbox-$filterId'),
              dimension: 44,
              child: Center(
                child: Checkbox(
                  value: selected,
                  onChanged: enabled ? (_) => onToggle() : null,
                ),
              ),
            ),
          ),
        ),
        onTap: enabled ? onSelect : null,
      ),
    );
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({required this.session});

  final RemoteSession session;

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

class _SessionTileState extends State<_SessionTile> {
  bool _pressed = false;
  bool _branching = false;

  Future<void> _showTaskActions(
      RemoteAppStore store, RemoteSession session) async {
    if (_branching) return;
    setState(() => _pressed = false);
    final branch = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: SizedBox(
            height: 56,
            child: ListTile(
              key: ValueKey<String>('task-row-branch-${session.id}'),
              minLeadingWidth: 32,
              leading: const Icon(Icons.call_split_rounded),
              title: const Text('Branch in new task'),
              enabled: store.connectionState == BridgeConnectionState.online,
              onTap: store.connectionState == BridgeConnectionState.online
                  ? () => Navigator.pop(sheetContext, true)
                  : null,
            ),
          ),
        ),
      ),
    );
    if (!mounted || branch != true) return;
    setState(() => _branching = true);
    try {
      final created = (await store.branchSession(session.id)).session;
      if (!mounted) return;
      store.openSessionForView(created);
      setState(() => _branching = false);
      unawaited(Navigator.of(context).push(sessionScreenRoute(created.id)));
    } on Object catch (caught) {
      if (!mounted) return;
      final message = caught
          .toString()
          .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Could not create the new task: $message'),
      ));
    } finally {
      if (mounted && _branching) setState(() => _branching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final session = widget.session;
    final displayTitle = _sessionDisplayTitle(session);
    final visual = providerVisualThemeFor(session.providerId);
    final preview = session.preview == null ||
            session.preview == session.title ||
            session.preview == displayTitle
        ? session.project
        : session.preview;
    return Material(
      color:
          _pressed ? visual.accent.withValues(alpha: 0.10) : Colors.transparent,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _pressed = true),
        onTapCancel: () => setState(() => _pressed = false),
        child: InkWell(
          key: ValueKey<String>('session-row-${session.id}'),
          splashFactory: InkRipple.splashFactory,
          overlayColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.pressed)) {
              return visual.accent.withValues(alpha: 0.14);
            }
            if (states.contains(WidgetState.hovered)) {
              return visual.accent.withValues(alpha: 0.06);
            }
            return null;
          }),
          onTap: () {
            unawaited(HapticFeedback.selectionClick());
            store.openSessionForView(session);
            unawaited(
                Navigator.of(context).push(sessionScreenRoute(session.id)));
            Future<void>.delayed(const Duration(milliseconds: 90), () {
              if (mounted) setState(() => _pressed = false);
            });
          },
          onLongPress: _branching
              ? null
              : () {
                  unawaited(HapticFeedback.selectionClick());
                  unawaited(_showTaskActions(store, session));
                },
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 13, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _ProviderBadge(
                  key: ValueKey<String>('session-provider-${session.id}'),
                  providerId: session.providerId,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(displayTitle,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.copyWith(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                    )),
                          ),
                          SizedBox(
                            key: ValueKey<String>('session-time-${session.id}'),
                            width: 44,
                            child: Text(
                              _relativeTime(session.lastActivityAt.toLocal()),
                              textAlign: TextAlign.right,
                              style: Theme.of(context)
                                  .textTheme
                                  .bodySmall
                                  ?.copyWith(
                                    fontSize: 12.5,
                                    fontFeatures: const <FontFeature>[
                                      FontFeature.tabularFigures(),
                                    ],
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: .62),
                                  ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          SizedBox.square(
                            dimension: 24,
                            child: session.state == 'offline' ||
                                    session.state == 'disconnected'
                                ? null
                                : _InlineStateIndicator(
                                    key: ValueKey<String>(
                                        'session-state-${session.id}'),
                                    state: session.state,
                                    visual: visual,
                                  ),
                          ),
                        ],
                      ),
                      if (preview != null &&
                          preview.trim().isNotEmpty) ...<Widget>[
                        const SizedBox(height: 4),
                        Text(preview,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style:
                                Theme.of(context).textTheme.bodySmall?.copyWith(
                                      fontSize: 13,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: .78),
                                    )),
                      ],
                    ],
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

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    required this.sessionId,
    this.imageAttachmentPicker,
    this.dictationRecorder,
    super.key,
  });

  final String sessionId;
  final Future<RemoteAttachment?> Function()? imageAttachmentPicker;
  final DictationRecorder? dictationRecorder;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen>
    with WidgetsBindingObserver {
  final TextEditingController _composer = TextEditingController();
  final TextEditingController _preparedDirectory = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final Map<String, GlobalKey> _messageKeys = <String, GlobalKey>{};
  RemoteAppStore? _store;
  bool _draftLoaded = false;
  bool _sending = false;
  bool _stickToBottom = true;
  bool _scrollScheduled = false;
  bool _loadingOlderHistory = false;
  String? _historyLoadError;
  bool _meshSuggestionVisible = false;
  String? _modelProviderId;
  String? _selectedModelId;
  String? _selectedReasoningEffort;
  VisionProxySelection? _visionProxySelection;
  String? _deliveryMode;
  String? _imageModelNoticeId;
  String? _childSessionsLoadedFor;
  String? _contextLoadedFor;
  String? _walletLoadedFor;
  bool _sourceActionRunning = false;
  Timer? _childSessionPollTimer;
  Timer? _dictationTimer;
  late final DictationRecorder _dictationRecorder;
  DateTime? _dictationStartedAt;
  Duration _dictationElapsed = Duration.zero;
  bool _recordingDictation = false;
  bool _transcribingDictation = false;
  String? _activeDictationSourceId;
  final List<RemoteAttachment> _attachments = <RemoteAttachment>[];
  final List<DelegationSelection> _meshTargets = <DelegationSelection>[];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _dictationRecorder =
        widget.dictationRecorder ?? MicrophoneDictationRecorder();
    _scrollController.addListener(_updateStickToBottom);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.of(context);
    if (!identical(_store, store)) {
      _store = store;
      store.setVisibleSession(widget.sessionId);
    }
    if (!_draftLoaded) {
      _composer.text = store.drafts[widget.sessionId] ?? '';
      _meshSuggestionVisible = _shouldShowMeshSuggestion(_composer.text);
      _deliveryMode = store.defaultDeliveryMode;
      _draftLoaded = true;
    }
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    if (session != null && _modelProviderId != session.providerId) {
      _modelProviderId = session.providerId;
      _selectedModelId = session.modelId;
      _selectedReasoningEffort = session.reasoningEffort;
      _visionProxySelection = store.visionBySession[session.id]?.configured;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _modelProviderId != session.providerId) return;
        unawaited(store.loadVisionProxy(session.id).then((status) {
          if (mounted)
            setState(() => _visionProxySelection = status.configured);
        }).catchError((Object _) {}));
      });
      if (store.isPreparedSession(session.id)) {
        _preparedDirectory.text = session.workingDirectory ?? '';
      }
      if (_supportsTurnModelSelection(session.providerId)) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _modelProviderId != session.providerId) return;
          unawaited(store.loadModels(session.providerId).then((models) {
            if (!mounted || _modelProviderId != session.providerId) return;
            final configured = models
                .where((model) => model.id == _selectedModelId)
                .firstOrNull;
            final initialModel = configured ??
                models.where((model) => model.isDefault).firstOrNull ??
                models.firstOrNull;
            if (store.isPreparedSession(session.id) && initialModel != null) {
              _selectedModelId ??= initialModel.id;
              _selectedReasoningEffort ??= initialModel.defaultReasoningEffort;
            }
            if (_attachments.isNotEmpty) {
              _maybeShowImageModelNotice(initialModel);
            } else {
              setState(() {});
            }
          }));
        });
      }
    } else if (session?.state == 'working') {
      _selectedModelId = session?.modelId;
      _selectedReasoningEffort = session?.reasoningEffort;
    }
    if (session != null &&
        !store.isPreparedSession(session.id) &&
        _contextLoadedFor != session.id) {
      _contextLoadedFor = session.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _contextLoadedFor != session.id) return;
        unawaited(() async {
          try {
            await store.loadSessionContext(session.id);
          } on Object {
            // Some harnesses do not expose usage. The touch control remains
            // available and explains that state without interrupting chat.
          }
        }());
      });
    }
    if (session != null) _configureChildSessionMonitoring(store, session);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _childSessionPollTimer?.cancel();
    _dictationTimer?.cancel();
    if (_recordingDictation) unawaited(_dictationRecorder.cancel());
    unawaited(_dictationRecorder.dispose());
    _store?.setVisibleSession(null);
    _store?.discardPreparedSession(widget.sessionId);
    _scrollController
      ..removeListener(_updateStickToBottom)
      ..dispose();
    _composer.dispose();
    _preparedDirectory.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      return;
    }
    final store = _store;
    if (!mounted || store == null) return;
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    if (session != null) _configureChildSessionMonitoring(store, session);
  }

  Future<void> _toggleDictation() async {
    if (_transcribingDictation) return;
    if (_recordingDictation) {
      await _finishDictation();
      return;
    }
    final store = StoreScope.of(context);
    final harnessId = _dictationHarnessId(store);
    var source = store.dictationSourceForHarness(harnessId);
    if (source == null) {
      source = await _showDictationSourcePicker(store, harnessId);
      if (source == null) return;
    } else if (store.preferredDictationSourceIdForHarness(harnessId) == null) {
      try {
        await store.setDictationSourceForHarness(harnessId, source.id);
      } on Object catch (caught) {
        if (mounted) _showDictationError(caught);
        return;
      }
    }
    _activeDictationSourceId = source.id;
    try {
      final permitted = await _dictationRecorder.start();
      if (!mounted) return;
      if (!permitted) {
        _activeDictationSourceId = null;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Microphone permission is needed for dictation.'),
        ));
        return;
      }
      _dictationStartedAt = DateTime.now();
      setState(() {
        _dictationElapsed = Duration.zero;
        _recordingDictation = true;
      });
      _dictationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted || !_recordingDictation) return;
        final elapsed = DateTime.now().difference(_dictationStartedAt!);
        if (elapsed >= const Duration(seconds: 30)) {
          unawaited(_finishDictation());
        } else {
          setState(() => _dictationElapsed = elapsed);
        }
      });
    } on Object catch (caught) {
      _activeDictationSourceId = null;
      if (mounted) _showDictationError(caught);
    }
  }

  String _dictationHarnessId(RemoteAppStore store) =>
      store.sessions
          .where((item) => item.id == widget.sessionId)
          .firstOrNull
          ?.providerId ??
      store.selectedProviderId;

  String _dictationLogoProviderId(TranscriptionSource source) {
    final identity = '${source.id} ${source.label}'.toLowerCase();
    if (identity.contains('xai') || identity.contains('grok')) return 'grok';
    if (identity.contains('openai') || identity.contains('codex')) {
      return 'codex';
    }
    return 'all';
  }

  Future<TranscriptionSource?> _showDictationSourcePicker(
      RemoteAppStore store, String harnessId) async {
    final preferredId = store.preferredDictationSourceIdForHarness(harnessId) ??
        store.dictationSourceForHarness(harnessId)?.id;
    final harnessName = providerVisualThemeFor(harnessId).displayName;
    final sourceId = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Dictation source',
                style: Theme.of(sheetContext).textTheme.titleMedium,
              ),
              const SizedBox(height: 3),
              Text(
                'Choose the service $harnessName uses for voice input.',
                style: Theme.of(sheetContext).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              if (store.dictationSources.isEmpty)
                Container(
                  key: const Key('dictation-source-empty'),
                  width: double.infinity,
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Theme.of(sheetContext)
                        .colorScheme
                        .surfaceContainerHighest
                        .withValues(alpha: 0.45),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Text(
                    'No dictation services were reported by this computer. '
                    'Add an OpenAI or xAI API credential in Tethoq Bridge.',
                  ),
                )
              else
                ...store.dictationSources.map((source) {
                  final ready = store.isDictationSourceReady(source);
                  final selected = preferredId == source.id;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Material(
                      color: selected
                          ? Theme.of(sheetContext)
                              .colorScheme
                              .primary
                              .withValues(alpha: 0.1)
                          : Theme.of(sheetContext)
                              .colorScheme
                              .surfaceContainerHighest
                              .withValues(alpha: 0.35),
                      borderRadius: BorderRadius.circular(12),
                      child: InkWell(
                        key: Key('dictation-source-option-${source.id}'),
                        borderRadius: BorderRadius.circular(12),
                        onTap: ready
                            ? () => Navigator.pop(sheetContext, source.id)
                            : null,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 10),
                          child: Row(
                            children: <Widget>[
                              ClipOval(
                                child: Container(
                                  width: 38,
                                  height: 38,
                                  alignment: Alignment.center,
                                  color: Theme.of(sheetContext)
                                      .colorScheme
                                      .surface,
                                  child: ProviderLogo(
                                    providerId:
                                        _dictationLogoProviderId(source),
                                    size: 24,
                                    semanticLabel: '${source.label} logo',
                                  ),
                                ),
                              ),
                              const SizedBox(width: 11),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    Text(
                                      source.label,
                                      style: Theme.of(sheetContext)
                                          .textTheme
                                          .bodyLarge
                                          ?.copyWith(
                                            fontWeight: FontWeight.w600,
                                            color: ready
                                                ? null
                                                : Theme.of(sheetContext)
                                                    .disabledColor,
                                          ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      ready
                                          ? 'Ready on Tethoq Bridge'
                                          : 'API credential needed in Tethoq Bridge · ${source.setupEnvironmentVariable}',
                                      style: Theme.of(sheetContext)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(
                                            color: ready
                                                ? Theme.of(sheetContext)
                                                    .colorScheme
                                                    .onSurfaceVariant
                                                : Theme.of(sheetContext)
                                                    .disabledColor,
                                          ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              Icon(
                                selected
                                    ? Icons.check_circle_rounded
                                    : ready
                                        ? Icons.circle_outlined
                                        : Icons.lock_outline_rounded,
                                size: 21,
                                color: selected
                                    ? Theme.of(sheetContext).colorScheme.primary
                                    : ready
                                        ? Theme.of(sheetContext)
                                            .colorScheme
                                            .onSurfaceVariant
                                        : Theme.of(sheetContext).disabledColor,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
    if (!mounted || sourceId == null) return null;
    try {
      await store.setDictationSourceForHarness(harnessId, sourceId);
    } on Object catch (caught) {
      if (mounted) _showDictationError(caught);
      return null;
    }
    return store.dictationSources
        .where((source) => source.id == sourceId)
        .firstOrNull;
  }

  Future<void> _openDictationSourcePicker() async {
    if (_recordingDictation || _transcribingDictation) return;
    final store = StoreScope.of(context);
    await _showDictationSourcePicker(store, _dictationHarnessId(store));
  }

  Future<void> _finishDictation() async {
    if (!_recordingDictation || _transcribingDictation) return;
    _dictationTimer?.cancel();
    _dictationTimer = null;
    setState(() {
      _recordingDictation = false;
      _transcribingDictation = true;
    });
    try {
      final waveBytes = await _dictationRecorder.stop();
      if (!mounted) return;
      final transcript = await StoreScope.of(context).transcribeDictation(
        waveBytes,
        sourceId: _activeDictationSourceId,
      );
      if (!mounted || transcript.isEmpty) return;
      _insertTranscript(transcript);
    } on Object catch (caught) {
      if (mounted) _showDictationError(caught);
    } finally {
      _activeDictationSourceId = null;
      if (mounted) setState(() => _transcribingDictation = false);
    }
  }

  void _insertTranscript(String transcript) {
    final current = _composer.value;
    final selection = current.selection.isValid
        ? current.selection
        : TextSelection.collapsed(offset: current.text.length);
    final start = selection.start.clamp(0, current.text.length);
    final end = selection.end.clamp(0, current.text.length);
    final before = current.text.substring(0, start);
    final after = current.text.substring(end);
    final leadingSpace = before.isNotEmpty &&
            !RegExp(r'\s$').hasMatch(before) &&
            !RegExp(r'^\s').hasMatch(transcript)
        ? ' '
        : '';
    final trailingSpace = after.isNotEmpty &&
            !RegExp(r'^\s').hasMatch(after) &&
            !RegExp(r'\s$').hasMatch(transcript)
        ? ' '
        : '';
    final inserted = '$leadingSpace$transcript$trailingSpace';
    final text = '$before$inserted$after';
    _composer.value = TextEditingValue(
      text: text,
      selection:
          TextSelection.collapsed(offset: before.length + inserted.length),
    );
    StoreScope.of(context).setDraft(widget.sessionId, text);
    setState(() {
      _meshSuggestionVisible = _shouldShowMeshSuggestion(text);
    });
  }

  void _showDictationError(Object caught) {
    final message = caught
        .toString()
        .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  String get _dictationHint {
    if (_transcribingDictation) return 'Transcribing…';
    if (!_recordingDictation) return 'Continue the session…';
    final seconds = _dictationElapsed.inSeconds;
    return 'Listening… 0:${seconds.toString().padLeft(2, '0')}';
  }

  void _configureChildSessionMonitoring(
      RemoteAppStore store, RemoteSession session) {
    final lifecycleState = WidgetsBinding.instance.lifecycleState;
    if ((lifecycleState != null &&
            lifecycleState != AppLifecycleState.resumed) ||
        ModalRoute.of(context)?.isCurrent == false) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      return;
    }
    final hasMeshDelegations = store.delegationsFor(session.id).isNotEmpty;
    if (!store.providerSupportsSessionRelationships(session.providerId) &&
        !hasMeshDelegations) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      return;
    }
    if (_childSessionsLoadedFor != session.id) {
      _childSessionsLoadedFor = session.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _childSessionsLoadedFor != session.id) return;
        unawaited(store
            .loadChildSessions(session.id)
            .catchError((Object _) => store.childSessionsFor(session.id)));
      });
    }
    final meshActive = store
        .delegationsFor(session.id)
        .any((task) => task.state != 'completed' && task.state != 'failed');
    if (session.state == 'working' || meshActive) {
      _childSessionPollTimer ??=
          Timer.periodic(const Duration(seconds: 4), (_) {
        if (!mounted ||
            WidgetsBinding.instance.lifecycleState !=
                AppLifecycleState.resumed ||
            ModalRoute.of(context)?.isCurrent == false) {
          return;
        }
        final current = store.sessions
            .where((item) => item.id == widget.sessionId)
            .firstOrNull;
        final currentMeshActive = store
            .delegationsFor(widget.sessionId)
            .any((task) => task.state != 'completed' && task.state != 'failed');
        if (current?.state != 'working' && !currentMeshActive) {
          _childSessionPollTimer?.cancel();
          _childSessionPollTimer = null;
          return;
        }
        unawaited(store.loadChildSessions(widget.sessionId).catchError(
            (Object _) => store.childSessionsFor(widget.sessionId)));
      });
    } else {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
    }
  }

  bool _shouldShowMeshSuggestion(String value) {
    if (_meshTargets.isNotEmpty) return false;
    final text = value.trim();
    if (text.contains(RegExp(r'\s'))) return false;
    return text.length >= 4 && '/mesh'.startsWith(text.toLowerCase());
  }

  Future<void> _activateMesh() async {
    _composer.clear();
    StoreScope.of(context).setDraft(widget.sessionId, '');
    setState(() => _meshSuggestionVisible = false);
    await _addMeshTarget();
  }

  Future<void> _addMeshTarget() async {
    final store = StoreScope.of(context);
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    if (session == null) return;
    final selectedProviders =
        _meshTargets.map((item) => item.providerId).toSet();
    final available = store.providers
        .where((provider) =>
            provider.providerId != session.providerId &&
            !selectedProviders.contains(provider.providerId) &&
            provider.detected &&
            provider.state == 'online' &&
            provider.authenticated != false)
        .toList(growable: false);
    if (available.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No other connected harness is available for /mesh.'),
        ));
      }
      return;
    }
    final provider = await showModalBottomSheet<ProviderConnection>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
              child: Text('Delegate with /mesh',
                  style: Theme.of(sheetContext).textTheme.titleMedium),
            ),
            ...available.map((item) => ListTile(
                  leading: ProviderLogo(providerId: item.providerId, size: 30),
                  title: Text(item.displayName),
                  subtitle: const Text('Create a real child session'),
                  onTap: () => Navigator.pop(sheetContext, item),
                )),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted || provider == null) return;
    final models = _supportsTurnModelSelection(provider.providerId)
        ? await store.loadModels(provider.providerId)
        : const <RemoteModel>[];
    if (!mounted) return;
    final remembered = store.delegationPreferences[provider.providerId];
    final model =
        models.where((item) => item.id == remembered?.modelId).firstOrNull ??
            models.where((item) => item.isDefault).firstOrNull ??
            models.firstOrNull;
    final efforts = model?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    final rememberedEffort = efforts
            .where((item) => item.id == remembered?.reasoningEffort)
            .firstOrNull
            ?.id ??
        model?.defaultReasoningEffort ??
        efforts.firstOrNull?.id;
    setState(() => _meshTargets.add(DelegationSelection(
          providerId: provider.providerId,
          modelId: model?.id,
          reasoningEffort: rememberedEffort,
        )));
  }

  Future<void> _editMeshTarget(int index) async {
    final store = StoreScope.of(context);
    final target = _meshTargets[index];
    final models = _supportsTurnModelSelection(target.providerId)
        ? await store.loadModels(target.providerId)
        : const <RemoteModel>[];
    if (!mounted) return;
    final selectedModelId = await showModalBottomSheet<String>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.72),
          child: ListView(
            shrinkWrap: true,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
                child: Text('Model',
                    style: Theme.of(sheetContext).textTheme.titleMedium),
              ),
              if (models.isEmpty)
                ListTile(
                  title: const Text('Harness default'),
                  trailing: const Icon(Icons.check_rounded),
                  onTap: () => Navigator.pop(sheetContext, ''),
                )
              else
                ...models.map((model) => ListTile(
                      selected: model.id == target.modelId,
                      title: Text(model.displayName),
                      subtitle: model.description == null
                          ? null
                          : Text(model.description!, maxLines: 2),
                      trailing: model.id == target.modelId
                          ? const Icon(Icons.check_rounded)
                          : model.isDefault
                              ? const Text('Default')
                              : null,
                      onTap: () => Navigator.pop(sheetContext, model.id),
                    )),
            ],
          ),
        ),
      ),
    );
    if (!mounted || selectedModelId == null) return;
    final model =
        models.where((item) => item.id == selectedModelId).firstOrNull;
    final efforts = model?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    String? effort = model?.defaultReasoningEffort;
    if (efforts.isNotEmpty) {
      effort = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        builder: (sheetContext) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                title: const Text('Reasoning effort'),
                subtitle: Text(model?.displayName ?? 'Harness default'),
              ),
              ...efforts.map((option) => ListTile(
                    selected: option.id == target.reasoningEffort,
                    title: Text(_effortDisplayLabel(option.id, model?.id)),
                    onTap: () => Navigator.pop(sheetContext, option.id),
                  )),
            ],
          ),
        ),
      );
      if (!mounted || effort == null) return;
    }
    setState(() => _meshTargets[index] = DelegationSelection(
          providerId: target.providerId,
          modelId: model?.id,
          reasoningEffort: effort,
        ));
  }

  void _updateStickToBottom() {
    if (!_scrollController.hasClients) return;
    if (_scrollController.position.pixels < 96 && !_loadingOlderHistory) {
      unawaited(_loadOlderHistory());
    }
    _stickToBottom = _scrollController.position.maxScrollExtent -
            _scrollController.position.pixels <
        96;
  }

  Future<void> _loadOlderHistory() async {
    final store = _store;
    if (store == null || !store.hasOlderHistory(widget.sessionId)) return;
    _loadingOlderHistory = true;
    _stickToBottom = false;
    if (_historyLoadError != null && mounted) {
      setState(() => _historyLoadError = null);
    }
    // A jump to the top can notify before the newly visible message widgets
    // have been laid out. Wait for that layout so the first retained message
    // can be used as a stable visual anchor while older messages are prepended.
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) {
      _loadingOlderHistory = false;
      return;
    }
    final before = _scrollController.hasClients
        ? _scrollController.position.maxScrollExtent
        : 0.0;
    final anchorId = store.messages[widget.sessionId]?.firstOrNull?.id;
    final anchorKey = anchorId == null ? null : _messageKeys[anchorId];
    final anchorBox = anchorKey?.currentContext?.findRenderObject();
    final anchorTop = anchorBox is RenderBox && anchorBox.attached
        ? anchorBox.localToGlobal(Offset.zero).dy
        : null;
    try {
      final added = await store.loadOlderSessionHistory(widget.sessionId);
      if (!mounted || !added) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scrollController.hasClients) return;
        final delta = _scrollController.position.maxScrollExtent - before;
        final movedAnchor = anchorKey?.currentContext?.findRenderObject();
        final anchorDelta = anchorTop != null &&
                movedAnchor is RenderBox &&
                movedAnchor.attached
            ? movedAnchor.localToGlobal(Offset.zero).dy - anchorTop
            : null;
        _scrollController.jumpTo(
            (_scrollController.position.pixels + (anchorDelta ?? delta))
                .clamp(0.0, _scrollController.position.maxScrollExtent));
      });
    } on Object catch (caught) {
      if (mounted) {
        setState(() => _historyLoadError = caught
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), ''));
      }
    } finally {
      _loadingOlderHistory = false;
    }
  }

  void _scheduleScrollToBottom() {
    if (!_stickToBottom || _loadingOlderHistory || _scrollScheduled) return;
    _scrollScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollScheduled = false;
      if (!mounted || !_stickToBottom || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  Future<void> _pickImageAttachment() async {
    if (widget.imageAttachmentPicker != null) {
      final attachment = await widget.imageAttachmentPicker!();
      if (!mounted || attachment == null) return;
      _setPendingAttachment(attachment);
      return;
    }
    final file = await openFile(
      acceptedTypeGroups: const <XTypeGroup>[
        XTypeGroup(
          label: 'Images',
          extensions: <String>['jpg', 'jpeg', 'png', 'gif', 'webp'],
          mimeTypes: <String>['image/*'],
          uniformTypeIdentifiers: <String>['public.image'],
        ),
      ],
    );
    if (!mounted || file == null) return;
    try {
      final source = await file.readAsBytes();
      final prepared = source.length <= _maxPhoneAttachmentBytes
          ? source
          : await compute(_prepareRemoteImage, source);
      if (!mounted) return;
      if (prepared == null) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'That image could not be prepared under the 25 MiB transfer limit.'),
        ));
        return;
      }
      final stem = file.name.replaceFirst(RegExp(r'\.[^.]+$'), '');
      final converted = !identical(prepared, source);
      final dataBase64 = await compute(_encodeBase64, prepared);
      if (!mounted) return;
      _setPendingAttachment(RemoteAttachment(
        name:
            converted ? '${stem.isEmpty ? 'attachment' : stem}.jpg' : file.name,
        mimeType: converted ? 'image/jpeg' : _imageMimeType(file.name),
        dataBase64: dataBase64,
        byteLength: prepared.length,
      ));
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('That image could not be opened.')));
    }
  }

  Future<void> _pickFileAttachment() async {
    final file = await openFile();
    if (!mounted || file == null) return;
    try {
      final byteLength = await file.length();
      if (!mounted) return;
      if (!_isValidPhoneAttachmentLength(byteLength)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Files must be between 1 byte and 25 MiB.'),
        ));
        return;
      }
      final bytes = await file.readAsBytes();
      if (!mounted) return;
      if (!_isValidPhoneAttachmentLength(bytes.length)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Files must be between 1 byte and 25 MiB.'),
        ));
        return;
      }
      final dataBase64 = await compute(_encodeBase64, bytes);
      if (!mounted) return;
      _setPendingAttachment(RemoteAttachment(
        name: file.name,
        mimeType: _genericMimeType(file.name),
        dataBase64: dataBase64,
        byteLength: bytes.length,
      ));
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('That file could not be opened.')));
    }
  }

  void _setPendingAttachment(RemoteAttachment attachment) {
    setState(() {
      _attachments
        ..clear()
        ..add(attachment);
    });
    final store = StoreScope.of(context);
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    final model = session == null
        ? null
        : (store.modelsByProvider[session.providerId] ?? const <RemoteModel>[])
            .where((item) => item.id == _selectedModelId)
            .firstOrNull;
    _maybeShowImageModelNotice(model);
  }

  void _maybeShowImageModelNotice(RemoteModel? model) {
    if (!mounted ||
        _attachments.isEmpty ||
        model?.supportsImageInput != false) {
      return;
    }
    final store = StoreScope.of(context);
    if (store.isImageModelNoticeDismissed(model!.providerId, model.id)) return;
    setState(() => _imageModelNoticeId = model.id);
  }

  Future<void> _showAttachmentMenu() async {
    final store = StoreScope.of(context);
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    final supportsFiles =
        session != null && _supportsGenericFileAttachments(session.providerId);
    await showModalBottomSheet<void>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.image_outlined),
              title: const Text('Photo or image'),
              subtitle:
                  const Text('Choose from this phone or device · up to 25 MiB'),
              onTap: () {
                Navigator.pop(sheetContext);
                unawaited(_pickImageAttachment());
              },
            ),
            Divider(
              height: 1,
              indent: 56,
              endIndent: 16,
              color: Theme.of(sheetContext)
                  .colorScheme
                  .onSurface
                  .withValues(alpha: 0.11),
            ),
            ListTile(
              leading: const Icon(Icons.attach_file_rounded),
              title: const Text('File'),
              subtitle: Text(supportsFiles
                  ? 'Transferred securely in phone-safe chunks · up to 25 MiB'
                  : 'This harness currently accepts images only'),
              enabled: supportsFiles,
              onTap: supportsFiles
                  ? () {
                      Navigator.pop(sheetContext);
                      unawaited(_pickFileAttachment());
                    }
                  : null,
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> _showChildSessions() async {
    await showModalBottomSheet<void>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) {
        final store = StoreScope.of(sheetContext);
        final children = store.childSessionsFor(widget.sessionId);
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.72,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                  child: Text(
                    'Agents',
                    style: Theme.of(sheetContext).textTheme.titleMedium,
                  ),
                ),
                if (children.isEmpty)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(18, 8, 18, 22),
                    child: Text('No child agents are loaded yet.'),
                  )
                else
                  Flexible(
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: children.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final child = children[index];
                        final name = child.agentNickname ?? child.title;
                        final details = <String>[
                          if (child.agentRole?.trim().isNotEmpty == true)
                            child.agentRole!,
                          _titleCase(child.state),
                        ];
                        return ListTile(
                          key: ValueKey<String>('child-agent-${child.id}'),
                          dense: true,
                          leading: _AgentStateIcon(state: child.state),
                          title: Text(name,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(details.join(' · '),
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          trailing: TextButton(
                            key: ValueKey<String>(
                                'view-child-agent-${child.id}'),
                            onPressed: () async {
                              store.openSessionForView(child);
                              if (!sheetContext.mounted || !mounted) return;
                              Navigator.pop(sheetContext);
                              await Navigator.of(this.context).push(
                                MaterialPageRoute<void>(
                                  builder: (_) =>
                                      SessionScreen(sessionId: child.id),
                                ),
                              );
                            },
                            child: const Text('View'),
                          ),
                        );
                      },
                    ),
                  ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _chooseModel(
      List<RemoteModel> models, ProviderVisualTheme visual) async {
    if (models.isEmpty) return;
    final store = StoreScope.of(context);
    final catalog = await store.loadModelCatalog();
    if (!mounted) return;
    final prepared = store.isPreparedSession(widget.sessionId);
    final currentProviderId = _modelProviderId ?? models.first.providerId;
    final fullCatalog = catalog.isEmpty ? models : catalog;
    final available = prepared
        ? fullCatalog
        : fullCatalog
            .where((model) => model.providerId == currentProviderId)
            .toList(growable: false);
    if (available.isEmpty) return;
    final selected = await showModalBottomSheet<_ModelChoice>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 760),
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: .94,
        child: _ModelPickerSheet(
          models: available,
          recentModels: store.recentModels(available),
          currentProviderId: currentProviderId,
          selectedModelId: _selectedModelId,
          visual: visual,
        ),
      ),
    );
    if (!mounted || selected == null) return;
    final model = available.firstWhere((item) =>
        item.providerId == selected.providerId && item.id == selected.modelId);
    if (prepared && model.providerId != currentProviderId) {
      store.updatePreparedProvider(widget.sessionId, model.providerId);
    }
    setState(() {
      _modelProviderId = model.providerId;
      _selectedModelId = model.id;
      _selectedReasoningEffort = null;
      _imageModelNoticeId = null;
    });
    store.rememberModelSelection(model.providerId, model.id);
    _walletLoadedFor = '${model.providerId}\u0000${model.id}';
    unawaited(store.loadWallet(model.providerId, modelId: model.id));
    _maybeShowImageModelNotice(model);
  }

  Future<void> _showTaskDetails(
      RemoteSession session, ProviderVisualTheme visual) async {
    final directory =
        session.workingDirectory ?? session.project ?? session.hostId;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('Task details',
                style: Theme.of(sheetContext).textTheme.titleLarge),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                ProviderLogo(providerId: session.providerId, size: 22),
                const SizedBox(width: 10),
                Text(providerVisualThemeFor(session.providerId).displayName,
                    style: Theme.of(sheetContext).textTheme.bodyLarge),
              ],
            ),
            if (session.modelId != null) ...<Widget>[
              const SizedBox(height: 14),
              Text(session.modelId!,
                  style: Theme.of(sheetContext).textTheme.bodyMedium),
            ],
            const SizedBox(height: 14),
            Text('Working directory',
                style: Theme.of(sheetContext).textTheme.labelMedium?.copyWith(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .62),
                    )),
            const SizedBox(height: 5),
            SingleChildScrollView(
              key: const Key('working-directory-scroll'),
              scrollDirection: Axis.horizontal,
              child: SelectableText(directory,
                  style: Theme.of(sheetContext)
                      .textTheme
                      .bodyMedium
                      ?.copyWith(fontFamily: 'monospace')),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _chooseReasoningEffort(
      List<ReasoningEffortOption> efforts, String? modelId) async {
    if (efforts.isEmpty) return;
    final selected = await showModalBottomSheet<String>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 2, 20, 10),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Reasoning effort',
                    style: Theme.of(context).textTheme.titleMedium),
              ),
            ),
            ...efforts.map((effort) => ListTile(
                  selected: effort.id == _selectedReasoningEffort,
                  title: Text(_effortDisplayLabel(effort.id, modelId)),
                  subtitle: effort.description == null
                      ? null
                      : Text(effort.description!),
                  trailing: effort.id == _selectedReasoningEffort
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () => Navigator.pop(context, effort.id),
                )),
          ],
        ),
      ),
    );
    if (!mounted || selected == null) return;
    setState(() => _selectedReasoningEffort = selected);
  }

  Future<void> _chooseVisionProxy() async {
    final store = StoreScope.of(context);
    final targets = await store.loadVisionProxyTargets();
    if (!mounted) return;
    if (targets.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('No image-capable visual support model is available.'),
      ));
      return;
    }
    final choices = targets
        .expand((target) => target.models.map((model) => (
              target: target,
              model: model,
            )))
        .toList(growable: false);
    final selected = await showModalBottomSheet<VisionProxySelection?>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: <Widget>[
            const ListTile(
              title: Text('Visual support'),
              subtitle: Text(
                  'Choose the model that will inspect images for this session.'),
            ),
            if (_visionProxySelection != null)
              ListTile(
                leading: const Icon(Icons.visibility_off_outlined),
                title: const Text('Disable visual support'),
                onTap: () => Navigator.pop(sheetContext,
                    const VisionProxySelection(providerId: '', modelId: '')),
              ),
            ...choices.map((choice) => ListTile(
                  key: ValueKey<String>(
                      'vision-model-${choice.target.providerId}-${choice.model.id}'),
                  leading: ProviderLogo(
                      providerId: choice.target.providerId, size: 30),
                  title: Text(choice.model.displayName),
                  subtitle: Text(choice.target.displayName),
                  selected: _visionProxySelection?.providerId ==
                          choice.target.providerId &&
                      _visionProxySelection?.modelId == choice.model.id,
                  onTap: () => Navigator.pop(
                      sheetContext,
                      VisionProxySelection(
                        providerId: choice.target.providerId,
                        modelId: choice.model.id,
                        reasoningEffort: choice.model.defaultReasoningEffort,
                      )),
                )),
          ],
        ),
      ),
    );
    if (!mounted || selected == null) return;
    VisionProxySelection? configured =
        selected.providerId.isEmpty ? null : selected;
    if (configured != null) {
      final choice = choices
          .where((item) =>
              item.target.providerId == configured!.providerId &&
              item.model.id == configured.modelId)
          .firstOrNull;
      final efforts =
          choice?.model.reasoningEfforts ?? const <ReasoningEffortOption>[];
      if (choice != null && efforts.isNotEmpty) {
        final currentEffort =
            _visionProxySelection?.providerId == configured.providerId &&
                    _visionProxySelection?.modelId == configured.modelId
                ? _visionProxySelection?.reasoningEffort
                : choice.model.defaultReasoningEffort;
        final effort = await showModalBottomSheet<String>(
          context: context,
          constraints: const BoxConstraints(maxWidth: 640),
          showDragHandle: true,
          builder: (sheetContext) => SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                ListTile(
                  title: const Text('Reasoning effort'),
                  subtitle: Text(choice.model.displayName),
                ),
                ...efforts.map((option) => ListTile(
                      key: ValueKey<String>('vision-effort-${option.id}'),
                      selected: option.id == currentEffort,
                      title:
                          Text(_effortDisplayLabel(option.id, choice.model.id)),
                      onTap: () => Navigator.pop(sheetContext, option.id),
                    )),
              ],
            ),
          ),
        );
        if (!mounted || effort == null) return;
        configured = VisionProxySelection(
          providerId: configured.providerId,
          modelId: configured.modelId,
          reasoningEffort: effort,
        );
      }
    }
    await store.configureVisionProxy(widget.sessionId, configured);
    if (mounted) setState(() => _visionProxySelection = configured);
  }

  Future<void> _chooseDeliveryMode(
      {required bool steeringSupported,
      required bool steeringAvailable}) async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const ListTile(
              title: Text('Send behavior'),
              subtitle: Text('Choose how this instruction joins the task.'),
            ),
            ListTile(
              key: const Key('delivery-option-queue'),
              leading: const Icon(Icons.schedule_send_outlined),
              title: const Text('Queue'),
              subtitle: const Text('Run it next after the current work.'),
              trailing: _deliveryMode != 'steer'
                  ? const Icon(Icons.check_rounded)
                  : null,
              onTap: () => Navigator.pop(context, 'queue'),
            ),
            ListTile(
              key: const Key('delivery-option-steer'),
              leading: const Icon(Icons.alt_route_rounded),
              title: const Text('Steer'),
              subtitle: Text(!steeringSupported
                  ? 'This harness does not support live steering.'
                  : steeringAvailable
                      ? 'Add direction to the work that is running now.'
                      : 'Available while this session is actively working.'),
              enabled: steeringAvailable,
              trailing: steeringAvailable && _deliveryMode == 'steer'
                  ? const Icon(Icons.check_rounded)
                  : null,
              onTap: steeringAvailable
                  ? () => Navigator.pop(context, 'steer')
                  : null,
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted || selected == null) return;
    setState(() => _deliveryMode = selected);
  }

  Future<void> _editSentMessage(
      RemoteMessage message, ProviderVisualTheme visual) async {
    final original = message.parts
        .where((part) => part.type == 'text')
        .map((part) => part.summary)
        .where((text) => text.trim().isNotEmpty)
        .join('\n');
    if (original.isEmpty) return;
    var editedText = original;
    final replacement = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Edit and restart from here?'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              TextFormField(
                key: const Key('edit-message-field'),
                initialValue: original,
                onChanged: (value) => editedText = value,
                autofocus: true,
                minLines: 2,
                maxLines: 8,
              ),
              const SizedBox(height: 12),
              Text(
                'Codex will remove this turn and every later turn, then restart with the edited message. Files already changed on the computer are not reverted.',
                style: Theme.of(dialogContext).textTheme.bodySmall?.copyWith(
                      color: Theme.of(dialogContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel')),
          FilledButton(
            key: const Key('confirm-edit-message'),
            onPressed: () {
              final value = editedText.trim();
              if (value.isNotEmpty) Navigator.pop(dialogContext, value);
            },
            child: const Text('Edit & restart'),
          ),
        ],
      ),
    );
    if (!mounted || replacement == null || replacement == original.trim()) {
      return;
    }
    final store = StoreScope.of(context);
    setState(() => _sending = true);
    try {
      await store.editMessage(
        widget.sessionId,
        message,
        replacement,
        modelId: _selectedModelId,
        reasoningEffort: _selectedReasoningEffort,
      );
    } on Object catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not edit that message: $error')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _openMessageActions(
    RemoteMessage message,
    ProviderVisualTheme visual, {
    required bool editEnabled,
  }) async {
    final copyText = _copyableMessageText(message);
    if (copyText.isEmpty && !editEnabled) return;
    final action = await showModalBottomSheet<_MessageAction>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      backgroundColor: visual.surfaceRaised,
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (copyText.isNotEmpty)
                SizedBox(
                  height: 56,
                  child: ListTile(
                    key: ValueKey<String>('copy-message-${message.id}'),
                    minLeadingWidth: 32,
                    leading: const Icon(Icons.copy_rounded),
                    title: const Text('Copy message'),
                    onTap: () =>
                        Navigator.pop(sheetContext, _MessageAction.copy),
                  ),
                ),
              if (editEnabled)
                SizedBox(
                  height: 56,
                  child: ListTile(
                    key: ValueKey<String>('edit-message-${message.id}'),
                    minLeadingWidth: 32,
                    leading: const Icon(Icons.edit_outlined),
                    title: const Text('Edit & restart'),
                    onTap: () =>
                        Navigator.pop(sheetContext, _MessageAction.edit),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    if (!mounted || action == null) return;
    if (action == _MessageAction.edit) {
      await _editSentMessage(message, visual);
      return;
    }
    try {
      await Clipboard.setData(ClipboardData(text: copyText));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Message copied')),
      );
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not copy message')),
      );
    }
  }

  Future<void> _openContextControls(RemoteAppStore store, RemoteSession session,
      ProviderVisualTheme visual) async {
    var usage = store.contextBySession[session.id];
    if (usage == null) {
      try {
        usage = await store.loadSessionContext(session.id);
      } on Object catch (error) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Context usage is unavailable: $error')));
        }
        return;
      }
    }
    if (!mounted) return;
    final initial = usage;
    final reportedWindowTokens = initial.contextWindowTokens;
    final windowTokens =
        reportedWindowTokens != null && reportedWindowTokens > 0
            ? reportedWindowTokens
            : null;
    var minimum = initial.minimumThresholdTokens ?? 1000;
    if (minimum < 1) minimum = 1;
    if (windowTokens != null && minimum > windowTokens) {
      minimum = windowTokens;
    }
    final maximum = windowTokens ?? minimum;
    var threshold = (initial.compactionThresholdTokens ?? maximum)
        .clamp(minimum, maximum)
        .toInt();
    final selected = await showModalBottomSheet<int>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      backgroundColor: visual.surfaceRaised,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) => SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: visual.border,
                    borderRadius: BorderRadius.circular(999),
                  ),
                ),
              ),
              const SizedBox(height: 18),
              const Text('Set automatic compaction',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 18),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text('Context used',
                        style: Theme.of(sheetContext).textTheme.bodyMedium),
                  ),
                  if (_contextFraction(initial) != null)
                    Text(_contextPercentLabel(initial),
                        style: TextStyle(
                            color: visual.accent,
                            fontSize: 17,
                            fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 8),
              SizedBox(
                key: const Key('session-context-threshold-bar'),
                height: 44,
                child: Stack(
                  alignment: Alignment.center,
                  children: <Widget>[
                    Positioned(
                      left: 12,
                      right: 12,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(999),
                        child: LinearProgressIndicator(
                          minHeight: 8,
                          value: _contextFraction(initial) ?? 0,
                          color: visual.accent,
                          backgroundColor: visual.border.withValues(alpha: .55),
                        ),
                      ),
                    ),
                    if (initial.supportsThreshold && windowTokens != null)
                      Semantics(
                        label: 'Automatic compaction threshold',
                        value: _compactTokenCount(threshold),
                        child: SliderTheme(
                          data: SliderTheme.of(sheetContext).copyWith(
                            trackHeight: 0,
                            activeTrackColor: Colors.transparent,
                            inactiveTrackColor: Colors.transparent,
                            disabledActiveTrackColor: Colors.transparent,
                            disabledInactiveTrackColor: Colors.transparent,
                            thumbColor: visual.accent,
                            overlayColor: visual.accent.withValues(alpha: .12),
                            thumbShape: const RoundSliderThumbShape(
                                enabledThumbRadius: 9),
                            overlayShape: const RoundSliderOverlayShape(
                                overlayRadius: 19),
                            showValueIndicator:
                                ShowValueIndicator.onlyForDiscrete,
                          ),
                          child: Slider(
                            key: const Key('session-context-threshold-slider'),
                            min: 0,
                            max: maximum.toDouble(),
                            divisions: (maximum ~/ 1000).clamp(1, 100).toInt(),
                            value: threshold.toDouble(),
                            label: _compactTokenCount(threshold),
                            semanticFormatterCallback: (_) =>
                                '${_compactTokenCount(threshold)} tokens',
                            onChanged: initial.isCompacting
                                ? null
                                : (value) {
                                    final next = value
                                        .round()
                                        .clamp(minimum, maximum)
                                        .toInt();
                                    setSheetState(() => threshold = next);
                                  },
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (initial.supportsThreshold &&
                  windowTokens != null) ...<Widget>[
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: <Widget>[
                    Text(_compactTokenCount(minimum),
                        style: Theme.of(sheetContext).textTheme.labelSmall),
                    Text(_compactTokenCount(threshold),
                        style: TextStyle(
                            color: visual.accent, fontWeight: FontWeight.w700)),
                    Text(_compactTokenCount(maximum),
                        style: Theme.of(sheetContext).textTheme.labelSmall),
                  ],
                ),
                const SizedBox(height: 9),
                Text(
                  'Compacts this task automatically when its context reaches this point.',
                  style: TextStyle(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .57),
                      fontSize: 13),
                ),
              ] else ...<Widget>[
                const SizedBox(height: 9),
                Text(
                  'Automatic compaction is not available for this agent.',
                  style: TextStyle(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .62),
                      height: 1.4),
                ),
              ],
              const SizedBox(height: 8),
              Theme(
                data: Theme.of(sheetContext)
                    .copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  key: const Key('session-context-usage-details'),
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: const EdgeInsets.only(bottom: 4),
                  visualDensity: VisualDensity.compact,
                  title: const Text('Usage details',
                      style:
                          TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  children: <Widget>[
                    _ContextStatRow(
                        label: 'In use',
                        value: initial.usedTokens == null
                            ? 'Not reported'
                            : initial.contextWindowTokens == null
                                ? _compactTokenCount(initial.usedTokens)
                                : '${_compactTokenCount(initial.usedTokens)} / ${_compactTokenCount(initial.contextWindowTokens)}'),
                    _ContextStatRow(
                        label: 'Input / output',
                        value:
                            '${initial.usage.inputTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.inputTokens)} / ${initial.usage.outputTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.outputTokens)}'),
                    if (initial.usage.cacheReadTokens != null ||
                        initial.usage.cacheWriteTokens != null)
                      _ContextStatRow(
                          label: 'Cached read / write',
                          value:
                              '${initial.usage.cacheReadTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.cacheReadTokens)} / ${initial.usage.cacheWriteTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.cacheWriteTokens)}'),
                    if (_contextCost(initial) != null)
                      _ContextStatRow(
                          label: 'Session cost', value: _contextCost(initial)!),
                  ],
                ),
              ),
              if (initial.supportsThreshold &&
                  windowTokens != null) ...<Widget>[
                if ((session.state == 'working' ||
                        session.state == 'needs_approval' ||
                        session.state == 'needs_input') &&
                    initial.usedTokens != null &&
                    threshold <= initial.usedTokens!)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      'Applying now will compact this task during the current turn.',
                      key: const Key('current-turn-compaction-note'),
                      style: TextStyle(
                          color: Theme.of(sheetContext)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: .68),
                          fontSize: 12.5,
                          height: 1.35),
                    ),
                  ),
                FilledButton(
                  key: const Key('save-session-context-threshold'),
                  onPressed: initial.isCompacting ||
                          threshold == initial.compactionThresholdTokens
                      ? null
                      : () => Navigator.pop(sheetContext, threshold),
                  child: Text(initial.isCompacting ? 'Compacting…' : 'Apply'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
    if (selected == null || !mounted) return;
    try {
      await store.setSessionCompactionThreshold(session.id, selected,
          compactNow: true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Automatic compaction updated')));
      }
    } on Object catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not update the threshold: $error')));
      }
    }
  }

  Future<void> _runSourceSessionAction(
    RemoteAppStore store,
    RemoteSession session,
    _SourceSessionAction action,
  ) async {
    if (_sourceActionRunning) return;
    final prompt = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: _SourceSessionActionSheet(
          action: action,
          store: store,
          harnessId: session.providerId,
          recorder: _dictationRecorder,
        ),
      ),
    );
    if (!mounted || prompt == null) return;
    setState(() => _sourceActionRunning = true);
    try {
      final RemoteSession created;
      if (action == _SourceSessionAction.handoff) {
        created = (await store.contextHandoff(session.id)).session;
        store.setDraft(created.id, prompt);
      } else {
        created =
            (await store.branchSession(session.id, prompt: prompt)).session;
      }
      if (!mounted) return;
      store.openSessionForView(created);
      await Navigator.of(context).push(sessionScreenRoute(created.id));
    } on Object catch (caught) {
      if (!mounted) return;
      final message = caught
          .toString()
          .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Could not create the new task: $message'),
      ));
    } finally {
      if (mounted) setState(() => _sourceActionRunning = false);
    }
  }

  Future<void> _openWallet(
    RemoteAppStore store,
    RemoteSession session,
    String? modelId,
    List<RemoteModel> models,
  ) async {
    final loaded = await store.loadWallet(
      session.providerId,
      modelId: modelId,
      force: true,
    );
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(sheetContext).bottom),
        child: _WalletSheet(
          store: store,
          providerId: session.providerId,
          modelId: modelId,
          models: models,
          initial:
              loaded ?? store.walletDisplayFor(session.providerId, modelId),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final session = store.sessions
            .where((item) => item.id == widget.sessionId)
            .firstOrNull ??
        (store.selectedSession?.id == widget.sessionId
            ? store.selectedSession
            : null);
    final preparedSession =
        session != null && store.isPreparedSession(session.id);
    if (preparedSession && _preparedDirectory.text.isEmpty) {
      _preparedDirectory.text = session.workingDirectory ?? '';
    }
    final visual =
        providerVisualThemeFor(session?.providerId ?? store.selectedProviderId);
    final sessionContext =
        session == null ? null : store.contextBySession[session.id];
    final dictationSource = session == null
        ? null
        : store.dictationSourceForHarness(session.providerId);
    final dictationTooltip = _recordingDictation
        ? 'Stop and transcribe'
        : _transcribingDictation
            ? 'Transcribing voice input'
            : dictationSource == null
                ? 'Choose a dictation service. Hold for voice options.'
                : 'Tap to dictate with ${dictationSource.label}. Hold to choose a different service.';
    final modelOptions = session == null
        ? const <RemoteModel>[]
        : store.modelsByProvider[session.providerId] ?? const <RemoteModel>[];
    final sessionWorking = session?.state == 'working';
    final compactConversationHeader = MediaQuery.sizeOf(context).height < 520;
    final configuredModel =
        modelOptions.where((model) => model.id == _selectedModelId).firstOrNull;
    final runtimeModel =
        modelOptions.where((model) => model.id == session?.modelId).firstOrNull;
    final metadataModel = (sessionWorking ? runtimeModel : configuredModel) ??
        modelOptions.where((model) => model.isDefault).firstOrNull ??
        modelOptions.firstOrNull;
    final reasoningEfforts =
        metadataModel?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    final modelSelectionSupported =
        session != null && _supportsTurnModelSelection(session.providerId);
    final displayedModelId = sessionWorking
        ? session?.modelId
        : _selectedModelId ?? session?.modelId ?? metadataModel?.id;
    final displayedModelLabel = sessionWorking
        ? runtimeModel?.displayName ?? session?.modelId ?? 'Model'
        : configuredModel?.displayName ??
            metadataModel?.displayName ??
            session?.modelId ??
            'Model';
    final displayedReasoningEffort = sessionWorking
        ? session?.reasoningEffort
        : _selectedReasoningEffort ?? session?.reasoningEffort;
    final displayedReasoningLabel = displayedReasoningEffort == null
        ? 'Effort unknown'
        : _effortDisplayLabel(displayedReasoningEffort, displayedModelId);
    final wallet = session == null
        ? null
        : store.walletDisplayFor(session.providerId, displayedModelId);
    if (session != null && !preparedSession) {
      final walletLoadKey =
          '${session.providerId}\u0000${displayedModelId ?? ''}';
      if (_walletLoadedFor != walletLoadKey) {
        _walletLoadedFor = walletLoadKey;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _walletLoadedFor != walletLoadKey) return;
          unawaited(
              store.loadWallet(session.providerId, modelId: displayedModelId));
        });
      }
    }
    final imageAttachmentSupported =
        session != null && _supportsImageAttachments(session.providerId);
    final steeringSupported =
        session != null && store.providerSupportsSteering(session.providerId);
    final steeringAvailable = sessionWorking && steeringSupported;
    final deliveryMode =
        _deliveryMode == 'steer' && steeringAvailable ? 'steer' : 'queue';
    final queuedMessages = store.queuedMessagesFor(widget.sessionId);
    final delegationTasks = store.delegationsFor(widget.sessionId);
    final messageEditingAvailable = session != null &&
        (session.state == 'idle' ||
            session.state == 'completed' ||
            session.state == 'failed') &&
        store.providerSupportsMessageEditing(session.providerId);
    final childSessions = store.childSessionsFor(widget.sessionId);
    final history = store.messages[widget.sessionId] ?? const <RemoteMessage>[];
    final liveAssistant = store.liveAssistantMessageFor(widget.sessionId);
    final identityMessages = <RemoteMessage>[
      ...history,
      if (liveAssistant != null) liveAssistant,
    ];
    final shimmeringReasoningMessage = <RemoteMessage>[
      ...history,
      if (liveAssistant != null) liveAssistant,
    ]
        .reversed
        .where((message) =>
            message.status == 'streaming' &&
            message.role.toLowerCase() == 'assistant' &&
            message.parts.any((part) =>
                _assistantTextTone(part, false) ==
                _AssistantTextTone.privateReasoning))
        .firstOrNull;
    final liveEvents = (store.events[widget.sessionId] ?? const <AgentEvent>[])
        .where((event) =>
            _showsConversationEvent(event.type) &&
            !_eventHasStructuredSubagent(event))
        .toList(growable: false);
    final activityGroups = _groupConversationActivity(liveEvents);
    final sessionApprovals = store.approvals.values
        .where((approval) => approval.sessionId == widget.sessionId)
        .toList();
    final inputRequests = store.userInputs.values
        .where((request) => request.sessionId == widget.sessionId)
        .toList();
    final itemCount = history.length +
        (liveAssistant == null ? 0 : 1) +
        (activityGroups.isEmpty ? 0 : 1) +
        sessionApprovals.length +
        inputRequests.length +
        queuedMessages.length +
        delegationTasks.length;
    final sessionHistoryLoading =
        store.isSessionHistoryLoading(widget.sessionId);
    final emptyHistoryError = itemCount == 0 && !sessionHistoryLoading
        ? _historyLoadError ?? store.error
        : null;
    _scheduleScrollToBottom();
    return Theme(
      data: buildRemoteTheme(visual),
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(
            toolbarHeight: compactConversationHeader ? 48 : 58,
            leadingWidth: 44,
            leading: IconButton(
              tooltip: 'Back',
              onPressed: () => Navigator.maybePop(context),
              icon: const Icon(Icons.chevron_left_rounded, size: 30),
            ),
            titleSpacing: 2,
            title: Text(
              session == null ? 'Session' : _sessionDisplayTitle(session),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontSize: 19,
                    fontWeight: FontWeight.w600,
                  ),
            ),
            actions: <Widget>[
              if (session != null && !preparedSession)
                _SessionContextButton(
                  context: sessionContext,
                  visual: visual,
                  onTap: () =>
                      unawaited(_openContextControls(store, session, visual)),
                ),
              if (session != null && _showsConversationState(session.state))
                Padding(
                  padding: const EdgeInsets.only(left: 6, right: 2),
                  child: _ConversationStateIndicator(
                      state: session.state, visual: visual),
                ),
              if (session?.state == 'working') ...<Widget>[
                IconButton(
                  key: const Key('interrupt-current-work'),
                  tooltip: 'Interrupt current work',
                  onPressed: () => unawaited(store.interrupt(session!.id)),
                  icon: const Icon(Icons.stop_rounded, size: 19),
                ),
                const SizedBox(width: 2),
              ],
              if (session != null)
                PopupMenuButton<String>(
                  key: const Key('session-actions-menu'),
                  tooltip: 'Session actions',
                  position: PopupMenuPosition.under,
                  onSelected: (value) {
                    switch (value) {
                      case 'task-details':
                        unawaited(_showTaskDetails(session, visual));
                        break;
                      case 'context-handoff':
                        unawaited(_runSourceSessionAction(
                            store, session, _SourceSessionAction.handoff));
                        break;
                      case 'branch':
                        unawaited(_runSourceSessionAction(
                            store, session, _SourceSessionAction.branch));
                        break;
                      case 'open-desktop':
                        unawaited(showDesktopWakeDialog(context, store));
                        break;
                    }
                  },
                  itemBuilder: (_) => <PopupMenuEntry<String>>[
                    const PopupMenuItem<String>(
                      key: Key('session-task-details'),
                      value: 'task-details',
                      child: Row(
                        children: <Widget>[
                          Icon(Icons.info_outline_rounded, size: 19),
                          SizedBox(width: 10),
                          Expanded(child: Text('Task details')),
                        ],
                      ),
                    ),
                    const PopupMenuDivider(),
                    PopupMenuItem<String>(
                      key: const Key('session-context-handoff'),
                      value: 'context-handoff',
                      enabled: !_sourceActionRunning &&
                          store.connectionState == BridgeConnectionState.online,
                      child: const Row(
                        children: <Widget>[
                          Icon(Icons.move_up_rounded, size: 19),
                          SizedBox(width: 10),
                          Expanded(child: Text('Context Handoff')),
                        ],
                      ),
                    ),
                    PopupMenuItem<String>(
                      key: const Key('session-branch-new-task'),
                      value: 'branch',
                      enabled: !_sourceActionRunning &&
                          store.connectionState == BridgeConnectionState.online,
                      child: const Row(
                        children: <Widget>[
                          Icon(Icons.call_split_rounded, size: 19),
                          SizedBox(width: 10),
                          Expanded(child: Text('Branch in New Task')),
                        ],
                      ),
                    ),
                    const PopupMenuDivider(),
                    PopupMenuItem<String>(
                      key: const Key('session-open-desktop'),
                      value: 'open-desktop',
                      enabled:
                          store.connectionState == BridgeConnectionState.online,
                      child: const Row(
                        children: <Widget>[
                          Icon(Icons.desktop_windows_outlined, size: 19),
                          SizedBox(width: 10),
                          Expanded(child: Text('Open on PC')),
                        ],
                      ),
                    ),
                  ],
                  icon: const Icon(Icons.more_horiz_rounded),
                ),
            ],
          ),
          body: _AdaptivePage(
              maxWidth: 900,
              child: Column(
                children: <Widget>[
                  if (sessionHistoryLoading)
                    LinearProgressIndicator(
                      key: const Key('session-history-loading'),
                      minHeight: 1,
                      color: visual.accent,
                      backgroundColor: visual.border.withValues(alpha: 0.3),
                    ),
                  if (_historyLoadError != null && itemCount > 0)
                    _SessionHistoryError(
                      message: _historyLoadError!,
                      onRetry: () => unawaited(_loadOlderHistory()),
                      compact: true,
                    ),
                  if (session != null &&
                      (preparedSession || childSessions.isNotEmpty))
                    Container(
                      width: double.infinity,
                      padding: EdgeInsets.fromLTRB(
                          16,
                          compactConversationHeader ? 3 : 8,
                          16,
                          compactConversationHeader ? 4 : 11),
                      decoration: BoxDecoration(
                        color: visual.background,
                        border: Border(
                            bottom: BorderSide(
                                color: visual.border.withValues(alpha: 0.72))),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          if (!compactConversationHeader && preparedSession)
                            Text(
                              'Working directory',
                              style: Theme.of(context)
                                  .textTheme
                                  .labelMedium
                                  ?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.58),
                                    fontWeight: FontWeight.w600,
                                  ),
                            ),
                          if (!compactConversationHeader && preparedSession)
                            const SizedBox(height: 4),
                          Row(
                            children: <Widget>[
                              Expanded(
                                child: preparedSession
                                    ? TextField(
                                        controller: _preparedDirectory,
                                        onChanged: (value) =>
                                            store.updatePreparedDirectory(
                                                session.id, value),
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.copyWith(fontFamily: 'monospace'),
                                        decoration: const InputDecoration(
                                          hintText:
                                              'Working directory (optional)',
                                          border: InputBorder.none,
                                          isDense: true,
                                        ),
                                      )
                                    : const SizedBox.shrink(),
                              ),
                              if (childSessions.isNotEmpty) ...<Widget>[
                                const SizedBox(width: 8),
                                TextButton.icon(
                                  key: const Key('child-agents-button'),
                                  onPressed: _showChildSessions,
                                  style: TextButton.styleFrom(
                                    foregroundColor: visual.accent,
                                    minimumSize: const Size(44, 44),
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 8),
                                    visualDensity: VisualDensity.compact,
                                  ),
                                  icon: const Icon(Icons.groups_2_outlined,
                                      size: 18),
                                  label: Text('${childSessions.length}',
                                      style: const TextStyle(fontSize: 13)),
                                ),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                  if (session != null &&
                      store.handoffSummaries[session.id]?.isNotEmpty == true)
                    _HandoffSummaryBanner(
                      summary: store.handoffSummaries[session.id]!,
                      sourceTitle: store.sessions
                          .where((candidate) =>
                              candidate.id ==
                              session.relationship?.sourceSessionId)
                          .firstOrNull
                          ?.title,
                    ),
                  Expanded(
                    child: itemCount == 0
                        ? sessionHistoryLoading
                            ? const Center(child: Text('Loading messages…'))
                            : emptyHistoryError != null
                                ? _SessionHistoryError(
                                    message: emptyHistoryError,
                                    onRetry: session == null
                                        ? null
                                        : () {
                                            setState(
                                                () => _historyLoadError = null);
                                            store.openSessionForView(session);
                                          },
                                  )
                                : const Center(child: Text('No messages yet.'))
                        : ListView.builder(
                            controller: _scrollController,
                            keyboardDismissBehavior:
                                ScrollViewKeyboardDismissBehavior.onDrag,
                            padding: const EdgeInsets.fromLTRB(12, 10, 12, 14),
                            itemCount: itemCount +
                                (store.hasOlderHistory(widget.sessionId) ||
                                        store.isOlderHistoryLoading(
                                            widget.sessionId)
                                    ? 1
                                    : 0),
                            itemBuilder: (context, index) {
                              final hasHistoryLoader = store
                                      .hasOlderHistory(widget.sessionId) ||
                                  store.isOlderHistoryLoading(widget.sessionId);
                              if (hasHistoryLoader && index == 0) {
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: Center(
                                    child: store.isOlderHistoryLoading(
                                            widget.sessionId)
                                        ? const SizedBox.square(
                                            dimension: 18,
                                            child: CircularProgressIndicator(
                                                strokeWidth: 2),
                                          )
                                        : TextButton(
                                            onPressed: () =>
                                                unawaited(_loadOlderHistory()),
                                            child: const Text(
                                                'Load earlier messages'),
                                          ),
                                  ),
                                );
                              }
                              if (hasHistoryLoader) index -= 1;
                              if (index < history.length) {
                                final message = history[index];
                                final canEdit =
                                    messageEditingAvailable && message.editable;
                                final hasMessageActions = canEdit ||
                                    _copyableMessageText(message).isNotEmpty;
                                return _MessageCard(
                                  key: _messageKeys.putIfAbsent(
                                      message.id, GlobalKey.new),
                                  message: message,
                                  visual: visual,
                                  providerId:
                                      session?.providerId ?? visual.providerId,
                                  showIdentity: _shouldShowAssistantIdentity(
                                      identityMessages, index),
                                  streaming: message.status == 'streaming',
                                  shimmerPrivateReasoning: message.id ==
                                      shimmeringReasoningMessage?.id,
                                  showFinalBoundary:
                                      _finalFollowsAssistantArtifacts(
                                          identityMessages, index),
                                  editEnabled: canEdit,
                                  onLongPress: hasMessageActions
                                      ? () => unawaited(_openMessageActions(
                                          message, visual,
                                          editEnabled: canEdit))
                                      : null,
                                );
                              }
                              var cursor = index - history.length;
                              if (liveAssistant != null) {
                                if (cursor == 0) {
                                  return _MessageCard(
                                    key: _messageKeys.putIfAbsent(
                                        liveAssistant.id, GlobalKey.new),
                                    message: liveAssistant,
                                    visual: visual,
                                    providerId: session?.providerId ??
                                        visual.providerId,
                                    showIdentity: _shouldShowAssistantIdentity(
                                        identityMessages, history.length),
                                    streaming: true,
                                    shimmerPrivateReasoning: liveAssistant.id ==
                                        shimmeringReasoningMessage?.id,
                                    showFinalBoundary:
                                        _finalFollowsAssistantArtifacts(
                                            identityMessages, history.length),
                                    onLongPress:
                                        _copyableMessageText(liveAssistant)
                                                .isNotEmpty
                                            ? () => unawaited(
                                                _openMessageActions(
                                                    liveAssistant, visual,
                                                    editEnabled: false))
                                            : null,
                                  );
                                }
                                cursor -= 1;
                              }
                              if (activityGroups.isNotEmpty) {
                                if (cursor == 0) {
                                  return _ReasoningActivityGroup(
                                    groups: activityGroups,
                                    visual: visual,
                                    working: sessionWorking,
                                  );
                                }
                                cursor -= 1;
                              }
                              if (cursor < sessionApprovals.length)
                                return _ApprovalCard(
                                    approval: sessionApprovals[cursor]);
                              cursor -= sessionApprovals.length;
                              if (cursor < inputRequests.length) {
                                return _UserInputCard(
                                    request: inputRequests[cursor]);
                              }
                              cursor -= inputRequests.length;
                              if (cursor < queuedMessages.length) {
                                final queued = queuedMessages[cursor];
                                return _QueuedInstructionCard(
                                  message: queued,
                                  visual: visual,
                                  onCancel: () => unawaited(
                                      store.cancelQueuedMessage(queued.id)),
                                );
                              }
                              cursor -= queuedMessages.length;
                              return _DelegationTaskCard(
                                task: delegationTasks[cursor],
                                visual: visual,
                                onOpenChild: (child) {
                                  final childSession = child.sessionId == null
                                      ? null
                                      : store.sessions
                                          .where((item) =>
                                              item.id == child.sessionId)
                                          .firstOrNull;
                                  if (childSession == null) return;
                                  store.openSessionForView(childSession);
                                  unawaited(Navigator.of(context).push(
                                      sessionScreenRoute(childSession.id)));
                                },
                              );
                            },
                          ),
                  ),
                  SafeArea(
                    top: false,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: visual.background,
                        border: Border(
                            top: BorderSide(
                                color: visual.border.withValues(alpha: 0.72))),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          _SessionControlsBar(
                            visual: visual,
                            modelLabel: sessionWorking
                                ? displayedModelLabel
                                : modelSelectionSupported
                                    ? displayedModelLabel
                                    : 'Harness model',
                            modelEnabled: !sessionWorking &&
                                modelSelectionSupported &&
                                modelOptions.isNotEmpty,
                            onModelTap: () =>
                                _chooseModel(modelOptions, visual),
                            wallet: wallet,
                            onWalletTap: session == null
                                ? null
                                : () => _openWallet(store, session,
                                    displayedModelId, modelOptions),
                            reasoningLabel: displayedReasoningLabel,
                            reasoningVisible: sessionWorking ||
                                (modelSelectionSupported &&
                                    reasoningEfforts.isNotEmpty),
                            reasoningEnabled:
                                !sessionWorking && reasoningEfforts.isNotEmpty,
                            effortIsUltra: displayedReasoningEffort == 'ultra',
                            onReasoningTap: () => _chooseReasoningEffort(
                                reasoningEfforts, displayedModelId),
                            visionLabel: _visionProxySelection == null
                                ? 'Add eyes'
                                : 'Eyes: ${_visionProxySelection!.modelId}',
                            visionEnabled: !sessionWorking,
                            onVisionTap: _chooseVisionProxy,
                            deliveryLabel:
                                deliveryMode == 'steer' ? 'Steer' : 'Queue',
                            onDeliveryTap: () => _chooseDeliveryMode(
                              steeringSupported: steeringSupported,
                              steeringAvailable: steeringAvailable,
                            ),
                          ),
                          if (_meshSuggestionVisible)
                            _MeshCommandSuggestion(
                              visual: visual,
                              onSelected: () => unawaited(_activateMesh()),
                            ),
                          if (_meshTargets.isNotEmpty)
                            _MeshComposerPanel(
                              targets: _meshTargets,
                              visual: visual,
                              onAdd: _meshTargets.length >= 4
                                  ? null
                                  : () => unawaited(_addMeshTarget()),
                              onEdit: (index) =>
                                  unawaited(_editMeshTarget(index)),
                              onRemove: (index) =>
                                  setState(() => _meshTargets.removeAt(index)),
                            ),
                          if (_attachments.isNotEmpty)
                            SizedBox(
                              height: 42,
                              child: ListView.separated(
                                padding:
                                    const EdgeInsets.fromLTRB(10, 5, 10, 3),
                                scrollDirection: Axis.horizontal,
                                itemCount: _attachments.length,
                                separatorBuilder: (_, __) =>
                                    const SizedBox(width: 6),
                                itemBuilder: (context, index) {
                                  final file = _attachments[index];
                                  return InputChip(
                                    avatar: file.mimeType.startsWith('image/')
                                        ? ClipRRect(
                                            key: ValueKey<String>(
                                                'pending-image-${file.name}'),
                                            borderRadius:
                                                BorderRadius.circular(3),
                                            child: _ExpandableMessageImage(
                                              imageUri: file.dataUri,
                                              name: file.name,
                                              width: 24,
                                              height: 24,
                                              fit: BoxFit.cover,
                                              cacheWidth: 48,
                                              fallback: const Icon(
                                                  Icons.broken_image_outlined,
                                                  size: 18),
                                            ),
                                          )
                                        : const Icon(
                                            Icons.insert_drive_file_outlined,
                                            size: 18),
                                    label: Text(file.name,
                                        overflow: TextOverflow.ellipsis),
                                    onDeleted: () => setState(() {
                                      _attachments.removeAt(index);
                                      if (_attachments.isEmpty) {
                                        _imageModelNoticeId = null;
                                      }
                                    }),
                                  );
                                },
                              ),
                            ),
                          if (_imageModelNoticeId != null)
                            _ImageModelNotice(
                              modelName: modelOptions
                                      .where((model) =>
                                          model.id == _imageModelNoticeId)
                                      .firstOrNull
                                      ?.displayName ??
                                  'This model',
                              visual: visual,
                              onDismiss: () {
                                final modelId = _imageModelNoticeId;
                                if (session != null && modelId != null) {
                                  store.dismissImageModelNotice(
                                      session.providerId, modelId);
                                }
                                setState(() => _imageModelNoticeId = null);
                              },
                            ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(8, 7, 8, 9),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: <Widget>[
                                SizedBox.square(
                                  dimension: 48,
                                  child: IconButton(
                                    key: const Key('add-attachment'),
                                    tooltip: 'Attach from this phone or device',
                                    style: IconButton.styleFrom(
                                      padding: EdgeInsets.zero,
                                      side: BorderSide(color: visual.border),
                                      shape: RoundedRectangleBorder(
                                          borderRadius:
                                              BorderRadius.circular(9)),
                                    ),
                                    onPressed: imageAttachmentSupported
                                        ? _showAttachmentMenu
                                        : null,
                                    icon:
                                        const Icon(Icons.add_rounded, size: 25),
                                  ),
                                ),
                                const SizedBox(width: 7),
                                Expanded(
                                  child: Row(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: <Widget>[
                                      Expanded(
                                        child: TextField(
                                          key: const Key('session-composer'),
                                          controller: _composer,
                                          minLines: 1,
                                          maxLines: 7,
                                          onChanged: (value) {
                                            store.setDraft(
                                                widget.sessionId, value);
                                            final showSuggestion =
                                                _shouldShowMeshSuggestion(
                                                    value);
                                            if (showSuggestion !=
                                                _meshSuggestionVisible) {
                                              setState(() =>
                                                  _meshSuggestionVisible =
                                                      showSuggestion);
                                            }
                                            if (_meshTargets.isEmpty &&
                                                value.toLowerCase() ==
                                                    '/mesh ') {
                                              unawaited(_activateMesh());
                                            }
                                          },
                                          decoration: InputDecoration(
                                            hintText: _dictationHint,
                                            hintMaxLines: 1,
                                            hintStyle: TextStyle(
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurface
                                                  .withValues(alpha: 0.48),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                            filled: true,
                                            fillColor: visual.surface,
                                            border: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(9),
                                              borderSide: BorderSide(
                                                  color: visual.border),
                                            ),
                                            enabledBorder: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(9),
                                              borderSide: BorderSide(
                                                  color: visual.border),
                                            ),
                                            focusedBorder: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(9),
                                              borderSide: BorderSide(
                                                  color: visual.accent),
                                            ),
                                            contentPadding:
                                                EdgeInsets.symmetric(
                                                    horizontal: 13,
                                                    vertical: 12),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 7),
                                      SizedBox.square(
                                        dimension: 48,
                                        child: Semantics(
                                          button: true,
                                          label: 'Voice dictation',
                                          hint: dictationTooltip,
                                          child: Tooltip(
                                            message: dictationTooltip,
                                            triggerMode:
                                                TooltipTriggerMode.manual,
                                            child: GestureDetector(
                                              behavior: HitTestBehavior.opaque,
                                              onLongPress: _recordingDictation ||
                                                      _transcribingDictation
                                                  ? null
                                                  : _openDictationSourcePicker,
                                              child: Stack(
                                                alignment: Alignment.center,
                                                clipBehavior: Clip.none,
                                                children: <Widget>[
                                                  IconButton(
                                                    key: const Key(
                                                        'dictation-button'),
                                                    onPressed:
                                                        _transcribingDictation
                                                            ? null
                                                            : _toggleDictation,
                                                    style: IconButton.styleFrom(
                                                      backgroundColor:
                                                          visual.surfaceRaised,
                                                      foregroundColor:
                                                          _recordingDictation
                                                              ? visual.accent
                                                              : null,
                                                      disabledBackgroundColor:
                                                          visual.surfaceRaised,
                                                      disabledForegroundColor:
                                                          Theme.of(context)
                                                              .disabledColor,
                                                      side: BorderSide(
                                                          color: visual.border),
                                                      shape:
                                                          const CircleBorder(),
                                                    ),
                                                    icon: _transcribingDictation
                                                        ? const SizedBox.square(
                                                            dimension: 17,
                                                            child:
                                                                CircularProgressIndicator(
                                                                    strokeWidth:
                                                                        2),
                                                          )
                                                        : Icon(
                                                            _recordingDictation
                                                                ? Icons
                                                                    .stop_circle_outlined
                                                                : Icons
                                                                    .mic_none_rounded,
                                                            size: 21,
                                                          ),
                                                  ),
                                                  if (!_recordingDictation &&
                                                      !_transcribingDictation)
                                                    Positioned(
                                                      right: 3,
                                                      bottom: 3,
                                                      child: IgnorePointer(
                                                        child: Container(
                                                          key: const Key(
                                                              'dictation-menu-badge'),
                                                          width: 15,
                                                          height: 15,
                                                          decoration:
                                                              BoxDecoration(
                                                            shape:
                                                                BoxShape.circle,
                                                            color: visual
                                                                .surfaceRaised,
                                                            border: Border.all(
                                                                color: visual
                                                                    .border),
                                                          ),
                                                          child: const Icon(
                                                            Icons
                                                                .keyboard_arrow_down_rounded,
                                                            size: 11,
                                                          ),
                                                        ),
                                                      ),
                                                    ),
                                                ],
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 7),
                                      ValueListenableBuilder<TextEditingValue>(
                                        valueListenable: _composer,
                                        builder: (context, composerValue, _) {
                                          final composerEmpty =
                                              composerValue.text.trim().isEmpty;
                                          return SizedBox.square(
                                            dimension: 48,
                                            child: IconButton(
                                              key:
                                                  const Key('send-instruction'),
                                              tooltip: 'Send message',
                                              style: IconButton.styleFrom(
                                                backgroundColor: visual.accent,
                                                foregroundColor:
                                                    visual.background,
                                                disabledBackgroundColor:
                                                    visual.surfaceRaised,
                                                disabledForegroundColor:
                                                    Theme.of(context)
                                                        .disabledColor,
                                                side: BorderSide(
                                                    color: visual.border),
                                                shape: const CircleBorder(),
                                              ),
                                              onPressed: _sending ||
                                                      composerEmpty
                                                  ? null
                                                  : () async {
                                                      setState(() =>
                                                          _sending = true);
                                                      try {
                                                        if (_meshTargets
                                                            .isNotEmpty) {
                                                          if (_attachments
                                                              .isNotEmpty) {
                                                            throw StateError(
                                                                '/mesh attachments are not available yet. Send the attachment in a child session after it opens.');
                                                          }
                                                          await store
                                                              .startDelegation(
                                                            widget.sessionId,
                                                            _composer.text,
                                                            List<DelegationSelection>.of(
                                                                _meshTargets),
                                                          );
                                                        } else {
                                                          final createdSessionId =
                                                              await store
                                                                  .submitMessage(
                                                            widget.sessionId,
                                                            _composer.text,
                                                            deliveryMode:
                                                                deliveryMode,
                                                            modelId:
                                                                _selectedModelId,
                                                            reasoningEffort:
                                                                _selectedReasoningEffort,
                                                            attachments:
                                                                _attachments,
                                                          );
                                                          _composer.clear();
                                                          _attachments.clear();
                                                          _meshTargets.clear();
                                                          _imageModelNoticeId =
                                                              null;
                                                          if (createdSessionId !=
                                                                  null &&
                                                              mounted) {
                                                            unawaited(Navigator
                                                                    .of(this
                                                                        .context)
                                                                .pushReplacement(
                                                                    sessionScreenRoute(
                                                                        createdSessionId)));
                                                          }
                                                        }
                                                        _composer.clear();
                                                        _attachments.clear();
                                                        _meshTargets.clear();
                                                        _imageModelNoticeId =
                                                            null;
                                                      } on Object catch (caught) {
                                                        if (mounted) {
                                                          _showDictationError(
                                                              caught);
                                                        }
                                                      } finally {
                                                        if (mounted) {
                                                          setState(() =>
                                                              _sending = false);
                                                        }
                                                      }
                                                    },
                                              icon: _sending
                                                  ? const SizedBox.square(
                                                      dimension: 17,
                                                      child:
                                                          CircularProgressIndicator(
                                                              strokeWidth: 2))
                                                  : const Icon(
                                                      Icons.send_rounded,
                                                      size: 23),
                                            ),
                                          );
                                        },
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              )),
        ),
      ),
    );
  }
}

enum _SourceSessionAction { handoff, branch }

class _SourceSessionActionSheet extends StatefulWidget {
  const _SourceSessionActionSheet({
    required this.action,
    required this.store,
    required this.harnessId,
    required this.recorder,
  });

  final _SourceSessionAction action;
  final RemoteAppStore store;
  final String harnessId;
  final DictationRecorder recorder;

  @override
  State<_SourceSessionActionSheet> createState() =>
      _SourceSessionActionSheetState();
}

class _SourceSessionActionSheetState extends State<_SourceSessionActionSheet> {
  final TextEditingController _prompt = TextEditingController();
  Timer? _timer;
  bool _recording = false;
  bool _transcribing = false;
  int _elapsedSeconds = 0;
  String? _sourceId;

  @override
  void dispose() {
    _timer?.cancel();
    if (_recording) unawaited(widget.recorder.cancel());
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _toggleDictation() async {
    if (_transcribing) return;
    if (_recording) {
      _timer?.cancel();
      setState(() {
        _recording = false;
        _transcribing = true;
      });
      try {
        final bytes = await widget.recorder.stop();
        final text =
            await widget.store.transcribeDictation(bytes, sourceId: _sourceId);
        if (!mounted || text.isEmpty) return;
        final existing = _prompt.text.trimRight();
        _prompt.text = existing.isEmpty ? text : '$existing $text';
        _prompt.selection =
            TextSelection.collapsed(offset: _prompt.text.length);
      } on Object catch (caught) {
        if (mounted) _showError(caught);
      } finally {
        _sourceId = null;
        if (mounted) setState(() => _transcribing = false);
      }
      return;
    }
    final source = widget.store.dictationSourceForHarness(widget.harnessId) ??
        widget.store.readyDictationSources.firstOrNull;
    if (source == null) {
      _showError(StateError(
          'Add a ready dictation service in Settings before using voice input.'));
      return;
    }
    try {
      final permitted = await widget.recorder.start();
      if (!mounted) return;
      if (!permitted) {
        _showError(
            StateError('Microphone permission is needed for dictation.'));
        return;
      }
      _sourceId = source.id;
      setState(() {
        _recording = true;
        _elapsedSeconds = 0;
      });
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted || !_recording) return;
        if (_elapsedSeconds >= 29) {
          unawaited(_toggleDictation());
        } else {
          setState(() => _elapsedSeconds += 1);
        }
      });
    } on Object catch (caught) {
      if (mounted) _showError(caught);
    }
  }

  void _showError(Object caught) {
    final message = caught
        .toString()
        .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final handoff = widget.action == _SourceSessionAction.handoff;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        key: const Key('source-session-action-sheet'),
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              handoff ? 'Context Handoff' : 'Branch in New Task',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            Text(
              handoff
                  ? 'Create a clean task with a compact summary of this chat.'
                  : 'Create a new task from this point without changing the source chat.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 15),
            TextField(
              key: const Key('source-action-prompt'),
              controller: _prompt,
              minLines: 3,
              maxLines: 7,
              autofocus: true,
              decoration: InputDecoration(
                labelText: 'Extra instruction (optional)',
                hintText: handoff
                    ? 'What should the new task focus on?'
                    : 'What should happen next in the new task?',
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  key: const Key('source-action-dictation'),
                  tooltip: _recording
                      ? 'Stop and transcribe'
                      : 'Dictate extra instruction',
                  onPressed: _transcribing ? null : _toggleDictation,
                  icon: _transcribing
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(_recording
                          ? Icons.stop_circle_outlined
                          : Icons.mic_none_rounded),
                ),
              ),
            ),
            if (_recording) ...<Widget>[
              const SizedBox(height: 7),
              Text(
                'Listening… 0:${_elapsedSeconds.toString().padLeft(2, '0')}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 9),
            Text(
              handoff
                  ? 'Your instruction opens as a draft in the new chat. It is not sent until you tap Send.'
                  : 'Your instruction is carried into the new chat.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: .58),
                    fontStyle: FontStyle.italic,
                  ),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: <Widget>[
                TextButton(
                  onPressed: _recording || _transcribing
                      ? null
                      : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  key: const Key('source-action-submit'),
                  onPressed: _recording || _transcribing
                      ? null
                      : () => Navigator.pop(context, _prompt.text.trim()),
                  icon: Icon(handoff
                      ? Icons.move_up_rounded
                      : Icons.call_split_rounded),
                  label: Text(handoff ? 'Create handoff' : 'Create branch'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _HandoffSummaryBanner extends StatelessWidget {
  const _HandoffSummaryBanner({required this.summary, this.sourceTitle});

  final String summary;
  final String? sourceTitle;

  @override
  Widget build(BuildContext context) {
    final grey = Theme.of(context).colorScheme.onSurface.withValues(alpha: .58);
    final label = sourceTitle == null
        ? 'Context carried into this task'
        : 'Context carried from $sourceTitle';
    return Material(
      key: const Key('context-handoff-summary'),
      color: Theme.of(context)
          .colorScheme
          .surfaceContainerHighest
          .withValues(alpha: .22),
      child: InkWell(
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          showDragHandle: true,
          builder: (sheetContext) => FractionallySizedBox(
            heightFactor: .7,
            child: ListView(
              key: const Key('context-handoff-summary-full'),
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
              children: <Widget>[
                Text(label,
                    style: Theme.of(sheetContext).textTheme.titleMedium),
                const SizedBox(height: 12),
                SelectableText(
                  summary,
                  style: Theme.of(sheetContext).textTheme.bodyMedium?.copyWith(
                        fontStyle: FontStyle.italic,
                        height: 1.45,
                      ),
                ),
              ],
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(15, 9, 11, 9),
          child: Row(
            children: <Widget>[
              const Icon(Icons.move_up_rounded, size: 18),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            Theme.of(context).textTheme.labelMedium?.copyWith(
                                  color: grey,
                                  fontWeight: FontWeight.w600,
                                )),
                    const SizedBox(height: 2),
                    Text(summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: grey,
                              fontStyle: FontStyle.italic,
                              height: 1.3,
                            )),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _ModelChoice {
  const _ModelChoice(this.providerId, this.modelId);

  final String providerId;
  final String modelId;
}

class _ModelPickerSheet extends StatefulWidget {
  const _ModelPickerSheet({
    required this.models,
    required this.recentModels,
    required this.currentProviderId,
    required this.selectedModelId,
    required this.visual,
  });

  final List<RemoteModel> models;
  final List<RemoteModel> recentModels;
  final String currentProviderId;
  final String? selectedModelId;
  final ProviderVisualTheme visual;

  @override
  State<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<_ModelPickerSheet> {
  String _query = '';

  bool _matches(RemoteModel model) {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return true;
    return <String>[
      model.displayName,
      model.id,
      model.providerId,
      model.description ?? '',
    ].join(' ').toLowerCase().contains(query);
  }

  Widget _modelTile(RemoteModel model, {required String keyPrefix}) {
    final selected = model.providerId == widget.currentProviderId &&
        model.id == widget.selectedModelId;
    final sourceColor = model.providerId == 'direct'
        ? const Color(0xff5aa9ff)
        : const Color(0xffffa552);
    return ListTile(
      key: Key('$keyPrefix-${model.providerId}-${model.id}'),
      selected: selected,
      selectedColor: widget.visual.accent,
      leading: keyPrefix == 'recent'
          ? ProviderLogo(providerId: model.providerId, size: 26)
          : null,
      title: Text(model.displayName,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      trailing: selected
          ? const Icon(Icons.check_rounded)
          : Icon(Icons.account_balance_wallet_outlined,
              size: 18, color: sourceColor),
      onTap: () =>
          Navigator.pop(context, _ModelChoice(model.providerId, model.id)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final matches = widget.models.where(_matches).toList(growable: false);
    final recent = widget.recentModels.where(_matches).take(5).toList();
    final recentKeys =
        recent.map((model) => '${model.providerId}\u0000${model.id}').toSet();
    final groups = <String, List<RemoteModel>>{};
    for (final model in matches.where((model) =>
        !recentKeys.contains('${model.providerId}\u0000${model.id}'))) {
      groups.putIfAbsent(model.providerId, () => <RemoteModel>[]).add(model);
    }
    final providerIds = groups.keys.toList()
      ..sort((left, right) {
        if (left == widget.currentProviderId) return -1;
        if (right == widget.currentProviderId) return 1;
        return providerVisualThemeFor(left)
            .displayName
            .compareTo(providerVisualThemeFor(right).displayName);
      });
    return Column(
      key: const Key('searchable-model-picker'),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('Choose model',
                style: Theme.of(context).textTheme.titleLarge),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(
            key: const Key('model-search-field'),
            onChanged: (value) => setState(() => _query = value),
            decoration: const InputDecoration(
              hintText: 'Search models or providers',
              prefixIcon: Icon(Icons.search_rounded),
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: matches.isEmpty
              ? const Center(
                  key: Key('model-search-empty'),
                  child: Text('No models match that search.'),
                )
              : ListView(
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  children: <Widget>[
                    if (recent.isNotEmpty) ...<Widget>[
                      const _ModelGroupHeader(
                        key: Key('recent-models-header'),
                        title: 'Recent',
                        icon: Icons.history_rounded,
                      ),
                      ...recent.map(
                          (model) => _modelTile(model, keyPrefix: 'recent')),
                      const Divider(height: 18),
                    ],
                    ...providerIds.expand((providerId) => <Widget>[
                          _ModelGroupHeader(
                            title:
                                providerVisualThemeFor(providerId).displayName,
                            providerId: providerId,
                          ),
                          ...groups[providerId]!.map((model) =>
                              _modelTile(model, keyPrefix: 'catalog')),
                        ]),
                    const SizedBox(height: 16),
                  ],
                ),
        ),
      ],
    );
  }
}

class _ModelGroupHeader extends StatelessWidget {
  const _ModelGroupHeader({
    required this.title,
    this.providerId,
    this.icon,
    super.key,
  });

  final String title;
  final String? providerId;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 13, 18, 4),
        child: Row(
          children: <Widget>[
            if (providerId != null)
              ProviderLogo(providerId: providerId!, size: 19)
            else
              Icon(icon, size: 18),
            const SizedBox(width: 8),
            Text(title,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    )),
          ],
        ),
      );
}

class _WalletSheet extends StatefulWidget {
  const _WalletSheet({
    required this.store,
    required this.providerId,
    required this.modelId,
    required this.models,
    required this.initial,
  });

  final RemoteAppStore store;
  final String providerId;
  final String? modelId;
  final List<RemoteModel> models;
  final ProviderWalletStatus initial;

  @override
  State<_WalletSheet> createState() => _WalletSheetState();
}

class _WalletSheetState extends State<_WalletSheet> {
  final TextEditingController _apiKey = TextEditingController();
  final TextEditingController _budget = TextEditingController();
  final TextEditingController _customName = TextEditingController();
  final TextEditingController _customBaseUrl = TextEditingController();
  final TextEditingController _customModels = TextEditingController();
  late ProviderWalletStatus _wallet;
  late final Map<String, String> _endpoints;
  late String _customEndpointId;
  String? _endpointId;
  String _customProtocol = 'responses';
  String _budgetMode = 'set';
  String? _error;
  bool _saving = false;
  bool _refreshingEndpoint = false;

  @override
  void initState() {
    super.initState();
    _wallet = widget.initial;
    _customEndpointId = randomId('phone-endpoint');
    _endpoints = <String, String>{};
    for (final endpoint in _wallet.availableEndpoints) {
      _endpoints[endpoint.id] = endpoint.name;
    }
    for (final model in widget.models) {
      final endpointId = model.endpointId;
      if (endpointId != null) {
        _endpoints[endpointId] = model.endpointName ?? endpointId;
      }
    }
    if (_wallet.endpointId != null) {
      _endpoints[_wallet.endpointId!] =
          _wallet.endpointName ?? _wallet.endpointId!;
    }
    _endpointId = _wallet.endpointId ?? _endpoints.keys.firstOrNull;
  }

  @override
  void dispose() {
    _apiKey.dispose();
    _budget.dispose();
    _customName.dispose();
    _customBaseUrl.dispose();
    _customModels.dispose();
    super.dispose();
  }

  Future<void> _selectEndpoint(String? endpointId) async {
    if (endpointId == null || endpointId == _endpointId) return;
    _apiKey.clear();
    setState(() {
      _endpointId = endpointId;
      _refreshingEndpoint = true;
      _error = null;
    });
    final wallet = await widget.store.loadWallet(
      widget.providerId,
      endpointId: endpointId,
      force: true,
    );
    if (!mounted || _endpointId != endpointId) return;
    setState(() {
      _refreshingEndpoint = false;
      if (wallet == null || wallet.endpointId != endpointId) {
        _error = 'Could not refresh that endpoint wallet.';
        return;
      }
      _wallet = wallet;
      for (final endpoint in wallet.availableEndpoints) {
        _endpoints[endpoint.id] = endpoint.name;
      }
    });
  }

  Future<void> _configure({bool clearApiKey = false}) async {
    if (_saving || _refreshingEndpoint) return;
    JsonMap? customEndpoint;
    final customName = _customName.text.trim();
    final customBaseUrl = _customBaseUrl.text.trim();
    final hasCustomEndpoint = customName.isNotEmpty || customBaseUrl.isNotEmpty;
    if (!clearApiKey && hasCustomEndpoint) {
      if (customName.isEmpty || customBaseUrl.isEmpty) {
        setState(() =>
            _error = 'Enter both a name and base URL for the custom endpoint.');
        return;
      }
      final modelIds = _customModels.text
          .split(',')
          .map((value) => value.trim())
          .where((value) => value.isNotEmpty)
          .toSet()
          .toList(growable: false);
      customEndpoint = <String, Object?>{
        'id': _customEndpointId,
        'name': customName,
        'baseUrl': customBaseUrl,
        'protocol': _customProtocol,
        if (modelIds.isNotEmpty) 'modelIds': modelIds,
      };
    }
    final endpointId = customEndpoint == null ? _endpointId : _customEndpointId;
    if (endpointId == null) {
      setState(() => _error = 'Choose a direct API endpoint first.');
      return;
    }
    final budgetText = clearApiKey ? '' : _budget.text.trim();
    final balance = budgetText.isEmpty ? null : double.tryParse(budgetText);
    if (budgetText.isNotEmpty && (balance == null || balance < 0)) {
      setState(() => _error = 'Enter a valid local spend budget.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final wallet = await widget.store.configureWallet(
        providerId: widget.providerId,
        endpointId: endpointId,
        modelId: widget.modelId,
        apiKey: clearApiKey ? null : _apiKey.text,
        clearApiKey: clearApiKey,
        setBalance: _budgetMode == 'set' ? balance : null,
        addBalance: _budgetMode == 'add' ? balance : null,
        customEndpoint: customEndpoint,
      );
      _apiKey.clear();
      if (!mounted) return;
      setState(() {
        _wallet = wallet;
        for (final endpoint in wallet.availableEndpoints) {
          _endpoints[endpoint.id] = endpoint.name;
        }
        _endpointId = wallet.endpointId ?? _endpointId;
        if (customEndpoint != null) {
          _endpoints[_customEndpointId] = customName;
          _endpointId = _customEndpointId;
          _customName.clear();
          _customBaseUrl.clear();
          _customModels.clear();
          _customEndpointId = randomId('phone-endpoint');
        }
        _budget.clear();
      });
    } on Object catch (caught) {
      _apiKey.clear();
      if (!mounted) return;
      setState(() => _error = caught
          .toString()
          .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final color =
        _wallet.isDirectApi ? const Color(0xff5aa9ff) : const Color(0xffffa552);
    final caution = _wallet.caution ??
        (_wallet.requiresApiKey
            ? 'An API key is required before this model can run.'
            : null);
    final selectedEndpoint = _wallet.availableEndpoints
        .where((endpoint) => endpoint.id == _endpointId)
        .firstOrNull;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        key: const Key('wallet-source-sheet'),
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.account_balance_wallet_outlined, color: color),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(_walletSourceLabel(_wallet),
                      style: Theme.of(context).textTheme.titleLarge),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(_wallet.detail),
            if (caution != null) ...<Widget>[
              const SizedBox(height: 12),
              Container(
                key: const Key('wallet-key-caution'),
                width: double.infinity,
                padding: const EdgeInsets.all(11),
                decoration: BoxDecoration(
                  color: const Color(0xffffa552).withValues(alpha: .12),
                  border: Border.all(
                      color: const Color(0xffffa552).withValues(alpha: .48)),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Icon(Icons.warning_amber_rounded,
                        size: 19, color: Color(0xffffa552)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(caution)),
                  ],
                ),
              ),
            ],
            if (_wallet.balance != null || _wallet.spent != null) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                <String>[
                  if (_wallet.balance != null)
                    'Budget ${_walletAmount(_wallet.balance!, _wallet.currency)}',
                  if (_wallet.spent != null)
                    'Spent ${_walletAmount(_wallet.spent!, _wallet.currency)}',
                ].join(' · '),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
            if (_wallet.isDirectApi) ...<Widget>[
              const SizedBox(height: 18),
              DropdownButtonFormField<String>(
                key: const Key('wallet-endpoint-selector'),
                initialValue: _endpointId,
                decoration: const InputDecoration(
                  labelText: 'Direct API endpoint',
                  border: OutlineInputBorder(),
                ),
                items: _endpoints.entries
                    .map((entry) => DropdownMenuItem<String>(
                          value: entry.key,
                          child: Text(entry.value),
                        ))
                    .toList(growable: false),
                onChanged: _saving
                    ? null
                    : _refreshingEndpoint
                        ? null
                        : (value) => unawaited(_selectEndpoint(value)),
              ),
              if (_refreshingEndpoint) ...<Widget>[
                const SizedBox(height: 8),
                const LinearProgressIndicator(
                  key: Key('wallet-endpoint-refreshing'),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                key: const Key('wallet-api-key-field'),
                controller: _apiKey,
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: selectedEndpoint?.apiKeyLabel ??
                      _wallet.apiKeyLabel ??
                      'API key',
                  helperText: _wallet.apiKeyConfigured
                      ? 'A key is configured. Enter a new one only to replace it.'
                      : 'The key is sent to your paired computer and is never shown here again.',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                key: const Key('wallet-budget-mode'),
                spacing: 8,
                children: <Widget>[
                  ChoiceChip(
                    label: const Text('Set total'),
                    selected: _budgetMode == 'set',
                    onSelected: _saving
                        ? null
                        : (_) => setState(() => _budgetMode = 'set'),
                  ),
                  ChoiceChip(
                    label: const Text('Add amount'),
                    selected: _budgetMode == 'add',
                    onSelected: _saving
                        ? null
                        : (_) => setState(() => _budgetMode = 'add'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                key: const Key('wallet-local-budget-field'),
                controller: _budget,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  labelText: _budgetMode == 'set'
                      ? 'Set local spend budget (${_wallet.currency})'
                      : 'Add to local spend budget (${_wallet.currency})',
                  helperText: 'A local spend limit, not stored money.',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              ExpansionTile(
                key: const Key('wallet-advanced-settings'),
                tilePadding: EdgeInsets.zero,
                childrenPadding: const EdgeInsets.only(bottom: 6),
                title: const Text('Advanced settings'),
                subtitle: const Text('Add a custom direct API endpoint'),
                children: <Widget>[
                  TextField(
                    key: const Key('wallet-custom-endpoint-name'),
                    controller: _customName,
                    decoration: const InputDecoration(
                      labelText: 'Endpoint name',
                      hintText: 'My gateway',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('wallet-custom-endpoint-url'),
                    controller: _customBaseUrl,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Base URL',
                      hintText: 'https://api.example.com/v1',
                      helperText:
                          'HTTPS is required except for localhost endpoints.',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    key: const Key('wallet-custom-endpoint-protocol'),
                    initialValue: _customProtocol,
                    decoration: const InputDecoration(
                      labelText: 'Protocol',
                      border: OutlineInputBorder(),
                    ),
                    items: const <DropdownMenuItem<String>>[
                      DropdownMenuItem(
                        value: 'responses',
                        child: Text('Responses API'),
                      ),
                      DropdownMenuItem(
                        value: 'chat_completions',
                        child: Text('OpenAI-compatible Chat Completions'),
                      ),
                    ],
                    onChanged: _saving
                        ? null
                        : (value) {
                            if (value != null) {
                              setState(() => _customProtocol = value);
                            }
                          },
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('wallet-custom-endpoint-models'),
                    controller: _customModels,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Model IDs (optional)',
                      hintText: 'model-a, model-b',
                      helperText: 'Separate model IDs with commas.',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ],
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(_error!,
                    key: const Key('wallet-config-error'),
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  TextButton(
                    key: const Key('wallet-clear-key'),
                    onPressed: _saving || _refreshingEndpoint
                        ? null
                        : () => _configure(clearApiKey: true),
                    child: const Text('Clear key'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const Key('wallet-save'),
                    onPressed:
                        _saving || _refreshingEndpoint ? null : _configure,
                    child: _saving
                        ? const SizedBox.square(
                            dimension: 17,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Save'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _walletAmount(double amount, String currency) =>
    '$currency ${amount.toStringAsFixed(2)}';

String _walletSourceLabel(ProviderWalletStatus wallet) => wallet.isDirectApi
    ? 'Direct API'
    : wallet.kind == 'subscription'
        ? 'Subscription'
        : wallet.label;

class _MeshCommandSuggestion extends StatelessWidget {
  const _MeshCommandSuggestion({
    required this.visual,
    required this.onSelected,
  });

  final ProviderVisualTheme visual;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) => Material(
        color: visual.surface.withValues(alpha: 0.92),
        child: InkWell(
          key: const Key('mesh-command-suggestion'),
          onTap: onSelected,
          child: Container(
            padding: const EdgeInsets.fromLTRB(13, 9, 13, 9),
            decoration: BoxDecoration(
              border: Border(
                bottom:
                    BorderSide(color: visual.border.withValues(alpha: 0.72)),
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(Icons.hub_outlined, color: visual.accent, size: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text('/mesh',
                          style: Theme.of(context)
                              .textTheme
                              .bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w600)),
                      Text('Delegate to another connected harness',
                          style: Theme.of(context)
                              .textTheme
                              .labelSmall
                              ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: 0.58))),
                    ],
                  ),
                ),
                const Icon(Icons.keyboard_return_rounded, size: 17),
              ],
            ),
          ),
        ),
      );
}

class _MeshComposerPanel extends StatelessWidget {
  const _MeshComposerPanel({
    required this.targets,
    required this.visual,
    required this.onAdd,
    required this.onEdit,
    required this.onRemove,
  });

  final List<DelegationSelection> targets;
  final ProviderVisualTheme visual;
  final VoidCallback? onAdd;
  final ValueChanged<int> onEdit;
  final ValueChanged<int> onRemove;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    return Container(
      key: const Key('mesh-composer-panel'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: visual.surface.withValues(alpha: 0.72),
        border: Border(
          bottom: BorderSide(color: visual.border.withValues(alpha: 0.78)),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.hub_outlined, size: 15, color: visual.accent),
              const SizedBox(width: 6),
              Text('/mesh delegation',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: visual.accent,
                      )),
              const Spacer(),
              if (onAdd != null)
                TextButton.icon(
                  key: const Key('mesh-add-harness'),
                  onPressed: onAdd,
                  style: TextButton.styleFrom(
                    minimumSize: const Size(0, 28),
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.add_rounded, size: 16),
                  label: const Text('Harness', style: TextStyle(fontSize: 11)),
                ),
            ],
          ),
          const SizedBox(height: 5),
          ...targets.asMap().entries.map((entry) {
            final index = entry.key;
            final target = entry.value;
            final provider = providerVisualThemeFor(target.providerId);
            final modelLabel = (store.modelsByProvider[target.providerId] ??
                        const <RemoteModel>[])
                    .where((model) => model.id == target.modelId)
                    .firstOrNull
                    ?.displayName ??
                target.modelId ??
                'Harness default';
            final details = <String>[
              modelLabel,
              if (target.reasoningEffort != null)
                _effortDisplayLabel(target.reasoningEffort!, target.modelId),
            ];
            return Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Material(
                color: visual.surfaceRaised.withValues(alpha: 0.55),
                shape: RoundedRectangleBorder(
                  side: BorderSide(
                      color: provider.accent.withValues(alpha: 0.32)),
                  borderRadius: BorderRadius.circular(7),
                ),
                child: InkWell(
                  key: ValueKey<String>('mesh-target-${target.providerId}'),
                  onTap: () => onEdit(index),
                  borderRadius: BorderRadius.circular(7),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(9, 7, 3, 7),
                    child: Row(
                      children: <Widget>[
                        ProviderLogo(providerId: target.providerId, size: 27),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(provider.displayName,
                                  style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600)),
                              Text(details.join(' · '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelSmall
                                      ?.copyWith(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurface
                                            .withValues(alpha: 0.58),
                                      )),
                            ],
                          ),
                        ),
                        const Icon(Icons.tune_rounded, size: 16),
                        IconButton(
                          tooltip: 'Remove harness',
                          visualDensity: VisualDensity.compact,
                          onPressed: () => onRemove(index),
                          icon: const Icon(Icons.close_rounded, size: 17),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );
          }),
        ],
      ),
    );
  }
}

class _DelegationTaskCard extends StatelessWidget {
  const _DelegationTaskCard({
    required this.task,
    required this.visual,
    required this.onOpenChild,
  });

  final RemoteDelegationTask task;
  final ProviderVisualTheme visual;
  final ValueChanged<RemoteDelegationChild> onOpenChild;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final active = task.state == 'spawning' ||
        task.state == 'working' ||
        task.state == 'synthesizing';
    return Container(
      key: ValueKey<String>('delegation-task-${task.id}'),
      margin: const EdgeInsets.only(bottom: 9),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(color: visual.accent, width: 2),
          top: BorderSide(color: visual.border.withValues(alpha: 0.52)),
          bottom: BorderSide(color: visual.border.withValues(alpha: 0.52)),
        ),
      ),
      child: Material(
        color: visual.surface.withValues(alpha: 0.5),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.fromLTRB(11, 2, 8, 2),
          childrenPadding: const EdgeInsets.fromLTRB(12, 0, 8, 8),
          leading: active
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 1.8))
              : Icon(task.state == 'completed'
                  ? Icons.check_rounded
                  : Icons.priority_high_rounded),
          title: Text(task.prompt,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style:
                  const TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
          subtitle: Text(
            switch (task.state) {
              'spawning' => 'Starting delegated harnesses',
              'working' => 'Delegated harnesses are working',
              'needs_attention' => 'A delegated harness needs attention',
              'synthesizing' => 'Parent is reading the results',
              'completed' => 'Delegation completed',
              _ => task.error ?? 'Delegation failed',
            },
            style: TextStyle(
                fontSize: 10,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.58)),
          ),
          children: task.children.map((child) {
            final provider = providerVisualThemeFor(child.providerId);
            final modelLabel = (store.modelsByProvider[child.providerId] ??
                        const <RemoteModel>[])
                    .where((model) => model.id == child.modelId)
                    .firstOrNull
                    ?.displayName ??
                child.modelId;
            return InkWell(
              onTap: child.sessionId == null ? null : () => onOpenChild(child),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: <Widget>[
                    ProviderLogo(providerId: child.providerId, size: 25),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(provider.displayName,
                              style: const TextStyle(
                                  fontSize: 11, fontWeight: FontWeight.w600)),
                          Text(
                            <String>[
                              if (modelLabel != null) modelLabel,
                              if (child.reasoningEffort != null)
                                _effortDisplayLabel(
                                    child.reasoningEffort!, child.modelId),
                              _titleCase(child.state),
                            ].join(' · '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                    _AgentStateIcon(state: child.state),
                    if (child.sessionId != null)
                      const Padding(
                        padding: EdgeInsets.only(left: 5),
                        child: Icon(Icons.chevron_right_rounded, size: 18),
                      ),
                  ],
                ),
              ),
            );
          }).toList(growable: false),
        ),
      ),
    );
  }
}

class _SessionControlsBar extends StatelessWidget {
  const _SessionControlsBar({
    required this.visual,
    required this.modelLabel,
    required this.modelEnabled,
    required this.onModelTap,
    required this.wallet,
    required this.onWalletTap,
    required this.reasoningLabel,
    required this.reasoningVisible,
    required this.reasoningEnabled,
    required this.effortIsUltra,
    required this.onReasoningTap,
    required this.visionLabel,
    required this.visionEnabled,
    required this.onVisionTap,
    required this.deliveryLabel,
    required this.onDeliveryTap,
  });

  final ProviderVisualTheme visual;
  final String modelLabel;
  final bool modelEnabled;
  final VoidCallback onModelTap;
  final ProviderWalletStatus? wallet;
  final VoidCallback? onWalletTap;
  final String reasoningLabel;
  final bool reasoningVisible;
  final bool reasoningEnabled;
  final bool effortIsUltra;
  final VoidCallback onReasoningTap;
  final String visionLabel;
  final bool visionEnabled;
  final VoidCallback onVisionTap;
  final String deliveryLabel;
  final VoidCallback onDeliveryTap;

  @override
  Widget build(BuildContext context) {
    final subdued =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.72);
    const ultra = Color(0xffa78bfa);
    return Container(
      key: const Key('session-controls'),
      height: 50,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: visual.surface.withValues(alpha: 0.38),
        border: Border(
            bottom: BorderSide(color: visual.border.withValues(alpha: 0.62))),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: <Widget>[
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 210),
              child: TextButton(
                key: const Key('model-control'),
                onPressed: modelEnabled ? onModelTap : null,
                style: TextButton.styleFrom(
                  foregroundColor: subdued,
                  disabledForegroundColor: subdued,
                  backgroundColor: visual.surfaceRaised.withValues(alpha: .7),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(0, 44),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10)),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(modelLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                    if (modelEnabled) ...<Widget>[
                      const SizedBox(width: 5),
                      const Icon(Icons.expand_more_rounded, size: 18),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: 5),
            if (wallet != null) ...<Widget>[
              Tooltip(
                message: '${_walletSourceLabel(wallet!)}. Tap for details.',
                child: IconButton(
                  key: const Key('wallet-source-control'),
                  onPressed: onWalletTap,
                  padding: EdgeInsets.zero,
                  constraints:
                      const BoxConstraints.tightFor(width: 44, height: 44),
                  style: IconButton.styleFrom(
                    backgroundColor:
                        visual.surfaceRaised.withValues(alpha: .46),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10)),
                  ),
                  color: wallet!.isDirectApi
                      ? const Color(0xff5aa9ff)
                      : const Color(0xffffa552),
                  icon: Icon(
                    wallet!.requiresApiKey
                        ? Icons.warning_amber_rounded
                        : Icons.account_balance_wallet_outlined,
                    size: 20,
                    semanticLabel: _walletSourceLabel(wallet!),
                  ),
                ),
              ),
              const SizedBox(width: 5),
            ],
            if (reasoningVisible) ...<Widget>[
              TextButton(
                key: const Key('reasoning-control'),
                onPressed: reasoningEnabled ? onReasoningTap : null,
                style: TextButton.styleFrom(
                  foregroundColor: effortIsUltra ? ultra : subdued,
                  disabledForegroundColor: effortIsUltra ? ultra : subdued,
                  backgroundColor: visual.surfaceRaised.withValues(alpha: .7),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(0, 44),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(reasoningLabel,
                        style: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w600)),
                    if (reasoningEnabled) ...<Widget>[
                      const SizedBox(width: 4),
                      const Icon(Icons.expand_more_rounded, size: 18),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 5),
            ],
            PopupMenuButton<String>(
              key: const Key('session-secondary-controls'),
              tooltip: 'More task controls',
              constraints: const BoxConstraints(minWidth: 210),
              onSelected: (value) {
                if (value == 'delivery') onDeliveryTap();
                if (value == 'vision') onVisionTap();
              },
              itemBuilder: (_) => <PopupMenuEntry<String>>[
                PopupMenuItem<String>(
                  key: const Key('delivery-control'),
                  value: 'delivery',
                  child: Row(
                    children: <Widget>[
                      Icon(
                        deliveryLabel == 'Steer'
                            ? Icons.alt_route_rounded
                            : Icons.schedule_send_outlined,
                        size: 19,
                      ),
                      const SizedBox(width: 10),
                      Expanded(child: Text(deliveryLabel)),
                    ],
                  ),
                ),
                PopupMenuItem<String>(
                  key: const Key('vision-control'),
                  value: 'vision',
                  enabled: visionEnabled,
                  child: Row(
                    children: <Widget>[
                      const Icon(Icons.visibility_outlined, size: 19),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(visionLabel,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                      ),
                    ],
                  ),
                ),
              ],
              icon: const Icon(Icons.more_horiz_rounded, size: 23),
              style: IconButton.styleFrom(
                foregroundColor: subdued,
                minimumSize: const Size.square(44),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ImageModelNotice extends StatelessWidget {
  const _ImageModelNotice({
    required this.modelName,
    required this.visual,
    required this.onDismiss,
  });

  final String modelName;
  final ProviderVisualTheme visual;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('text-only-image-notice'),
      margin: const EdgeInsets.fromLTRB(10, 1, 10, 3),
      padding: const EdgeInsets.only(left: 9),
      decoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: 0.72),
        border: Border.all(color: visual.border.withValues(alpha: 0.7)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.info_outline_rounded,
              size: 15,
              color: Theme.of(context)
                  .colorScheme
                  .onSurface
                  .withValues(alpha: 0.58)),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              '$modelName is listed as text-only, so it may reject this image.',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontSize: 10,
                    fontWeight: FontWeight.w400,
                    height: 1.25,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.68),
                  ),
            ),
          ),
          IconButton(
            key: const Key('dismiss-text-only-image-notice'),
            tooltip: 'Dismiss',
            onPressed: onDismiss,
            visualDensity: VisualDensity.compact,
            iconSize: 17,
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }
}

class _SessionHistoryError extends StatelessWidget {
  const _SessionHistoryError({
    required this.message,
    this.onRetry,
    this.compact = false,
  });

  final String message;
  final VoidCallback? onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: 18,
          vertical: compact ? 7 : 18,
        ),
        child: Row(
          key: const Key('session-history-error'),
          mainAxisSize: compact ? MainAxisSize.max : MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.sync_problem_rounded,
                size: 18, color: Theme.of(context).colorScheme.error),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                message,
                maxLines: compact ? 2 : 4,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            if (onRetry != null) ...<Widget>[
              const SizedBox(width: 6),
              TextButton(onPressed: onRetry, child: const Text('Retry')),
            ],
          ],
        ),
      ),
    );
  }
}

bool _messageHasFinalContent(RemoteMessage message) => message.parts.any(
      (part) =>
          !part.isAttachment &&
          part.type != 'subagent' &&
          !_isArtifactPart(part) &&
          _messagePartText(part).trim().isNotEmpty &&
          !_isRawMarkupOnly(_messagePartText(part)),
    );

bool _shouldShowAssistantIdentity(List<RemoteMessage> messages, int index) {
  if (index < 0 || index >= messages.length) return false;
  final message = messages[index];
  if (message.role.toLowerCase() != 'assistant') return false;
  var firstInTurn = true;
  for (var cursor = index - 1; cursor >= 0; cursor -= 1) {
    final role = messages[cursor].role.toLowerCase();
    if (role == 'user') break;
    if (role == 'assistant') {
      firstInTurn = false;
      break;
    }
  }
  if (firstInTurn) return true;
  if (!_messageHasFinalContent(message)) return false;
  for (var cursor = index + 1; cursor < messages.length; cursor += 1) {
    final candidate = messages[cursor];
    if (candidate.role.toLowerCase() == 'user') break;
    if (candidate.role.toLowerCase() == 'assistant' &&
        _messageHasFinalContent(candidate)) {
      return false;
    }
  }
  return true;
}

bool _finalFollowsAssistantArtifacts(List<RemoteMessage> messages, int index) {
  if (index < 0 || index >= messages.length) return false;
  final message = messages[index];
  if (message.role.toLowerCase() != 'assistant' ||
      !_messageHasFinalContent(message)) {
    return false;
  }
  for (var cursor = index - 1; cursor >= 0; cursor -= 1) {
    final candidate = messages[cursor];
    final role = candidate.role.toLowerCase();
    if (role == 'user' || role == 'system') break;
    if (role != 'assistant') continue;
    if (_messageHasFinalContent(candidate)) return false;
    if (candidate.parts.any(_isArtifactPart)) return true;
  }
  return false;
}

bool _isConversationBoundary(RemoteMessage message) {
  if (message.role.toLowerCase() == 'system') return true;
  return message.parts.any((part) {
    final metadata = <Object?>[
      part.type,
      part.data['kind'],
      part.data['event'],
      part.data['eventType'],
      part.data['phase'],
    ].whereType<String>().join(' ').toLowerCase();
    return metadata.contains('compact');
  });
}

String _conversationBoundaryLabel(RemoteMessage message) {
  final text = message.parts.map(_messagePartText).join(' ').toLowerCase();
  final metadata = message.parts
      .expand((part) => <Object?>[
            part.type,
            part.data['kind'],
            part.data['event'],
            part.data['eventType'],
            part.data['phase'],
          ])
      .whereType<String>()
      .join(' ')
      .toLowerCase();
  return text.contains('earlier conversation summary') ||
          text.contains('compact') ||
          metadata.contains('compact')
      ? 'Context compacted'
      : 'System context';
}

enum _AssistantTextTone { finalAnswer, commentary, privateReasoning }

enum _MessageAction { copy, edit }

String _copyableMessageText(RemoteMessage message) {
  final role = message.role.toLowerCase();
  if (role != 'user' && role != 'assistant') return '';
  final visible = message.parts
      .where((part) =>
          part.type == 'text' ||
          (role == 'assistant' &&
              part.type == 'reasoning' &&
              part.data['phase'] == 'commentary'))
      .map((part) => _withoutMemoryCitation(_messagePartText(
            part,
            stripAttachmentEnvelope: role == 'user',
          )))
      .where((text) => text.isNotEmpty && !_isRawMarkupOnly(text))
      .join('\n\n')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n')
      .map((line) => line.replaceFirst(RegExp(r'[ \t]+$'), ''))
      .join('\n')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
  return visible;
}

_AssistantTextTone _assistantTextTone(ContentPart part, bool isUser) {
  if (isUser || !_isArtifactPart(part)) {
    return _AssistantTextTone.finalAnswer;
  }
  if (part.type == 'reasoning' && part.data['phase'] != 'commentary') {
    return _AssistantTextTone.privateReasoning;
  }
  return _AssistantTextTone.commentary;
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({
    required this.message,
    required this.visual,
    required this.providerId,
    required this.showIdentity,
    this.streaming = false,
    this.shimmerPrivateReasoning = false,
    this.showFinalBoundary = false,
    this.editEnabled = false,
    this.onLongPress,
    super.key,
  });

  final RemoteMessage message;
  final ProviderVisualTheme visual;
  final String providerId;
  final bool showIdentity;
  final bool streaming;
  final bool shimmerPrivateReasoning;
  final bool showFinalBoundary;
  final bool editEnabled;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role.toLowerCase() == 'user';
    if (_isConversationBoundary(message)) {
      return _ConversationBoundary(
        messageId: message.id,
        label: _conversationBoundaryLabel(message),
      );
    }
    final meshEnvelope = isUser
        ? message.parts
            .where((part) => part.type == 'text')
            .map((part) => part.summary)
            .where((text) => text.startsWith('[[UAR_MESH_RESULT:'))
            .firstOrNull
        : null;
    if (meshEnvelope != null) {
      return _MeshResultContextCard(messageId: message.id, visual: visual);
    }
    final legacyAttachments = isUser
        ? message.parts
            .expand((part) => _legacyAttachmentNames(part.summary))
            .toList(growable: false)
        : const <String>[];
    final hasMemoryContext = !isUser &&
        message.parts.any((part) => _hasMemoryCitation(part.summary));
    final renderedParts = message.parts
        .where((part) => !part.isAttachment && part.type != 'subagent')
        .map((part) => (
              text: _withoutMemoryCitation(
                  _messagePartText(part, stripAttachmentEnvelope: isUser)),
              tone: _assistantTextTone(part, isUser),
            ))
        .where((part) => part.text.isNotEmpty && !_isRawMarkupOnly(part.text))
        .toList(growable: false);
    final attachmentParts = message.parts
        .where((part) => part.isAttachment)
        .toList(growable: false);
    final subagentParts = message.parts
        .where((part) => part.type == 'subagent')
        .toList(growable: false);
    final attachments = attachmentParts.indexed
        .map((entry) => _MessageAttachmentView.fromPart(
              entry.$2,
              fallbackName: entry.$1 < legacyAttachments.length
                  ? legacyAttachments[entry.$1]
                  : null,
            ))
        .toList(growable: false);
    final representedNames =
        attachments.map((attachment) => attachment.name.toLowerCase()).toSet();
    final fallbackAttachments = legacyAttachments
        .where((name) => !representedNames.contains(name.toLowerCase()))
        .map(_MessageAttachmentView.filenameOnly)
        .toList(growable: false);
    final displayedAttachments = <_MessageAttachmentView>[
      ...attachments,
      ...fallbackAttachments,
    ];
    if (renderedParts.isEmpty &&
        displayedAttachments.isEmpty &&
        subagentParts.isEmpty &&
        !hasMemoryContext) {
      return const SizedBox.shrink();
    }
    final newestPrivateReasoningIndex = renderedParts.lastIndexWhere(
      (part) => part.tone == _AssistantTextTone.privateReasoning,
    );
    final firstFinalIndex = renderedParts
        .indexWhere((part) => part.tone == _AssistantTextTone.finalAnswer);
    final hasEarlierArtifactInMessage = firstFinalIndex > 0 &&
        renderedParts
            .take(firstFinalIndex)
            .any((part) => part.tone != _AssistantTextTone.finalAnswer);
    final background = isUser
        ? Color.alphaBlend(
            visual.accent.withValues(alpha: 0.16), visual.surfaceRaised)
        : Colors.transparent;
    final borderColor = isUser
        ? visual.accent.withValues(alpha: 0.34)
        : visual.border.withValues(alpha: 0.76);
    return Align(
      key: ValueKey<String>('message-align-${message.id}'),
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (!isUser)
            SizedBox(
              width: 34,
              child: showIdentity
                  ? Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: ProviderLogo(
                        key: ValueKey<String>(
                            'assistant-identity-${message.id}'),
                        providerId: providerId,
                        size: 22,
                      ),
                    )
                  : null,
            ),
          Flexible(
            child: Column(
              crossAxisAlignment:
                  isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onLongPress: onLongPress,
                  child: AbsorbPointer(
                    absorbing: editEnabled &&
                        !displayedAttachments
                            .any((attachment) => attachment.imageUri != null),
                    child: Container(
                      key: ValueKey<String>('message-bubble-${message.id}'),
                      constraints: BoxConstraints(
                          maxWidth: MediaQuery.sizeOf(context).width *
                              (isUser ? 0.78 : 0.82)),
                      margin: const EdgeInsets.symmetric(vertical: 5),
                      padding: isUser
                          ? const EdgeInsets.fromLTRB(13, 10, 13, 8)
                          : const EdgeInsets.fromLTRB(4, 7, 5, 5),
                      decoration: BoxDecoration(
                        color: background,
                        border: isUser ? Border.all(color: borderColor) : null,
                        borderRadius: isUser
                            ? const BorderRadius.only(
                                topLeft: Radius.circular(8),
                                topRight: Radius.circular(2),
                                bottomLeft: Radius.circular(8),
                                bottomRight: Radius.circular(8),
                              )
                            : null,
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          ...displayedAttachments.indexed.map((entry) =>
                              Padding(
                                padding: EdgeInsets.only(
                                    bottom: renderedParts.isNotEmpty ||
                                            subagentParts.isNotEmpty ||
                                            entry.$1 <
                                                displayedAttachments.length - 1
                                        ? 8
                                        : 0),
                                child: entry.$2.imageUri == null
                                    ? _AttachmentFileLabel(
                                        key: ValueKey<String>(
                                            'message-file-${message.id}-${entry.$1}'),
                                        attachment: entry.$2,
                                        visual: visual,
                                      )
                                    : ClipRRect(
                                        key: ValueKey<String>(
                                            'message-image-${message.id}-${entry.$1}'),
                                        borderRadius: BorderRadius.circular(5),
                                        child: _ExpandableMessageImage(
                                          imageUri: entry.$2.imageUri!,
                                          name: entry.$2.name,
                                          fit: BoxFit.cover,
                                          width: 260,
                                          height: 170,
                                          cacheWidth: 520,
                                          fallback: _AttachmentFileLabel(
                                            attachment: entry.$2,
                                            visual: visual,
                                          ),
                                        ),
                                      ),
                              )),
                          if (subagentParts.isNotEmpty)
                            Padding(
                              padding: EdgeInsets.only(
                                  bottom: renderedParts.isNotEmpty ? 8 : 0),
                              child: _SubagentActivityGroup(
                                key: ValueKey<String>(
                                    'subagent-activity-group-${message.id}'),
                                parts: subagentParts,
                                visual: visual,
                              ),
                            ),
                          ...renderedParts.indexed.map((entry) {
                            final privateReasoning = entry.$2.tone ==
                                _AssistantTextTone.privateReasoning;
                            final commentary =
                                entry.$2.tone == _AssistantTextTone.commentary;
                            final style = Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(
                                  height: 1.42,
                                  color: privateReasoning
                                      ? Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.56)
                                      : commentary
                                          ? Theme.of(context)
                                              .colorScheme
                                              .onSurface
                                              .withValues(alpha: 0.82)
                                          : null,
                                  fontStyle: privateReasoning
                                      ? FontStyle.italic
                                      : FontStyle.normal,
                                  fontWeight: FontWeight.w400,
                                );
                            final artifact =
                                entry.$2.tone != _AssistantTextTone.finalAnswer;
                            final activePrivateReasoning = streaming &&
                                shimmerPrivateReasoning &&
                                privateReasoning &&
                                entry.$1 == newestPrivateReasoningIndex;
                            final text = artifact
                                ? _ArtifactMessageText(
                                    key: activePrivateReasoning
                                        ? ValueKey<String>(
                                            'artifact-shimmer-${message.id}')
                                        : null,
                                    text: entry.$2.text,
                                    style: style,
                                    visual: visual,
                                    active: activePrivateReasoning,
                                  )
                                : _SafeMessageMarkdown(
                                    text: entry.$2.text,
                                    style: style,
                                    visual: visual,
                                  );
                            return Padding(
                              padding: EdgeInsets.only(
                                  bottom: entry.$1 == renderedParts.length - 1
                                      ? 0
                                      : 7),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (entry.$1 == firstFinalIndex &&
                                      (showFinalBoundary ||
                                          hasEarlierArtifactInMessage))
                                    _FinalAnswerDivider(
                                      messageId: message.id,
                                    ),
                                  text,
                                ],
                              ),
                            );
                          }),
                          if (hasMemoryContext) ...<Widget>[
                            if (renderedParts.isNotEmpty ||
                                displayedAttachments.isNotEmpty ||
                                subagentParts.isNotEmpty)
                              const SizedBox(height: 8),
                            _MemoryContextIndicator(visual: visual),
                          ],
                          if (streaming) ...<Widget>[
                            const SizedBox(height: 6),
                            SizedBox.square(
                              dimension: 10,
                              child: CircularProgressIndicator(
                                  strokeWidth: 1.5, color: visual.accent),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ConversationBoundary extends StatelessWidget {
  const _ConversationBoundary({
    required this.messageId,
    required this.label,
  });

  final String messageId;
  final String label;

  @override
  Widget build(BuildContext context) {
    final color =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.42);
    return Semantics(
      key: ValueKey<String>('conversation-boundary-$messageId'),
      container: true,
      label: label,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 34, vertical: 10),
        child: Row(
          children: <Widget>[
            Expanded(
                child: Divider(height: 1, color: color.withValues(alpha: .5))),
            const SizedBox(width: 8),
            Icon(Icons.compress_rounded, size: 14, color: color),
            const SizedBox(width: 5),
            ExcludeSemantics(
              child: Text(
                label,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: color,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500,
                    ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
                child: Divider(height: 1, color: color.withValues(alpha: .5))),
          ],
        ),
      ),
    );
  }
}

class _FinalAnswerDivider extends StatelessWidget {
  const _FinalAnswerDivider({required this.messageId});

  final String messageId;

  @override
  Widget build(BuildContext context) => Semantics(
        key: ValueKey<String>('final-answer-boundary-$messageId'),
        container: true,
        label: 'Final answer',
        child: ExcludeSemantics(
          child: Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 9, right: 28),
            child: Divider(
              height: 1,
              thickness: .7,
              color: Theme.of(context)
                  .colorScheme
                  .onSurface
                  .withValues(alpha: .18),
            ),
          ),
        ),
      );
}

bool _isSafeMarkdownUri(Uri? uri) =>
    uri != null &&
    (uri.scheme == 'https' || uri.scheme == 'http') &&
    uri.host.isNotEmpty;

Future<void> _openMarkdownLink(BuildContext context, String? href) async {
  final uri = href == null ? null : Uri.tryParse(href);
  if (!_isSafeMarkdownUri(uri)) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('This link type is blocked.')),
    );
    return;
  }
  try {
    final opened = await launchUrl(uri!, mode: LaunchMode.externalApplication);
    if (!opened && context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That link could not be opened.')),
      );
    }
  } on Object {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That link could not be opened.')),
      );
    }
  }
}

class _SafeMessageMarkdown extends StatelessWidget {
  const _SafeMessageMarkdown({
    required this.text,
    required this.style,
    required this.visual,
  });

  final String text;
  final TextStyle? style;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body =
        style ?? theme.textTheme.bodyMedium ?? const TextStyle(fontSize: 15);
    final subdued = theme.colorScheme.onSurface.withValues(alpha: .66);
    final code = body.copyWith(
      color: theme.colorScheme.onSurface.withValues(alpha: .92),
      fontFamily: 'monospace',
      fontSize: 13.5,
      height: 1.38,
    );
    final sheet = MarkdownStyleSheet(
      a: body.copyWith(
        color: visual.accent,
        decoration: TextDecoration.underline,
        decorationColor: visual.accent.withValues(alpha: .58),
      ),
      p: body,
      pPadding: EdgeInsets.zero,
      code: code.copyWith(
        backgroundColor: visual.surfaceRaised.withValues(alpha: .68),
      ),
      h1: body.copyWith(
          fontSize: 22, height: 1.22, fontWeight: FontWeight.w700),
      h1Padding: const EdgeInsets.only(top: 3, bottom: 6),
      h2: body.copyWith(
          fontSize: 19, height: 1.25, fontWeight: FontWeight.w700),
      h2Padding: const EdgeInsets.only(top: 3, bottom: 5),
      h3: body.copyWith(
          fontSize: 17, height: 1.28, fontWeight: FontWeight.w600),
      h3Padding: const EdgeInsets.only(top: 2, bottom: 4),
      h4: body.copyWith(
          fontSize: 15.5, height: 1.32, fontWeight: FontWeight.w600),
      h4Padding: const EdgeInsets.only(top: 2, bottom: 3),
      h5: body.copyWith(
          fontSize: 15, height: 1.34, fontWeight: FontWeight.w600),
      h5Padding: const EdgeInsets.only(top: 2, bottom: 3),
      h6: body.copyWith(
          fontSize: 15, height: 1.34, fontWeight: FontWeight.w500),
      h6Padding: const EdgeInsets.only(top: 2, bottom: 3),
      em: body.copyWith(fontStyle: FontStyle.italic),
      strong: body.copyWith(fontWeight: FontWeight.w700),
      del: body.copyWith(decoration: TextDecoration.lineThrough),
      blockSpacing: 8,
      listIndent: 22,
      listBullet: body.copyWith(color: subdued),
      listBulletPadding: const EdgeInsets.only(right: 5),
      blockquote: body.copyWith(color: subdued),
      blockquotePadding: const EdgeInsets.fromLTRB(11, 3, 4, 3),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: visual.accent.withValues(alpha: .46),
            width: 1.5,
          ),
        ),
      ),
      codeblockPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      codeblockDecoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: .72),
        border: Border.all(color: visual.border.withValues(alpha: .74)),
        borderRadius: BorderRadius.circular(6),
      ),
      tableHead: body.copyWith(fontSize: 14, fontWeight: FontWeight.w700),
      tableBody: body.copyWith(fontSize: 14, height: 1.32),
      tableHeadAlign: TextAlign.left,
      tablePadding: const EdgeInsets.only(bottom: 5),
      tableBorder: TableBorder.all(
        color: visual.border.withValues(alpha: .78),
        width: .7,
      ),
      tableColumnWidth: const IntrinsicColumnWidth(),
      tableScrollbarThumbVisibility: true,
      tableCellsPadding:
          const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      tableCellsDecoration: const BoxDecoration(),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(
            color: theme.colorScheme.onSurface.withValues(alpha: .18),
            width: .7,
          ),
        ),
      ),
    );
    // This renderer has no WebView/HTML execution path. Markdown images are
    // also replaced with inert references so remote content never loads itself.
    return MarkdownBody(
      data: text,
      selectable: true,
      styleSheet: sheet,
      fitContent: true,
      onTapLink: (label, href, title) =>
          unawaited(_openMarkdownLink(context, href)),
      imageBuilder: (uri, title, alt) => _MarkdownImageReference(
        uri: uri,
        label: alt?.trim().isNotEmpty == true ? alt!.trim() : 'Image link',
        visual: visual,
      ),
    );
  }
}

class _MarkdownImageReference extends StatelessWidget {
  const _MarkdownImageReference({
    required this.uri,
    required this.label,
    required this.visual,
  });

  final Uri uri;
  final String label;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final safe = _isSafeMarkdownUri(uri);
    final color = safe
        ? visual.accent.withValues(alpha: .8)
        : Theme.of(context).colorScheme.onSurface.withValues(alpha: .5);
    return Semantics(
      button: safe,
      label: safe ? 'Open image link: $label' : 'Blocked image link: $label',
      child: InkWell(
        key: ValueKey<String>('markdown-image-reference-$uri'),
        onTap: safe
            ? () => unawaited(_openMarkdownLink(context, uri.toString()))
            : null,
        borderRadius: BorderRadius.circular(4),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 1),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(safe ? Icons.image_outlined : Icons.block_rounded,
                  size: 15, color: color),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  safe ? label : '$label (blocked)',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: color,
                        decoration: safe ? TextDecoration.underline : null,
                      ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MemoryContextIndicator extends StatelessWidget {
  const _MemoryContextIndicator({required this.visual});

  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final color =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.56);
    return Container(
      key: const Key('memory-context-indicator'),
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(
              color: visual.accent.withValues(alpha: 0.52), width: 1.5),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.history_rounded, size: 14, color: color),
          const SizedBox(width: 5),
          Text(
            'Used saved context',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: color,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.1,
                ),
          ),
        ],
      ),
    );
  }
}

class _MeshResultContextCard extends StatelessWidget {
  const _MeshResultContextCard({
    required this.messageId,
    required this.visual,
  });

  final String messageId;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) => Container(
        key: ValueKey<String>('mesh-result-context-$messageId'),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        decoration: BoxDecoration(
          color: visual.surface.withValues(alpha: 0.45),
          border: Border(
            left: BorderSide(color: visual.accent, width: 2),
            bottom: BorderSide(color: visual.border.withValues(alpha: 0.48)),
          ),
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.hub_outlined, size: 17, color: visual.accent),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Delegated results returned to the parent',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w500,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.7),
                    ),
              ),
            ),
          ],
        ),
      );
}

class _ArtifactMessageText extends StatefulWidget {
  const _ArtifactMessageText({
    required this.text,
    required this.style,
    required this.visual,
    required this.active,
    super.key,
  });

  final String text;
  final TextStyle? style;
  final ProviderVisualTheme visual;
  final bool active;

  @override
  State<_ArtifactMessageText> createState() => _ArtifactMessageTextState();
}

class _ArtifactMessageTextState extends State<_ArtifactMessageText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _animationsDisabled = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1900),
    );
  }

  void _syncAnimation() {
    if (widget.active && !_animationsDisabled) {
      if (!_controller.isAnimating) unawaited(_controller.repeat());
    } else {
      _controller
        ..stop()
        ..value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animationsDisabled = MediaQuery.disableAnimationsOf(context);
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _ArtifactMessageText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active != oldWidget.active) _syncAnimation();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active || _animationsDisabled) {
      return _SafeMessageMarkdown(
        text: widget.text,
        style: widget.style,
        visual: widget.visual,
      );
    }
    final base = widget.style?.color ??
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.64);
    final edgeHighlight = Color.lerp(base, widget.visual.accent, 0.3)!;
    final centerHighlight =
        Color.lerp(Colors.white, widget.visual.accent, 0.2)!;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) => ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (bounds) {
          final offset = -2 + (_controller.value * 4);
          return LinearGradient(
            begin: Alignment(offset - 1, 0),
            end: Alignment(offset + 1, 0),
            colors: <Color>[
              base,
              base,
              edgeHighlight,
              centerHighlight,
              edgeHighlight,
              base,
              base,
            ],
            stops: const <double>[0, 0.2, 0.38, 0.5, 0.62, 0.8, 1],
          ).createShader(bounds);
        },
        child: child,
      ),
      child: _SafeMessageMarkdown(
        text: widget.text,
        style: widget.style?.copyWith(color: Colors.white),
        visual: widget.visual,
      ),
    );
  }
}

class _AttachmentFileLabel extends StatelessWidget {
  const _AttachmentFileLabel(
      {required this.attachment, required this.visual, super.key});

  final _MessageAttachmentView attachment;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: 0.72),
        border: Border.all(color: visual.border.withValues(alpha: 0.76)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            attachment.isImage
                ? Icons.image_outlined
                : Icons.insert_drive_file_outlined,
            size: 17,
            color: visual.accent.withValues(alpha: 0.82),
          ),
          const SizedBox(width: 7),
          Flexible(
            child: Text(
              attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w500,
                  ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SubagentActivityGroup extends StatefulWidget {
  const _SubagentActivityGroup({
    required this.parts,
    required this.visual,
    super.key,
  });

  final List<ContentPart> parts;
  final ProviderVisualTheme visual;

  @override
  State<_SubagentActivityGroup> createState() => _SubagentActivityGroupState();
}

class _SubagentActivityGroupState extends State<_SubagentActivityGroup> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final activeParts = widget.parts.where(_isActiveSubagentPart).toList();
    final activeReceiverIds = activeParts
        .expand((part) => jsonList(part.data['receiverSessionIds']))
        .whereType<String>()
        .toSet();
    final activeCount = activeReceiverIds.isNotEmpty
        ? activeReceiverIds.length
        : activeParts.length;
    final label = activeCount > 0
        ? '$activeCount ${activeCount == 1 ? 'agent' : 'agents'} active'
        : 'Agent activity';
    final overallState = activeCount > 0 ? 'working' : 'completed';
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 300),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(
            button: true,
            label: label,
            hint: _expanded ? 'Hide agent details' : 'Show agent details',
            child: InkWell(
              key: const Key('agent-activity-toggle'),
              borderRadius: BorderRadius.circular(5),
              overlayColor: WidgetStatePropertyAll(
                  widget.visual.accent.withValues(alpha: 0.08)),
              onTap: () => setState(() => _expanded = !_expanded),
              child: SizedBox(
                height: 44,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    _AgentStateIcon(state: overallState),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 20,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.62),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            ...widget.parts.indexed.map((entry) => _SubagentActivityDetail(
                  key: ValueKey<String>('subagent-activity-detail-${entry.$1}'),
                  part: entry.$2,
                )),
        ],
      ),
    );
  }
}

bool _isActiveSubagentPart(ContentPart part) {
  final status = optionalString(part.data, 'status');
  return status == 'running' || status == 'working' || status == 'pending';
}

class _SubagentActivityDetail extends StatelessWidget {
  const _SubagentActivityDetail({required this.part, super.key});

  final ContentPart part;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final receiverIds =
        jsonList(part.data['receiverSessionIds']).whereType<String>().toSet();
    final receiver = store.sessions
        .where((session) => receiverIds.contains(session.id))
        .firstOrNull;
    final action = optionalString(part.data, 'action') ?? 'unknown';
    final status = optionalString(part.data, 'status') ?? 'unknown';
    final summary = optionalString(part.data, 'summary');
    final tool = optionalString(part.data, 'tool');
    final title = summary ?? _subagentActionLabel(action, tool);
    final receiverLabel = receiver?.agentNickname ??
        receiver?.agentRole ??
        (receiverIds.length > 1 ? '${receiverIds.length} agents' : null);
    return Semantics(
      label: '$title, ${_titleCase(status)}',
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Row(
          children: <Widget>[
            const SizedBox(width: 2),
            _AgentStateIcon(state: status == 'running' ? 'working' : status),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.w500,
                        ),
                  ),
                  if (receiverLabel != null)
                    Text(
                      receiverLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.54),
                          ),
                    ),
                ],
              ),
            ),
            if (receiver != null)
              TextButton(
                key: ValueKey<String>('view-subagent-${receiver.id}'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 7),
                  minimumSize: const Size(44, 44),
                ),
                onPressed: () async {
                  store.openSessionForView(receiver);
                  if (!context.mounted) return;
                  await Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => SessionScreen(sessionId: receiver.id),
                  ));
                },
                child: const Text('View'),
              ),
          ],
        ),
      ),
    );
  }
}

String _subagentActionLabel(String action, String? tool) => switch (action) {
      'spawn' => 'Started an agent',
      'message' => 'Sent an agent message',
      'wait' => 'Waiting for an agent',
      'interrupt' => 'Interrupted an agent',
      'list' => 'Checked agent activity',
      _ => tool?.trim().isNotEmpty == true ? tool! : 'Agent activity',
    };

class _QueuedInstructionCard extends StatefulWidget {
  const _QueuedInstructionCard({
    required this.message,
    required this.visual,
    required this.onCancel,
  });

  final RemoteQueuedMessage message;
  final ProviderVisualTheme visual;
  final VoidCallback onCancel;

  @override
  State<_QueuedInstructionCard> createState() => _QueuedInstructionCardState();
}

class _QueuedInstructionCardState extends State<_QueuedInstructionCard> {
  bool _expanded = false;

  @override
  void didUpdateWidget(covariant _QueuedInstructionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.message.id != widget.message.id) _expanded = false;
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.message;
    final visual = widget.visual;
    final failed = message.state == 'failed';
    final sending = message.state == 'sending';
    final label = failed
        ? 'COULD NOT SEND'
        : sending
            ? 'SENDING NEXT'
            : 'QUEUED NEXT';
    final color = failed ? Theme.of(context).colorScheme.error : visual.accent;
    return Container(
      key: ValueKey<String>('queued-instruction-${message.id}'),
      margin: const EdgeInsets.only(top: 7, bottom: 3),
      padding: const EdgeInsets.fromLTRB(11, 9, 4, 9),
      decoration: BoxDecoration(
        color: visual.surface.withValues(alpha: 0.34),
        border: Border(
          left: BorderSide(color: color.withValues(alpha: 0.88), width: 2),
          top: BorderSide(color: visual.border.withValues(alpha: 0.42)),
          bottom: BorderSide(color: visual.border.withValues(alpha: 0.42)),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: sending
                ? SizedBox.square(
                    dimension: 15,
                    child: CircularProgressIndicator(
                        strokeWidth: 1.7, color: color))
                : Icon(Icons.schedule_send_outlined, size: 17, color: color),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: color,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.7,
                        )),
                const SizedBox(height: 3),
                Text(message.content,
                    maxLines: _expanded ? null : 4,
                    overflow: _expanded
                        ? TextOverflow.visible
                        : TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontSize: 12.5,
                          height: 1.35,
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.82),
                        )),
                if (message.content.length > 220)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      key: ValueKey<String>('expand-queued-${message.id}'),
                      onPressed: () => setState(() => _expanded = !_expanded),
                      style: TextButton.styleFrom(
                        foregroundColor: color.withValues(alpha: 0.86),
                        minimumSize: const Size(44, 44),
                        padding: const EdgeInsets.only(right: 8),
                        visualDensity: VisualDensity.compact,
                      ),
                      child: Text(_expanded ? 'Collapse' : 'Show full'),
                    ),
                  ),
                if (message.attachments.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 5),
                  Wrap(
                    spacing: 8,
                    runSpacing: 3,
                    children: message.attachments
                        .map((attachment) => Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                Icon(
                                    attachment.mimeType.startsWith('image/')
                                        ? Icons.image_outlined
                                        : Icons.insert_drive_file_outlined,
                                    size: 13,
                                    color: color.withValues(alpha: 0.72)),
                                const SizedBox(width: 3),
                                Text(
                                  attachment.name,
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelSmall
                                      ?.copyWith(fontSize: 12),
                                ),
                              ],
                            ))
                        .toList(growable: false),
                  ),
                ],
                if (message.error?.isNotEmpty == true) ...<Widget>[
                  const SizedBox(height: 4),
                  Text(message.error!,
                      style: Theme.of(context)
                          .textTheme
                          .labelSmall
                          ?.copyWith(color: color)),
                ],
              ],
            ),
          ),
          if (!sending)
            IconButton(
              key: ValueKey<String>('cancel-queued-${message.id}'),
              tooltip: 'Remove queued instruction',
              visualDensity: VisualDensity.compact,
              onPressed: widget.onCancel,
              icon: const Icon(Icons.close_rounded, size: 17),
            ),
        ],
      ),
    );
  }
}

class _ActivityEventGroup {
  const _ActivityEventGroup(this.events);

  final List<AgentEvent> events;
}

enum _ActivityKind {
  read,
  write,
  edit,
  run,
  search,
  browse,
  agent,
  error,
  tool
}

class _ActivityPresentation {
  const _ActivityPresentation({
    required this.kind,
    required this.label,
    required this.snippet,
    this.target,
  });

  final _ActivityKind kind;
  final String label;
  final String? target;
  final String snippet;
}

class _ReasoningActivityGroup extends StatefulWidget {
  const _ReasoningActivityGroup({
    required this.groups,
    required this.visual,
    required this.working,
  });

  final List<_ActivityEventGroup> groups;
  final ProviderVisualTheme visual;
  final bool working;

  @override
  State<_ReasoningActivityGroup> createState() =>
      _ReasoningActivityGroupState();
}

class _ReasoningActivityGroupState extends State<_ReasoningActivityGroup> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final motionDisabled = MediaQuery.disableAnimationsOf(context);
    final labelStyle = Theme.of(context).textTheme.bodyMedium?.copyWith(
          color:
              Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.64),
          fontWeight: FontWeight.w500,
        );
    return Padding(
      padding: const EdgeInsets.only(left: 34, right: 4, top: 2, bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(
            button: true,
            expanded: _expanded,
            label:
                _expanded ? 'Hide reasoning actions' : 'Show reasoning actions',
            child: InkWell(
              key: const Key('reasoning-activity-toggle'),
              borderRadius: BorderRadius.circular(6),
              onTap: () => setState(() => _expanded = !_expanded),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: _ArtifactMessageText(
                        text: 'Reasoning',
                        style: labelStyle,
                        visual: widget.visual,
                        active: widget.working,
                      ),
                    ),
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 21,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.56),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: motionDisabled
                ? Duration.zero
                : const Duration(milliseconds: 160),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: _expanded
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: widget.groups
                        .map((group) => _EventCard(
                              key: ValueKey<String>(
                                  'activity-${group.events.first.eventId}'),
                              group: group,
                              visual: widget.visual,
                            ))
                        .toList(growable: false),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}

class _EventCard extends StatefulWidget {
  const _EventCard({
    required this.group,
    required this.visual,
    super.key,
  });

  final _ActivityEventGroup group;
  final ProviderVisualTheme visual;

  @override
  State<_EventCard> createState() => _EventCardState();
}

class _EventCardState extends State<_EventCard> {
  bool _expanded = false;
  bool _enlarged = false;

  void _collapse() => setState(() {
        _expanded = false;
        _enlarged = false;
      });

  @override
  Widget build(BuildContext context) {
    final presentation = _activityPresentation(widget.group);
    final hasSnippet = presentation.snippet.isNotEmpty;
    final longSnippet = _isLongActivitySnippet(presentation.snippet);
    final motionDisabled = MediaQuery.disableAnimationsOf(context);
    final targetColor =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.58);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          button: hasSnippet,
          expanded: hasSnippet ? _expanded : null,
          label: <String>[
            presentation.label,
            if (presentation.target != null) presentation.target!,
            if (hasSnippet) _expanded ? 'Collapse details' : 'Expand details',
          ].join(', '),
          child: InkWell(
            key: ValueKey<String>(
                'activity-disclosure-${widget.group.events.first.eventId}'),
            borderRadius: BorderRadius.circular(6),
            onTap: hasSnippet
                ? () => setState(() => _expanded = !_expanded)
                : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Row(
                children: <Widget>[
                  SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: Icon(
                        _activityIcon(presentation.kind),
                        size: 18,
                        color: widget.visual.accent.withValues(alpha: 0.86),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    presentation.label,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                  if (presentation.target != null) ...<Widget>[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        presentation.target!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: targetColor,
                              fontSize: 12.5,
                            ),
                      ),
                    ),
                  ] else
                    const Spacer(),
                  if (hasSnippet)
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 20,
                      color: targetColor,
                    ),
                ],
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: motionDisabled
              ? Duration.zero
              : const Duration(milliseconds: 160),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topCenter,
          child: _expanded
              ? _ActivitySnippet(
                  key: ValueKey<String>(
                      'activity-snippet-${widget.group.events.first.eventId}'),
                  text: presentation.snippet,
                  enlarged: _enlarged,
                  canResize: longSnippet,
                  visual: widget.visual,
                  onCollapse: _collapse,
                  onResize: () => setState(() => _enlarged = !_enlarged),
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }
}

class _ActivitySnippet extends StatelessWidget {
  const _ActivitySnippet({
    required this.text,
    required this.enlarged,
    required this.canResize,
    required this.visual,
    required this.onCollapse,
    required this.onResize,
    super.key,
  });

  final String text;
  final bool enlarged;
  final bool canResize;
  final ProviderVisualTheme visual;
  final VoidCallback onCollapse;
  final VoidCallback onResize;

  @override
  Widget build(BuildContext context) {
    final lineCount = '\n'.allMatches(text).length + 1;
    final compactHeight = (lineCount * 19 + 104).clamp(168, 320).toDouble();
    final largeHeight = (MediaQuery.sizeOf(context).height * 0.68)
        .clamp(compactHeight, 560)
        .toDouble();
    final height = enlarged ? largeHeight : compactHeight;
    final muted =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.68);
    return Padding(
      padding: const EdgeInsets.only(left: 2, right: 2, bottom: 8),
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: visual.surface.withValues(alpha: 0.72),
          border: Border.all(color: visual.border.withValues(alpha: 0.72)),
          borderRadius: BorderRadius.circular(8),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            SizedBox(
              height: 44,
              child: Row(
                children: <Widget>[
                  TextButton.icon(
                    key: const Key('activity-collapse-top'),
                    onPressed: onCollapse,
                    icon: const Icon(Icons.keyboard_arrow_up_rounded, size: 19),
                    label: const Text('Collapse'),
                  ),
                  const Spacer(),
                  if (canResize)
                    IconButton(
                      key: const Key('activity-resize-snippet'),
                      tooltip: enlarged ? 'Reduce snippet' : 'Enlarge snippet',
                      onPressed: onResize,
                      icon: Icon(
                        enlarged
                            ? Icons.close_fullscreen_rounded
                            : Icons.open_in_full_rounded,
                        size: 18,
                      ),
                    ),
                ],
              ),
            ),
            Divider(height: 1, color: visual.border.withValues(alpha: 0.6)),
            Expanded(
              child: Scrollbar(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SelectableText(
                      text,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurface,
                        fontFamily: 'monospace',
                        fontSize: 13,
                        height: 1.45,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Divider(height: 1, color: visual.border.withValues(alpha: 0.6)),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                key: const Key('activity-collapse-bottom'),
                onPressed: onCollapse,
                style: TextButton.styleFrom(foregroundColor: muted),
                icon: const Icon(Icons.keyboard_arrow_up_rounded, size: 19),
                label: const Text('Collapse'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

List<_ActivityEventGroup> _groupConversationActivity(List<AgentEvent> events) {
  final grouped = <List<AgentEvent>>[];
  for (final event in events) {
    final phase = event.type.split('.').last;
    final family = _activityEventFamily(event);
    final operationId = _activityOperationId(event);
    var match = -1;
    if (phase != 'started') {
      for (var index = grouped.length - 1; index >= 0; index -= 1) {
        final candidate = grouped[index];
        if (_activityGroupFinished(candidate) ||
            _activityEventFamily(candidate.first) != family) {
          continue;
        }
        final candidateId = _activityOperationId(candidate.first);
        if (operationId == null ||
            candidateId == null ||
            operationId == candidateId) {
          match = index;
          break;
        }
      }
    }
    if (match < 0) {
      grouped.add(<AgentEvent>[event]);
    } else {
      grouped[match].add(event);
    }
  }
  return grouped
      .map((events) =>
          _ActivityEventGroup(List<AgentEvent>.unmodifiable(events)))
      .toList(growable: false);
}

bool _activityGroupFinished(List<AgentEvent> events) {
  final type = events.last.type;
  return type.endsWith('.completed') || type.contains('error');
}

String _activityEventFamily(AgentEvent event) => event.type.split('.').first;

String? _activityOperationId(AgentEvent event) => _activityString(
      event.payload,
      const <String>{
        'callId',
        'call_id',
        'toolCallId',
        'tool_call_id',
        'itemId'
      },
      allowGenericId: true,
    );

_ActivityPresentation _activityPresentation(_ActivityEventGroup group) {
  final kind = _activityKind(group);
  final snippet = _activitySnippetText(group);
  return _ActivityPresentation(
    kind: kind,
    label: switch (kind) {
      _ActivityKind.read => 'Read',
      _ActivityKind.write => 'Write',
      _ActivityKind.edit => 'Edit',
      _ActivityKind.run => 'Run',
      _ActivityKind.search => 'Search',
      _ActivityKind.browse => 'Browse',
      _ActivityKind.agent => 'Delegate',
      _ActivityKind.error => 'Issue',
      _ActivityKind.tool => 'Tool',
    },
    target: _activityTarget(group, snippet),
    snippet: snippet,
  );
}

_ActivityKind _activityKind(_ActivityEventGroup group) {
  final type = group.events.first.type.toLowerCase();
  if (type.contains('error')) return _ActivityKind.error;
  if (type.startsWith('command.')) return _ActivityKind.run;
  if (type.startsWith('file.')) return _ActivityKind.edit;
  final name = _activityToolName(group).toLowerCase().replaceAll(
        RegExp(r'[^a-z0-9]+'),
        '_',
      );
  final description = '$name ${_activitySnippetText(group)}'.toLowerCase();
  if (RegExp(r'(^|_)(read|read_file|view|open_file|inspect)($|_)')
          .hasMatch(name) ||
      RegExp(r'\b(read|inspect(?:ing|ed)?|view(?:ing|ed)?|opened?)\b')
          .hasMatch(description)) {
    return _ActivityKind.read;
  }
  if (RegExp(r'(^|_)(write|write_file|create_file|save)($|_)').hasMatch(name)) {
    return _ActivityKind.write;
  }
  if (RegExp(r'(^|_)(edit|patch|apply_patch|replace|update_file)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.edit;
  }
  if (RegExp(r'(^|_)(bash|shell|exec|execute|command|terminal)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.run;
  }
  if (RegExp(r'(^|_)(search|grep|find|glob|query)($|_)').hasMatch(name)) {
    return _ActivityKind.search;
  }
  if (RegExp(r'(^|_)(browser|web|navigate|screenshot|page)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.browse;
  }
  if (RegExp(
          r'(^|_)(spawn_agent|send_message|wait_agent|delegate|subagent)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.agent;
  }
  if (type.startsWith('agent.')) return _ActivityKind.agent;
  return _ActivityKind.tool;
}

String _activityToolName(_ActivityEventGroup group) {
  for (final event in group.events) {
    final name = _activityString(
      event.payload,
      const <String>{'tool', 'name', 'toolName', 'tool_name'},
    );
    if (name != null) return name;
  }
  return group.events.first.type.split('.').first;
}

String? _activityTarget(_ActivityEventGroup group, String snippet) {
  String? path;
  for (final event in group.events) {
    path ??= _activityString(
      event.payload,
      const <String>{'path', 'filePath', 'file_path', 'filename'},
    );
  }
  path ??= RegExp(r'<path>([^<]+)</path>', caseSensitive: false)
      .firstMatch(snippet)
      ?.group(1)
      ?.trim();
  final lines = _activityLineRange(group, snippet);
  if (path != null && path.isNotEmpty) {
    final compactPath = _compactActivityPath(path);
    return lines == null ? compactPath : '$compactPath · $lines';
  }
  final kind = _activityKind(group);
  if (kind == _ActivityKind.run) {
    for (final event in group.events) {
      final command = _activityString(
        event.payload,
        const <String>{'command'},
      );
      if (command != null) return _compactActivityTarget(command);
    }
  }
  if (kind == _ActivityKind.search) {
    for (final event in group.events) {
      final query = _activityString(
        event.payload,
        const <String>{'pattern', 'query', 'search'},
      );
      if (query != null) return _compactActivityTarget(query);
    }
  }
  return lines;
}

String? _activityLineRange(_ActivityEventGroup group, String snippet) {
  for (final event in group.events) {
    final start = _activityNumber(event.payload, const <String>{
      'line',
      'startLine',
      'lineStart',
      'line_start',
      'offset'
    });
    final end = _activityNumber(
        event.payload, const <String>{'endLine', 'lineEnd', 'line_end'});
    final limit = _activityNumber(event.payload, const <String>{'limit'});
    if (start != null) {
      final calculatedEnd = end ?? (limit == null ? null : start + limit - 1);
      return calculatedEnd == null || calculatedEnd == start
          ? 'line $start'
          : 'lines $start–$calculatedEnd';
    }
  }
  final described = RegExp(
          r'(?:showing\s+)?lines?\s+(\d+)(?:\s*[-–—]\s*(\d+))?',
          caseSensitive: false)
      .firstMatch(snippet);
  if (described != null) {
    final start = described.group(1)!;
    final end = described.group(2);
    return end == null ? 'line $start' : 'lines $start–$end';
  }
  final numbered = RegExp(r'^\s*(\d+):', multiLine: true)
      .allMatches(snippet)
      .map((match) => int.tryParse(match.group(1)!))
      .whereType<int>()
      .toList(growable: false);
  if (numbered.isNotEmpty) {
    return numbered.first == numbered.last
        ? 'line ${numbered.first}'
        : 'lines ${numbered.first}–${numbered.last}';
  }
  return null;
}

String _activitySnippetText(_ActivityEventGroup group) {
  var combined = '';
  for (final event in group.events) {
    final values = _activityStrings(
      event.payload,
      const <String>{
        'output',
        'content',
        'text',
        'delta',
        'code',
        'patch',
        'diff',
        'message',
        'command',
      },
    );
    for (final value in values) {
      final cleaned = _cleanActivitySnippet(value);
      if (cleaned.isEmpty || cleaned == combined) continue;
      if (combined.isEmpty || cleaned.startsWith(combined)) {
        combined = cleaned;
      } else if (!combined.contains(cleaned)) {
        combined = '$combined\n$cleaned';
      }
    }
  }
  return combined.trim();
}

String _cleanActivitySnippet(String value) {
  final trimmed = value.trim();
  final content =
      RegExp(r'<content>\s*([\s\S]*?)\s*</content>', caseSensitive: false)
          .firstMatch(trimmed)
          ?.group(1);
  if (content != null) return content.trim();
  return trimmed
      .replaceAll(
          RegExp(r'</?(?:path|type|content)>', caseSensitive: false), '')
      .trim();
}

String? _activityString(Map<Object?, Object?> source, Set<String> keys,
    {bool allowGenericId = false, int depth = 0}) {
  final values = _activityStrings(source, keys,
      allowGenericId: allowGenericId, depth: depth);
  return values.isEmpty ? null : values.first;
}

List<String> _activityStrings(Map<Object?, Object?> source, Set<String> keys,
    {bool allowGenericId = false, int depth = 0}) {
  if (depth > 4) return const <String>[];
  final result = <String>[];
  for (final key in keys) {
    final value = source[key];
    if (value is String && value.trim().isNotEmpty) result.add(value);
  }
  if (allowGenericId) {
    final id = source['id'];
    if (id is String && id.trim().isNotEmpty) result.add(id);
  }
  for (final entry in source.entries) {
    final key = entry.key.toString().toLowerCase();
    if (_isSensitiveActivityKey(key)) continue;
    final value = entry.value;
    if (value is Map<Object?, Object?>) {
      result.addAll(_activityStrings(value, keys,
          allowGenericId: allowGenericId, depth: depth + 1));
    } else if (value is List<Object?>) {
      for (final item in value) {
        if (item is Map<Object?, Object?>) {
          result.addAll(_activityStrings(item, keys,
              allowGenericId: allowGenericId, depth: depth + 1));
        }
      }
    }
  }
  return result.toSet().toList(growable: false);
}

int? _activityNumber(Map<Object?, Object?> source, Set<String> keys,
    {int depth = 0}) {
  if (depth > 4) return null;
  for (final key in keys) {
    final value = source[key];
    if (value is num) return value.toInt();
    if (value is String) {
      final parsed = int.tryParse(value);
      if (parsed != null) return parsed;
    }
  }
  for (final entry in source.entries) {
    if (_isSensitiveActivityKey(entry.key.toString().toLowerCase())) continue;
    final value = entry.value;
    if (value is Map<Object?, Object?>) {
      final nested = _activityNumber(value, keys, depth: depth + 1);
      if (nested != null) return nested;
    }
  }
  return null;
}

bool _isSensitiveActivityKey(String key) =>
    key.contains('token') ||
    key.contains('secret') ||
    key.contains('password') ||
    key.contains('credential') ||
    key.contains('authorization') ||
    key.contains('base64');

String _compactActivityPath(String path) {
  final segments = path
      .replaceAll('\\', '/')
      .split('/')
      .where((segment) => segment.isNotEmpty)
      .toList(growable: false);
  if (segments.length <= 2) return segments.join('/');
  return segments.sublist(segments.length - 2).join('/');
}

String _compactActivityTarget(String value) {
  final oneLine = value.trim().split(RegExp(r'\r?\n')).first;
  return oneLine.length <= 96 ? oneLine : '${oneLine.substring(0, 93)}…';
}

bool _isLongActivitySnippet(String text) =>
    text.length > 900 || '\n'.allMatches(text).length >= 14;

IconData _activityIcon(_ActivityKind kind) => switch (kind) {
      _ActivityKind.read => Icons.auto_stories_outlined,
      _ActivityKind.write => Icons.note_add_outlined,
      _ActivityKind.edit => Icons.edit_note_outlined,
      _ActivityKind.run => Icons.terminal_rounded,
      _ActivityKind.search => Icons.travel_explore_outlined,
      _ActivityKind.browse => Icons.language_rounded,
      _ActivityKind.agent => Icons.alt_route_rounded,
      _ActivityKind.error => Icons.error_outline_rounded,
      _ActivityKind.tool => Icons.bolt_outlined,
    };

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval});

  final ApprovalRequest approval;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(children: <Widget>[
              const Icon(Icons.security),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(approval.title,
                      style: Theme.of(context).textTheme.titleMedium))
            ]),
            if (approval.reason != null)
              Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(approval.reason!)),
            if (approval.command != null)
              Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SelectableText(approval.command!)),
            if (approval.workingDirectory != null)
              Text('Directory: ${approval.workingDirectory}'),
            if (approval.affectedFiles.isNotEmpty)
              Text('Files: ${approval.affectedFiles.join(', ')}'),
            if (approval.networkDestinations.isNotEmpty)
              Text('Network: ${approval.networkDestinations.join(', ')}'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: approval.choices
                  .map((choice) => choice.kind == 'reject'
                      ? OutlinedButton(
                          onPressed: () => unawaited(
                              store.respondToApproval(approval, choice.id)),
                          child: Text(choice.label))
                      : FilledButton(
                          onPressed: () => unawaited(
                              store.respondToApproval(approval, choice.id)),
                          child: Text(choice.label)))
                  .toList(growable: false),
            ),
          ],
        ),
      ),
    );
  }
}

class _UserInputCard extends StatefulWidget {
  const _UserInputCard({required this.request});

  final UserInputRequest request;

  @override
  State<_UserInputCard> createState() => _UserInputCardState();
}

class _UserInputCardState extends State<_UserInputCard> {
  final _answer = TextEditingController();
  String? _error;
  bool _sending = false;

  @override
  void dispose() {
    _answer.dispose();
    super.dispose();
  }

  JsonMap get _question {
    final questions = widget.request.request['questions'];
    if (questions is List<Object?> && questions.isNotEmpty) {
      final first = questions.first;
      if (first is Map<Object?, Object?>) {
        return first.map<String, Object?>(
            (key, value) => MapEntry<String, Object?>(key.toString(), value));
      }
    }
    return widget.request.request;
  }

  String get _answerKey {
    final value = _question['id'] ?? widget.request.request['questionId'];
    return value is String && value.trim().isNotEmpty ? value : 'answer';
  }

  List<String> get _options {
    final source = _question['options'] ?? widget.request.request['options'];
    if (source is! List<Object?>) return const <String>[];
    return source
        .map((option) {
          if (option is String) return option;
          if (option is Map<Object?, Object?>) {
            final label = option['label'] ?? option['value'];
            if (label is String) return label;
          }
          return '';
        })
        .where((value) => value.trim().isNotEmpty)
        .toList(growable: false);
  }

  String get _prompt {
    final value = _question['question'];
    return value is String && value.trim().isNotEmpty
        ? value
        : widget.request.prompt ?? 'The agent needs more information.';
  }

  Future<void> _submit(String value) async {
    final answer = value.trim();
    if (answer.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await StoreScope.of(context)
          .respondToUserInput(widget.request, <String, Object?>{
        _answerKey: answer,
      });
    } on Object catch (caught) {
      if (mounted) {
        setState(() => _error = caught
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), ''));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final options = _options;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(children: <Widget>[
              const Icon(Icons.question_answer),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(widget.request.title,
                      style: Theme.of(context).textTheme.titleMedium))
            ]),
            Padding(
                padding: const EdgeInsets.only(top: 8), child: Text(_prompt)),
            const SizedBox(height: 12),
            if (options.isNotEmpty)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: options
                    .map((option) => FilledButton.tonal(
                          onPressed: _sending
                              ? null
                              : () => unawaited(_submit(option)),
                          child: Text(option),
                        ))
                    .toList(growable: false),
              )
            else ...<Widget>[
              TextField(
                  key: const Key('user-input-answer'),
                  controller: _answer,
                  minLines: 1,
                  maxLines: 5,
                  decoration: const InputDecoration(
                      labelText: 'Your answer', border: OutlineInputBorder())),
              const SizedBox(height: 10),
              FilledButton(
                onPressed:
                    _sending ? null : () => unawaited(_submit(_answer.text)),
                child: _sending
                    ? const SizedBox.square(
                        dimension: 17,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Send answer'),
              ),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
          ],
        ),
      ),
    );
  }
}

class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({super.key});

  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  bool _starting = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_starting && _error == null) unawaited(_startDraft());
  }

  Future<void> _startDraft() async {
    if (_starting) return;
    final store = StoreScope.of(context);
    final available = store.providers
        .where((provider) =>
            provider.detected && provider.capabilities.createSession)
        .toList(growable: false);
    if (available.isEmpty) {
      setState(() => _error = 'No agent is ready to start a task.');
      return;
    }
    final selected = available
            .where((provider) =>
                provider.providerId == store.selectedProviderId &&
                provider.authenticated != false)
            .firstOrNull ??
        available
            .where((provider) => provider.authenticated == true)
            .firstOrNull ??
        available.first;
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final session = await store.startPreparedSession(selected.providerId);
      if (!mounted) return;
      await Navigator.of(context)
          .pushReplacement(sessionScreenRoute(session.id));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = error
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: _error == null
              ? const SizedBox.square(
                  key: Key('new-task-starting'),
                  dimension: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 14),
                      FilledButton(
                        onPressed: () {
                          setState(() => _error = null);
                          unawaited(_startDraft());
                        },
                        child: const Text('Try again'),
                      ),
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

class HostsScreen extends StatelessWidget {
  const HostsScreen({super.key});

  Future<void> _editDictationDictionary(
      BuildContext context, RemoteAppStore store) async {
    final controller =
        TextEditingController(text: store.dictationDictionary.join('\n'));
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Dictation dictionary'),
        content: SizedBox(
          width: 440,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                  'Add names, technical terms, or preferred spellings. Use one entry per line.'),
              const SizedBox(height: 12),
              TextField(
                key: const Key('dictation-dictionary-field'),
                controller: controller,
                minLines: 5,
                maxLines: 10,
                decoration: const InputDecoration(
                  hintText: 'OpenCode\nKronos\nSlyRS',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (save == true) {
      await store.setDictationDictionary(controller.text.split('\n'));
    }
    controller.dispose();
  }

  Future<void> _showDictationSourceDetails(BuildContext context,
      RemoteAppStore store, TranscriptionSource source) async {
    final ready = store.isDictationSourceReady(source);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => _SettingsDetailsSheet(
        title: source.label,
        details: <(String, String)>[
          ('Status', ready ? 'Ready' : 'Setup needed'),
          if (!ready) ('Computer setting', source.setupEnvironmentVariable),
        ],
        note: ready
            ? 'Dictation audio is sent through your paired computer.'
            : 'Add this credential to Tethoq Bridge on your computer, then reconnect.',
      ),
    );
  }

  Future<void> _removeHost(
      BuildContext context, RemoteAppStore store, PairedHost host) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove this computer?'),
        content: const Text(
            'Tethoq will revoke its access when it is reachable. You will need to pair it again to reconnect.'),
        actions: <Widget>[
          TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Remove')),
        ],
      ),
    );
    if (confirmed == true) await store.removeHost(host.hostId);
  }

  Future<void> _showHostDetails(
      BuildContext context, RemoteAppStore store, PairedHost host) async {
    final current = store.activeHost?.hostId == host.hostId;
    final remove = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => _SettingsDetailsSheet(
        title: host.displayName ?? host.hostId,
        details: <(String, String)>[
          (
            'Connection',
            current ? _bridgeStateLabel(store.connectionState) : 'Saved'
          ),
          ('Endpoint', host.endpoint),
        ],
        action: TextButton.icon(
          style: TextButton.styleFrom(minimumSize: const Size(0, 44)),
          onPressed: () => Navigator.pop(sheetContext, true),
          icon: const Icon(Icons.delete_outline_rounded),
          label: const Text('Remove computer'),
        ),
      ),
    );
    if (remove == true && context.mounted) {
      await _removeHost(context, store, host);
    }
  }

  Future<void> _revokeDevice(
      BuildContext context, RemoteAppStore store, PairedDevice device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Revoke this phone?'),
        content: const Text(
            'This phone will need to pair again before it can use this computer.'),
        actions: <Widget>[
          TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Revoke')),
        ],
      ),
    );
    if (confirmed == true) {
      await store.revokePairedDevice(device.credentialId);
    }
  }

  Future<void> _showProviderDetails(BuildContext context, RemoteAppStore store,
      ProviderConnection provider) async {
    final canReconnect = !provider.detected ||
        provider.authenticated == false ||
        provider.state == 'failed' ||
        provider.state == 'disconnected' ||
        provider.state == 'unknown';
    final reconnect = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => _SettingsDetailsSheet(
        title: provider.displayName,
        details: <(String, String)>[
          ('Status', _providerStateLabel(provider.state)),
          ('Available', provider.detected ? 'Yes' : 'No'),
          (
            'Authentication',
            provider.authenticated == null
                ? 'Unknown'
                : provider.authenticated!
                    ? 'Ready'
                    : 'Needed'
          ),
        ],
        action: canReconnect
            ? FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: () => Navigator.pop(sheetContext, true),
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Reconnect'),
              )
            : null,
      ),
    );
    if (reconnect == true) {
      await store.reconnectProvider(provider.providerId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: _AdaptivePage(
          maxWidth: 680,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
            children: <Widget>[
              _SettingsSectionLabel(label: 'Composer'),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                title: const Text('Default send behavior'),
                subtitle: Text(store.defaultDeliveryMode == 'steer'
                    ? 'Guide active work when supported'
                    : 'Send after current work'),
                trailing: DropdownButton<String>(
                  key: const Key('default-delivery-mode'),
                  value: store.defaultDeliveryMode,
                  underline: const SizedBox.shrink(),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: 'queue', child: Text('Queue')),
                    DropdownMenuItem(value: 'steer', child: Text('Steer')),
                  ],
                  onChanged: (value) {
                    if (value != null) {
                      unawaited(store.setDefaultDeliveryMode(value));
                    }
                  },
                ),
              ),
              const Divider(height: 24),
              _SettingsExpansion(
                key: const Key('settings-section-dictation'),
                title: 'Dictation',
                subtitle: store.selectedDictationSource?.label ??
                    'Choose speech-to-text',
                children: <Widget>[
                  ...store.dictationSources.map((source) => Column(
                        children: <Widget>[
                          ListTile(
                            key: Key('dictation-source-setting-${source.id}'),
                            contentPadding:
                                const EdgeInsets.symmetric(horizontal: 2),
                            leading: _SettingsStateMark(
                              label: source.isReady ? 'Ready' : 'Setup needed',
                              tone: source.isReady
                                  ? _SettingsStateTone.ready
                                  : _SettingsStateTone.attention,
                            ),
                            title: Text(source.label),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                if (store.selectedDictationSource?.id ==
                                    source.id)
                                  const Icon(Icons.check_rounded, size: 20),
                                IconButton(
                                  key: Key(
                                      'dictation-source-details-${source.id}'),
                                  tooltip: 'Source details',
                                  onPressed: () => unawaited(
                                      _showDictationSourceDetails(
                                          context, store, source)),
                                  icon: const Icon(Icons.info_outline_rounded,
                                      size: 20),
                                ),
                              ],
                            ),
                            onTap: source.isReady
                                ? () => unawaited(
                                    store.setDictationSource(source.id))
                                : () => unawaited(_showDictationSourceDetails(
                                    context, store, source)),
                          ),
                          const Divider(height: 1),
                        ],
                      )),
                  ListTile(
                    key: const Key('dictation-dictionary-setting'),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                    leading: const Icon(Icons.spellcheck_rounded),
                    title: const Text('Custom words'),
                    subtitle: const Text('Names and preferred spellings'),
                    trailing: const Icon(Icons.chevron_right_rounded, size: 20),
                    onTap: () =>
                        unawaited(_editDictationDictionary(context, store)),
                  ),
                ],
              ),
              const Divider(height: 1),
              _SettingsExpansion(
                key: const Key('settings-section-computers'),
                title: 'Paired computers',
                subtitle: store.activeHost?.displayName ??
                    (store.hosts.isEmpty ? 'No computer paired' : null),
                children: <Widget>[
                  if (store.connectionState == BridgeConnectionState.online)
                    ListTile(
                      key: const Key('settings-open-desktop'),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                      leading: const Icon(Icons.desktop_windows_outlined),
                      title: const Text('Open Tethoq Desktop'),
                      trailing: const Icon(Icons.open_in_new_rounded, size: 19),
                      onTap: () =>
                          unawaited(showDesktopWakeDialog(context, store)),
                    ),
                  ListTile(
                    key: const Key('pair-another-computer'),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                    leading: const Icon(Icons.qr_code_scanner_rounded),
                    title: const Text('Pair computer'),
                    trailing: const Icon(Icons.chevron_right_rounded, size: 20),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                          builder: (_) => const PairingScreen()),
                    ),
                  ),
                  const Divider(height: 1),
                  ...store.hosts.map((host) {
                    final current = store.activeHost?.hostId == host.hostId;
                    final connecting = current &&
                        (store.connectionState ==
                                BridgeConnectionState.connecting ||
                            store.connectionState ==
                                BridgeConnectionState.reconnecting);
                    final online = current &&
                        store.connectionState == BridgeConnectionState.online;
                    return Column(
                      children: <Widget>[
                        ListTile(
                          key: Key('paired-computer-${host.hostId}'),
                          contentPadding:
                              const EdgeInsets.symmetric(horizontal: 2),
                          leading: _SettingsStateMark(
                            label: current
                                ? _bridgeStateLabel(store.connectionState)
                                : 'Saved',
                            tone: online
                                ? _SettingsStateTone.ready
                                : connecting
                                    ? _SettingsStateTone.busy
                                    : _SettingsStateTone.muted,
                          ),
                          title: Text(host.displayName ?? 'Paired computer'),
                          subtitle: current ? const Text('Current') : null,
                          trailing: IconButton(
                            key: Key('paired-computer-details-${host.hostId}'),
                            tooltip: 'Computer details',
                            onPressed: () => unawaited(
                                _showHostDetails(context, store, host)),
                            icon: const Icon(Icons.info_outline_rounded,
                                size: 20),
                          ),
                          onTap: online
                              ? null
                              : () => unawaited(store.connectHost(host)),
                        ),
                        const Divider(height: 1),
                      ],
                    );
                  }),
                  if (store.pairedDevices.isNotEmpty) ...<Widget>[
                    const Padding(
                      padding: EdgeInsets.fromLTRB(2, 18, 2, 4),
                      child: _SettingsSectionLabel(label: 'Phone access'),
                    ),
                    ...store.pairedDevices.map((device) {
                      final current =
                          device.deviceId == store.activeHost?.deviceId;
                      return Column(
                        children: <Widget>[
                          ListTile(
                            contentPadding:
                                const EdgeInsets.symmetric(horizontal: 2),
                            leading: const Icon(Icons.phone_android_outlined),
                            title:
                                Text(current ? 'This phone' : 'Paired phone'),
                            subtitle:
                                Text('Paired ${_shortDate(device.issuedAt)}'),
                            trailing: current
                                ? const _SettingsStateMark(
                                    label: 'Current',
                                    tone: _SettingsStateTone.ready,
                                  )
                                : IconButton(
                                    tooltip: 'Revoke phone access',
                                    icon: const Icon(Icons.link_off_rounded,
                                        size: 20),
                                    onPressed: () => unawaited(
                                        _revokeDevice(context, store, device)),
                                  ),
                          ),
                          const Divider(height: 1),
                        ],
                      );
                    }),
                  ],
                ],
              ),
              const Divider(height: 1),
              _SettingsExpansion(
                key: const Key('settings-section-agents'),
                title: 'Agent connections',
                children: store.providers
                    .map((provider) => Column(
                          children: <Widget>[
                            ListTile(
                              key: Key(
                                  'agent-connection-${provider.providerId}'),
                              contentPadding:
                                  const EdgeInsets.symmetric(horizontal: 2),
                              leading: _ProviderBadge(
                                  providerId: provider.providerId),
                              title: Text(provider.displayName),
                              trailing: _SettingsStateMark(
                                label: _providerStateLabel(provider.state),
                                tone: _providerStateTone(provider.state),
                              ),
                              onTap: () => unawaited(_showProviderDetails(
                                  context, store, provider)),
                            ),
                            const Divider(height: 1),
                          ],
                        ))
                    .toList(growable: false),
              ),
            ],
          )),
    );
  }
}

class _SettingsSectionLabel extends StatelessWidget {
  const _SettingsSectionLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Text(
        label,
        style: Theme.of(context)
            .textTheme
            .titleMedium
            ?.copyWith(fontWeight: FontWeight.w600),
      );
}

class _SettingsExpansion extends StatelessWidget {
  const _SettingsExpansion({
    required this.title,
    required this.children,
    this.subtitle,
    super.key,
  });

  final String title;
  final String? subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 2),
        childrenPadding: EdgeInsets.zero,
        shape: const Border(),
        collapsedShape: const Border(),
        title: Text(
          title,
          style: Theme.of(context)
              .textTheme
              .titleMedium
              ?.copyWith(fontWeight: FontWeight.w600),
        ),
        subtitle: subtitle == null
            ? null
            : Text(
                subtitle!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
        children: children,
      );
}

enum _SettingsStateTone { ready, attention, busy, muted }

class _SettingsStateMark extends StatelessWidget {
  const _SettingsStateMark({required this.label, required this.tone});

  final String label;
  final _SettingsStateTone tone;

  @override
  Widget build(BuildContext context) {
    final color = switch (tone) {
      _SettingsStateTone.ready => const Color(0xff6edc91),
      _SettingsStateTone.attention => const Color(0xffffb061),
      _SettingsStateTone.busy => Theme.of(context).colorScheme.primary,
      _SettingsStateTone.muted =>
        Theme.of(context).colorScheme.onSurface.withValues(alpha: .42),
    };
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        child: tone == _SettingsStateTone.busy
            ? SizedBox.square(
                dimension: 16,
                child:
                    CircularProgressIndicator(strokeWidth: 1.8, color: color),
              )
            : Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
      ),
    );
  }
}

class _SettingsDetailsSheet extends StatelessWidget {
  const _SettingsDetailsSheet({
    required this.title,
    required this.details,
    this.note,
    this.action,
  });

  final String title;
  final List<(String, String)> details;
  final String? note;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 2, 20, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                ...details.map((detail) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 7),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            width: 112,
                            child: Text(
                              detail.$1,
                              style: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.copyWith(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: .62)),
                            ),
                          ),
                          Expanded(
                            child: SelectableText(
                              detail.$2,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
                    )),
                if (note != null) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(note!, style: Theme.of(context).textTheme.bodyMedium),
                ],
                if (action != null) ...<Widget>[
                  const SizedBox(height: 18),
                  Align(alignment: Alignment.centerLeft, child: action!),
                ],
              ],
            ),
          ),
        ),
      );
}

String _bridgeStateLabel(BridgeConnectionState state) => switch (state) {
      BridgeConnectionState.online => 'Connected',
      BridgeConnectionState.connecting => 'Connecting',
      BridgeConnectionState.reconnecting => 'Reconnecting',
      BridgeConnectionState.disconnected => 'Not connected',
      BridgeConnectionState.closed => 'Closed',
    };

String _providerStateLabel(String state) => switch (state) {
      'online' => 'Connected',
      'working' => 'Working',
      'failed' => 'Needs attention',
      'needs_approval' => 'Approval needed',
      'needs_input' => 'Input needed',
      'disconnected' => 'Not connected',
      'idle' => 'Ready',
      _ => _titleCase(state),
    };

_SettingsStateTone _providerStateTone(String state) => switch (state) {
      'online' || 'idle' || 'completed' => _SettingsStateTone.ready,
      'working' => _SettingsStateTone.busy,
      'failed' ||
      'needs_approval' ||
      'needs_input' =>
        _SettingsStateTone.attention,
      _ => _SettingsStateTone.muted,
    };

class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.state, required this.error});

  final BridgeConnectionState state;
  final String? error;

  @override
  Widget build(BuildContext context) {
    if (state == BridgeConnectionState.online && error == null)
      return const SizedBox.shrink();
    return Material(
      color: error != null
          ? Theme.of(context).colorScheme.errorContainer
          : Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: <Widget>[
            if (state == BridgeConnectionState.connecting ||
                state == BridgeConnectionState.reconnecting)
              const Padding(
                  padding: EdgeInsets.only(right: 10),
                  child: SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))),
            Expanded(child: Text(error ?? 'Connection: ${state.name}')),
          ],
        ),
      ),
    );
  }
}

String _shortDate(DateTime value) {
  final local = value.toLocal();
  final month = local.month.toString().padLeft(2, '0');
  final day = local.day.toString().padLeft(2, '0');
  return '${local.year}-$month-$day';
}

String _sessionDisplayTitle(RemoteSession session) {
  if (session.providerId == 'grok' &&
      session.title.trim().toLowerCase() ==
          (session.project ?? '').trim().toLowerCase()) {
    return 'Untitled Grok session';
  }
  return session.title;
}

class _AdaptivePage extends StatelessWidget {
  const _AdaptivePage({required this.child, this.maxWidth = 840});

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

class _ProviderBadge extends StatelessWidget {
  const _ProviderBadge({required this.providerId, super.key});

  final String providerId;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: 30,
      child: Center(child: ProviderLogo(providerId: providerId, size: 22)),
    );
  }
}

bool _showsConversationState(String state) =>
    state == 'working' ||
    state == 'needs_approval' ||
    state == 'needs_input' ||
    state == 'failed' ||
    state == 'disconnected';

bool _showsConversationEvent(String type) =>
    type != 'session.status_changed' &&
    type != 'message.started' &&
    type != 'message.delta' &&
    type != 'message.completed' &&
    type != 'message.queued' &&
    type != 'message.queue_updated' &&
    type != 'message.queue_removed' &&
    type != 'agent.completed' &&
    type != 'agent.interrupted' &&
    type != 'approval.requested' &&
    type != 'approval.resolved' &&
    type != 'user_input.requested';

bool _eventHasStructuredSubagent(AgentEvent event) =>
    jsonList(event.payload['parts']).any(
        (part) => part is Map<Object?, Object?> && part['type'] == 'subagent');

const Set<String> _builtInModelProviders = <String>{
  'codex',
  'opencode',
  'grok',
  'pi',
  'omp',
  'qwen',
  'goose',
  'kimi',
  'hermes',
  'cline',
  'copilot',
  'direct',
};

bool _supportsTurnModelSelection(String providerId) =>
    _builtInModelProviders.contains(providerId);

bool _supportsImageAttachments(String providerId) =>
    _builtInModelProviders.contains(providerId);

bool _supportsGenericFileAttachments(String providerId) =>
    providerId == 'opencode';

const int _maxPhoneAttachmentBytes = 25 * 1024 * 1024;

bool _isValidPhoneAttachmentLength(int byteLength) =>
    byteLength > 0 && byteLength <= _maxPhoneAttachmentBytes;

String _encodeBase64(Uint8List bytes) => base64Encode(bytes);

Uint8List? _prepareRemoteImage(Uint8List bytes) {
  final decoded = image_lib.decodeImage(bytes);
  if (decoded == null) return null;
  final source = image_lib.bakeOrientation(decoded);
  for (final longestEdge in const <int>[4096, 3072, 2048, 1600, 1280]) {
    final resized = source.width <= longestEdge && source.height <= longestEdge
        ? source
        : source.width >= source.height
            ? image_lib.copyResize(source, width: longestEdge)
            : image_lib.copyResize(source, height: longestEdge);
    for (final quality in const <int>[90, 82, 70, 58]) {
      final encoded = image_lib.encodeJpg(resized, quality: quality);
      if (encoded.length <= _maxPhoneAttachmentBytes) return encoded;
    }
  }
  return null;
}

String _imageMimeType(String name) {
  final extension = name.split('.').last.toLowerCase();
  return switch (extension) {
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'image/jpeg',
  };
}

String _genericMimeType(String name) {
  final extension =
      name.contains('.') ? name.split('.').last.toLowerCase() : '';
  return switch (extension) {
    'json' => 'application/json',
    'pdf' => 'application/pdf',
    'csv' => 'text/csv',
    'txt' || 'md' || 'log' => 'text/plain',
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'application/octet-stream',
  };
}

bool _isArtifactPart(ContentPart part) {
  if (part.type == 'reasoning' || part.data['phase'] == 'commentary') {
    return true;
  }
  final lines = part.summary
      .trim()
      .split(RegExp(r'\r?\n'))
      .where((line) => line.trim().isNotEmpty)
      .toList(growable: false);
  return lines.isNotEmpty &&
      lines.every((line) {
        final value = line.trim();
        return value.length > 4 &&
            value.startsWith('**') &&
            value.endsWith('**');
      });
}

String _messagePartText(ContentPart part,
    {bool stripAttachmentEnvelope = false}) {
  var text = part.summary.trim();
  if (stripAttachmentEnvelope) {
    text = _withoutLegacyAttachmentEnvelope(text);
  }
  if (!_isArtifactPart(part)) return text;
  return text.split(RegExp(r'\r?\n')).map((line) {
    final value = line.trim();
    return value.length > 4 && value.startsWith('**') && value.endsWith('**')
        ? value.substring(2, value.length - 2).trim()
        : value;
  }).join('\n');
}

bool _isRawMarkupOnly(String text) {
  final value = text.trim();
  if (value.isEmpty || !value.startsWith('<') || !value.endsWith('>')) {
    return false;
  }
  if (RegExp(r'^(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>)$')
      .hasMatch(value)) {
    return true;
  }
  if (RegExp(r'^<[A-Za-z][\w.:-]*(?:\s[^>]*)?/\s*>$').hasMatch(value)) {
    return true;
  }
  final opening =
      RegExp(r'^<([A-Za-z][\w.:-]*)(?:\s[^>]*)?>').firstMatch(value);
  if (opening == null) return false;
  final tag = RegExp.escape(opening.group(1)!);
  return RegExp('</$tag\\s*>\$', caseSensitive: false).hasMatch(value);
}

bool _hasMemoryCitation(String text) =>
    text.toLowerCase().contains('<oai-mem-citation>');

String _withoutMemoryCitation(String text) {
  final lower = text.toLowerCase();
  const opening = '<oai-mem-citation>';
  const closing = '</oai-mem-citation>';
  var output = text;
  var search = lower;
  while (true) {
    final start = search.indexOf(opening);
    if (start < 0) break;
    final end = search.indexOf(closing, start + opening.length);
    if (end < 0) {
      output = output.substring(0, start);
      break;
    }
    final after = end + closing.length;
    output = '${output.substring(0, start)}${output.substring(after)}';
    search = output.toLowerCase();
  }
  return output.trim();
}

List<String> _legacyAttachmentNames(String text) {
  const header = '# Files mentioned by the user:';
  const request = '## My request:';
  final headerIndex = text.indexOf(header);
  if (headerIndex < 0 || text.substring(0, headerIndex).trim().isNotEmpty) {
    return const <String>[];
  }
  final requestIndex = text.indexOf(request, headerIndex + header.length);
  if (requestIndex < 0) return const <String>[];
  final metadata = text.substring(headerIndex + header.length, requestIndex);
  return RegExp(r'^\s*##\s+([^:\r\n]+):\s+.+$', multiLine: true)
      .allMatches(metadata)
      .map((match) => _safeAttachmentName(match.group(1)!))
      .where((name) => name.isNotEmpty)
      .toList(growable: false);
}

String _withoutLegacyAttachmentEnvelope(String text) {
  const header = '# Files mentioned by the user:';
  const request = '## My request:';
  var display = text;
  final headerIndex = display.indexOf(header);
  if (headerIndex >= 0 && display.substring(0, headerIndex).trim().isEmpty) {
    final requestIndex = display.indexOf(request, headerIndex + header.length);
    if (requestIndex >= 0) {
      display = display.substring(requestIndex + request.length);
    }
  }
  return display
      .replaceAll(
          RegExp(r'^\s*</?image\b[^>]*>\s*$',
              caseSensitive: false, multiLine: true),
          '')
      .trim();
}

String _safeAttachmentName(String value) {
  final segments = value.trim().replaceAll('\\', '/').split('/');
  return segments.isEmpty ? '' : segments.last.trim();
}

bool _isImageFilename(String name) => RegExp(
      r'\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$',
      caseSensitive: false,
    ).hasMatch(name);

class _MessageAttachmentView {
  const _MessageAttachmentView({
    required this.name,
    required this.isImage,
    this.imageUri,
  });

  factory _MessageAttachmentView.fromPart(ContentPart part,
      {String? fallbackName}) {
    final isImage = part.isImageAttachment;
    return _MessageAttachmentView(
      name: _safeAttachmentName(part.attachmentName ??
          fallbackName ??
          (isImage ? 'Image' : 'Attachment')),
      isImage: isImage,
      imageUri: isImage ? _messageImageUri(part) : null,
    );
  }

  factory _MessageAttachmentView.filenameOnly(String name) =>
      _MessageAttachmentView(
        name: _safeAttachmentName(name),
        isImage: _isImageFilename(name),
      );

  final String name;
  final bool isImage;
  final String? imageUri;
}

String? _messageImageUri(ContentPart part) {
  final uri = part.attachmentUri;
  if (uri == null) return null;
  if (uri.startsWith('data:image/')) {
    final comma = uri.indexOf(',');
    if (comma < 0 || !uri.substring(0, comma).endsWith(';base64')) return null;
    return uri;
  }
  final parsed = Uri.tryParse(uri);
  if (parsed?.scheme == 'https' || parsed?.scheme == 'http') return uri;
  return null;
}

class _ExpandableMessageImage extends StatelessWidget {
  const _ExpandableMessageImage({
    required this.imageUri,
    required this.name,
    required this.width,
    required this.height,
    required this.fit,
    required this.cacheWidth,
    required this.fallback,
  });

  final String imageUri;
  final String name;
  final double width;
  final double height;
  final BoxFit fit;
  final int cacheWidth;
  final Widget fallback;

  Widget _image({required BoxFit fit, double? width, double? height}) {
    if (imageUri.startsWith('data:image/')) {
      return _MemoizedDataUriImage(
        dataUri: imageUri,
        width: width ?? this.width,
        height: height ?? this.height,
        fit: fit,
        cacheWidth: fit == BoxFit.contain ? 1800 : cacheWidth,
        fallback: fallback,
      );
    }
    return Image.network(
      imageUri,
      width: width ?? this.width,
      height: height ?? this.height,
      fit: fit,
      cacheWidth: fit == BoxFit.contain ? null : cacheWidth,
      errorBuilder: (_, __, ___) => fallback,
    );
  }

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: 'Expand image $name',
        child: InkWell(
          key: const Key('expand-message-image'),
          onTap: () => showDialog<void>(
            context: context,
            barrierColor: Colors.black.withValues(alpha: .92),
            builder: (dialogContext) => Dialog(
              key: const Key('expanded-message-image'),
              insetPadding: const EdgeInsets.all(10),
              backgroundColor: Colors.black,
              child: Stack(
                children: <Widget>[
                  Positioned.fill(
                    child: InteractiveViewer(
                      minScale: .8,
                      maxScale: 5,
                      child: Center(
                        child: _image(
                          fit: BoxFit.contain,
                          width: MediaQuery.sizeOf(dialogContext).width,
                          height: MediaQuery.sizeOf(dialogContext).height,
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: 8,
                    right: 8,
                    child: IconButton.filledTonal(
                      key: const Key('close-expanded-message-image'),
                      tooltip: 'Close image',
                      onPressed: () => Navigator.pop(dialogContext),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ),
                ],
              ),
            ),
          ),
          child: _image(fit: fit),
        ),
      );
}

class _MemoizedDataUriImage extends StatefulWidget {
  const _MemoizedDataUriImage({
    required this.dataUri,
    required this.width,
    required this.height,
    required this.fit,
    required this.cacheWidth,
    required this.fallback,
  });

  final String dataUri;
  final double width;
  final double height;
  final BoxFit fit;
  final int cacheWidth;
  final Widget fallback;

  @override
  State<_MemoizedDataUriImage> createState() => _MemoizedDataUriImageState();
}

class _MemoizedDataUriImageState extends State<_MemoizedDataUriImage> {
  Uint8List? _bytes;

  @override
  void initState() {
    super.initState();
    _decode();
  }

  @override
  void didUpdateWidget(covariant _MemoizedDataUriImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.dataUri != widget.dataUri) _decode();
  }

  void _decode() {
    final comma = widget.dataUri.indexOf(',');
    if (comma < 0 || !widget.dataUri.substring(0, comma).endsWith(';base64')) {
      _bytes = null;
      return;
    }
    try {
      _bytes = base64Decode(widget.dataUri.substring(comma + 1));
    } on FormatException {
      _bytes = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final bytes = _bytes;
    if (bytes == null) return widget.fallback;
    return Image.memory(
      bytes,
      width: widget.width,
      height: widget.height,
      fit: widget.fit,
      cacheWidth: widget.cacheWidth,
    );
  }
}

String _titleCase(String value) {
  final normalized = value.replaceAll('_', ' ').trim();
  if (normalized.isEmpty) return value;
  return '${normalized[0].toUpperCase()}${normalized.substring(1)}';
}

String _effortDisplayLabel(String effort, String? modelId) {
  if (modelId == 'gpt-5.6-sol' && effort == 'low') return 'Light';
  return _titleCase(effort);
}

class _AgentStateIcon extends StatelessWidget {
  const _AgentStateIcon({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) {
    if (state == 'working') {
      return const SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 1.8),
      );
    }
    return Icon(
      switch (state) {
        'completed' => Icons.check_circle_outline_rounded,
        'failed' => Icons.error_outline_rounded,
        'needs_input' || 'needs_approval' => Icons.priority_high_rounded,
        _ => Icons.person_outline_rounded,
      },
      size: 19,
    );
  }
}

double? _contextFraction(SessionContextState context) {
  final reported = context.usedPercent;
  if (reported != null) return (reported / 100).clamp(0.0, 1.0).toDouble();
  final used = context.usedTokens;
  final window = context.contextWindowTokens;
  if (used == null || window == null || window <= 0) return null;
  return (used / window).clamp(0.0, 1.0).toDouble();
}

String _contextPercentLabel(SessionContextState context) {
  final fraction = _contextFraction(context);
  return fraction == null ? '—' : '${(fraction * 100).round()}%';
}

String _compactTokenCount(int? value) {
  if (value == null) return '—';
  if (value >= 1000000) {
    final digits = value >= 10000000 ? 0 : 1;
    return '${(value / 1000000).toStringAsFixed(digits)}m';
  }
  if (value >= 1000) {
    final digits = value >= 100000 ? 0 : 1;
    return '${(value / 1000).toStringAsFixed(digits)}k';
  }
  return '$value';
}

String? _contextCost(SessionContextState context) {
  final cost = context.usage.cost;
  if (cost == null) return null;
  final currency = (context.usage.currency ?? 'USD').toUpperCase();
  final prefix = switch (currency) {
    'USD' => r'$',
    'GBP' => '£',
    'EUR' => '€',
    _ => '',
  };
  final value = cost.toStringAsFixed(cost < 1 ? 4 : 2);
  return prefix.isEmpty ? '$value $currency' : '$prefix$value';
}

class _SessionContextButton extends StatelessWidget {
  const _SessionContextButton(
      {required this.context, required this.visual, required this.onTap});

  final SessionContextState? context;
  final ProviderVisualTheme visual;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final usage = this.context;
    final fraction = usage == null ? null : _contextFraction(usage);
    final label = fraction == null
        ? 'Context usage unavailable. Tap for details.'
        : '${_contextPercentLabel(usage!)} of context used. Tap for automatic compaction settings.';
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: InkWell(
          key: const Key('session-context-button'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 68,
            height: 44,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  if (usage != null && fraction != null) ...<Widget>[
                    Text(_contextPercentLabel(usage),
                        style: TextStyle(
                            color: visual.accent,
                            fontSize: 12,
                            fontWeight: FontWeight.w700)),
                    const SizedBox(height: 5),
                  ],
                  ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: LinearProgressIndicator(
                      minHeight: 4,
                      value: fraction ?? 0,
                      color: visual.accent,
                      backgroundColor: visual.border.withValues(alpha: .55),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ContextStatRow extends StatelessWidget {
  const _ContextStatRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .58),
                      fontSize: 12)),
            ),
            Text(value,
                style:
                    const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
      );
}

class _ConversationStateIndicator extends StatelessWidget {
  const _ConversationStateIndicator(
      {required this.state, required this.visual});

  final String state;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      'needs_approval' || 'needs_input' => const Color(0xffffb061),
      'failed' => Theme.of(context).colorScheme.error,
      'disconnected' =>
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.58),
      _ => visual.accent,
    };
    final label = switch (state) {
      'needs_approval' => 'Approval needed',
      'needs_input' => 'Input needed',
      'failed' => 'Failed',
      'disconnected' => 'Offline',
      _ => 'Working',
    };
    final indicator = state == 'working'
        ? SizedBox.square(
            dimension: 15,
            child: CircularProgressIndicator(strokeWidth: 1.9, color: color),
          )
        : Icon(
            state == 'failed'
                ? Icons.error_outline_rounded
                : state == 'disconnected'
                    ? Icons.cloud_off_outlined
                    : Icons.priority_high_rounded,
            size: 17,
            color: color,
          );
    return Semantics(
      key: const Key('conversation-state-indicator'),
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: 44,
          child: Center(child: indicator),
        ),
      ),
    );
  }
}

class _InlineStateIndicator extends StatelessWidget {
  const _InlineStateIndicator(
      {required this.state, required this.visual, super.key});

  final String state;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final needsAttention = state == 'needs_approval' ||
        state == 'needs_input' ||
        state == 'failed';
    final color = state == 'online'
        ? const Color(0xff6edc91)
        : needsAttention
            ? state == 'failed'
                ? Theme.of(context).colorScheme.error
                : const Color(0xffffb061)
            : state == 'completed'
                ? const Color(0xff6edc91)
                : state == 'working'
                    ? visual.accent
                    : Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: .5);
    final label = switch (state) {
      'needs_approval' => 'Approval',
      'needs_input' => 'Input',
      'disconnected' => 'Offline',
      'online' => 'Online',
      _ => _titleCase(state),
    };
    final indicator = state == 'working'
        ? SizedBox.square(
            dimension: 13,
            child: CircularProgressIndicator(strokeWidth: 1.7, color: color),
          )
        : state == 'idle' || state == 'unknown' || state == 'online'
            ? Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              )
            : Icon(
                needsAttention
                    ? Icons.priority_high_rounded
                    : state == 'completed'
                        ? Icons.check_rounded
                        : Icons.cloud_off_outlined,
                size: 15,
                color: color,
              );
    return Semantics(
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: 24,
          child: Center(child: indicator),
        ),
      ),
    );
  }
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value);
  if (difference.inSeconds < 60) return 'just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  return '${difference.inDays}d ago';
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
