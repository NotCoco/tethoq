import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'src/app_shell.dart';
import 'src/app_theme.dart';
import 'src/demo_store.dart';
import 'src/draft_journal.dart';
import 'src/external_system_activity.dart';
import 'src/screens.dart';
import 'src/security.dart';
import 'src/store.dart';

void main(List<String> arguments) {
  WidgetsFlutterBinding.ensureInitialized();
  const demoBuild =
      bool.fromEnvironment('TETHOQ_DEMO') || bool.fromEnvironment('UAR_DEMO');
  final demoMode = demoBuild || arguments.contains('--demo');
  final store = demoMode ? DemoRemoteAppStore() : _createProductionStore();
  runApp(UniversalAgentRemoteApp(store: store));
  unawaited(store.initialize());
}

RemoteAppStore _createProductionStore() {
  final security = DeviceSecurity();
  return RemoteAppStore(
    security: security,
    draftJournalFactory: () async {
      final supportDirectory = await getApplicationSupportDirectory();
      return DraftJournal(
        root: Directory(
          '${supportDirectory.path}${Platform.pathSeparator}mobile-draft-journal',
        ),
        keyProvider: security,
      );
    },
  );
}

class UniversalAgentRemoteApp extends StatefulWidget {
  const UniversalAgentRemoteApp({
    required this.store,
    this.materialAppBuilder,
    super.key,
  });

  final RemoteAppStore store;
  @visibleForTesting
  final Widget Function(Widget child)? materialAppBuilder;

  @override
  State<UniversalAgentRemoteApp> createState() =>
      _UniversalAgentRemoteAppState();
}

class _UniversalAgentRemoteAppState extends State<UniversalAgentRemoteApp>
    with WidgetsBindingObserver {
  static const _draftJournalFlushRetryDelays = <Duration>[
    Duration(milliseconds: 100),
    Duration(milliseconds: 300),
  ];

  late bool _initialized;
  late bool _hasHosts;
  late String _selectedProviderId;
  bool _wasBackgrounded = false;
  bool _backgroundFlushActive = false;
  bool _draftJournalFlushedForBackground = false;
  int _backgroundFlushGeneration = 0;
  int _backgroundFlushAttempts = 0;
  Future<void>? _draftJournalFlushOperation;
  Timer? _draftJournalFlushRetryTimer;
  int _resumeGeneration = 0;
  Future<void>? _foregroundRecoveryOperation;
  RemoteAppStore? _trailingForegroundRecoveryStore;
  int? _trailingForegroundRecoveryGeneration;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _readAppState();
    widget.store.addListener(_handleStoreChange);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (externalSystemActivity.consumeLifecycleState(state)) {
      switch (state) {
        case AppLifecycleState.hidden:
        case AppLifecycleState.paused:
          // A picker or permission sheet is not a real foreground recovery,
          // but Android may still kill the process while that system UI is
          // covering us. Flush the latest encrypted draft before yielding.
          _enterBackgroundForDraftFlush();
          return;
        case AppLifecycleState.resumed:
          _leaveBackgroundForDraftFlush();
          return;
        case AppLifecycleState.inactive:
        case AppLifecycleState.detached:
          return;
      }
    }
    switch (state) {
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        _wasBackgrounded = true;
        _invalidatePendingForegroundRecovery();
        _enterBackgroundForDraftFlush();
        return;
      case AppLifecycleState.resumed:
        _leaveBackgroundForDraftFlush();
        if (!_wasBackgrounded) return;
        _wasBackgrounded = false;
        final resumedStore = widget.store;
        final generation = ++_resumeGeneration;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted ||
              generation != _resumeGeneration ||
              !identical(widget.store, resumedStore)) {
            return;
          }
          _requestForegroundRecovery(resumedStore, generation);
        });
        return;
      case AppLifecycleState.inactive:
        // Permission prompts, file pickers, and brief system overlays can make
        // the app inactive without actually backgrounding it.
        return;
      case AppLifecycleState.detached:
        _wasBackgrounded = true;
        _invalidatePendingForegroundRecovery();
        _enterBackgroundForDraftFlush();
        return;
    }
  }

  void _invalidatePendingForegroundRecovery() {
    _resumeGeneration += 1;
    _trailingForegroundRecoveryStore = null;
    _trailingForegroundRecoveryGeneration = null;
  }

  void _requestForegroundRecovery(RemoteAppStore store, int generation) {
    if (!mounted ||
        generation != _resumeGeneration ||
        !identical(widget.store, store)) {
      return;
    }
    if (_foregroundRecoveryOperation != null) {
      _trailingForegroundRecoveryStore = store;
      _trailingForegroundRecoveryGeneration = generation;
      return;
    }
    _startForegroundRecovery(store);
  }

  void _startForegroundRecovery(RemoteAppStore store) {
    final operation = Future<void>.sync(store.resumeFromBackground);
    _foregroundRecoveryOperation = operation;
    unawaited(_finishForegroundRecovery(operation));
  }

  Future<void> _finishForegroundRecovery(Future<void> operation) async {
    try {
      await operation;
    } on Object {
      // A later genuine background return may retry the recovery.
    }
    if (!identical(_foregroundRecoveryOperation, operation)) return;
    _foregroundRecoveryOperation = null;
    final trailingStore = _trailingForegroundRecoveryStore;
    final trailingGeneration = _trailingForegroundRecoveryGeneration;
    _trailingForegroundRecoveryStore = null;
    _trailingForegroundRecoveryGeneration = null;
    if (!mounted ||
        trailingStore == null ||
        trailingGeneration != _resumeGeneration ||
        !identical(widget.store, trailingStore)) {
      return;
    }
    _startForegroundRecovery(trailingStore);
  }

  void _enterBackgroundForDraftFlush() {
    if (!_backgroundFlushActive) {
      _backgroundFlushActive = true;
      _draftJournalFlushedForBackground = false;
      _backgroundFlushAttempts = 0;
      _backgroundFlushGeneration += 1;
    }
    _startBackgroundDraftFlush(_backgroundFlushGeneration);
  }

  void _leaveBackgroundForDraftFlush() {
    if (!_backgroundFlushActive) return;
    _backgroundFlushActive = false;
    _draftJournalFlushedForBackground = false;
    _backgroundFlushAttempts = 0;
    _backgroundFlushGeneration += 1;
    _draftJournalFlushRetryTimer?.cancel();
    _draftJournalFlushRetryTimer = null;
  }

  void _startBackgroundDraftFlush(int generation) {
    if (!mounted ||
        !_backgroundFlushActive ||
        generation != _backgroundFlushGeneration ||
        _draftJournalFlushedForBackground ||
        _backgroundFlushAttempts > _draftJournalFlushRetryDelays.length ||
        _draftJournalFlushOperation != null ||
        _draftJournalFlushRetryTimer != null) {
      return;
    }
    _backgroundFlushAttempts += 1;
    final store = widget.store;
    final operation = Future<void>.sync(store.flushDraftJournal);
    _draftJournalFlushOperation = operation;
    unawaited(_finishBackgroundDraftFlush(generation, store, operation));
  }

  Future<void> _finishBackgroundDraftFlush(
    int generation,
    RemoteAppStore store,
    Future<void> operation,
  ) async {
    var succeeded = false;
    try {
      await operation;
      succeeded = true;
    } on Object {
      // A background write gets a small bounded retry window below.
    }
    if (!identical(_draftJournalFlushOperation, operation)) return;
    _draftJournalFlushOperation = null;
    if (!mounted || !identical(widget.store, store)) return;
    if (generation != _backgroundFlushGeneration) {
      if (_backgroundFlushActive) {
        _startBackgroundDraftFlush(_backgroundFlushGeneration);
      }
      return;
    }
    if (!_backgroundFlushActive) return;
    if (succeeded) {
      _draftJournalFlushedForBackground = true;
      return;
    }
    final retryIndex = _backgroundFlushAttempts - 1;
    if (retryIndex >= _draftJournalFlushRetryDelays.length) return;
    _draftJournalFlushRetryTimer = Timer(
      _draftJournalFlushRetryDelays[retryIndex],
      () {
        _draftJournalFlushRetryTimer = null;
        _startBackgroundDraftFlush(generation);
      },
    );
  }

  @override
  void didUpdateWidget(covariant UniversalAgentRemoteApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.store, widget.store)) return;
    _invalidatePendingForegroundRecovery();
    oldWidget.store.removeListener(_handleStoreChange);
    _draftJournalFlushRetryTimer?.cancel();
    _draftJournalFlushRetryTimer = null;
    _draftJournalFlushOperation = null;
    _draftJournalFlushedForBackground = false;
    _backgroundFlushAttempts = 0;
    _backgroundFlushGeneration += 1;
    _readAppState();
    widget.store.addListener(_handleStoreChange);
    if (_backgroundFlushActive) {
      _startBackgroundDraftFlush(_backgroundFlushGeneration);
    }
  }

  void _readAppState() {
    _initialized = widget.store.initialized;
    _hasHosts = widget.store.hasHosts;
    _selectedProviderId = widget.store.selectedProviderId;
  }

  void _handleStoreChange() {
    final initialized = widget.store.initialized;
    final hasHosts = widget.store.hasHosts;
    final selectedProviderId = widget.store.selectedProviderId;
    if (initialized == _initialized &&
        hasHosts == _hasHosts &&
        selectedProviderId == _selectedProviderId) {
      return;
    }
    setState(() {
      _initialized = initialized;
      _hasHosts = hasHosts;
      _selectedProviderId = selectedProviderId;
    });
  }

  @override
  void dispose() {
    _backgroundFlushActive = false;
    _backgroundFlushGeneration += 1;
    _draftJournalFlushRetryTimer?.cancel();
    _invalidatePendingForegroundRecovery();
    WidgetsBinding.instance.removeObserver(this);
    widget.store.removeListener(_handleStoreChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final home = !_initialized
        ? const Scaffold(body: Center(child: CircularProgressIndicator()))
        : _hasHosts
            ? const AppShell()
            : const PairingScreen();
    return StoreScope(
      store: widget.store,
      child: widget.materialAppBuilder?.call(home) ??
          MaterialApp(
            title: 'Tethoq',
            debugShowCheckedModeBanner: false,
            theme:
                buildRemoteTheme(providerVisualThemeFor(_selectedProviderId)),
            home: home,
          ),
    );
  }
}
