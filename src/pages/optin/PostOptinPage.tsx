import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import CloseIcon from '@mui/icons-material/Close';
import { PinCodeHelper, WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { nodeRequest } from '../../lib/nem/api';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } from '../../lib/nem/crypto';
import { getNetworkConfig } from '../../lib/symbol/network';
import { addressFromPublicKey, prettyAddress } from '../../lib/symbol/crypto';
import {
  POST_OPTIN_FEE_XEM, amountLabelKey, canClaim, canStart, formatClaimAmount, isPublicKeyFormat, isUnusedOnNem,
  randomClaimAmount, showsDestination,
} from '../../lib/optin/post';
import type { NemAccountLookup, PostOptinStatus } from '../../lib/optin/post';
import bgWelcome from '../../assets/optin/welcome-background.webp';
import bgPurpleSmall from '../../assets/optin/background-purple-small.webp';
import bgWhite from '../../assets/optin/background-white.webp';
import imgAccount from '../../assets/optin/account.png';
import imgPassword from '../../assets/optin/password.png';
import imgTerms from '../../assets/optin/terms.png';
import imgVerify from '../../assets/optin/address-verify.png';
import imgCheck from '../../assets/optin/check.png';
import './optin.css';

// Symbol の事後オプトイン（NEM Wallet 2.5.1 の catapultOptin 画面、Symbol メインネット稼働後のもの）を、デモとして体験する画面。
// 流れと見た目は当時のまま：
//   0 ようこそ → 15 アカウントを選ぶ・ステータス → 16 Symbol の公開鍵 → 17 内容の確認（利用規約・パスワード）
//   → 送信前の注意（アドレスの確認）→ 0 に戻ってステータスを取り直す → 15 で「保留中」を見る
// 違うのは、何も送らないことと、請求する金額が 1 XYM 〜 100 万 XYM のランダムな額になる点。
// 当時は、通常のアカウントと、マルチシグアカウント（連署者ごとに署名）の 2 通りがあった。ここでは通常のアカウントだけ。
type Step = 0 | 15 | 16 | 17;

const MIGRATION_URL = 'https://nemplatform.com/symbol-migration';
const TERMS_URL = 'https://symbolplatform.com/terms-conditions/';
// 元の画面は「データを取得しています…」を、実際のノードへの問い合わせの間だけ出していた。
const MIN_LOADING_MS = 900;
const NODE_TIMEOUT_MS = 6000;
const SEND_LOADING_MS = 1600;

// ノードが応答しない（オフライン等）とき、いつまでも待たせない。
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const id = window.setTimeout(() => resolve(fallback), ms);
    promise.then((v) => { window.clearTimeout(id); resolve(v); }, () => { window.clearTimeout(id); resolve(fallback); });
  });
}

// NEM のアカウント情報（残高・公開鍵の記録）。取れなければ null。
function lookupNemAccount(address: string): Promise<NemAccountLookup | null> {
  const request = nodeRequest<{ account?: { balance?: number; publicKey?: string | null } }>(`/account/get?address=${address}`)
    .then((r): NemAccountLookup => ({ balance: r.account?.balance ?? 0, publicKey: r.account?.publicKey ?? null }));
  return withTimeout<NemAccountLookup | null>(request, NODE_TIMEOUT_MS, null);
}

// 入力された 64 文字が、NIS1 の鍵ではなく Symbol の公開鍵として使えるか（当時と同じ確かめ方）。
async function isSymbolPublicKey(key: string, networkByte: number): Promise<boolean> {
  let asPublic: string | null = null;
  let asPrivate: string | null = null;
  try { asPublic = nemAddressFromPublicKey(key, networkByte); } catch { /* not usable as a public key */ }
  try { asPrivate = nemAddressFromPublicKey(nemKeyPairFromPrivateKey(key).publicKey, networkByte); } catch { /* not usable as a private key */ }
  const [a, b] = await Promise.all([asPublic ? lookupNemAccount(asPublic) : null, asPrivate ? lookupNemAccount(asPrivate) : null]);
  return isUnusedOnNem(a, b);
}

interface OptinTarget {
  publicKey: string;
  /** ハイフン区切りの Symbol アドレス（当時の画面と同じ表示）。 */
  address: string;
}

export default function PostOptinPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tr = (key: string) => t(`optin.${key}`);
  const tp = (key: string) => t(`postoptin.${key}`);

  const [step, setStep] = useState<Step>(0);
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [nemWallet, setNemWallet] = useState<Wallet | null>(null);
  const [status, setStatus] = useState<PostOptinStatus>(1);
  const [amountMicro, setAmountMicro] = useState(0n);
  const [optinAddress, setOptinAddress] = useState('');

  const [publicKey, setPublicKey] = useState('');
  const [optinAccount, setOptinAccount] = useState<OptinTarget | null>(null);
  const [publicKeyError, setPublicKeyError] = useState(false);
  const keyCheckId = useRef(0);

  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [password, setPassword] = useState('');
  const [modalShown, setModalShown] = useState(false);
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const sendTimer = useRef<number | undefined>(undefined);

  const fetching = loading || statusLoading;

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => () => window.clearTimeout(sendTimer.current), []);

  // 開いたとき：NEM アカウントを調べ、請求する額をランダムに決める（当時の「オプトインのデータをフェッチしています…」に当たる）。
  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    (async () => {
      let wallet: Wallet | null = null;
      try {
        wallet = await WalletsHelper.getActive('nem');
      } catch (e) {
        console.error('PostOptinPage: failed to load the account', e);
      }
      const wait = Math.max(0, MIN_LOADING_MS - (Date.now() - started));
      window.setTimeout(() => {
        if (cancelled) return;
        setNemWallet(wallet);
        // 請求する金額は、開くたびに 1 XYM 〜 100 万 XYM からランダムに決める（残高とは関係ない）。
        setAmountMicro(randomClaimAmount());
        setLoading(false);
      }, wait);
    })();
    return () => { cancelled = true; };
  }, []);

  const exit = () => navigate('/service');

  // 公開鍵の入力：64 文字になったら、NIS1 の鍵でないか確かめて、Symbol のアドレスを出す。
  const onPublicKeyChange = (value: string) => {
    setPublicKey(value);
    const id = ++keyCheckId.current;
    const key = value.trim();
    if (!isPublicKeyFormat(key)) {
      setOptinAccount(null);
      setPublicKeyError(false);
      return;
    }
    void (async () => {
      const networkByte = getNetworkConfig().networkByte;
      let target: OptinTarget | null = null;
      try {
        if (await isSymbolPublicKey(key, networkByte)) {
          target = { publicKey: key.toUpperCase(), address: prettyAddress(addressFromPublicKey(key, networkByte)) };
        }
      } catch (e) {
        console.error('PostOptinPage: failed to check the public key', e instanceof Error ? e.message : 'unknown error');
      }
      if (id !== keyCheckId.current) return;
      setOptinAccount(target);
      setPublicKeyError(target === null);
    })();
  };

  const backFromKey = () => {
    keyCheckId.current += 1;
    setOptinAccount(null);
    setPublicKey('');
    setPublicKeyError(false);
    setStep(15);
  };

  // 「送信」：パスワードを確かめて、アドレスの確認（注意）を出す。
  const showConfirmAddressModal = async () => {
    if (!nemWallet || busy) return;
    setBusy(true);
    try {
      const ok = await PinCodeHelper.check(nemWallet.profileKey, password);
      if (!ok) {
        showToast(tr('wrong_password'), true);
        return;
      }
      setAddressConfirmed(false);
      setModalShown(true);
    } finally {
      setBusy(false);
    }
  };

  // 確認のあとの「送信」：当時は NEM のトランザクションを署名して送っていた。ここでは何も送らず、
  // 最初の画面に戻ってステータスを取り直し、「保留中」にする。
  const send = () => {
    if (!optinAccount) return;
    const destination = optinAccount.address;
    setModalShown(false);
    setStep(0);
    setStatusLoading(true);
    setPassword('');
    setAcceptTerms(false);
    setAcceptPrivacy(false);
    sendTimer.current = window.setTimeout(() => {
      setOptinAddress(destination);
      setStatus(2);
      setOptinAccount(null);
      setPublicKey('');
      setPublicKeyError(false);
      setStatusLoading(false);
    }, SEND_LOADING_MS);
  };

  // --- 部品 ---------------------------------------------------------------------------------
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
      {step === 15 && !fetching && status === 2 && (
        <button type="button" className="optin-demo-action" onClick={() => setStatus(6)}>{tp('demo_complete')}</button>
      )}
      {toast && toast.text && <div className={`optin-toast${toast.error ? ' is-error' : ''}`} role="status">{toast.text}</div>}
    </>
  );
  const BlockBtn = ({ onClick, disabled, children, style }: { onClick: () => void; disabled?: boolean; children: ReactNode; style?: React.CSSProperties }) => (
    <button type="button" className="btn symbol-button symbol-button__block" style={{ float: 'left', ...style }} onClick={onClick} disabled={disabled}>{children}</button>
  );

  const rootStyle = { '--optin-check-img': `url(${imgCheck})` } as React.CSSProperties;
  const white = step === 17 && !fetching;

  // --- 体験できないプロファイル --------------------------------------------------------------
  if (!loading && (nemWallet == null || nemWallet.watchOnly)) {
    return (
      <div className="optin-root" style={rootStyle}>
        <img src={bgPurpleSmall} className="imageLogo" alt="" />
        <Chrome />
        <div className="optin-content">
          <div className="container text-center">
            <h4 className="text-white">{tp('no_nem')}</h4>
          </div>
        </div>
      </div>
    );
  }

  // --- 背景（元は動画 / 画像） -----------------------------------------------------------------
  let background = bgPurpleSmall;
  if (fetching || step === 0) background = bgWelcome;
  else if (step === 17) background = bgWhite;

  const claimable = canClaim(amountMicro);
  const amountText = `${formatClaimAmount(amountMicro)} XYM`;
  const fieldStyle: React.CSSProperties = { width: '100%', textAlign: 'left', paddingLeft: 30 };

  return (
    <div className={`optin-root post-optin${white ? ' optin-root--white' : ''}`} style={rootStyle}>
      <img src={background} className="imageLogo" alt="" />
      <Chrome />
      <div className="optin-content">
        <div className="container">
          {/* LOADING SCREEN */}
          {fetching && (
            <div className="row welcome-page">
              <div className="col-md-12"><h1 className="text-white">{tr('welcome_loading')}</h1></div>
            </div>
          )}

          {/* STEP 0: WELCOME */}
          {!fetching && step === 0 && (
            <>
              <div className="row welcome-page">
                <div className="col-md-12"><h1 className="text-white">{tr('welcome_title')}</h1></div>
              </div>
              <div className="col-md-10 welcome-page" style={{ top: '48%', marginLeft: -15 }}>
                <div className="form-group" style={{ marginBottom: 25 }}>
                  <h4 className="text-white">{tp('info_1')}</h4>
                  <h4 className="text-white">{tp('info_2')} <br /> {tp('info_3')}</h4>
                  <h4 style={{ marginTop: 15 }}>
                    <a href={MIGRATION_URL} target="_blank" rel="noopener noreferrer" className="symbol-link">
                      <strong>{tr('link_info')}<span style={{ textDecoration: 'underline' }}>{tr('here')}</span></strong>
                    </a>
                  </h4>
                </div>
                <button type="button" className="btn symbol-button" onClick={() => setStep(15)}>{tr('ready')}</button>
              </div>
            </>
          )}

          {/* STEP 15: SELECT ACCOUNT / STATUS */}
          {!fetching && step === 15 && nemWallet && (
            <>
              <Header img={imgAccount} title={tp('select_account')} />
              <div className="col-md-8 col-md-offset-2">
                <div className="form-group">
                  <p>{tp('your_nis')}</p>
                  <label className="optin-label-form">{nemWallet.address}</label>
                </div>
                <div className="form-group">
                  {claimable && (
                    <>
                      <p>{tp('status')}</p>
                      <label className="optin-label-form">
                        <div className={`status-color-${status}`}>{tp(`status_title_${status}`)}</div>
                      </label>
                    </>
                  )}
                  <p>{tp('details')}</p>
                  <div className="optin-label-form">
                    <label style={{ fontWeight: 'lighter' }}>{claimable ? tp(`status_text_${status}`) : tp('not_available')}</label>
                  </div>
                </div>
                {showsDestination(status) && (
                  <div className="form-group">
                    <p>{tp('dest_address')}</p>
                    <label className="text-left optin-label-form">{optinAddress}</label>
                  </div>
                )}
                {claimable && (
                  <div className="form-group">
                    <p>{tp(amountLabelKey(status))}</p>
                    <label className="text-left optin-label-form" style={fieldStyle}>{amountText}</label>
                  </div>
                )}
                {canStart(status, amountMicro) && (
                  <div className="mt-4">
                    <div className="row">
                      <div className="col-md-6" style={{ padding: '0 16px' }} />
                      <div className="col-md-6" style={{ padding: '0 16px' }}>
                        <BlockBtn onClick={() => setStep(16)}>{tp('start')}</BlockBtn>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* STEP 16: SYMBOL PUBLIC KEY */}
          {!fetching && step === 16 && (
            <>
              <Header img={imgPassword} title={tp('unlock_title')} />
              <div className="col-md-8 col-md-offset-2">
                <div className="form-group">
                  <p>{tp('unlock_title')}</p>
                  <input
                    type="text"
                    className="optin-label-form"
                    placeholder={tp('public_key_placeholder')}
                    value={publicKey}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onPublicKeyChange(e.target.value)}
                  />
                  {publicKeyError && <p style={{ color: 'red', fontSize: 14, marginTop: 10 }}>{tp('nis1_key')}</p>}
                </div>
                {optinAccount && (
                  <div className="form-group">
                    <p>{tr('your_address')}</p>
                    <label className="optin-label-form">{optinAccount.address}</label>
                  </div>
                )}
                <div className="mt-4">
                  <div className="row">
                    <div className="col-md-6" style={{ padding: '0 16px' }}>
                      <BlockBtn onClick={backFromKey}>{tr('back')}</BlockBtn>
                    </div>
                    <div className="col-md-6" style={{ padding: '0 16px' }}>
                      {optinAccount && <BlockBtn onClick={() => setStep(17)}>{tr('next')}</BlockBtn>}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* STEP 17: REVIEW */}
          {!fetching && step === 17 && optinAccount && (
            <>
              <Header img={imgTerms} title={tp('review_title')} color="#44004E" />
              {!modalShown && (
                <div className="col-md-8 col-md-offset-2">
                  <div className="form-group">
                    <p className="purple-dark">{tp('dest_address')}</p>
                    <label className="text-left optin-label-form-white" style={fieldStyle}>{optinAccount.address}</label>
                  </div>
                  <div className="form-group">
                    <p className="purple-dark">{tp('quantity')}</p>
                    <label className="text-left optin-label-form-white" style={fieldStyle}>{amountText}</label>
                  </div>

                  <input id="accept_and_read_terms" className="optin-plain" type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
                  <label className="optin-agree mt-2" htmlFor="accept_and_read_terms">
                    <b>{tr('read_accept')}<a href={TERMS_URL} className="symbol-link" style={{ color: 'rgb(205,0,205)' }} target="_blank" rel="noopener noreferrer">{tr('tac_text')}</a></b>{tr('read_accept_post')}
                  </label>
                  <br />
                  <input id="accept_and_read_privacy" className="optin-plain" type="checkbox" checked={acceptPrivacy} onChange={(e) => setAcceptPrivacy(e.target.checked)} />
                  <label className="optin-agree mt-2" htmlFor="accept_and_read_privacy">
                    <b>{tr('read_accept')}<a href={TERMS_URL} className="symbol-link" style={{ color: 'rgb(205,0,205)' }} target="_blank" rel="noopener noreferrer">{tp('pp_text')}</a></b>{tr('read_accept_post')}
                  </label>

                  <div className="mt-4">
                    <p className="purple-dark">{tr('fee')}</p>
                    <label className="text-left optin-label-form-white" style={fieldStyle}>{POST_OPTIN_FEE_XEM} XEM</label>
                  </div>
                  <div className="mt-4">
                    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                      <p className="purple-dark">{tr('enter_password')}</p>
                      <input
                        className="form-control optin-input purple-dark"
                        type="password"
                        value={password}
                        autoComplete="current-password"
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </fieldset>
                  </div>
                  <div className="mt-4">
                    <div className="row">
                      <div className="col-md-6" style={{ padding: '0 16px' }}>
                        <BlockBtn onClick={() => setStep(16)}>{tr('back')}</BlockBtn>
                      </div>
                      <div className="col-md-6" style={{ padding: '0 16px' }}>
                        <BlockBtn
                          onClick={() => { void showConfirmAddressModal(); }}
                          disabled={!acceptTerms || !acceptPrivacy || password.length === 0 || busy}
                          style={{ background: 'linear-gradient(42deg, rgba(255,0,255,1) 0%, rgba(255,255,255,1) 100%)' }}
                        >{tp('send')}</BlockBtn>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* CONFIRM ADDRESS MODAL */}
      {modalShown && optinAccount && (
        <div className="optin-confirm-bg">
          <div className="optin-confirm-modal">
            <div className="optin-confirm-modal-inner">
              <div className="optin-confirm-modal-image-container">
                <img src={imgVerify} className="optin-confirm-modal-image" alt="" />
              </div>
              <div className="optin-confirm-modal-body">
                <h4 style={{ color: '#44004E', fontWeight: 'bold', fontSize: 24 }}>{tp('modal_title')}</h4>
                <div className="mt-2">{tp('modal_text')}</div>
                <div className="mt-4">
                  <div className="form-group">
                    <p className="purple-dark">{tp('dest_address')}</p>
                    <label className="text-left optin-label-form-white" style={fieldStyle}>{optinAccount.address}</label>
                  </div>
                </div>
                <div className="mt-4">
                  <input id="address_confirm" className="optin-plain" type="checkbox" checked={addressConfirmed} onChange={(e) => setAddressConfirmed(e.target.checked)} />
                  <label className="optin-agree mt-2" htmlFor="address_confirm"><b>{tp('modal_checkbox')}</b></label>
                </div>
                <div className="mt-2">
                  <div className="row">
                    <div className="col-md-6" style={{ padding: '0 16px' }}>
                      <BlockBtn onClick={() => setModalShown(false)}>{tr('back')}</BlockBtn>
                    </div>
                    <div className="col-md-6" style={{ padding: '0 16px' }}>
                      <BlockBtn
                        onClick={send}
                        disabled={!addressConfirmed}
                        style={{ background: 'linear-gradient(42deg, rgba(255,0,255,1) 0%, rgba(255,255,255,1) 100%)' }}
                      >{tp('send')}</BlockBtn>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
