// Run: npx tsx dev-tests/ledger-link.test.ts
// The screen shows only "USB cable" and "Bluetooth". Which USB method (WebHID / WebUSB) is used is decided here.
import { openCable, usbTryOrder } from '../src/lib/ledger/transport';
import type { LedgerTransport, TransportKind } from '../src/lib/ledger/transport';
import { LedgerError } from '../src/lib/ledger/framing';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const both = { hid: true, usb: true };
const fakeT = (kind: TransportKind): LedgerTransport => ({ kind, async exchange() { return new Uint8Array(0); }, async close() {}, onDisconnect() {} });

(async () => {
  // --- order
  check('order: WebHID first by default', usbTryOrder(both, null, null).join() === 'hid,usb');
  check('order: Android (WebUSB only) has just usb', usbTryOrder({ hid: false, usb: true }, null, null).join() === 'usb');
  check('order: neither supported -> empty', usbTryOrder({ hid: false, usb: false }, null, null).length === 0);
  check('order: the method that worked last time goes first', usbTryOrder(both, 'usb', null).join() === 'usb,hid');
  check('order: the method that failed last time goes last', usbTryOrder(both, null, 'hid').join() === 'usb,hid');
  check('order: a failed method is still tried when it is the only one', usbTryOrder({ hid: true, usb: false }, null, 'hid').join() === 'hid');

  // --- opening
  {
    const tried: string[] = [];
    const t = await openCable(['hid', 'usb'], async (k) => { tried.push(k); return fakeT(k); });
    check('open: first method works -> used, second not tried', t.kind === 'hid' && tried.join() === 'hid');
  }
  {
    const tried: string[] = []; const failedKinds: string[] = [];
    const t = await openCable(['hid', 'usb'], async (k) => { tried.push(k); if (k === 'hid') throw new LedgerError('in_use', 'busy'); return fakeT(k); }, (k) => failedKinds.push(k));
    check('open: HID cannot be opened -> falls back to WebUSB', t.kind === 'usb' && tried.join() === 'hid,usb' && failedKinds.join() === 'hid');
  }
  {
    const tried: string[] = [];
    let err: unknown = null;
    try { await openCable(['hid', 'usb'], async (k) => { tried.push(k); throw new LedgerError('no_device'); }); } catch (e) { err = e; }
    check('open: closing the chooser stops at once (no second chooser)', err instanceof LedgerError && err.kind === 'no_device' && tried.join() === 'hid');
  }
  {
    let err: unknown = null;
    try { await openCable(['hid', 'usb'], async (k) => { throw new LedgerError(k === 'hid' ? 'in_use' : 'disconnected', k); }); } catch (e) { err = e; }
    check('open: both fail -> the first error is reported', err instanceof LedgerError && err.kind === 'in_use');
  }
  {
    let err: unknown = null;
    try { await openCable([], async (k) => fakeT(k)); } catch (e) { err = e; }
    check('open: nothing supported -> unsupported_browser', err instanceof LedgerError && err.kind === 'unsupported_browser');
  }
  console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
