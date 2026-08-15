import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:universal_agent_remote/src/screens.dart';

void main() {
  testWidgets('Codex Remote QR is handed off instead of paired as Tethoq',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: PairingQrScannerScreen()),
    );
    await tester.pump();

    expect(find.text('Scan QR code'), findsOneWidget);

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
