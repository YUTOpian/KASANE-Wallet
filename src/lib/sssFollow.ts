// SSS Extension のネットワークに、アプリのネットワークを合わせるかどうかの判定（副作用なし）。
// SSS は Symbol のみで、メインネットかテストネットかは SSS 側で決まる。食い違ったら SSS に合わせる。
//
// - SSS のプロファイルを使っているとき: 常に SSS に合わせる（署名は SSS で行うので、ずれたままでは使えない）。
// - それ以外のプロファイル: SSS のネットワークが「分かった・切り替わった」そのときに1回だけ合わせる。
//   そのあとで手動で切り替えた分は、無理に戻さない（SSS を入れているだけで、ネットワークを選べなくなるのを避ける）。
//   合わせないもの: 閲覧用プロファイル（登録したアドレスのネットワークが決まっている）、
//   Symbol 以外のチェーン（NEM）、mijin v2（SSS では表せない独自のネットワーク）。

export type SssNetwork = 'mainnet' | 'testnet';

export interface SssFollowInput {
  /** SSS でいま選ばれているアカウントのネットワーク。 */
  sssNetwork: SssNetwork;
  /** アプリのいまのネットワーク（'mainnet' | 'testnet' | 'mijin'）。 */
  appNetwork: string;
  /** アプリのいまのチェーン（'symbol' | 'nem'）。 */
  appChain: string;
  /** いま使っているプロファイル（まだ無ければ null）。 */
  profile: { sss?: boolean; watchOnly?: boolean } | null;
  /** SSS のネットワークが、いま分かった・切り替わったところか（SSS のプロファイル以外の判断に使う）。 */
  sssNetworkJustChanged: boolean;
}

export interface SssFollowResult {
  /** 切り替える先のネットワーク。切り替えなくてよければ null。 */
  network: SssNetwork | null;
  /** チェーンを Symbol に切り替えるか（SSS のプロファイルのときだけ）。 */
  switchChainToSymbol: boolean;
}

export function sssFollow(input: SssFollowInput): SssFollowResult {
  const { sssNetwork, appNetwork, appChain, profile, sssNetworkJustChanged } = input;
  if (profile?.sss) {
    return { network: appNetwork !== sssNetwork ? sssNetwork : null, switchChainToSymbol: appChain !== 'symbol' };
  }
  const none: SssFollowResult = { network: null, switchChainToSymbol: false };
  if (!sssNetworkJustChanged) return none;
  if (profile?.watchOnly) return none;
  if (appChain !== 'symbol') return none;
  if (appNetwork === 'mijin') return none;
  return { network: appNetwork !== sssNetwork ? sssNetwork : null, switchChainToSymbol: false };
}
