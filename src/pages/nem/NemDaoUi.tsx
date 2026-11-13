import { useEffect, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { WalletsHelper } from '../../lib/storage';
import { isNemDaoId } from '../../lib/nem/daoCore';

/** いま開いているウォレットの NEM アカウント（無ければ null、読み込み中は undefined）。 */
export interface NemActor { address: string; publicKey: string }

export function useNemActor(): NemActor | null | undefined {
  const [actor, setActor] = useState<NemActor | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    WalletsHelper.getActive('nem')
      .then((w) => { if (!cancelled) setActor(w ? { address: w.address, publicKey: w.publicKey } : null); })
      .catch(() => { if (!cancelled) setActor(null); });
    return () => { cancelled = true; };
  }, []);
  return actor;
}

export const LoadingBox = () => <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;

export const nemDaoPath = (id: string, tab = 'home') => `/dao/view?id=${id}${tab === 'home' ? '' : `&tab=${tab}`}`;

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// 開いた DAO を覚えておく（ネットワークごと、新しい順に 10 件）。
const RECENT_KEY = 'kasane.nemdao.recent';
export interface RecentNemDao { id: string; name: string }

export function loadRecentNemDaos(network: string): RecentNemDao[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, RecentNemDao[]>;
    return Array.isArray(all[network]) ? all[network].filter((d) => isNemDaoId(d.id)) : [];
  } catch { return []; }
}

export function rememberNemDao(network: string, dao: RecentNemDao): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, RecentNemDao[]>;
    all[network] = [dao, ...(all[network] ?? []).filter((d) => d.id !== dao.id)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch { /* 覚えられなくても動く */ }
}

/** パスワードで、いま開いている NEM ウォレットの秘密鍵を開く（違えば Error('invalid_password')）。 */
export async function unlockNemKey(password: string): Promise<{ privateKey: string; publicKey: string }> {
  const wallet = await WalletsHelper.getActive('nem');
  if (!wallet) throw new Error('no_wallet');
  const privateKey = await WalletsHelper.decryptKey(wallet.id, password);
  if (privateKey == null) throw new Error('invalid_password');
  return { privateKey, publicKey: wallet.publicKey };
}

export const groupDigits = (value: bigint): string => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
