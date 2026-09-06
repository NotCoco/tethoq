import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:universal_agent_remote/src/screens.dart';

void main() {
  test('camera permission lifecycle cannot cancel the first scanner start', () {
    expect(
      pairingScannerLifecycleCommand(
        AppLifecycleState.inactive,
        hasCameraPermission: false,
        returning: false,
      ),
      PairingScannerLifecycleCommand.none,
    );
    expect(
      pairingScannerLifecycleCommand(
        AppLifecycleState.resumed,
        hasCameraPermission: false,
        returning: false,
      ),
      PairingScannerLifecycleCommand.none,
    );
    expect(
      pairingScannerLifecycleCommand(
        AppLifecycleState.inactive,
        hasCameraPermission: true,
        returning: false,
      ),
      PairingScannerLifecycleCommand.stop,
    );
    expect(
      pairingScannerLifecycleCommand(
        AppLifecycleState.resumed,
        hasCameraPermission: true,
        returning: false,
      ),
      PairingScannerLifecycleCommand.start,
    );
    expect(
      pairingScannerLifecycleCommand(
        AppLifecycleState.resumed,
        hasCameraPermission: true,
        returning: true,
      ),
      PairingScannerLifecycleCommand.none,
    );
  });

  test('quick pause and resume restarts after an in-flight scanner stop',
      () async {
    var running = true;
    var starting = false;
    var startCalls = 0;
    var stopCalls = 0;
    final stopGate = Completer<void>();
    final transitions = PairingScannerTransitionCoordinator(
      isRunning: () => running,
      isStarting: () => starting,
      start: () async {
        startCalls += 1;
        starting = true;
        await Future<void>.delayed(Duration.zero);
        starting = false;
        running = true;
      },
      stop: () async {
        stopCalls += 1;
        await stopGate.future;
        running = false;
      },
    );

    transitions.requestRunning(false);
    await Future<void>.delayed(Duration.zero);
    expect(stopCalls, 1);

    transitions.requestRunning(true);
    stopGate.complete();
    await transitions.settled;

    expect(stopCalls, 1);
    expect(startCalls, 1);
    expect(running, isTrue,
        reason: 'resume must win even when stop was already in flight');
  });

  testWidgets('Codex Remote QR is handed off instead of paired as Tethoq',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: PairingQrScannerScreen()),
    );
    await tester.pump();

    expect(find.text('Scan QR code'), findsOneWidget);
    expect(
      tester
          .widget<MobileScanner>(find.byType(MobileScanner))
          .controller
          ?.autoStart,
      isFalse,
    );

    void scanCodexRemoteQr() {
      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect!(const BarcodeCapture(
        barcodes: <Barcode>[
          Barcode(
            rawValue: 'https://chatgpt.com/codex/pair?pairing_code=test-code',
          ),
        ],
      ));
    }

    scanCodexRemoteQr();
    await tester.pumpAndSettle();

    expect(
      find.text('This connects the ChatGPT app, not Tethoq'),
      findsOneWidget,
    );
    expect(find.text('Continue scanning'), findsOneWidget);
    expect(find.text('Open in ChatGPT'), findsOneWidget);

    await tester.tap(find.text('Continue scanning'));
    await tester.pumpAndSettle();
    expect(
      find.text('This connects the ChatGPT app, not Tethoq'),
      findsNothing,
    );

    scanCodexRemoteQr();
    await tester.pumpAndSettle();
    expect(
      find.text('This connects the ChatGPT app, not Tethoq'),
      findsOneWidget,
    );
  });
}
