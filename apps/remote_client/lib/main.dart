import 'dart:async';

import 'package:flutter/material.dart';

import 'src/app_shell.dart';
import 'src/app_theme.dart';
import 'src/demo_store.dart';
import 'src/screens.dart';
import 'src/store.dart';

void main(List<String> arguments) {
  WidgetsFlutterBinding.ensureInitialized();
  const demoBuild =
      bool.fromEnvironment('TETHOQ_DEMO') || bool.fromEnvironment('UAR_DEMO');
  final demoMode = demoBuild || arguments.contains('--demo');
  final store = demoMode ? DemoRemoteAppStore() : RemoteAppStore();
  runApp(UniversalAgentRemoteApp(store: store));
  unawaited(store.initialize());
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

class _UniversalAgentRemoteAppState extends State<UniversalAgentRemoteApp> {
  late bool _initialized;
  late bool _hasHosts;
  late String _selectedProviderId;

  @override
  void initState() {
    super.initState();
    _readAppState();
    widget.store.addListener(_handleStoreChange);
  }

  @override
  void didUpdateWidget(covariant UniversalAgentRemoteApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.store, widget.store)) return;
    oldWidget.store.removeListener(_handleStoreChange);
    _readAppState();
    widget.store.addListener(_handleStoreChange);
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
