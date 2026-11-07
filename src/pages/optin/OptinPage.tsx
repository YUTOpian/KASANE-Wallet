import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import { PinCodeHelper, WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { fetchNemOwnedNamespaces, fetchNemXemBalance } from '../../lib/nem/api';
import { getNetworkConfig } from '../../lib/symbol/network';
import MessageDialog from '../../components/MessageDialog';
import { setChain } from '../../lib/chain';
import { downloadPaperWallet } from '../../lib/paperWalletExport';
import { createOptinMnemonic, deriveOptinDestination, optinFee } from '../../lib/optin/derive';
import type { OptinDestination } from '../../lib/optin/derive';
import bgWelcome from '../../assets/optin/welcome-background.webp';
import bgPurpleSmall from '../../assets/optin/background-purple-small.webp';
import bgPurpleBig from '../../assets/optin/background-purple-big.webp';
import bgWhite from '../../assets/optin/background-white.webp';
import imgAccount from '../../assets/optin/account.png';
import imgTerms from '../../assets/optin/terms.png';
import imgNamespace from '../../assets/optin/namespace.png';
import imgVrf from '../../assets/optin/vrfkeys.png';
import imgLogoWhite from '../../assets/optin/logo_white.png';
import imgClipboard from '../../assets/optin/clipboard.png';
import imgCheck from '../../assets/optin/check.png';
import './optin.css';

// Symbol の事前オプトイン（NEM Wallet 2.5.0 の catapultOptin 画面）を、デモとして体験する画面。
// 流れと見た目は当時のまま：
//   0 ようこそ → 10 アカウントを作る（カーソルを動かす）→ 11 Symbol アカウント（アドレス / ニーモニック）
//   → 2 ネームスペース → 3 VRF キー → 4 利用規約 → 5 確定（パスワード）→ 完了後の画面
// 違うのは、最後に何も送信しないこと。ニーモニックは当時と同じく、この画面の中で新しく作る
// （カーソルの動きを乱数に混ぜて 24 語を作り、アドレスは BIP32 で導く）。このプロファイルのニーモニックは開かない。
type Step = 0 | 10 | 11 | 2 | 3 | 4 | 5;

const MIGRATION_URL = 'https://nemplatform.com/symbol-migration';
const TERMS_URL = 'https://nemplatform.com/wp-content/uploads/2020/09/Symbol-Terms-and-Conditions-for-XYM-9-Sep-2020.pdf';
// 元の画面は「ステータスを取得しています…」を、実際のノードへの問い合わせの間だけ出していた。
const MIN_LOADING_MS = 900;
const NODE_TIMEOUT_MS = 6000;
const SEND_LOADING_MS = 1600;
// カーソルを 1 回動かすごとに進む量（当時と同じ）。
const ENTROPY_STEP = 0.15;
// 集める動きの数の上限（値の個数。座標 2 つと時刻 1 つで 3 個）。進行バーが満ちるまでに十分足りる量。
const ENTROPY_SAMPLE_LIMIT = 6000;

interface FinalSnapshot {
  address: string;
  namespaces: string[];
  vrfPublicKey: string;
}

// ノードが応答しない（オフライン等）とき、いつまでも「取得しています…」のままにしない。
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const id = window.setTimeout(() => resolve(fallback), ms);
    promise.then((v) => { window.clearTimeout(id); resolve(v); }, () => { window.clearTimeout(id); resolve(fallback); });
  });
}

function microToText(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${frac}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function OptinPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tr = (key: string) => t(`optin.${key}`);

  const [step, setStep] = useState<Step>(0);
  const [loading, setLoading] = useState(true);
  const [isOptedIn, setIsOptedIn] = useState(false);
  // オプトイン先のアカウントを加える先のプロファイル（いま開いているアカウントのもの）。
  // 閲覧用・Ledger のプロファイルは署名できないので体験できない。
  const [profileWallet, setProfileWallet] = useState<Wallet | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [nemAddress, setNemAddress] = useState('');
  const [balance, setBalance] = useState<bigint>(0n);

  // step 10: 進み具合（カーソルを動かすと増える）
  const [barStarted, setBarStarted] = useState(false);
  const [barWidth, setBarWidth] = useState(0);
  const [entropyDone, setEntropyDone] = useState(false);
  const widthRef = useRef(0);
  // カーソル（指）の動き：座標と時刻。新しいニーモニックの乱数に混ぜる（画面の外には出さない）。
  const samplesRef = useRef<number[]>([]);

  const [dest, setDest] = useState<OptinDestination | null>(null);

  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [includeVrf, setIncludeVrf] = useState(false);
  const [backupConfirm, setBackupConfirm] = useState(false);
  const [understandConfirm, setUnderstandConfirm] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [final, setFinal] = useState<FinalSnapshot | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // 確定のとき、オプトイン先のアドレスを Symbol 側のアカウントに加えた結果。
  const [symbolAdd, setSymbolAdd] = useState<'added' | 'shown' | 'other-profile' | 'error' | null>(null);
  // アカウントを新しく作った（Symbol 側に加えた）あとで画面を閉じるとき、そのことを知らせるポップアップ。
  const [showCreatedNotice, setShowCreatedNotice] = useState(false);

  const skipNamespaces = namespaces.length === 0;
  const selectedNamespaces = namespaces.filter((n) => included[n]);
  const fee = optinFee(selectedNamespaces.length, includeVrf);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  // 開いたとき：プロファイルと、NEM アカウントのネームスペース・残高を調べる
  // （当時の「オプトインのステータスをフェッチしています…」に当たる）。
  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    (async () => {
      let pw: Wallet | null = null;
      let nemAddr = '';
      let ns: string[] = [];
      let bal = 0n;
      try {
        const base = await WalletsHelper.getActiveAny();
        if (base && !base.keyless) pw = base;
        const nem = await WalletsHelper.getActive('nem');
        if (nem && !nem.watchOnly) nemAddr = nem.address;
        if (nemAddr) {
          // ネームスペースが取れなければ、その手順は飛ばす（当時も同じ）。残高は 0 のまま。
          const [list, balance0] = await Promise.all([
            withTimeout(fetchNemOwnedNamespaces(nemAddr), NODE_TIMEOUT_MS, []),
            withTimeout(fetchNemXemBalance(nemAddr), NODE_TIMEOUT_MS, 0n),
          ]);
          ns = list.filter((n) => n.depth === 1 && !n.expired).map((n) => n.name);
          bal = balance0;
        }
      } catch (e) {
        console.error('OptinPage: failed to load the profile', e);
      }
      const wait = Math.max(0, MIN_LOADING_MS - (Date.now() - started));
      window.setTimeout(() => {
        if (cancelled) return;
        setProfileWallet(pw);
        setNoProfile(pw == null);
        setNemAddress(nemAddr);
        setNamespaces(ns);
        setIncluded(Object.fromEntries(ns.map((n) => [n, true])));
        setBalance(bal);
        setLoading(false);
      }, wait);
    })();
    return () => { cancelled = true; };
  }, []);

  // step 10: カーソル（指）を動かすと進む。進み切ったら「Done!」。
  useEffect(() => {
    if (step !== 10 || !barStarted || entropyDone) return;
    const onMove = (e: Event) => {
      const point = 'touches' in e ? (e as TouchEvent).touches[0] : (e as MouseEvent);
      if (point && samplesRef.current.length < ENTROPY_SAMPLE_LIMIT) {
        samplesRef.current.push(point.clientX, point.clientY, performance.now());
      }
      widthRef.current += ENTROPY_STEP;
      if (widthRef.current >= 100) {
        widthRef.current = 100;
        setBarWidth(100);
        setEntropyDone(true);
      } else {
        setBarWidth(widthRef.current);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
    };
  }, [step, barStarted, entropyDone]);

  const resetEntropy = () => {
    samplesRef.current = [];
    setDest(null);
    widthRef.current = 0;
    setBarWidth(0);
    setBarStarted(false);
    setEntropyDone(false);
  };

  // 確定の前に、NEM アドレスのいまの XEM 残高を取り直す（オプトインされる額は XEM の残高どおり）。
  // 取れなかったときは、開いたときに取った値のままにする。
  const refreshBalance = async () => {
    if (!nemAddress) return;
    const latest = await withTimeout<bigint | null>(fetchNemXemBalance(nemAddress), NODE_TIMEOUT_MS, null);
    if (latest !== null) setBalance(latest);
  };

  // 閉じる：アカウントを新しく作っていたら、先にそのことをポップアップで知らせる（OK で閉じる）。
  const exit = () => {
    if (symbolAdd === 'added') setShowCreatedNotice(true);
    else navigate('/service');
  };

  const onCopy = async (text: string) => {
    showToast((await copyText(text)) ? tr('copied') : '', false);
  };

  // step 10 の「次へ」：新しいニーモニックを作り、BIP32 でオプトイン先のアカウントを導く。
  // パスワードは聞かない（このプロファイルのニーモニックは使わない）。
  const goNextFromEntropy = () => {
    if (!entropyDone) return;
    try {
      const phrase = createOptinMnemonic(samplesRef.current);
      setDest(deriveOptinDestination(phrase, getNetworkConfig().networkByte));
      samplesRef.current = [];
      setStep(11);
    } catch (e) {
      console.error('OptinPage: failed to create the recovery phrase', e instanceof Error ? e.message : 'unknown error');
      showToast(tr('create_failed'), true);
    }
  };

  const downloadAndGo = async () => {
    if (!dest || busy) return;
    setBusy(true);
    try {
      // 当時は symbol-paper-wallets の PDF。ここではこのアプリのペーパーウォレット（Symbol 用）。
      await downloadPaperWallet({ kind: 'mnemonic', mnemonic: dest.mnemonic, chain: 'symbol' });
      setStep(skipNamespaces ? 3 : 2);
    } catch (e) {
      console.error('OptinPage: failed to build the paper wallet', e instanceof Error ? e.message : 'unknown error');
      showToast('PDF', true);
    } finally {
      setBusy(false);
    }
  };

  const backFromTerms = () => {
    setBackupConfirm(false);
    setUnderstandConfirm(false);
    setAcceptTerms(false);
    setStep(3);
  };

  const backFromConfirm = () => {
    setPassword('');
    setBackupConfirm(false);
    setUnderstandConfirm(false);
    setAcceptTerms(false);
    setStep(4);
  };

  // 「オプトインを確定する」：当時は NEM のトランザクションを署名して送っていた。ここでは
  // パスワードの確認だけして、何も送らずに完了後の画面を見せる。
  const send = async () => {
    if (!dest || !profileWallet || busy) return;
    setBusy(true);
    try {
      const ok = await PinCodeHelper.check(profileWallet.profileKey, password);
      if (!ok) {
        showToast(tr('wrong_password'), true);
        return;
      }
      // オプトイン先のアドレスを、このプロファイルの Symbol 側のアカウントとして使えるようにする。
      // すでに同じ鍵のアカウントがあれば再表示、無ければ追加（パスワードは上で確認済み）。
      let added: 'added' | 'shown' | 'other-profile' | 'error' = 'error';
      try {
        added = await WalletsHelper.addImportedKeyToProfile(profileWallet.id, dest.publicKey, dest.privateKey, password, 'symbol');
      } catch (e) {
        console.error('OptinPage: failed to add the Symbol account', e);
      }
      setSymbolAdd(added);
      setFinal({
        address: dest.address,
        namespaces: selectedNamespaces,
        vrfPublicKey: includeVrf ? dest.vrfPublicKey : '',
      });
      // 使い終わった秘密（ニーモニック・パスワード）は画面の状態から消す。
      setDest(null);
      setPassword('');
      setBackupConfirm(false);
      setUnderstandConfirm(false);
      setAcceptTerms(false);
      setStep(0);
      setLoading(true);
      window.setTimeout(() => {
        setIsOptedIn(true);
        setLoading(false);
      }, SEND_LOADING_MS);
    } finally {
      setBusy(false);
    }
  };

  // --- 部品 ---------------------------------------------------------------------------------
  const Ico = ({ side, children }: { side: 'left' | 'right'; children: ReactNode }) => (
    <span className={`optin-ico optin-ico--${side}`} aria-hidden="true">{children}</span>
  );
  const CopyIcon = ({ text }: { text: string }) => (
    <img className="clipboard-icon" src={imgClipboard} alt="" onClick={() => onCopy(text)} />
  );
  const BackBtn = ({ onClick }: { onClick: () => void }) => (
    <button type="button" className="btn symbol-button symbol-button__block float-right" onClick={onClick}>
      <Ico side="left"><ChevronLeftIcon fontSize="small" /></Ico>{tr('back')}
    </button>
  );
  const NextBtn = ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
    <button type="button" className="btn symbol-button symbol-button__block float-left" onClick={onClick} disabled={disabled}>
      {tr('next')}<Ico side="right"><ChevronRightIcon fontSize="small" /></Ico>
    </button>
  );
  const Header = ({ img, title, color }: { img: string; title: string; color?: string }) => (
    <div className="row container-div">
      <div className="col-md-12">
        <img src={img} alt="" />
        <h1 style={color ? { color } : undefined}>{title}</h1>
      </div>
    </div>
  );
  const Chrome = () => (
    <>
      <button type="button" className="optin-exit" onClick={exit} aria-label={tr('exit')}><CloseIcon fontSize="small" /></button>
      <span className="optin-demo">{tr('demo')}</span>
      {toast && toast.text && <div className={`optin-toast${toast.error ? ' is-error' : ''}`} role="status">{toast.text}</div>}
    </>
  );

  const rootStyle = { '--optin-check-img': `url(${imgCheck})` } as React.CSSProperties;
  const white = step === 4 && !loading && !isOptedIn;

  // --- 体験できないプロファイル --------------------------------------------------------------
  if (!loading && noProfile) {
    return (
      <div className="optin-root" style={rootStyle}>
        <img src={bgPurpleSmall} className="imageLogo" alt="" />
        <Chrome />
        <div className="optin-content">
          <div className="container text-center">
            <h4 className="text-white">{tr('no_profile')}</h4>
          </div>
        </div>
      </div>
    );
  }

  const createdNotice = (
    <MessageDialog
      open={showCreatedNotice}
      title={tr('account_created_title')}
      texts={t('optin.account_created_message', { returnObjects: true, address: final?.address ?? '' }) as string[]}
      onClose={() => { setShowCreatedNotice(false); navigate('/service'); }}
    />
  );

  // --- 完了後の画面（当時は NEM Wallet 本体の白い画面） -------------------------------------
  if (!loading && isOptedIn && final) {
    const whole = microToText(balance);
    return (
      <div className="optin-root optin-root--white" style={rootStyle}>
        <Chrome />
        {createdNotice}
        <div className="catapultOptin-page">
          <div className="container-fluid main">
            <div className="row">
              <div className="col-md-8"><h2>{tr('done_title')}</h2></div>
              <div className="col-md-4 helper">
                <a href={MIGRATION_URL} target="_blank" rel="noopener noreferrer"><h4>{tr('done_help')}</h4></a>
              </div>
            </div>
            <div className="row">
              <div className="col-lg-6 col-md-12">
                <div className="panel-heading">
                  <div className="tabDescription"><span>{tr('done_transaction')}</span></div>
                  <ul className="nav-tabs"><li className="active"><a>{tr('tab_normal')}</a></li></ul>
                </div>
                <div className="panel-body">
                  <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                    <label>{tr('address')}: </label>
                    <input type="text" className="form-control" value={nemAddress} readOnly />
                  </fieldset>
                  <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                    <label>{tr('balance')}: </label>
                    <div className="form-control formFloat"><input type="text" value={whole} readOnly disabled /><small>XEM</small></div>
                  </fieldset>
                </div>
                <div style={{ marginTop: 40 }}>
                  <h4 className="alert-success">{tr('done_success')}</h4>
                </div>
              </div>
              <div className="col-lg-6 col-md-12">
                <div className="panel-heading margin-form"><h3>{tr('done_review')}</h3></div>
                <div className="margin-form"><h5 className="title-list">{tr('symbol_address')}</h5></div>
                <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                  <input type="text" className="form-control" value={final.address} readOnly />
                </fieldset>
                {symbolAdd && (
                  <div className="margin-form" style={{ marginBottom: 15 }}>
                    <p style={{ color: symbolAdd === 'error' || symbolAdd === 'other-profile' ? '#c0392b' : '#198754', fontSize: 14 }}>
                      {tr(`symbol_add_${symbolAdd === 'other-profile' ? 'other' : symbolAdd}`)}
                    </p>
                    {(symbolAdd === 'added' || symbolAdd === 'shown') && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => { setChain('symbol'); navigate('/account', { replace: true }); }}
                      >
                        {tr('open_in_symbol')}
                      </button>
                    )}
                  </div>
                )}
                <div className="margin-form"><h5 className="title-list">{tr('ns_opted')}</h5></div>
                <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                  {final.namespaces.map((n) => (
                    <ul className="list-group" key={n}><li className="list-group-item">{n}</li></ul>
                  ))}
                  {final.namespaces.length === 0 && <p className="nothing" style={{ color: '#7b8993', fontSize: 14 }}>{tr('none')}</p>}
                </fieldset>
                {final.vrfPublicKey && (
                  <>
                    <div className="margin-form"><h5 className="title-list">{tr('vrf_public_key')}</h5></div>
                    <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                      <input type="text" className="form-control" value={final.vrfPublicKey} readOnly />
                    </fieldset>
                  </>
                )}
                <div className="margin-form"><h5 className="title-list">{tr('balance_snapshot')}</h5></div>
                <fieldset className="form-group" style={{ border: 0, padding: 0, margin: '0 0 15px' }}>
                  <div className="form-control formFloat"><input type="text" value={whole} readOnly disabled /><small>XYM</small></div>
                </fieldset>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- 背景（元は動画 / 画像） -----------------------------------------------------------------
  let background = bgPurpleSmall;
  if (loading || step === 0) background = bgWelcome;
  else if (step === 5) background = bgPurpleBig;
  else if (step === 4) background = bgWhite;

  return (
    <div className={`optin-root${white ? ' optin-root--white' : ''}`} style={rootStyle}>
      <img src={background} className="imageLogo" alt="" />
      <Chrome />
      {createdNotice}
      <div className="optin-content">
        <div className="container">
          {/* LOADING */}
          {loading && (
            <div className="row welcome-page">
              <div className="col-md-12"><h1 className="text-white">{tr('welcome_loading')}</h1></div>
            </div>
          )}

          {/* STEP 0: WELCOME */}
          {!loading && step === 0 && (
            <>
              <div className="row welcome-page">
                <div className="col-md-12"><h1 className="text-white">{tr('welcome_title')}</h1></div>
              </div>
              <div className="col-md-10 welcome-page" style={{ top: '48%', marginLeft: -15 }}>
                <div className="form-group" style={{ marginBottom: 25 }}>
                  <h4 className="text-white">{tr('info_1')}</h4>
                  <h4 className="text-white">{tr('info_2')} <br /> {tr('info_3')}</h4>
                  <h4 style={{ marginTop: 15 }}>
                    <a href={MIGRATION_URL} target="_blank" rel="noopener noreferrer" className="symbol-link">
                      <strong>{tr('link_info')}<span style={{ textDecoration: 'underline' }}>{tr('here')}</span></strong>
                    </a>
                  </h4>
                </div>
                <button type="button" className="btn symbol-button" onClick={() => { resetEntropy(); setStep(10); }}>{tr('ready')}</button>
              </div>
            </>
          )}

          {/* STEP 10: CREATE THE SYMBOL ACCOUNT (move the cursor) */}
          {!loading && step === 10 && (
            <>
              <Header img={imgAccount} title={tr('create_account')} />
              <div className="row text-center">
                <div className="col-md-12 centered-col" style={{ marginBottom: 50 }}>
                  <img src={imgLogoWhite} alt="" style={{ width: '15%' }} />
                </div>
                <div className="col-md-12 text-center">
                  <div>
                    <p>{tr('entropy_info_1')}</p>
                    <p><b>{tr('entropy_info_2')}</b></p>
                  </div>
                  {!barStarted && (
                    <div className="mt-4">
                      <div className="row">
                        <button type="button" className="btn symbol-button" onClick={() => setBarStarted(true)}>{tr('start')}</button>
                      </div>
                    </div>
                  )}
                  {barStarted && (
                    <div className="progressBar">
                      <div id="pBarOptIn" style={{ width: `${barWidth}%` }}>
                        {entropyDone
                          ? <span><CheckCircleIcon sx={{ fontSize: 14, verticalAlign: '-2px' }} /> Done!</span>
                          : <span>{Math.round(barWidth)}%</span>}
                      </div>
                    </div>
                  )}
                  {entropyDone && (
                    <div className="row mt-4">
                      <div className="col-md-6"><BackBtn onClick={() => { resetEntropy(); setStep(0); }} /></div>
                      <div className="col-md-6"><NextBtn onClick={goNextFromEntropy} /></div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* STEP 11: YOUR SYMBOL ACCOUNT */}
          {!loading && step === 11 && dest && (
            <>
              <Header img={imgAccount} title={tr('symbol_ready')} />
              <div className="col-md-8 col-md-offset-2">
                <div className="form-group">
                  <p>{tr('your_address')}</p>
                  <label className="text-center optin-label-form">{dest.address}</label>
                  <CopyIcon text={dest.address} />
                </div>
                <div className="form-group" style={{ marginBottom: '4em' }}>
                  <p>{tr('your_mnemonic')}</p>
                  <label className="text-center optin-label-form">{dest.mnemonic}</label>
                  <CopyIcon text={dest.mnemonic} />
                </div>
                <div className="text-center">
                  <a className="btn symbol-button" role="button" onClick={downloadAndGo}>
                    <Ico side="left"><FileDownloadOutlinedIcon fontSize="small" /></Ico>{tr('download_wallet')}
                  </a>
                </div>
              </div>
            </>
          )}

          {/* STEP 2: NAMESPACES */}
          {!loading && step === 2 && (
            <>
              <Header img={imgNamespace} title={tr('ns_title')} />
              <div className="row text-center">
                <div className="col-md-8 col-md-offset-2">
                  <h4>{tr('ns_info')}</h4>
                  <h4><b><a href={`${MIGRATION_URL}#acc-tb_mrzh282-10`} target="_blank" rel="noopener noreferrer" className="symbol-link">{tr('ns_link')}<span style={{ textDecoration: 'underline' }}>{tr('here')}</span></a></b></h4>
                </div>
              </div>
              <div className="col-md-12 mt-4" style={{ marginTop: '2rem' }}>
                <div className="col-md-6 col-md-offset-3">
                  <form className="form" onSubmit={(e) => e.preventDefault()}>
                    <h4 style={{ marginBottom: '1em' }}>{tr('ns_select')}</h4>
                    {namespaces.map((n) => (
                      <div className="inputGroupSymbol" key={n}>
                        <input id={`ns-${n}`} type="checkbox" checked={!!included[n]} onChange={(e) => setIncluded((prev) => ({ ...prev, [n]: e.target.checked }))} />
                        <label htmlFor={`ns-${n}`}>{n}</label>
                      </div>
                    ))}
                  </form>
                </div>
                <div className="col-md-6 col-md-offset-3 mt-4">
                  <div className="row">
                    <div className="col-md-6"><BackBtn onClick={() => setStep(11)} /></div>
                    <div className="col-md-6"><NextBtn onClick={() => setStep(3)} /></div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* STEP 3: VRF KEYS */}
          {!loading && step === 3 && dest && (
            <>
              <Header img={imgVrf} title={tr('vrf_title')} />
              <div className="row text-center">
                <div className="col-md-8 col-md-offset-2">
                  <h4>{tr('vrf_info')}</h4>
                  <h4><b><a href={`${MIGRATION_URL}#acc-tb_mrzh282-11`} target="_blank" rel="noopener noreferrer" className="symbol-link">{tr('vrf_link')}<span style={{ textDecoration: 'underline' }}>{tr('here')}</span></a></b></h4>
                </div>
              </div>
              <div className="col-md-12">
                <div className="col-md-6 col-md-offset-3">
                  <div className="inputGroupSymbol">
                    <input id="vrfCheckbox" type="checkbox" checked={includeVrf} onChange={(e) => setIncludeVrf(e.target.checked)} />
                    <label htmlFor="vrfCheckbox">{tr('vrf_keys')}</label>
                  </div>
                </div>
                {includeVrf && (
                  <div className="col-md-8 col-md-offset-2">
                    <div className="mt-4">
                      <p>{tr('vrf_public')}</p>
                      <label className="text-center optin-label-form">{dest.vrfAddress}</label>
                      <CopyIcon text={dest.vrfAddress} />
                    </div>
                    <div className="mt-4">
                      <p>{tr('vrf_private')}</p>
                      <label className="text-center optin-label-form">{dest.vrfPrivateKey}</label>
                      <CopyIcon text={dest.vrfPrivateKey} />
                    </div>
                  </div>
                )}
              </div>
              <div className="col-md-12 mt-4">
                <div className="col-md-6 col-md-offset-3">
                  <div className="row">
                    <div className="col-md-6"><BackBtn onClick={() => setStep(skipNamespaces ? 11 : 2)} /></div>
                    <div className="col-md-6"><NextBtn onClick={() => setStep(4)} /></div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* STEP 4: TERMS AND CONDITIONS */}
          {!loading && step === 4 && (
            <>
              <Header img={imgTerms} title={tr('tac_title')} color="#44004E" />
              <div className="row text-center">
                <div className="col-md-12">
                  <h4>
                    <p style={{ color: '#44004E' }}>{tr('tac_info_1')}</p>
                    <p style={{ color: '#44004E' }}><b>{tr('tac_info_2')}</b></p>
                  </h4>
                </div>
              </div>
              <div className="col-md-12 mt-4">
                <div className="col-md-offset-1 col-md-10">
                  <div>
                    <input id="backup_confirm" className="optin-plain" type="checkbox" checked={backupConfirm} onChange={(e) => setBackupConfirm(e.target.checked)} />
                    <label htmlFor="backup_confirm" className="optin-agree" style={{ color: '#44004E' }}>{tr('confirm_backup')}</label>
                  </div>
                  <div className="mt-2">
                    <input id="understand_confirm" className="optin-plain" type="checkbox" checked={understandConfirm} onChange={(e) => setUnderstandConfirm(e.target.checked)} />
                    <label htmlFor="understand_confirm" className="optin-agree" style={{ color: '#44004E' }}>{tr('understand_funds')}</label>
                  </div>
                  <div className="mt-2">
                    <input id="accept_and_read_terms" className="optin-plain" type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
                    <label htmlFor="accept_and_read_terms" className="optin-agree" style={{ color: '#44004E' }}>
                      {tr('read_accept')}<a href={TERMS_URL} className="symbol-link" style={{ color: 'rgb(205,0,205)' }} target="_blank" rel="noopener noreferrer">{tr('tac_text')}</a>{tr('read_accept_post')}
                    </label>
                  </div>
                  <div className="mt-4">
                    <div className="row">
                      <div className="col-md-6"><BackBtn onClick={backFromTerms} /></div>
                      <div className="col-md-6">
                        <button
                          type="button"
                          className="btn symbol-button symbol-button__block symbol-button--pink float-left"
                          onClick={() => { void refreshBalance(); setStep(5); }}
                          disabled={!backupConfirm || !understandConfirm || !acceptTerms}
                        >{tr('confirm_3')}</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* STEP 5: CONFIRM */}
          {!loading && step === 5 && dest && (
            <>
              <Header img={imgLogoWhite} title={tr('confirm_title')} />
              <div className="row text-center">
                <div className="col-md-12"><h4>{tr('confirm_info')}</h4></div>
              </div>
              <div className="col-md-12">
                <div className="col-md-8 col-md-offset-2">
                  <div className="mt-4">
                    <p>{tr('your_address')}</p>
                    <label className="text-center optin-label-form" style={{ width: '100%' }}>{dest.address}</label>
                  </div>
                  <div className="mt-4">
                    <p>{tr('your_mnemonic')}</p>
                    <label className="text-center optin-label-form" style={{ width: '100%' }}>{dest.mnemonic}</label>
                  </div>
                  {!skipNamespaces && (
                    <div className="mt-4">
                      <p>{tr('ns_list')}</p>
                      {namespaces.map((n) => (
                        <div className="inputGroupSymbol is-readonly" key={n}>
                          <input id={`final-${n}`} type="checkbox" checked={!!included[n]} readOnly onChange={() => undefined} />
                          <label htmlFor={`final-${n}`} onClick={(e) => e.preventDefault()}>{n}</label>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-4">
                    <p>{tr('vrf_keys')}</p>
                    <div className="inputGroupSymbol is-readonly">
                      <input id="final-includeVrf" type="checkbox" checked={includeVrf} readOnly onChange={() => undefined} />
                      <label htmlFor="final-includeVrf" onClick={(e) => e.preventDefault()}>{tr('vrf_keys')}</label>
                    </div>
                  </div>
                  <div className="mt-4">
                    <p>{tr('balance_snapshot')}</p>
                    <label className="text-left optin-label-form" style={{ width: '100%', textAlign: 'left', paddingLeft: 30 }}>{microToText(balance)} XYM</label>
                  </div>
                  <div className="mt-4">
                    <p>{tr('fee')}</p>
                    <label className="text-left optin-label-form" style={{ width: '100%', textAlign: 'left', paddingLeft: 30 }}>{fee} XEM</label>
                  </div>
                  <div className="mt-4">
                    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                      <p>{tr('enter_password')}</p>
                      <div className="input-group">
                        <input
                          className="form-control optin-input"
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          autoComplete="current-password"
                          onChange={(e) => setPassword(e.target.value)}
                        />
                        <span className="input-group-addon icon-eye" onClick={() => setShowPassword((v) => !v)}>
                          {showPassword ? <VisibilityOffIcon sx={{ fontSize: 18 }} /> : <VisibilityIcon sx={{ fontSize: 18 }} />}
                        </span>
                      </div>
                    </fieldset>
                  </div>
                  <div className="mt-4">
                    <div className="row">
                      <div className="col-md-6"><BackBtn onClick={backFromConfirm} /></div>
                      <div className="col-md-6">
                        <button type="button" className="btn symbol-button symbol-button__block float-left" onClick={send} disabled={password.length === 0 || busy}>{tr('confirm_optin')}</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
