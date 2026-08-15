import 'dart:async';

import 'models.dart';
import 'transport.dart';

typedef DesktopRpcRequester = Future<JsonMap> Function(
  String type,
  JsonMap payload, {
  required Duration timeout,
});

enum DesktopAppState {
  running,
  stopped,
  starting;

  static DesktopAppState fromWire(Object? value) {
    return switch (value) {
      'running' => DesktopAppState.running,
      'stopped' => DesktopAppState.stopped,
      'starting' => DesktopAppState.starting,
      _ => throw const FormatException(
          'Tethoq Desktop returned an invalid lifecycle state'),
    };
  }
}

class DesktopWakeResult {
  const DesktopWakeResult({
    required this.state,
    required this.launched,
    required this.alreadyRunning,
  });

  final DesktopAppState state;
  final bool launched;
  final bool alreadyRunning;
}

class DesktopWakeTimeoutException implements Exception {
  const DesktopWakeTimeoutException();

  @override
  String toString() => 'Tethoq Desktop did not become ready in time';
}

/// Performs the small, authenticated lifecycle handshake used by an explicit
/// "Open Tethoq" action. It never accepts a path, executable, argument, or
/// session payload from the phone.
class DesktopWakeCoordinator {
  DesktopWakeCoordinator({
    required DesktopRpcRequester request,
    Future<void> Function(Duration duration)? delay,
    this.statusRequestTimeout = const Duration(seconds: 4),
    // The Bridge may wait up to 15 seconds for Desktop's authenticated
    // readiness endpoint. Leave transport/headroom so the response is not
    // abandoned while Desktop is still legitimately starting.
    this.wakeRequestTimeout = const Duration(seconds: 18),
    this.readinessTimeout = const Duration(seconds: 20),
    this.pollInterval = const Duration(milliseconds: 500),
  })  : _request = request,
        _delay = delay ?? Future<void>.delayed;

  final DesktopRpcRequester _request;
  final Future<void> Function(Duration duration) _delay;
  final Duration statusRequestTimeout;
  final Duration wakeRequestTimeout;
  final Duration readinessTimeout;
  final Duration pollInterval;

  Future<DesktopAppState> status({Duration? timeout}) async {
    final response = await _request(
      'desktop.status',
      const <String, Object?>{},
      timeout: timeout ?? statusRequestTimeout,
    );
    return DesktopAppState.fromWire(response['state']);
  }

  Future<DesktopWakeResult> wake() async {
    final initial = await status();
    if (initial == DesktopAppState.running) {
      return const DesktopWakeResult(
        state: DesktopAppState.running,
        launched: false,
        alreadyRunning: true,
      );
    }

    final wakeResponse = await _request(
      'desktop.wake',
      const <String, Object?>{},
      timeout: wakeRequestTimeout,
    );
    final wakeState = DesktopAppState.fromWire(wakeResponse['state']);
    if (wakeState == DesktopAppState.stopped) {
      throw const FormatException(
          'Tethoq Desktop returned an invalid wake state');
    }
    final launched = wakeResponse['launched'] == true;
    if (wakeState == DesktopAppState.running) {
      return DesktopWakeResult(
        state: DesktopAppState.running,
        launched: launched,
        alreadyRunning: false,
      );
    }

    var remaining = readinessTimeout;
    while (remaining > Duration.zero) {
      final pause = remaining < pollInterval ? remaining : pollInterval;
      await _delay(pause);
      remaining -= pause;
      try {
        final current = await status(
          timeout: remaining < statusRequestTimeout && remaining > Duration.zero
              ? remaining
              : statusRequestTimeout,
        );
        if (current == DesktopAppState.running) {
          return DesktopWakeResult(
            state: DesktopAppState.running,
            launched: launched,
            alreadyRunning: false,
          );
        }
      } on BridgeRequestException catch (error) {
        if (!error.retryable) rethrow;
      } on TimeoutException {
        // A transient readiness probe can consume its small timeout. The next
        // bounded probe is still useful while the app is starting.
      }
    }
    throw const DesktopWakeTimeoutException();
  }
}
