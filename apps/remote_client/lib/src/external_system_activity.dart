import 'package:flutter/widgets.dart';

/// Coordinates lifecycle signals caused by system-owned UI such as pickers.
final externalSystemActivity = ExternalSystemActivityCoordinator();

class ExternalSystemActivityCoordinator {
  final List<ExternalSystemActivityLease> _activeLeases =
      <ExternalSystemActivityLease>[];
  bool _overlayReturnPending = false;

  ExternalSystemActivityLease acquire() {
    final lease = ExternalSystemActivityLease._(this);
    _activeLeases.add(lease);
    return lease;
  }

  /// Returns whether [state] belongs to an external-system-activity round trip.
  ///
  /// Once a leased activity backgrounds the Flutter view, that classification
  /// remains sticky through its matching resume even if the awaited plugin
  /// result releases the lease first.
  bool consumeLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        if (_overlayReturnPending) return true;
        final lease = _latestUnclaimedLease();
        if (lease == null) return false;
        lease._claimed = true;
        _overlayReturnPending = true;
        return true;
      case AppLifecycleState.resumed:
        if (!_overlayReturnPending) return false;
        _overlayReturnPending = false;
        return true;
      case AppLifecycleState.inactive:
        return false;
      case AppLifecycleState.detached:
        _overlayReturnPending = false;
        return false;
    }
  }

  ExternalSystemActivityLease? _latestUnclaimedLease() {
    for (var index = _activeLeases.length - 1; index >= 0; index -= 1) {
      final lease = _activeLeases[index];
      if (!lease._claimed) return lease;
    }
    return null;
  }

  void _release(ExternalSystemActivityLease lease) {
    final removed = _activeLeases.remove(lease);
    assert(removed);
  }
}

class ExternalSystemActivityLease {
  ExternalSystemActivityLease._(this._coordinator);

  final ExternalSystemActivityCoordinator _coordinator;
  bool _claimed = false;
  bool _released = false;

  void release() {
    if (_released) return;
    _released = true;
    _coordinator._release(this);
  }
}
